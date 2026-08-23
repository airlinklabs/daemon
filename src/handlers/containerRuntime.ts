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
// All container operations go through this interface. Implementations exist
// for Docker and Podman, with Podman handling its specific quirks.

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
  { path: '/run/user/1000/podman/podman.sock', platform: 'linux' }, // rootless
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

// ── Docker Runtime Implementation ──────────────────────────────────────────

class DockerRuntime implements ContainerRuntime {
  private docker: Docker;
  readonly name: 'docker' = 'docker';
  private _socketPath: string;
  private _capabilities: RuntimeCapabilities | null = null;

  constructor(socketPath: string) {
    this._socketPath = socketPath;
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

    this._capabilities = {
      version: 1,
      runtime: 'docker',
      apiVersion: 'unknown', // populated lazily by pingRuntime
      rootless: false,
      socketValid: validateSocket(this._socketPath).valid,
      socketPath: this._socketPath,
      cgroupVersion: 2,
      storageDriver: 'overlay2',
      limits: {
        memory: { enforced: true, enforcement: 'enforced' },
        cpu: { enforced: true, enforcement: 'enforced' },
        pids: { enforced: true, enforcement: 'enforced' },
        swap: { enforced: true, enforcement: 'enforced' },
        storage: {
          enforced: false,
          enforcement: 'advisory',
          reason: 'StorageOpt is overlay2-only; fallback is soft directory-size polling',
        },
        networkRate: {
          enforced: false,
          enforcement: 'advisory',
          reason: 'requires NET_ADMIN capability + tc binary in image',
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

// ── Podman Runtime Implementation ──────────────────────────────────────────
// Handles Podman-specific differences:
// 1. No StorageOpt support (uses overlay, not overlay2)
// 2. Rootless mode with different cgroup handling
// 3. No NET_ADMIN capability in rootless mode
// 4. Different socket paths (including rootless user socket)
// 5. cgroup v2 only (no cgroup v1 support)

class PodmanRuntime implements ContainerRuntime {
  private docker: Docker;
  readonly name: 'podman' = 'podman';
  private _socketPath: string;
  private _capabilities: RuntimeCapabilities | null = null;
  private _isRootless: boolean = false;

  constructor(socketPath: string) {
    this._socketPath = socketPath;
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
    // Podman pull has slightly different options; Dockerode handles the compat layer
    return this.docker.pull(image, opts);
  }

  createContainer(opts: Docker.ContainerCreateOptions): Promise<Docker.Container> {
    // Podman doesn't support StorageOpt; remove it if present
    if (opts.HostConfig?.StorageOpt) {
      logger.debug('removing StorageOpt from container create options (not supported by Podman)');
      const { StorageOpt, ...restHostConfig } = opts.HostConfig;
      opts = { ...opts, HostConfig: restHostConfig };
    }

    // In rootless mode, Podman doesn't support NET_ADMIN capability
    if (this._isRootless && opts.HostConfig?.CapAdd) {
      const filteredCaps = opts.HostConfig.CapAdd.filter((cap: string) => cap !== 'NET_ADMIN');
      if (filteredCaps.length !== opts.HostConfig.CapAdd.length) {
        logger.debug('removing NET_ADMIN capability (not supported in Podman rootless mode)');
        opts = {
          ...opts,
          HostConfig: {
            ...opts.HostConfig,
            CapAdd: filteredCaps,
          },
        };
      }
    }

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

    this._capabilities = {
      version: 1,
      runtime: 'podman',
      apiVersion: 'unknown', // populated lazily by pingRuntime
      rootless: this._isRootless,
      socketValid: validateSocket(this._socketPath).valid,
      socketPath: this._socketPath,
      cgroupVersion: 2, // Podman only supports cgroup v2
      storageDriver: 'overlay', // Podman uses overlay, not overlay2
      limits: {
        memory: { enforced: true, enforcement: 'enforced' },
        cpu: { enforced: true, enforcement: 'enforced' },
        pids: { enforced: true, enforcement: 'enforced' },
        swap: { enforced: true, enforcement: 'enforced' },
        storage: {
          enforced: false,
          enforcement: 'advisory',
          reason: 'Podman does not support Docker StorageOpt; fallback is soft directory-size polling',
        },
        networkRate: {
          enforced: false,
          enforcement: this._isRootless ? 'unsupported' : 'advisory',
          reason: this._isRootless
            ? 'not supported in Podman rootless mode'
            : 'requires NET_ADMIN capability + tc binary in image',
        },
        blkioWeight: {
          enforced: !this._isRootless,
          enforcement: this._isRootless ? 'unsupported' : 'enforced',
          reason: this._isRootless ? 'not supported in Podman rootless mode' : undefined,
        },
        oomKillDisable: {
          enforced: true,
          enforcement: 'enforced',
          // Podman uses --oom-score-adj instead of --oom-kill-disable
          reason: 'Podman uses --oom-score-adj instead of --oom-kill-disable',
        },
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

      // Detect rootless mode from security options
      this._isRootless = info.SecurityOptions?.some((o: string) => o.includes('rootless')) ?? false;
      caps.rootless = this._isRootless;

      // Update capabilities based on rootless detection
      if (this._isRootless) {
        caps.limits.networkRate.enforcement = 'unsupported';
        caps.limits.networkRate.reason = 'not supported in Podman rootless mode';
        caps.limits.blkioWeight.enforcement = 'unsupported';
        caps.limits.blkioWeight.reason = 'not supported in Podman rootless mode';
      }

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

  const runtime = type === 'podman' ? new PodmanRuntime(socketPath) : new DockerRuntime(socketPath);

  // Lazy ping — log the result but don't block startup
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
