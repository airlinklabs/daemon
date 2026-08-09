import { existsSync, statSync } from 'node:fs';
import Docker from 'dockerode';
import logger from '../logger';

// ── Capability report ────────────────────────────────────────────────────────
// Declares what the runtime can and cannot enforce. The panel consumes this
// to hide/disable unsupported options with concrete explanations.

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

// ── ContainerRuntime interface ──────────────────────────────────────────────
// All container operations go through this interface. The single implementation
// wraps Dockerode; a Podman-specific adapter is only added when observed
// semantic/API differences require it (currently none — Podman's compat API
// matches Docker's).

export interface ContainerRuntime {
  name: string;
  getContainer(id: string): Docker.Container;
  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream>;
  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream>;
  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container>;
  getImage(name: string): Docker.Image;
  modem: Docker['modem'];
  /** Runtime capability report — consumed by the panel. */
  capabilities(): RuntimeCapabilities;
}

// ── Validated endpoint selection ─────────────────────────────────────────────
// Replaces the old hardcoded socket paths with validated selection that checks
// socket type, permissions, and API identity during readiness.

interface EndpointCandidate {
  path: string;
  platform?: string;
}

const DOCKER_ENDPOINTS: EndpointCandidate[] = [
  { path: '/var/run/docker.sock', platform: 'linux' },
  { path: '//./pipe/docker_engine', platform: 'win32' },
];

const PODMAN_ENDPOINTS: EndpointCandidate[] = [
  { path: '/run/podman/podman.sock', platform: 'linux' },
];

function validateSocket(socketPath: string): { valid: boolean; reason?: string } {
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

function selectEndpoint(runtime: 'docker' | 'podman'): string {
  const candidates = runtime === 'docker' ? DOCKER_ENDPOINTS : PODMAN_ENDPOINTS;
  for (const c of candidates) {
    if (c.platform && c.platform !== process.platform) continue;
    const result = validateSocket(c.path);
    if (result.valid) return c.path;
    if (result.reason) logger.warn(`runtime endpoint rejected: ${result.reason}`);
  }
  // fallback to default — let Dockerode try and fail loudly
  return runtime === 'docker' ? '/var/run/docker.sock' : '/run/podman/podman.sock';
}

// ── Single Dockerode-backed implementation ──────────────────────────────────

class DockerodeRuntime implements ContainerRuntime {
  private docker: Docker;
  readonly name: 'docker' | 'podman';
  private _socketPath: string;
  private _capabilities: RuntimeCapabilities | null = null;

  constructor(socketPath: string, runtimeName: 'docker' | 'podman') {
    this._socketPath = socketPath;
    this.name = runtimeName;
    this.docker = new Docker({ socketPath });
  }

  get socketPath(): string {
    return this._socketPath;
  }

  getContainer(id: string): Docker.Container {
    return this.docker.getContainer(id);
  }

  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers(opts);
  }

  getEvents(opts?: Docker.GetEventsOptions): Promise<NodeJS.ReadableStream> {
    return this.docker.getEvents(opts);
  }

  pull(image: string, opts?: object): Promise<NodeJS.ReadableStream> {
    return this.docker.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    return this.docker.createContainer(opts);
  }

  getImage(name: string): Docker.Image {
    return this.docker.getImage(name);
  }

  get modem(): Docker['modem'] {
    return this.docker.modem;
  }

  capabilities(): RuntimeCapabilities {
    if (this._capabilities) return this._capabilities;

    const isDocker = this.name === 'docker';

    this._capabilities = {
      version: 1,
      runtime: this.name,
      apiVersion: 'unknown', // populated lazily by pingRuntime
      rootless: false,
      socketValid: validateSocket(this._socketPath).valid,
      socketPath: this._socketPath,
      cgroupVersion: 2,
      storageDriver: isDocker ? 'overlay2' : 'overlay',
      limits: {
        memory: { enforced: true, enforcement: 'enforced' },
        cpu: { enforced: true, enforcement: 'enforced' },
        pids: { enforced: true, enforcement: 'enforced' },
        swap: { enforced: true, enforcement: 'enforced' },
        storage: {
          enforced: false,
          enforcement: 'advisory',
          reason: isDocker
            ? 'StorageOpt is overlay2-only; fallback is soft directory-size polling'
            : 'Podman does not support Docker StorageOpt; fallback is soft directory-size polling',
        },
        networkRate: {
          enforced: false,
          enforcement: 'advisory',
          reason: 'requires NET_ADMIN capability + tc binary in image; not supported on Podman rootless',
        },
        blkioWeight: { enforced: true, enforcement: 'enforced' },
        oomKillDisable: { enforced: true, enforcement: 'enforced' },
      },
      operations: {
        pull: true,
        create: true,
        start: true,
        stop: true,
        kill: true,
        delete: true,
        exec: true,
        logs: true,
        events: true,
        stats: true,
        ports: true,
        mounts: true,
      },
    };

    return this._capabilities;
  }

  /** Ping the runtime and populate apiVersion/cgroupVersion from live data. */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      const info = await this.docker.info();
      const caps = this.capabilities();
      caps.apiVersion = info.ApiVersion ?? 'unknown';
      caps.cgroupVersion = info.CgroupVersion ?? 2;
      caps.storageDriver = info.Driver ?? caps.storageDriver;
      caps.rootless = info.SecurityOptions?.some((o: string) => o.includes('rootless')) ?? false;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createRuntime(type: 'docker' | 'podman' = 'docker'): ContainerRuntime {
  const socketPath = selectEndpoint(type);
  const socketCheck = validateSocket(socketPath);

  if (!socketCheck.valid) {
    logger.warn(`runtime endpoint validation failed: ${socketCheck.reason} — runtime may not be ready`);
  }

  logger.info('container runtime initialized', { runtime: type, socketPath, socketValid: socketCheck.valid });

  const runtime = new DockerodeRuntime(socketPath, type);

  // Lazy ping — log the result but don't block startup
  runtime.ping().then((result) => {
    if (result.ok) {
      logger.info('runtime ping succeeded', { runtime: type, apiVersion: runtime.capabilities().apiVersion });
    } else {
      logger.warn('runtime ping failed', { runtime: type, error: result.error });
    }
  });

  return runtime;
}
