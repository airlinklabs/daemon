import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type Docker from "dockerode";
import config from "../config";
import logger from "../logger";
import { getPaths } from "../paths";
import { emit } from "../ws/events";
import { normalizeConsoleCommand } from "./consoleCommand";
import { createRuntime } from "./containerRuntime";
import type { MountSpec } from "./dockerConfig";
import {
  buildHostConfig,
  buildInstallerHostConfig,
  parseEnvironmentVariables,
  parsePortBindings,
  validateMounts,
} from "./dockerConfig";
import { buildInitScript } from "./dockerInit";
import {
  initContainerStateMap as _initContainerStateMap,
  forgetContainer,
  isContainerRunning,
  setContainerRunning,
} from "./dockerState";
import { archiveLogHistory, beginCapture } from "./logHistory";

const runtime = createRuntime(config.containerRuntime);
export const docker = runtime;

import { getErrorMessage } from "../utils/errorMessage";

function getDockerStatusCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

const CONSOLE_FIFO_RELATIVE_PATH = join(".airlinkd", "console.in");
const CONSOLE_FIFO_WRITE_TIMEOUT_MS = 10_000;
const STORAGE_ENFORCE_INTERVAL_MS = 30_000;
const STOP_GRACEFUL_TIMEOUT_MS = 20_000;
const STOP_GRACEFUL_POLL_MS = 500;
const STOP_FORCE_TIMEOUT_S = 5;

const storageLimits = new Map<string, number>();

async function applyNetworkThrottle(id: string, mbps: number): Promise<void> {
  if (!(mbps > 0)) return;
  try {
    const container = docker.getContainer(id);
    const exec = await container.exec({
      Cmd: [
        "/bin/sh",
        "-c",
        `command -v tc >/dev/null 2>&1 && tc qdisc add dev eth0 root handle 1: tbf rate ${mbps}mbit burst 64kb latency 50ms`,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: false, stdin: false });
    const exitCode = await waitForExecExit(stream, exec, id);
    if (exitCode === 0) {
      logger.info(`applied network throttle: ${id} @ ${mbps} mbps`);
    } else if (exitCode === null) {
      logger.warn(
        `network throttle result unknown for ${id} (timed out waiting for exec)`,
      );
    } else {
      logger.warn(
        `network throttle command exited with code ${exitCode} for ${id}`,
      );
    }
  } catch (err) {
    logger.warn(`network throttle skipped for ${id}: ${getErrorMessage(err)}`);
  }
}

async function waitForExecExit(
  stream: unknown,
  exec: { inspect(): Promise<{ ExitCode?: number | null }> },
  id: string,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (typeof stream !== "object" || stream === null || !("on" in stream))
    return null;
  const readable = stream as NodeJS.ReadableStream;
  let settled = false;
  const finished = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        logger.warn(
          `network throttle exec for ${id} timed out after ${timeoutMs}ms`,
        );
      }
      resolve();
    }, timeoutMs);
    readable.resume();
    readable.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      resolve();
    });
    readable.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        logger.warn(`network throttle stream error for ${id}: ${err.message}`);
      }
      resolve();
    });
  });
  await finished;
  const info = await exec.inspect();
  return typeof info.ExitCode === "number" ? info.ExitCode : null;
}

let storageEnforcementRunning = false;
async function enforceStorageLimits(): Promise<void> {
  if (storageEnforcementRunning) return;
  storageEnforcementRunning = true;
  try {
    for (const [id, limitMb] of storageLimits) {
      if (limitMb <= 0) continue;
      let usageMb: number;
      try {
        usageMb = await getStorageUsageMb(id);
      } catch (err) {
        logger.warn(
          `storage usage check failed for ${id}: ${getErrorMessage(err)}`,
        );
        continue;
      }
      if (usageMb <= limitMb) continue;
      const running = isContainerRunning(id);
      if (running === false) {
        storageLimits.delete(id);
        continue;
      }
      logger.warn(
        `container ${id} exceeded storage limit (${usageMb.toFixed(0)} MB > ${limitMb} MB), stopping`,
      );
      emit(id, {
        type: "error",
        message: `storage limit exceeded (${usageMb.toFixed(0)} MB of ${limitMb} MB), server stopped`,
      });
      stopContainer(id).catch((err) => {
        logger.error(
          `storage-limit stop failed for ${id}: ${getErrorMessage(err)}`,
        );
      });
    }
  } finally {
    storageEnforcementRunning = false;
  }
}
setInterval(() => {
  enforceStorageLimits().catch(() => {});
}, STORAGE_ENFORCE_INTERVAL_MS).unref?.();

export async function checkDocker(): Promise<void> {
  const cmd = runtime.name === "docker" ? "docker" : "podman";
  const proc = Bun.spawn([cmd, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd} is not installed or not in PATH`);
}

export async function checkDockerRunning(): Promise<void> {
  const cmd = runtime.name === "docker" ? "docker" : "podman";
  const proc = Bun.spawn([cmd, "ps", "-q"], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`${cmd} is not running, start it and try again`);
}

export type ContainerStats = {
  running: boolean;
  exists: boolean;
  memory: { usage: number; limit: number; percentage: number };
  cpu: { percentage: number };
  storage: { usage: number };
};

async function getStorageUsageMb(id: string): Promise<number> {
  const volumePath = join(getPaths(config.paths).volumesRoot, id);
  if (!existsSync(volumePath)) return 0;
  function walk(dir: string): number {
    let total = 0;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const p = join(dir, entry);
        try {
          const st = lstatSync(p);
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) {
            total += walk(p);
          } else if (st.isFile()) {
            total += st.size;
          }
        } catch {}
      }
    } catch {}
    return total;
  }
  return walk(volumePath) / 1024 / 1024;
}

export async function getContainerStats(
  id: string,
): Promise<ContainerStats | null> {
  let storage: { usage: number };
  try {
    storage = { usage: await getStorageUsageMb(id) };
  } catch (err) {
    logger.warn(`storage usage walk failed for ${id}: ${getErrorMessage(err)}`);
    storage = { usage: 0 };
  }
  let info: Docker.ContainerInspectInfo;
  try {
    info = await docker.getContainer(id).inspect();
  } catch (err) {
    if (getDockerStatusCode(err) === 404) return null;
    logger.warn(`inspect failed for ${id}: ${getErrorMessage(err)}`);
    return null;
  }
  const notRunning: ContainerStats = {
    running: false,
    exists: true,
    memory: { usage: 0, limit: 0, percentage: 0 },
    cpu: { percentage: 0 },
    storage,
  };
  if (!info.State.Running) return notRunning;
  let stats: Docker.ContainerStats;
  try {
    stats = await docker.getContainer(id).stats({ stream: false });
  } catch (err) {
    logger.warn(
      `stats failed for running container ${id}: ${getErrorMessage(err)}`,
    );
    return {
      running: true,
      exists: true,
      memory: { usage: 0, limit: 0, percentage: 0 },
      cpu: { percentage: 0 },
      storage,
    };
  }
  const memUsage = (stats.memory_stats.usage as number) ?? 0;
  const memLimit = (stats.memory_stats.limit as number) ?? 1;
  const memCache = (stats.memory_stats.stats as { cache?: number })?.cache ?? 0;
  const memActual = memUsage - memCache;
  const cpuDelta =
    (stats.cpu_stats.cpu_usage.total_usage as number) -
    (stats.precpu_stats.cpu_usage.total_usage as number);
  const sysDelta =
    (stats.cpu_stats.system_cpu_usage as number) -
    ((stats.precpu_stats.system_cpu_usage as number) ?? 0);
  const numCpus =
    (stats.cpu_stats.online_cpus as number) ??
    (stats.cpu_stats.cpu_usage.percpu_usage as number[] | undefined)?.length ??
    1;
  const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
  return {
    running: true,
    exists: true,
    memory: {
      usage: memActual,
      limit: memLimit,
      percentage: (memActual / memLimit) * 100,
    },
    cpu: { percentage: Math.max(0, cpuPercent) },
    storage,
  };
}

export async function getContainerState(
  id: string,
): Promise<{
  running: boolean;
  startedAt: string | null;
  exitCode: number | null;
  status: string | null;
}> {
  try {
    const info = await docker.getContainer(id).inspect();
    return {
      running: info.State.Running === true,
      startedAt: info.State.StartedAt || null,
      exitCode:
        typeof info.State.ExitCode === "number" ? info.State.ExitCode : null,
      status: info.State.Status || null,
    };
  } catch (err) {
    if (getDockerStatusCode(err) !== 404)
      logger.warn(`inspect failed for ${id}: ${getErrorMessage(err)}`);
    return { running: false, startedAt: null, exitCode: null, status: null };
  }
}

export function initContainer(id: string): string {
  const volumesDir = getPaths(config.paths).volumesRoot;
  const volumePath = join(volumesDir, id);
  if (!existsSync(volumesDir)) mkdirSync(volumesDir, { recursive: true });
  if (!existsSync(volumePath)) mkdirSync(volumePath, { recursive: true });
  return volumePath;
}

export async function pullImageWithProgress(
  image: string,
  containerId: string,
): Promise<void> {
  logger.info("pulling container image", { image, containerId });
  emit(containerId, { type: "pulling", message: `pulling image ${image}` });
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        emit(containerId, {
          type: "error",
          message: `pull failed: ${err.message}`,
        });
        reject(err);
        return;
      }
      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            emit(containerId, {
              type: "error",
              message: `pull error: ${err.message}`,
            });
            reject(err);
          } else {
            emit(containerId, {
              type: "pulling",
              message: `image ${image} is ready`,
            });
            resolve();
          }
        },
        (event: { status: string; id?: string }) => {
          if (
            event.status === "Pull complete" ||
            event.status === "Already exists"
          )
            emit(containerId, {
              type: "pulling",
              message: `layer ${event.id ?? ""}: ${event.status}`,
            });
        },
      );
    });
  });
}

export async function startContainer(
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports = "",
  Memory: number,
  Cpu: number,
  Storage = 0,
  Swap = 0,
  mounts: MountSpec[] = [],
): Promise<void> {
  logger.info("starting container", { containerId: id, image });
  emit(id, {
    type: "pulling",
    message: `cleaning up any old ${id} container first`,
  });
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404)
      throw new Error(
        `failed to remove existing container ${id}: ${getErrorMessage(err)}`,
      );
  }
  const volumePath = initContainer(id);
  const { portBindings, exposedPorts } = parsePortBindings(ports);
  const modifiedEnv = parseEnvironmentVariables(env);
  const portSummary = Object.entries(portBindings)
    .map(([c, h]) => `${h[0].HostPort} -> ${c}`)
    .join(", ");
  if (portSummary)
    emit(id, { type: "pulling", message: `port bindings: ${portSummary}` });

  // Validate mount sources before any Docker operations
  try {
    validateMounts(mounts, getPaths(config.paths).base);
  } catch (err) {
    throw new Error(
      `invalid mount: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch (err) {
    if (getDockerStatusCode(err) !== 404)
      logger.warn(
        `could not inspect image ${image}: ${getErrorMessage(err)} — will attempt pull`,
      );
    imageExists = false;
    emit(id, {
      type: "pulling",
      message: `image not found locally, pulling from registry`,
    });
  }
  if (!imageExists) await pullImageWithProgress(image, id);
  emit(id, { type: "creating", message: `creating ${id}` });
  const eulaPath = join(volumePath, "eula.txt");
  if (
    !existsSync(eulaPath) ||
    !readFileSync(eulaPath, "utf8").includes("eula=true")
  )
    writeFileSync(
      eulaPath,
      "#By installing Minecraft you agree to the EULA\neula=true\n",
      "utf8",
    );
  const imageInspect = await docker
    .getImage(image)
    .inspect()
    .catch((err: unknown) => {
      logger.error(
        `could not inspect image ${image} for entrypoint: ${getErrorMessage(err)}`,
      );
      return null;
    });
  const rawEntrypoint = imageInspect?.Config?.Entrypoint ?? [];
  const rawCmd = imageInspect?.Config?.Cmd ?? [];
  const originalEntrypoint: string[] = Array.isArray(rawEntrypoint)
    ? rawEntrypoint
    : [rawEntrypoint];
  const originalCmd: string[] = Array.isArray(rawCmd) ? rawCmd : [rawCmd];
  const airlinkdDir = join(volumePath, ".airlinkd");
  if (!existsSync(airlinkdDir)) mkdirSync(airlinkdDir, { recursive: true });
  const initScript = buildInitScript(originalEntrypoint, originalCmd);
  writeFileSync(join(airlinkdDir, "init.sh"), initScript, {
    mode: 0o755,
    encoding: "utf8",
  });
  modifiedEnv.PS1 = "airlinkd~\\$ ";
  modifiedEnv.PROMPT = "airlinkd~\\$ ";
  modifiedEnv.prompt = "airlinkd~\\$ ";
  const hostConfig = buildHostConfig({
    volumePath,
    portBindings,
    Memory,
    Cpu,
    Storage,
    Swap,
    mounts,
    runtimeName: runtime.name,
    networkRateMbps: config.networkRateMbps,
  });
  const container = await docker.createContainer({
    name: id,
    Image: image,
    Hostname: "airlinkd",
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    Entrypoint: ["/bin/sh", "/home/container/.airlinkd/init.sh"],
    WorkingDir: "/home/container",
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
    Labels: {
      Service: "airlinkd",
      ContainerType: "server",
      ServerId: id,
    },
  });
  emit(id, { type: "starting", message: `starting ${id}` });
  try {
    await container.start();
  } catch (err) {
    setContainerRunning(id, false);
    throw err;
  }
  setContainerRunning(id, true);
  if (config.networkRateMbps > 0)
    await applyNetworkThrottle(id, config.networkRateMbps);
  if (Storage > 0) storageLimits.set(id, Storage);
  else storageLimits.delete(id);
  emit(id, { type: "started", message: "server started" });
  try {
    beginCapture(id);
  } catch (err) {
    logger.warn(`log capture init failed for ${id}: ${getErrorMessage(err)}`);
  }
}

export async function createInstaller(
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {},
  entrypoint = "bash",
  serverLimits?: { Memory: number; Cpu: number },
): Promise<void> {
  try {
    await docker.getContainer(`installer_${id}`).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404)
      logger.warn(
        `could not remove existing installer container for ${id}: ${getErrorMessage(err)}`,
      );
  }
  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);
  emit(id, { type: "installing", message: "preparing installer" });
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch (err) {
    if (getDockerStatusCode(err) !== 404)
      logger.warn(
        `could not inspect installer image ${image}: ${getErrorMessage(err)} — will attempt pull`,
      );
    imageExists = false;
  }
  if (!imageExists) {
    emit(id, {
      type: "installing",
      message: `pulling installer image: ${image}`,
    });
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err)
          return reject(
            new Error(`failed to pull installer image: ${err.message}`),
          );
        resolve();
      });
    });
  }
  emit(id, { type: "installing", message: "running install script" });
  const hostConfig = buildInstallerHostConfig({
    volumePath,
    Memory: serverLimits?.Memory ?? 512,
    Cpu: serverLimits?.Cpu ?? 100,
  });
  const container = await docker.createContainer({
    name: `installer_${id}`,
    Image: image,
    Entrypoint: [
      entrypoint,
      "-c",
      script.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    ],
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      Service: "airlinkd",
      ContainerType: "server_installer",
      ServerId: id,
    },
    HostConfig: hostConfig,
  });
  const attachStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });
  const installerLines: string[] = [];
  const logDone = new Promise<void>((resolve) => {
    let buf = Buffer.alloc(0);
    attachStream.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const frameSize = buf.readUInt32BE(4);
        if (buf.length < 8 + frameSize) break;
        const payload = buf.slice(8, 8 + frameSize).toString("utf8");
        buf = buf.slice(8 + frameSize);
        for (const line of payload.split("\n")) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Docker stream output contains control characters that must be stripped
          const clean = line
            .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
            .trim();
          if (clean) {
            installerLines.push(clean);
            emit(id, { type: "installing", message: clean });
          }
        }
      }
    });
    attachStream.on("end", resolve);
    attachStream.on("error", resolve);
  });
  await container.start();
  const [result] = await Promise.all([container.wait(), logDone]);
  if (result.StatusCode !== 0) {
    logger.warn(`installer for ${id} exited with code ${result.StatusCode}`);
    for (const l of installerLines.slice(-20)) logger.warn(`  ${l}`);
    const logPath = join(volumePath, ".airlinkd", "install.log");
    try {
      const logDir = join(volumePath, ".airlinkd");
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      writeFileSync(logPath, installerLines.join("\n"), "utf8");
    } catch (err) {
      logger.warn(
        `could not persist install log for ${id}: ${getErrorMessage(err)}`,
      );
    }
    await container.remove({ force: true }).catch((err) => {
      logger.warn(
        `could not remove failed installer container for ${id}: ${getErrorMessage(err)}`,
      );
    });
    throw new Error(
      `install script failed with exit code ${result.StatusCode}`,
    );
  }
  const logPath = join(volumePath, ".airlinkd", "install.log");
  try {
    const logDir = join(volumePath, ".airlinkd");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, installerLines.join("\n"), "utf8");
  } catch (err) {
    logger.warn(
      `could not persist install log for ${id}: ${getErrorMessage(err)}`,
    );
  }
  emit(id, { type: "installed", message: "installation complete" });
  await container.remove({ force: true }).catch((err) => {
    logger.warn(
      `could not remove installer container for ${id}: ${getErrorMessage(err)}`,
    );
  });
}

export async function stopContainer(
  id: string,
  stopCmd?: string,
): Promise<void> {
  const container = docker.getContainer(id);
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (err) {
    if (getDockerStatusCode(err) === 404) return;
    throw new Error(
      `could not inspect container ${id} for stop: ${getErrorMessage(err)}`,
    );
  }
  if (!info.State.Running) {
    setContainerRunning(id, false);
    return;
  }
  emit(id, { type: "stopping", message: "stopping server" });
  if (stopCmd && stopCmd !== "kill") {
    try {
      await sendCommandToContainer(id, stopCmd);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.warn(`failed to send stop command to ${id}: ${err}`);
    }
    const deadline = Date.now() + STOP_GRACEFUL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STOP_GRACEFUL_POLL_MS));
      try {
        const current = await container.inspect();
        if (!current.State.Running) {
          setContainerRunning(id, false);
          await archiveLogHistory(id).catch((err) => {
            logger.warn(
              `could not archive logs for ${id}: ${getErrorMessage(err)}`,
            );
          });
          emit(id, { type: "stopped", message: "server stopped" });
          return;
        }
      } catch (err) {
        if (getDockerStatusCode(err) === 404) {
          setContainerRunning(id, false);
          await archiveLogHistory(id).catch((err) => {
            logger.warn(
              `could not archive logs for ${id}: ${getErrorMessage(err)}`,
            );
          });
          emit(id, { type: "stopped", message: "server stopped" });
          return;
        }
        logger.warn(
          `stop poll inspect failed for ${id}: ${getErrorMessage(err)}`,
        );
      }
    }
  }
  try {
    await container.stop({ t: STOP_FORCE_TIMEOUT_S });
  } catch (err: unknown) {
    const status = getDockerStatusCode(err);
    if (status !== 304 && status !== 404)
      logger.warn(`container.stop() for ${id}: ${getErrorMessage(err)}`);
  }
  try {
    await container.remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404)
      logger.warn(
        `container.remove() after stop for ${id}: ${getErrorMessage(err)}`,
      );
  }
  setContainerRunning(id, false);
  await archiveLogHistory(id).catch((err) => {
    logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
  });
  emit(id, { type: "stopped", message: "server stopped" });
}

export async function killContainer(id: string): Promise<void> {
  storageLimits.delete(id);
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404)
      throw new Error(
        `failed to kill container ${id}: ${getErrorMessage(err)}`,
      );
  }
  forgetContainer(id);
  setContainerRunning(id, false);
  await archiveLogHistory(id).catch((err) => {
    logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
  });
  emit(id, { type: "killed", message: "container forcibly removed" });
}

export async function deleteContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404)
      throw new Error(
        `failed to delete container ${id}: ${getErrorMessage(err)}`,
      );
  }
  forgetContainer(id);
}

export async function deleteContainerAndVolume(id: string): Promise<void> {
  storageLimits.delete(id);
  await deleteContainer(id);
  const volumePath = join(getPaths(config.paths).volumesRoot, id);
  if (existsSync(volumePath))
    rmSync(volumePath, { recursive: true, force: true });
}

async function writeCommandToConsoleFifo(
  id: string,
  command: string,
): Promise<void> {
  const fifoPath = join(
    getPaths(config.paths).volumesRoot,
    id,
    CONSOLE_FIFO_RELATIVE_PATH,
  );
  if (!existsSync(fifoPath) || !statSync(fifoPath).isFIFO())
    throw new Error(
      `console command FIFO is not ready for container ${id}; restart the container with the current daemon`,
    );
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      'printf "%s\n" "$1" > "$2"',
      "airlinkd-console-command",
      command,
      fifoPath,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => {
    proc.kill();
  }, CONSOLE_FIFO_WRITE_TIMEOUT_MS);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(
        `console FIFO write exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendCommandToContainer(
  id: string,
  command: string,
): Promise<void> {
  try {
    const container = docker.getContainer(id);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err) {
      if (getDockerStatusCode(err) === 404)
        throw new Error(`container ${id} is not running`);
      throw new Error(
        `could not inspect container ${id}: ${getErrorMessage(err)}`,
      );
    }
    if (!info.State.Running) throw new Error(`container ${id} is not running`);
    const cleanedCommand = normalizeConsoleCommand(command);
    if (!cleanedCommand)
      throw new Error(`empty command ignored for container ${id}`);
    await writeCommandToConsoleFifo(id, cleanedCommand);
  } catch (error) {
    logger.error(`failed to send command to container ${id}`, error);
    throw error;
  }
}

export type { MountSpec } from "./dockerConfig";
export {
  buildHostConfig,
  buildInstallerHostConfig,
  memoryOverheadMultiplier,
  parseEnvironmentVariables,
  parsePortBindings,
  validateMounts,
} from "./dockerConfig";
// Re-export everything from split modules so existing imports keep working.
export { buildInitScript } from "./dockerInit";
export {
  applyContainerEvent,
  applyContainerList,
  isContainerRunning,
  onContainerCrash,
  setContainerRunning,
} from "./dockerState";
export const initContainerStateMap = () => _initContainerStateMap(runtime);
