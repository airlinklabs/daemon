// dockerode - no bun-native docker socket client exists, this is the best option
import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { create as tarCreate, extract as tarExtract } from "tar";
import logger from "../logger";
import { setServerState, removeServerState } from "./installState";

export const docker = new Docker({
  socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
});

const eventSubscribers = new Map<string, Set<(event: { type: string; message: string }) => void>>();
const stateMap = new Map<string, boolean>();

function emitContainerEvent(containerId: string, event: { type: string; message: string }): void {
  const subs = eventSubscribers.get(containerId);
  if (!subs) return;
  for (const fn of subs) fn(event);
}

export function subscribe(containerId: string, fn: (event: { type: string; message: string }) => void): () => void {
  const subs = eventSubscribers.get(containerId) ?? new Set();
  subs.add(fn);
  eventSubscribers.set(containerId, subs);
  return () => {
    const current = eventSubscribers.get(containerId);
    current?.delete(fn);
    if (current && current.size === 0) eventSubscribers.delete(containerId);
  };
}

export async function checkDocker(): Promise<void> {
  const proc = Bun.spawn(["docker", "--version"], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    logger.error("docker is not installed or not in PATH, bailing");
    process.exit(1);
  }
}

export async function checkDockerRunning(): Promise<void> {
  const proc = Bun.spawn(["docker", "ps", "-q"], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    logger.error("docker is not running, start it and try again");
    process.exit(1);
  }
}

export function initContainer(id: string): string {
  const volumesDir = path.resolve("volumes");
  const volumePath = path.join(volumesDir, id);
  fs.mkdirSync(volumePath, { recursive: true });
  return volumePath;
}

function parseEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  if (process.platform !== "darwin" || !env.START) return { ...env };
  return { ...env, START: env.START.replace(/^(java\s+)/, "$1-XX:UseSVE=0 ") };
}

function parsePortBindings(ports: string): Record<string, Array<{ HostPort: string }>> {
  const result: Record<string, Array<{ HostPort: string }>> = {};
  for (const mapping of ports.split(",")) {
    const [hostPort, containerPort] = mapping.split(":");
    if (hostPort && containerPort && !Number.isNaN(Number(hostPort)) && !Number.isNaN(Number(containerPort))) {
      result[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
    }
  }
  return result;
}

const quoted = (args: string[]) => args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");

export async function startContainer(
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports = "",
  memory = 0,
  cpu = 0,
): Promise<void> {
  emitContainerEvent(id, { type: "pulling", message: "Preparing environment" });
  await docker.getContainer(id).remove({ force: true }).catch(() => {});
  const volumePath = initContainer(id);
  const portBindings = parsePortBindings(ports);
  const modifiedEnv = parseEnvironmentVariables(env);

  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const eulaPath = path.join(volumePath, "eula.txt");
  if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, "utf8").includes("eula=true")) {
    fs.writeFileSync(eulaPath, "#By installing Minecraft you agree to the EULA\neula=true\n", "utf8");
  }

  const imageInspect = await docker.getImage(image).inspect().catch(() => null);
  const rawEntrypoint = imageInspect?.Config?.Entrypoint ?? [];
  const rawCmd = imageInspect?.Config?.Cmd ?? [];
  const originalEntrypoint = Array.isArray(rawEntrypoint) ? rawEntrypoint : [rawEntrypoint];
  const originalCmd = Array.isArray(rawCmd) ? rawCmd : [rawCmd];

  const execLine =
    originalEntrypoint.length > 0
      ? `exec ${quoted(originalEntrypoint)}${originalCmd.length > 0 ? ` ${quoted(originalCmd)}` : ""}`
      : originalCmd.length > 0
        ? `exec ${quoted(originalCmd)}`
        : "exec /bin/sh";

  const airlinkdDir = path.join(volumePath, ".airlinkd");
  fs.mkdirSync(airlinkdDir, { recursive: true });
  fs.writeFileSync(
    path.join(airlinkdDir, "init.sh"),
    [
      "#!/bin/sh",
      "echo 'airlinkd' > /etc/hostname 2>/dev/null || true",
      "hostname airlinkd 2>/dev/null || true",
      "if [ -f /etc/passwd ]; then",
      "  sed -i 's|^container:|airlinkd:|' /etc/passwd 2>/dev/null || true",
      "  sed -i 's|^user:|airlinkd:|' /etc/passwd 2>/dev/null || true",
      "  sed -i 's|^app:|airlinkd:|' /etc/passwd 2>/dev/null || true",
      "fi",
      execLine,
      "",
    ].join("\n"),
    { mode: 0o755, encoding: "utf8" },
  );

  modifiedEnv.PS1 = "airlinkd~ ";
  modifiedEnv.PROMPT = "airlinkd~ ";
  modifiedEnv.prompt = "airlinkd~ ";

  const exposedPorts = Object.fromEntries(Object.keys(portBindings).map((port) => [port, {}]));
  const container = await docker.createContainer({
    name: id,
    Image: image,
    Hostname: "airlinkd",
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    Entrypoint: ["/bin/sh", "/home/container/.airlinkd/init.sh"],
    WorkingDir: "/home/container",
    HostConfig: {
      Binds: [`${volumePath}:/home/container`],
      PortBindings: portBindings,
      Memory: memory * 1024 * 1024,
      NanoCpus: Math.max(0.5, cpu / 100) * 1e9,
      RestartPolicy: { Name: "no" },
    },
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
  });

  await container.start();
  emitContainerEvent(id, { type: "started", message: "Server started" });
}

export async function createInstaller(
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {},
  entrypoint = "bash",
): Promise<void> {
  await docker.getContainer(`installer_${id}`).remove({ force: true }).catch(() => {});
  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);

  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const container = await docker.createContainer({
    name: `installer_${id}`,
    Image: image,
    Entrypoint: [entrypoint, "-c", script.replace(/\r\n/g, "\n").replace(/\r/g, "\n")],
    Env: Object.entries(modifiedEnv).map(([key, value]) => `${key}=${value}`),
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${volumePath}:/mnt/server`],
      AutoRemove: false,
      NetworkMode: "host",
    },
  });

  const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
  attachStream.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").replace(/[\x00-\x08\x0b-\x1f]/g, "").trim();
    if (line) emitContainerEvent(id, { type: "installing", message: line });
  });
  await container.start();
  const result = await container.wait();
  await container.remove({ force: true }).catch(() => {});
  if (result.StatusCode !== 0) {
    await setServerState(id, "failed");
    throw new Error(`Install script failed with exit code ${result.StatusCode}`);
  }
  await setServerState(id, "installed");
}

export async function stopContainer(id: string, stopCmd?: string): Promise<void> {
  const container = docker.getContainer(id);
  if (stopCmd) await sendCommandToContainer(id, stopCmd);
  await container.stop({ t: 10 });
  emitContainerEvent(id, { type: "stopped", message: "Server stopped" });
}

export async function killContainer(id: string): Promise<void> {
  await docker.getContainer(id).kill();
  emitContainerEvent(id, { type: "killed", message: "Server killed" });
}

export async function deleteContainerAndVolume(id: string): Promise<void> {
  await docker.getContainer(id).remove({ force: true }).catch(() => {});
  fs.rmSync(path.resolve("volumes", id), { recursive: true, force: true });
  await removeServerState(id);
}

export async function sendCommandToContainer(id: string, command: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect().catch(() => null);
  if (!info || !info.State.Running) return;
  const stream = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false });
  stream.write(`${command}\n`);
  stream.end();
}

export async function initContainerStateMap(): Promise<void> {
  const containers = await docker.listContainers({ all: true });
  for (const container of containers) {
    stateMap.set(container.Id, container.State === "running");
    const name = container.Names?.[0]?.replace(/^\//, "");
    if (name) stateMap.set(name, container.State === "running");
  }

  const eventStream = await docker.getEvents({ filters: JSON.stringify({ type: ["container"] }) });
  eventStream.on("data", (chunk: Buffer) => {
    try {
      const event = JSON.parse(chunk.toString()) as { status?: string; Action?: string; id?: string; Actor?: { Attributes?: { name?: string } } };
      const action = event.status ?? event.Action ?? "";
      const id = event.id ?? "";
      const name = event.Actor?.Attributes?.name;
      if (action === "start") {
        stateMap.set(id, true);
        if (name) stateMap.set(name, true);
      } else if (action === "die" || action === "stop") {
        stateMap.set(id, false);
        if (name) stateMap.set(name, false);
      } else if (action === "destroy") {
        stateMap.delete(id);
        if (name) stateMap.delete(name);
      }
    } catch {}
  });
}

export function isContainerRunning(id: string): boolean | null {
  return stateMap.has(id) ? (stateMap.get(id) ?? false) : null;
}

export type ContainerStats = {
  running: boolean;
  exists: boolean;
  memory: { usage: number; limit: number; percentage: number };
  cpu: { percentage: number };
};

export async function getContainerStats(id: string): Promise<ContainerStats | null> {
  try {
    const container = docker.getContainer(id);
    const stats = await container.stats({ stream: false });
    const memUsage = stats.memory_stats.usage ?? 0;
    const memLimit = stats.memory_stats.limit ?? 1;
    const memCache = stats.memory_stats.stats?.cache ?? 0;
    const memActual = memUsage - memCache;
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage ?? 0);
    const numCpus = stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
    const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
    return {
      running: true,
      exists: true,
      memory: { usage: memActual, limit: memLimit, percentage: (memActual / memLimit) * 100 },
      cpu: { percentage: Math.min(100, cpuPercent) },
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such container")) return null;
    return { running: false, exists: true, memory: { usage: 0, limit: 0, percentage: 0 }, cpu: { percentage: 0 } };
  }
}

export async function getContainerState(id: string): Promise<{ running: boolean; startedAt: string | null }> {
  try {
    const info = await docker.getContainer(id).inspect().catch(() => null);
    if (!info) return { running: false, startedAt: null };
    return { running: info.State.Running === true, startedAt: info.State.StartedAt || null };
  } catch {
    return { running: false, startedAt: null };
  }
}

export async function createBackup(id: string, name: string): Promise<any> {
  const volumePath = path.resolve(`volumes/${id}`);
  const backupsDir = path.resolve("backups", id);
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupUuid = randomUUID();
  const backupFileName = `${backupUuid}.tar.gz`;
  const backupPath = path.join(backupsDir, backupFileName);
  await tarCreate({
    gzip: true,
    file: backupPath,
    cwd: volumePath,
    filter: (filePath) => !filePath.includes("node_modules"),
  }, ["."]);
  const stats = fs.statSync(backupPath);
  return {
    success: true,
    message: "Backup created successfully",
    backup: {
      uuid: backupUuid,
      name,
      filePath: `backups/${id}/${backupFileName}`,
      size: stats.size,
      createdAt: new Date().toISOString(),
    },
  };
}

export async function restoreBackup(id: string, backupPath: string): Promise<void> {
  const fullBackupPath = path.resolve(backupPath);
  const volumePath = path.resolve(`volumes/${id}`);
  fs.mkdirSync(volumePath, { recursive: true });
  await tarExtract({ file: fullBackupPath, cwd: volumePath });
}
