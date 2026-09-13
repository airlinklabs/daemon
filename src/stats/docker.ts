import { existsSync } from "node:fs";
import {
  DOCKER_FETCH_DEFAULT_TIMEOUT_MS,
  DOCKER_FETCH_LIST_TIMEOUT_MS,
  DOCKER_CONTAINER_STATS_TIMEOUT_MS,
} from "../config/timeouts";
import {
  DOCKER_DISPLAY_CONTAINER_ID_LENGTH,
  DOCKER_ERROR_MSG_MAX_LENGTH,
  DOCKER_MAX_DISPLAY_CONTAINERS,
} from "../config/docker";
import { DOCKER_API_VERSION } from "../config/docker";
import type { ContainerInfo, DockerStats } from "./types";

interface DockerResponse {
  status: number;
  body: string;
  json: unknown;
}

interface DockerContainerInfo {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
}

interface DockerContainerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
}

function decodeChunked(text: string): string {
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    const nl = rest.indexOf("\r\n");
    if (nl < 0) break;
    const size = parseInt(rest.slice(0, nl), 16);
    if (Number.isNaN(size) || size < 0) break;
    rest = rest.slice(nl + 2);
    if (size === 0) break;
    out += rest.slice(0, size);
    rest = rest.slice(size + 2);
  }
  return out;
}

function dockerFetch(
  path: string,
  socket: string,
  timeoutMs = DOCKER_FETCH_DEFAULT_TIMEOUT_MS,
): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const req = `GET ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`;
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("timeout"));
    }, timeoutMs);
    Bun.connect({
      unix: socket,
      socket: {
        data(_socket, data) {
          buf += data.toString("utf8");
        },
        open(socket) {
          socket.write(req);
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const sep = buf.indexOf("\r\n\r\n");
          const head = sep >= 0 ? buf.slice(0, sep) : buf;
          let body = sep >= 0 ? buf.slice(sep + 4) : "";
          const status = Number(head.split(" ")[1] ?? 0);
          if (/transfer-encoding:\s*chunked/i.test(head))
            body = decodeChunked(body);
          let json: unknown = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status, body, json });
        },
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

let dockerSocket: string | null | undefined;

function getDockerSocket(): string | null {
  if (dockerSocket !== undefined) return dockerSocket;
  const candidates = [
    process.env.AIRLINK_DOCKER_SOCKET,
    "/var/run/docker.sock",
    "/run/podman/podman.sock",
  ].filter((p): p is string => !!p);
  for (const socket of candidates) {
    try {
      if (existsSync(socket)) {
        dockerSocket = socket;
        return socket;
      }
    } catch {}
  }
  dockerSocket = null;
  return null;
}

function containerStatCpu(stats: DockerContainerStats): number {
  const cur = stats?.cpu_stats;
  const prev = stats?.precpu_stats;
  if (!cur || !prev) return 0;
  const cpuDelta =
    (cur.cpu_usage?.total_usage ?? 0) - (prev.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cur.system_cpu_usage ?? 0) - (prev.system_cpu_usage ?? 0);
  const cores = cur.online_cpus ?? 1;
  if (sysDelta <= 0 || cpuDelta <= 0) return 0;
  return Math.min(100, (cpuDelta / sysDelta) * cores * 100);
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

export async function collectDocker(): Promise<DockerStats> {
  const empty: DockerStats = {
    online: false,
    error: null,
    containers: [],
    images: 0,
    networks: 0,
    volumes: 0,
    dockerDiskGb: 0,
  };
  const socket = getDockerSocket();
  if (!socket) return { ...empty, error: "no docker socket found" };
  const results = await Promise.allSettled([
    withTimeout(
      dockerFetch(`/${DOCKER_API_VERSION}/containers/json?all=1`, socket),
      DOCKER_FETCH_LIST_TIMEOUT_MS,
      null,
    ),
    withTimeout(
      dockerFetch(`/${DOCKER_API_VERSION}/images/json`, socket),
      DOCKER_FETCH_LIST_TIMEOUT_MS,
      null,
    ),
    withTimeout(
      dockerFetch(`/${DOCKER_API_VERSION}/networks`, socket),
      DOCKER_FETCH_LIST_TIMEOUT_MS,
      null,
    ),
    withTimeout(
      dockerFetch(`/${DOCKER_API_VERSION}/volumes`, socket),
      DOCKER_FETCH_LIST_TIMEOUT_MS,
      null,
    ),
    withTimeout(
      dockerFetch(`/${DOCKER_API_VERSION}/system/df`, socket),
      DOCKER_FETCH_LIST_TIMEOUT_MS,
      null,
    ),
  ]);
  const firstError = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  const infos = (
    results[0].status === "fulfilled" ? results[0].value?.json : null
  ) as DockerContainerInfo[] | null;
  if (firstError && !infos) {
    const msg = String(firstError.reason?.message ?? firstError.reason);
    if (msg.includes("EACCES") || msg.includes("permission")) {
      return { ...empty, error: "permission denied (run as root)" };
    }
    return { ...empty, error: msg.slice(0, DOCKER_ERROR_MSG_MAX_LENGTH) };
  }
  if (!Array.isArray(infos))
    return { ...empty, error: "docker API unreachable" };
  const running = infos
    .filter((c: DockerContainerInfo) => c.State === "running")
    .slice(0, DOCKER_MAX_DISPLAY_CONTAINERS);
  const stats = await Promise.allSettled(
    running.map((c: DockerContainerInfo) =>
      withTimeout(
        dockerFetch(
          `/${DOCKER_API_VERSION}/containers/${c.Id}/stats?stream=false`,
          socket,
          DOCKER_FETCH_DEFAULT_TIMEOUT_MS,
        ),
        DOCKER_CONTAINER_STATS_TIMEOUT_MS,
        null,
      ),
    ),
  );
  const perId = new Map<
    string,
    { cpu: number; memUsed: number; memLimit: number }
  >();
  running.forEach((c: DockerContainerInfo, i: number) => {
    const s = stats[i]!;
    if (s.status !== "fulfilled" || !s.value?.json) return;
    const v = s.value.json as DockerContainerStats;
    const cpu = containerStatCpu(v);
    const memUsed = v.memory_stats?.usage ?? 0;
    const memLimit = v.memory_stats?.limit ?? 0;
    perId.set(c.Id, { cpu, memUsed, memLimit });
  });
  const containersOut: ContainerInfo[] = infos.map((c: DockerContainerInfo) => {
    const m = perId.get(c.Id);
    return {
      id: c.Id.slice(0, DOCKER_DISPLAY_CONTAINER_ID_LENGTH),
      name: (c.Names?.[0] ?? "?").replace(/^\//, ""),
      image: c.Image ?? "?",
      state: c.State ?? "?",
      status: c.Status ?? "",
      cpuPct: m?.cpu ?? 0,
      memUsedMb: m ? m.memUsed / 1e6 : 0,
      memLimitMb: m && m.memLimit > 0 ? m.memLimit / 1e6 : 0,
    };
  });
  containersOut.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return b.cpuPct - a.cpuPct;
  });
  return {
    online: true,
    error: null,
    containers: containersOut,
    images:
      results[1].status === "fulfilled"
        ? ((results[1].value?.json as { length?: number })?.length ?? 0)
        : 0,
    networks:
      results[2].status === "fulfilled"
        ? ((results[2].value?.json as { length?: number })?.length ?? 0)
        : 0,
    volumes:
      results[3].status === "fulfilled"
        ? ((results[3].value?.json as { Volumes?: unknown[] })?.Volumes
            ?.length ?? 0)
        : 0,
    dockerDiskGb:
      results[4].status === "fulfilled"
        ? ((results[4].value?.json as { LayersSize?: number })?.LayersSize ??
            0) / 1e9
        : 0,
  };
}
