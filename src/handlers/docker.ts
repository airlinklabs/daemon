// dockerode — no bun-native docker socket client exists, this is the best option

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Docker from 'dockerode';
import config from '../config';
import { getPaths } from '../paths';
import logger from '../logger';
import { emit } from '../ws/events';
import { normalizeConsoleCommand } from './consoleCommand';
import { createRuntime } from './containerRuntime';
import { archiveLogHistory, beginCapture } from './logHistory';

const runtime = createRuntime(config.containerRuntime);
export const docker = runtime;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

function getDockerStatusCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}
const CONSOLE_FIFO_RELATIVE_PATH = join('.airlinkd', 'console.in');
const CONSOLE_FIFO_WRITE_TIMEOUT_MS = 10_000;
const STORAGE_ENFORCE_INTERVAL_MS = 30_000;
const DOCKER_EVENT_RECONNECT_ERROR_MS = 5_000;
const DOCKER_EVENT_RECONNECT_END_MS = 2_000;
const STOP_GRACEFUL_TIMEOUT_MS = 20_000;
const STOP_GRACEFUL_POLL_MS = 500;
const STOP_FORCE_TIMEOUT_S = 5;
const PIDS_LIMIT = 256;
const BLKIO_WEIGHT = 500;
const CPU_NANO_FACTOR = 1e9;

// per-container disk quota in MB, enforced by background polling (soft cap —
// works on every storage driver, unlike Docker's overlay2-only StorageOpt)
const storageLimits = new Map<string, number>();

// Best-effort network rate limit. tc is applied inside the container netns
// (eth0) via exec — needs NET_ADMIN, which we only grant when NETWORK_RATE_MBPS
// is configured. Unthrottled containers (tc missing from the image, Podman
// hosts) are never hard-blocked — that tolerance is intentional and the
// outcome is logged truthfully below.
async function applyNetworkThrottle(id: string, mbps: number): Promise<void> {
  if (!(mbps > 0)) return;
  try {
    const container = docker.getContainer(id);
    const exec = await container.exec({
      Cmd: [
        '/bin/sh',
        '-c',
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
      logger.warn(`network throttle result unknown for ${id} (timed out waiting for exec)`);
    } else {
      // Non-zero exit means `tc` isn't present in the image or rejected the
      // qdisc — tolerated (container stays unthrottled), but not silent.
      logger.warn(`network throttle command exited with code ${exitCode} for ${id}`);
    }
  } catch (err) {
    logger.warn(`network throttle skipped for ${id}: ${getErrorMessage(err)}`);
  }
}

// Drains an exec output stream until it ends, then reads the exit code from
// the exec object. Returns null if the stream never ends within the timeout
// (a hung tc must not stall container startup forever) or if the exit code is
// still unset when we give up.
async function waitForExecExit(
  stream: unknown,
  exec: { inspect(): Promise<{ ExitCode?: number | null }> },
  id: string,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (typeof stream !== 'object' || stream === null || !('on' in stream)) return null;

  const readable = stream as NodeJS.ReadableStream;
  let settled = false;

  // The timer is the strict upper bound: it unblocks the awaiting caller even
  // if neither 'end' nor 'error' ever fires (a never-ending exec stream).
  const finished = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        logger.warn(`network throttle exec for ${id} timed out after ${timeoutMs}ms`);
      }
      resolve();
    }, timeoutMs);

    readable.resume();
    readable.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      resolve();
    });
    readable.on('error', (err: Error) => {
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
  return typeof info.ExitCode === 'number' ? info.ExitCode : null;
}

let storageEnforcementRunning = false;

function enforceStorageLimits(): void {
  if (storageEnforcementRunning) return;
  storageEnforcementRunning = true;
  try {
    for (const [id, limitMb] of storageLimits) {
      if (limitMb <= 0) continue;
      let usageMb: number;
      try {
        usageMb = getStorageUsageMb(id);
      } catch (err) {
        // the volume may have been deleted mid-walk — treat this container as
        // no longer enforceable rather than crashing the poller
        logger.warn(`storage usage check failed for ${id}: ${getErrorMessage(err)}`);
        continue;
      }
      if (usageMb <= limitMb) continue;
      const running = isContainerRunning(id);
      if (running === false) {
        storageLimits.delete(id);
        continue;
      }
      logger.warn(`container ${id} exceeded storage limit (${usageMb.toFixed(0)} MB > ${limitMb} MB), stopping`);
      emit(id, {
        type: 'error',
        message: `storage limit exceeded (${usageMb.toFixed(0)} MB of ${limitMb} MB), server stopped`,
      });
      stopContainer(id).catch((err) => {
        // A failed stop leaves an over-quota container running — surface it,
        // never pretend the limit was enforced.
        logger.error(`storage-limit stop failed for ${id}: ${getErrorMessage(err)}`);
      });
    }
  } finally {
    storageEnforcementRunning = false;
  }
}

setInterval(enforceStorageLimits, STORAGE_ENFORCE_INTERVAL_MS).unref?.();

// ── Pure function: build init.sh wrapper ────────────────────────────────────
// Generates a shell script that patches the container's identity (hostname,
// PS1 prompt) and sets up the console FIFO before launching the original
// entrypoint. This is a pure function with no I/O — easy to unit test.
export function buildInitScript(originalEntrypoint: string[], originalCmd: string[]): string {
  const quoted = (args: string[]) => args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

  let startLine: string;
  if (originalEntrypoint.length > 0) {
    startLine = `${quoted(originalEntrypoint)}${originalCmd.length > 0 ? ` ${quoted(originalCmd)}` : ''}`;
  } else if (originalCmd.length > 0) {
    startLine = quoted(originalCmd);
  } else {
    startLine = '/bin/sh';
  }

  const lines = [
    '#!/bin/sh',
    '',
    '# Patch hostname so kernel-level tools report "airlinkd"',
    "echo 'airlinkd' > /etc/hostname 2>/dev/null || true",
    'hostname airlinkd 2>/dev/null || true',
    '',
    '# Set USER/HOME so shell prompts and tools report the container user',
    '# without mutating /etc/passwd on the host image.',
    'export USER="$(id -un 2>/dev/null || echo user)"',
    'export LOGNAME="$USER"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax, not a JS template placeholder
    'export HOME="${HOME:-/home/container}"',
    '',
    '# Patch shell RC files for bash, zsh, and fish',
    'for _rc in /home/container/.bashrc /home/container/.zshrc /root/.bashrc /root/.zshrc /etc/bash.bashrc; do',
    '  if [ -f "$_rc" ]; then',
    '    sed -i \'s/petrodactyl/airlinkd/g\' "$_rc" 2>/dev/null || true',
    '    grep -q \'PS1.*airlinkd\' "$_rc" 2>/dev/null || echo \'export PS1="container@airlinkd \\\\w \\\\\\$ "\' >> "$_rc"',
    '  fi',
    'done',
    '# Fish uses a different syntax for prompts',
    'if [ -f /home/container/.config/fish/config.fish ]; then',
    "  sed -i 's/petrodactyl/airlinkd/g' /home/container/.config/fish/config.fish 2>/dev/null || true",
    'fi',
    '',
    'export PS1="container@airlinkd \\w \\$ "',
    '',
    '# Set up the console FIFO (named pipe) for command input',
    'AIRLINKD_CONSOLE_FIFO=/home/container/.airlinkd/console.in',
    'if [ ! -p "$AIRLINKD_CONSOLE_FIFO" ]; then',
    '  rm -f "$AIRLINKD_CONSOLE_FIFO"',
    '  mkfifo "$AIRLINKD_CONSOLE_FIFO"',
    'fi',
    '',
    '# Pipe FIFO output into the original entrypoint — commands written to the',
    '# FIFO by the daemon appear as stdin to the game server process',
    `while true; do cat "$AIRLINKD_CONSOLE_FIFO"; done | ${startLine}`,
  ];

  return `${lines.join('\n')}\n`;
}

// check docker/podman is installed
export async function checkDocker(): Promise<void> {
  const cmd = runtime.name === 'docker' ? 'docker' : 'podman';
  const proc = Bun.spawn([cmd, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd} is not installed or not in PATH`);
  }
}

// check docker/podman daemon is running
export async function checkDockerRunning(): Promise<void> {
  const cmd = runtime.name === 'docker' ? 'docker' : 'podman';
  const proc = Bun.spawn([cmd, 'ps', '-q'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd} is not running, start it and try again`);
  }
}

// ── Container state cache ────────────────────────────────────────────────────
// In-memory map of container ID/name → running state. Populated on startup
// from docker.listContainers() and updated in real-time via Docker event
// streaming. NOT persisted to disk — on daemon restart, the map is rebuilt
// from Docker's state. Operators should be aware that this cache is
// ephemeral and exists only in the daemon process memory.
const stateMap = new Map<string, boolean>();

// Pure transition function so state logic is unit-testable without a docker
// socket. `unknown` actions carry no reliable state signal and are ignored.
export function applyContainerEvent(stateMap: Map<string, boolean>, action: string, id: string, name?: string): void {
  switch (action) {
    case 'start':
    case 'restart':
      stateMap.set(id, true);
      if (name) stateMap.set(name, true);
      break;
    case 'create':
    case 'pause':
    case 'die':
    case 'stop':
      stateMap.set(id, false);
      if (name) stateMap.set(name, false);
      break;
    case 'destroy':
      stateMap.delete(id);
      if (name) stateMap.delete(name);
      break;
    default:
      break;
  }
}

// Pure mapping from docker.listContainers() output into the state map.
export function applyContainerList(
  stateMap: Map<string, boolean>,
  containers: Array<{ Id: string; State: string; Names?: string[] }>,
): void {
  for (const c of containers) {
    const running = c.State === 'running';
    stateMap.set(c.Id, running);
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (name) stateMap.set(name, running);
  }
}

async function syncStateFromDocker(): Promise<void> {
  try {
    const containers = await docker.listContainers({ all: true });
    stateMap.clear();
    applyContainerList(stateMap, containers);
    logger.info(`found ${containers.length} containers on boot`);
  } catch (err) {
    // Docker may be unreachable at boot — log and fall through to the event
    // stream, which resyncs the map when the connection (re)establishes.
    logger.error('could not map containers from docker', err);
  }
}

export async function initContainerStateMap(): Promise<void> {
  await syncStateFromDocker();
  await subscribeToDockerEvents();
}

async function subscribeToDockerEvents(): Promise<void> {
  try {
    const stream = await docker.getEvents({
      filters: JSON.stringify({ type: ['container'] }),
    });

    // Re-list after the stream is connected so the gap between the boot list
    // and this point is closed: any container started/stopped in between is
    // reflected here, and every reconnect re-syncs to reality.
    await syncStateFromDocker();

    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Action: string;
          id: string;
          Actor?: { Attributes?: { name?: string } };
        };
        applyContainerEvent(stateMap, event.Action, event.id, event.Actor?.Attributes?.name ?? '');
      } catch (err) {
        // Docker occasionally emits partial/garbled frames — a genuine
        // tolerance, but never a silent one.
        logger.debug(`dropped malformed docker event: ${getErrorMessage(err)}`);
      }
    });

    stream.on('error', (err: Error) => {
      logger.error('docker event stream had a bad time, reconnecting in 5s', err);
      setTimeout(subscribeToDockerEvents, DOCKER_EVENT_RECONNECT_ERROR_MS);
    });

    stream.on('end', () => {
      logger.warn('docker event stream dropped, reconnecting in 2s');
      setTimeout(subscribeToDockerEvents, DOCKER_EVENT_RECONNECT_END_MS);
    });

    logger.info('docker event stream connected');
  } catch (err) {
    logger.error('could not watch docker events, trying again in 5s', err);
    setTimeout(subscribeToDockerEvents, DOCKER_EVENT_RECONNECT_ERROR_MS);
  }
}

// null means unknown — caller can fall back to inspect()
export function isContainerRunning(id: string): boolean | null {
  return stateMap.get(id) ?? null;
}

export function setContainerRunning(id: string, running: boolean): void {
  stateMap.set(id, running);
}

// forget a container's cached state entirely (used after confirmed destroy)
function forgetContainer(id: string): void {
  stateMap.delete(id);
}

// return shape — DO NOT CHANGE THIS
// the panel parses these exact field names in its server card components
export type ContainerStats = {
  running: boolean;
  exists: boolean;
  memory: { usage: number; limit: number; percentage: number };
  cpu: { percentage: number };
  storage: { usage: number };
};

function getStorageUsageMb(id: string): number {
  const volumePath = join(getPaths(config.paths).volumesRoot, id);
  if (!existsSync(volumePath)) return 0;

  function walk(dir: string): number {
    let total = 0;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      // a symlink inside the volume (e.g. mc and/or a data dir) can point
      // outside and must not be counted toward the quota
      if (lstatSync(p).isSymbolicLink()) continue;
      if (statSync(p).isDirectory()) {
        total += walk(p);
      } else if (statSync(p).isFile()) {
        total += statSync(p).size;
      }
    }
    return total;
  }

  return walk(volumePath) / 1024 / 1024;
}

export async function getContainerStats(id: string): Promise<ContainerStats | null> {
  // Storage is a soft host-side metric gathered on demand. If the volume walk
  // trips over a transient filesystem error (a file being deleted mid-walk),
  // report usage as 0 rather than taking the whole stats endpoint down.
  let storage: { usage: number };
  try {
    storage = { usage: getStorageUsageMb(id) };
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
    // Stats collection failed but the container IS running — report the true
    // running state with zeroed resources rather than a false "stopped".
    logger.warn(`stats failed for running container ${id}: ${getErrorMessage(err)}`);
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

  // same formula docker CLI uses
  const cpuDelta =
    (stats.cpu_stats.cpu_usage.total_usage as number) - (stats.precpu_stats.cpu_usage.total_usage as number);
  const sysDelta =
    (stats.cpu_stats.system_cpu_usage as number) - ((stats.precpu_stats.system_cpu_usage as number) ?? 0);
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

// inspect-only state check — never times out waiting for stats collection
export async function getContainerState(
  id: string,
): Promise<{ running: boolean; startedAt: string | null; exitCode: number | null; status: string | null }> {
  try {
    const info = await docker.getContainer(id).inspect();
    return {
      running: info.State.Running === true,
      startedAt: info.State.StartedAt || null,
      exitCode: typeof info.State.ExitCode === 'number' ? info.State.ExitCode : null,
      status: info.State.Status || null,
    };
  } catch (err) {
    // 404 = the container is gone, reporting "not running" is correct; any
    // other error means we genuinely don't know, so log it rather than pass
    // a false "stopped" off as fact.
    if (getDockerStatusCode(err) !== 404) {
      logger.warn(`inspect failed for ${id}: ${getErrorMessage(err)}`);
    }
    return { running: false, startedAt: null, exitCode: null, status: null };
  }
}

// parse "hostPort:containerPort,hostPort:containerPort/udp" into dockerode PortBindings + ExposedPorts
export function parsePortBindings(ports: string): {
  portBindings: Record<string, [{ HostPort: string }]>;
  exposedPorts: Record<string, object>;
} {
  const portBindings: Record<string, [{ HostPort: string }]> = {};
  const exposedPorts: Record<string, object> = {};
  if (!ports?.trim()) return { portBindings, exposedPorts };

  for (const entry of ports.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [hostPort, rest] = trimmed.split(':');
    if (!rest) {
      logger.warn(`dropped invalid port binding entry (no host:container split): ${trimmed}`);
      continue;
    }

    // format: containerPort or containerPort/proto
    const [containerPort, proto = 'tcp'] = rest.split('/');
    if (!hostPort || !containerPort || Number.isNaN(Number(hostPort)) || Number.isNaN(Number(containerPort))) {
      logger.warn(`dropped invalid port binding entry: ${trimmed}`);
      continue;
    }

    const key = `${containerPort}/${proto}`;
    portBindings[key] = [{ HostPort: hostPort }];
    exposedPorts[key] = {};
  }

  return { portBindings, exposedPorts };
}

export function parseEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  const newEnv = { ...env };
  // macOS silicon needs this flag for java — on linux it's a no-op so it's harmless
  if (process.platform === 'darwin' && newEnv.START) {
    newEnv.START = newEnv.START.replace(/^(java\s+)/, '$1-XX:UseSVE=0 ');
  }
  return newEnv;
}

// creates the volume dir for a container if it doesn't exist, returns the path
export function initContainer(id: string): string {
  const volumesDir = getPaths(config.paths).volumesRoot;
  const volumePath = join(volumesDir, id);
  if (!existsSync(volumesDir)) mkdirSync(volumesDir, { recursive: true });
  if (!existsSync(volumePath)) mkdirSync(volumePath, { recursive: true });
  return volumePath;
}

// pull an image and stream progress over the events WS
export async function pullImageWithProgress(image: string, containerId: string): Promise<void> {
  logger.info('pulling container image', { image, containerId });
  emit(containerId, { type: 'pulling', message: `pulling image ${image}` });

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        emit(containerId, {
          type: 'error',
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
              type: 'error',
              message: `pull error: ${err.message}`,
            });
            reject(err);
          } else {
            emit(containerId, { type: 'pulling', message: `image ${image} is ready` });
            resolve();
          }
        },
        (event: { status: string; progress?: string; id?: string }) => {
          // don't spam the WS with every layer chunk — only send meaningful status changes
          if (event.status === 'Pull complete' || event.status === 'Already exists') {
            emit(containerId, {
              type: 'pulling',
              message: `layer ${event.id ?? ''}: ${event.status}`,
            });
          }
        },
      );
    });
  });
}

export type MountSpec = { source: string; target: string; readOnly?: boolean };

// Pure builder for the Docker HostConfig — kept separate from the I/O in
// startContainer so every limit/port/mount the panel sends can be verified
// in a unit test without a docker socket.
export function buildHostConfig(opts: {
  volumePath: string;
  portBindings: Record<string, [{ HostPort: string }]>;
  Memory: number;
  Cpu: number;
  Storage?: number;
  Swap?: number;
  mounts?: MountSpec[];
  runtimeName: string;
  networkRateMbps: number;
}): Record<string, unknown> {
  const hostConfig: Record<string, unknown> = {
    Binds: [
      `${opts.volumePath}:/home/container`,
      ...(opts.mounts ?? []).map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
    ],
    PortBindings: opts.portBindings,
    Memory: opts.Memory * 1024 * 1024, // panel sends MB, dockerode wants bytes
    MemorySwap: opts.Swap === -1 ? -1 : (opts.Memory + Math.max(0, opts.Swap ?? 0)) * 1024 * 1024,
    OomKillDisable: false,
    PidsLimit: PIDS_LIMIT,
    BlkioWeight: BLKIO_WEIGHT,
    NanoCpus: Math.floor((opts.Cpu / 100) * CPU_NANO_FACTOR), // panel sends 0-100%, dockerode wants NanoCPUs
    RestartPolicy: { Name: 'unless-stopped' },
  };

  // tc inside the container netns needs NET_ADMIN; only grant it when throttling.
  if (opts.networkRateMbps > 0 && opts.runtimeName === 'docker') {
    hostConfig.CapAdd = ['NET_ADMIN'];
  }

  // StorageOpt is overlay2-only (Docker). Podman rejects it — skip it there
  // and rely on the soft polling enforcer below.
  if ((opts.Storage ?? 0) > 0 && opts.runtimeName === 'docker') {
    hostConfig.StorageOpt = { size: `${opts.Storage}M` };
  }

  return hostConfig;
}

// start or restart a game server container
export async function startContainer(
  id: string,
  image: string,
  env: Record<string, string> = {},
  ports = '',
  Memory: number,
  Cpu: number,
  Storage = 0,
  Swap = 0,
  mounts: MountSpec[] = [],
): Promise<void> {
  logger.info('starting container', { containerId: id, image });
  emit(id, { type: 'pulling', message: `cleaning up any old ${id} container first` });

  // force-remove any existing container with this name before creating a new one.
  // A non-404 failure here means we can't guarantee a clean start (a stale
  // container of the same name would make createContainer conflict) — fail loudly.
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404) {
      throw new Error(`failed to remove existing container ${id}: ${getErrorMessage(err)}`);
    }
  }

  const volumePath = initContainer(id);
  const { portBindings, exposedPorts } = parsePortBindings(ports);
  const modifiedEnv = parseEnvironmentVariables(env);

  const portSummary = Object.entries(portBindings)
    .map(([container, host]) => `${host[0].HostPort} -> ${container}`)
    .join(', ');
  if (portSummary) emit(id, { type: 'pulling', message: `port bindings: ${portSummary}` });

  // check if image is already local before pulling. A 404 means "not present,
  // pull it". Any other error means docker itself is unhappy — log it and still
  // attempt the pull, which will surface the real failure loudly.
  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch (err) {
    if (getDockerStatusCode(err) !== 404) {
      logger.warn(`could not inspect image ${image}: ${getErrorMessage(err)} — will attempt pull`);
    }
    imageExists = false;
    emit(id, {
      type: 'pulling',
      message: `image not found locally, pulling from registry`,
    });
  }

  if (!imageExists) {
    await pullImageWithProgress(image, id);
  }

  emit(id, { type: 'creating', message: `creating ${id}` });

  // pre-write eula=true so minecraft servers don't exit on first boot
  const eulaPath = join(volumePath, 'eula.txt');
  if (!existsSync(eulaPath) || !readFileSync(eulaPath, 'utf8').includes('eula=true')) {
    writeFileSync(eulaPath, '#By installing Minecraft you agree to the EULA\neula=true\n', 'utf8');
  }

  // write a wrapper script that patches /etc/hostname and /etc/passwd before
  // handing off to the original image entrypoint. belt-and-braces approach:
  // docker's Hostname field covers the kernel hostname, the script covers
  // shells that read /etc/hostname or run whoami.
  const imageInspect = await docker
    .getImage(image)
    .inspect()
    .catch((err: unknown) => {
      // An image we just verified/pulled failing to inspect is anomalous — a
      // wrong entrypoint would start a broken server, so surface it.
      logger.error(`could not inspect image ${image} for entrypoint: ${getErrorMessage(err)}`);
      return null;
    });
  const rawEntrypoint = imageInspect?.Config?.Entrypoint ?? [];
  const rawCmd = imageInspect?.Config?.Cmd ?? [];
  const originalEntrypoint: string[] = Array.isArray(rawEntrypoint) ? rawEntrypoint : [rawEntrypoint];
  const originalCmd: string[] = Array.isArray(rawCmd) ? rawCmd : [rawCmd];

  const airlinkdDir = join(volumePath, '.airlinkd');
  if (!existsSync(airlinkdDir)) mkdirSync(airlinkdDir, { recursive: true });

  const initScript = buildInitScript(originalEntrypoint, originalCmd);
  writeFileSync(join(airlinkdDir, 'init.sh'), initScript, {
    mode: 0o755,
    encoding: 'utf8',
  });

  modifiedEnv.PS1 = 'container@airlinkd \\w \\$ ';
  modifiedEnv.PROMPT = 'container@airlinkd \\w \\$ ';
  modifiedEnv.prompt = 'container@airlinkd \\w \\$ ';

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
    Hostname: 'airlinkd',
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    Entrypoint: ['/bin/sh', '/home/container/.airlinkd/init.sh'],
    WorkingDir: '/home/container',
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    OpenStdin: true,
    Tty: true,
  });

  emit(id, { type: 'starting', message: `starting ${id}` });
  try {
    await container.start();
  } catch (err) {
    // The container object exists but never reached "running" — record that
    // explicitly so the cache can't report a phantom running container.
    setContainerRunning(id, false);
    throw err;
  }
  setContainerRunning(id, true);
  if (config.networkRateMbps > 0) await applyNetworkThrottle(id, config.networkRateMbps);
  // A restart may lower or drop the disk quota — always reconcile the enforced
  // set, otherwise a previously-limited container keeps its old (stale) cap.
  if (Storage > 0) storageLimits.set(id, Storage);
  else storageLimits.delete(id);
  emit(id, { type: 'started', message: 'server started' });
  try {
    beginCapture(id);
  } catch (err) {
    logger.warn(`log capture init failed for ${id}: ${getErrorMessage(err)}`);
  }
}

// run an installer container that mounts the volume, runs a script, then exits
export async function createInstaller(
  id: string,
  image: string,
  script: string,
  env: Record<string, string> = {},
  entrypoint = 'bash',
): Promise<void> {
  // force-remove any leftover installer container
  try {
    await docker.getContainer(`installer_${id}`).remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404) {
      logger.warn(`could not remove existing installer container for ${id}: ${getErrorMessage(err)}`);
    }
  }

  const volumePath = initContainer(id);
  const modifiedEnv = parseEnvironmentVariables(env);

  emit(id, { type: 'installing', message: 'preparing installer' });

  let imageExists = false;
  try {
    await docker.getImage(image).inspect();
    imageExists = true;
  } catch (err) {
    if (getDockerStatusCode(err) !== 404) {
      logger.warn(`could not inspect installer image ${image}: ${getErrorMessage(err)} — will attempt pull`);
    }
    imageExists = false;
  }

  if (!imageExists) {
    emit(id, {
      type: 'installing',
      message: `pulling installer image: ${image}`,
    });
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) return reject(new Error(`failed to pull installer image: ${err.message}`));
        resolve();
      });
    });
  }

  emit(id, { type: 'installing', message: 'running install script' });

  const container = await docker.createContainer({
    name: `installer_${id}`,
    Image: image,
    Entrypoint: [entrypoint, '-c', script.replace(/\r\n/g, '\n').replace(/\r/g, '\n')],
    Env: Object.entries(modifiedEnv).map(([k, v]) => `${k}=${v}`),
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${volumePath}:/mnt/server`],
      AutoRemove: false,
      NetworkMode: 'host',
    },
  });

  // attach before start — guarantees we capture output from the first byte
  const attachStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const installerLines: string[] = [];

  // docker non-TTY attach uses an 8-byte mux header per frame
  // parse frame by frame — multiple frames can arrive in one data event
  const logDone = new Promise<void>((resolve) => {
    let buf = Buffer.alloc(0);

    attachStream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const frameSize = buf.readUInt32BE(4);
        if (buf.length < 8 + frameSize) break;
        const payload = buf.slice(8, 8 + frameSize).toString('utf8');
        buf = buf.slice(8 + frameSize);
        for (const line of payload.split('\n')) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping ANSI control bytes
          const clean = line.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
          if (clean) {
            installerLines.push(clean);
            emit(id, { type: 'installing', message: clean });
          }
        }
      }
    });

    attachStream.on('end', resolve);
    attachStream.on('error', resolve);
  });

  await container.start();

  const [result] = await Promise.all([container.wait(), logDone]);

  if (result.StatusCode !== 0) {
    logger.warn(`installer for ${id} exited with code ${result.StatusCode}`);
    for (const l of installerLines.slice(-20)) logger.warn(`  ${l}`);
    // best-effort cleanup: a leftover installer container is cosmetic and must
    // not mask the install failure that follows
    await container.remove({ force: true }).catch((err) => {
      logger.warn(`could not remove failed installer container for ${id}: ${getErrorMessage(err)}`);
    });
    throw new Error(`install script failed with exit code ${result.StatusCode}`);
  }

  emit(id, { type: 'installed', message: 'installation complete' });
  // best-effort cleanup: the server container that follows gets a fresh name,
  // so a stuck installer container is cosmetic, not fatal
  await container.remove({ force: true }).catch((err) => {
    logger.warn(`could not remove installer container for ${id}: ${getErrorMessage(err)}`);
  });
}

export async function stopContainer(id: string, stopCmd?: string): Promise<void> {
  const container = docker.getContainer(id);

  // 404 = the container is already gone, so there is nothing to stop — a real
  // toleration. Any other inspect failure means we cannot confirm whether it is
  // running; reporting a successful stop from that would be a lie, so surface it.
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (err) {
    if (getDockerStatusCode(err) === 404) return;
    throw new Error(`could not inspect container ${id} for stop: ${getErrorMessage(err)}`);
  }
  if (!info.State.Running) {
    setContainerRunning(id, false);
    return;
  }

  emit(id, { type: 'stopping', message: 'stopping server' });

  // send the game-specific stop command first (e.g. "stop" for minecraft)
  if (stopCmd && stopCmd !== 'kill') {
    try {
      await sendCommandToContainer(id, stopCmd);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.warn(`failed to send stop command to ${id}: ${err}`);
    }

    // wait up to 20s for the process to exit on its own
    const deadline = Date.now() + STOP_GRACEFUL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STOP_GRACEFUL_POLL_MS));
      try {
        const current = await container.inspect();
        if (!current.State.Running) {
          // confirmed stopped via inspect — the cache may only report false
          // once it is actually false
          setContainerRunning(id, false);
          await archiveLogHistory(id).catch((err) => {
            logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
          });
          emit(id, { type: 'stopped', message: 'server stopped' });
          return;
        }
      } catch (err) {
        // 404 = it exited and was removed between polls — the stop intent is
        // satisfied. Any other error is a transient daemon hiccup; keep polling
        // until the deadline rather than guessing.
        if (getDockerStatusCode(err) === 404) {
          setContainerRunning(id, false);
          await archiveLogHistory(id).catch((err) => {
            logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
          });
          emit(id, { type: 'stopped', message: 'server stopped' });
          return;
        }
        logger.warn(`stop poll inspect failed for ${id}: ${getErrorMessage(err)}`);
      }
    }
  }

  // process didn't exit cleanly — force it
  try {
    await container.stop({ t: STOP_FORCE_TIMEOUT_S });
  } catch (err: unknown) {
    const status = getDockerStatusCode(err);
    if (status !== 304 && status !== 404) {
      logger.warn(`container.stop() for ${id}: ${getErrorMessage(err)}`);
    }
  }

  try {
    await container.remove({ force: true });
  } catch (err: unknown) {
    if (getDockerStatusCode(err) !== 404) {
      logger.warn(`container.remove() after stop for ${id}: ${getErrorMessage(err)}`);
    }
  }

  setContainerRunning(id, false);
  await archiveLogHistory(id).catch((err) => {
    logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
  });
  emit(id, { type: 'stopped', message: 'server stopped' });
}
export async function killContainer(id: string): Promise<void> {
  storageLimits.delete(id);
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    // 404 = the container was already gone — the kill intent is satisfied and
    // the container can no longer be running, so this is a real tolerance. Any
    // other error means it may still exist; report it rather than emitting a
    // fake "killed".
    if (getDockerStatusCode(err) !== 404) {
      throw new Error(`failed to kill container ${id}: ${getErrorMessage(err)}`);
    }
  }
  forgetContainer(id);
  setContainerRunning(id, false);
  await archiveLogHistory(id).catch((err) => {
    logger.warn(`could not archive logs for ${id}: ${getErrorMessage(err)}`);
  });
  emit(id, { type: 'killed', message: 'container forcibly removed' });
}

export async function deleteContainer(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch (err: unknown) {
    // Same 404 tolerance as kill: an already-gone container is not a delete
    // failure. Anything else means a container may still exist — the caller
    // (delete + wipe volume, or reinstall) must NOT proceed as if it succeeded.
    if (getDockerStatusCode(err) !== 404) {
      throw new Error(`failed to delete container ${id}: ${getErrorMessage(err)}`);
    }
  }
  forgetContainer(id);
}

export async function deleteContainerAndVolume(id: string): Promise<void> {
  storageLimits.delete(id);
  await deleteContainer(id);
  const volumePath = join(getPaths(config.paths).volumesRoot, id);
  if (existsSync(volumePath)) {
    rmSync(volumePath, { recursive: true, force: true });
  }
}

async function writeCommandToConsoleFifo(id: string, command: string): Promise<void> {
  const fifoPath = join(getPaths(config.paths).volumesRoot, id, CONSOLE_FIFO_RELATIVE_PATH);
  if (!existsSync(fifoPath) || !statSync(fifoPath).isFIFO()) {
    throw new Error(
      `console command FIFO is not ready for container ${id}; restart the container with the current daemon`,
    );
  }

  const proc = Bun.spawn(['sh', '-c', 'printf "%s\\n" "$1" > "$2"', 'airlinkd-console-command', command, fifoPath], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, CONSOLE_FIFO_WRITE_TIMEOUT_MS);

  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // stderr is read purely to enrich the error message; if the read fails we
      // still have the exit code, so an empty detail string is a fine fallback
      const stderr = await new Response(proc.stderr).text().catch(() => '');
      throw new Error(`console FIFO write exited with code ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendCommandToContainer(id: string, command: string): Promise<void> {
  try {
    const container = docker.getContainer(id);

    // 404 genuinely means "not running / gone"; any other inspect failure is a
    // real lookup error and must not be disguised as a "not running" message.
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err) {
      if (getDockerStatusCode(err) === 404) {
        throw new Error(`container ${id} is not running`);
      }
      throw new Error(`could not inspect container ${id}: ${getErrorMessage(err)}`);
    }
    if (!info.State.Running) {
      throw new Error(`container ${id} is not running`);
    }

    const cleanedCommand = normalizeConsoleCommand(command);
    if (!cleanedCommand) {
      throw new Error(`empty command ignored for container ${id}`);
    }

    await writeCommandToConsoleFifo(id, cleanedCommand);
  } catch (error) {
    logger.error(`failed to send command to container ${id}`, error);
    throw error;
  }
}
