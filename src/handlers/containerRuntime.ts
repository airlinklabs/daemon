import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Docker from 'dockerode';
import logger from '../logger';

// Capability types shared by all runtimes. The panel reads these to decide
// which limits to show and which to grey out with an explanation.

export type Enforcement = 'enforced' | 'advisory' | 'unsupported';

export interface LimitCapability {
  enforced: boolean;
  enforcement: Enforcement;
  reason?: string;
}

export interface RuntimeCapabilities {
  version: number;
  runtime: 'docker' | 'podman';
  apiVersion: string;
  rootless: boolean;
  socketValid: boolean;
  socketPath: string;
  cgroupVersion: number;
  storageDriver: string;
  limits: {
    memory: LimitCapability;
    cpu: LimitCapability;
    pids: LimitCapability;
    swap: LimitCapability;
    storage: LimitCapability;
    networkRate: LimitCapability;
    blkioWeight: LimitCapability;
    oomKillDisable: LimitCapability;
  };
  operations: {
    pull: boolean;
    create: boolean;
    start: boolean;
    stop: boolean;
    kill: boolean;
    delete: boolean;
    exec: boolean;
    logs: boolean;
    events: boolean;
    stats: boolean;
    ports: boolean;
    mounts: boolean;
  };
}

// Every container operation goes through this interface. Docker and Podman each
// implement it, with Podman handling its own quirks around rootless mode,
// missing StorageOpt, and different capability enforcement.

export interface ContainerRuntime {
  name: string;
  getContainer(id: string): Docker.Container;
  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream>;
  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream>;
  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container>;
  getImage(name: string): Docker.Image;
  modem: Docker['modem'];
  capabilities(): RuntimeCapabilities;
  ping(): Promise<{ ok: boolean; error?: string }>;
}

// ── Shared utilities ─────────────────────────────────────────────────────────

interface EndpointCandidate {
  path: string;
  platform?: string;
}

/** Check that a socket file exists, is actually a socket, and is reachable. */
export function validateSocket(socketPath: string): { valid: boolean; reason?: string } {
  try {
    if (!existsSync(socketPath)) return { valid: false, reason: `socket not found: ${socketPath}` };
    const st = statSync(socketPath);
    const isSocket = (st.mode & 0o170000) === 0o140000; // S_IFSOCK
    if (!isSocket) return { valid: false, reason: `not a socket: ${socketPath}` };
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `socket check failed: ${err}` };
  }
}

/** Resolve the rootless Podman socket path from $XDG_RUNTIME_DIR or uid fallback. */
export function rootlessPodmanSocket(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, 'podman', 'podman.sock');
  const uid = process.getuid?.();
  if (uid !== undefined && uid >= 0) return `/run/user/${uid}/podman/podman.sock`;
  return '/run/user/1000/podman/podman.sock';
}

/** Detect cgroup version (1 or 2) from the host filesystem. */
export function detectCgroupVersion(): number {
  try {
    return existsSync('/sys/fs/cgroup/cgroup.controllers') ? 2 : 1;
  } catch {
    return 2;
  }
}

// ── Endpoint selection ───────────────────────────────────────────────────────

const DOCKER_ENDPOINTS: EndpointCandidate[] = [
  { path: '/var/run/docker.sock', platform: 'linux' },
  { path: '//./pipe/docker_engine', platform: 'win32' },
];

const PODMAN_ENDPOINTS: EndpointCandidate[] = [
  { path: '/run/podman/podman.sock', platform: 'linux' },
  { path: rootlessPodmanSocket(), platform: 'linux' },
];

function selectEndpoint(runtime: 'docker' | 'podman'): string {
  const candidates = runtime === 'docker' ? DOCKER_ENDPOINTS : PODMAN_ENDPOINTS;
  for (const c of candidates) {
    if (c.platform && c.platform !== process.platform) continue;
    const result = validateSocket(c.path);
    if (result.valid) return c.path;
    if (result.reason) logger.warn(`runtime endpoint rejected: ${result.reason}`);
  }
  return runtime === 'docker' ? '/var/run/docker.sock' : '/run/podman/podman.sock';
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRuntime(type: 'docker' | 'podman' = 'docker'): ContainerRuntime {
  const socketPath = selectEndpoint(type);
  const socketCheck = validateSocket(socketPath);

  if (!socketCheck.valid) {
    logger.warn(`runtime endpoint validation failed: ${socketCheck.reason} — runtime may not be ready`);
  }

  logger.info('container runtime initialized', { runtime: type, socketPath, socketValid: socketCheck.valid });

  // Lazy imports to avoid circular dependencies. Both modules import types
  // from this file, so they can't be imported at the top level.
  let runtime: ContainerRuntime;
  if (type === 'podman') {
    const { PodmanRuntime } = require('./podmanRuntime') as typeof import('./podmanRuntime');
    runtime = new PodmanRuntime(socketPath);
  } else {
    const { DockerRuntime } = require('./dockerRuntime') as typeof import('./dockerRuntime');
    runtime = new DockerRuntime(socketPath);
  }

  runtime.ping().then((result) => {
    if (result.ok) {
      logger.info('runtime ping succeeded', {
        runtime: type,
        apiVersion: runtime.capabilities().apiVersion,
        rootless: runtime.capabilities().rootless,
      });
    } else {
      logger.warn('runtime ping failed', { runtime: type, error: result.error });
    }
  });

  return runtime;
}
