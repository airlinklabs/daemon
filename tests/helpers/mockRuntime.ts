/**
 * Mock Container Runtime for Daemon Tests (Phase 9)
 *
 * Provides a fake container runtime that doesn't require Docker/Podman.
 * Useful for testing container lifecycle logic without actual container operations.
 */
import type { ContainerRuntime, RuntimeCapabilities } from '../../src/handlers/containerRuntime';

export interface MockContainer {
  id: string;
  name: string;
  image: string;
  state: 'created' | 'running' | 'paused' | 'stopped' | 'deleted';
  ports: Record<string, string>;
  env: Record<string, string>;
  labels: Record<string, string>;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
}

export class MockContainerRuntime implements ContainerRuntime {
  readonly name: 'docker' | 'podman' = 'docker';
  private containers: Map<string, MockContainer> = new Map();
  private _capabilities: RuntimeCapabilities;

  constructor() {
    this._capabilities = {
      version: 1,
      runtime: 'docker',
      apiVersion: '1.41',
      rootless: false,
      socketValid: true,
      socketPath: '/var/run/docker.sock',
      cgroupVersion: 2,
      storageDriver: 'overlay2',
      limits: {
        memory: { enforced: true, enforcement: 'enforced' },
        cpu: { enforced: true, enforcement: 'enforced' },
        pids: { enforced: true, enforcement: 'enforced' },
        swap: { enforced: true, enforcement: 'enforced' },
        storage: { enforced: false, enforcement: 'advisory' },
        networkRate: { enforced: false, enforcement: 'advisory' },
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
  }

  get socketPath(): string {
    return '/var/run/docker.sock';
  }

  getContainer(id: string) {
    return {
      id,
      inspect: async () => ({
        Id: id,
        State: { Running: true },
        NetworkSettings: { Ports: {} },
      }),
      start: async () => {},
      stop: async () => {},
      kill: async () => {},
      remove: async () => {},
      logs: async () => '',
      exec: async () => ({ start: async () => {}, resize: async () => {} }),
    } as any;
  }

  async listContainers() {
    return Array.from(this.containers.values()).map((c) => ({
      Id: c.id,
      Names: [`/${c.name}`],
      Image: c.image,
      State: c.state,
      Status: c.state,
      Ports: [],
      Created: c.createdAt,
      Labels: c.labels,
    })) as any[];
  }

  async getEvents() {
    return {
      on: () => {},
      pipe: () => {},
      read: () => null,
    } as any;
  }

  async pull() {
    return {
      on: () => {},
      pipe: () => {},
    } as any;
  }

  async createContainer(opts: any) {
    const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const container: MockContainer = {
      id,
      name: opts.name || id,
      image: opts.Image || 'unknown',
      state: 'created',
      ports: {},
      env: {},
      labels: opts.Labels || {},
      createdAt: Math.floor(Date.now() / 1000),
    };

    this.containers.set(id, container);
    return this.getContainer(id);
  }

  getImage(name: string) {
    return {
      name,
      inspect: async () => ({ Id: name, RepoTags: [name] }),
      remove: async () => {},
    } as any;
  }

  get modem() {
    return {
      dialProgress: async () => {},
      dial: async () => {},
      fetch: async () => new Response(),
    } as any;
  }

  capabilities(): RuntimeCapabilities {
    return this._capabilities;
  }

  async ping(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  // ── Test Helpers ─────────────────────────────────────────────────────────

  /** Add a mock container for testing */
  addContainer(container: MockContainer): void {
    this.containers.set(container.id, container);
  }

  /** Get a mock container by ID */
  getMockContainer(id: string): MockContainer | undefined {
    return this.containers.get(id);
  }

  /** Clear all mock containers */
  clearContainers(): void {
    this.containers.clear();
  }
}

/**
 * Mock Podman Runtime — simulates Podman-specific behavior:
 * - Strips StorageOpt from create options
 * - Filters NET_ADMIN capability in rootless mode
 * - Reports Podman capability profile
 */
export class MockPodmanRuntime extends MockContainerRuntime {
  override readonly name: 'podman' = 'podman';
  private _isRootless: boolean;
  /** Tracks the last createContainer opts after Podman transformations */
  lastCreateOpts: any = null;

  constructor(rootless: boolean = false) {
    super();
    this._isRootless = rootless;
  }

  override get socketPath(): string {
    return this._isRootless
      ? `/run/user/1000/podman/podman.sock`
      : '/run/podman/podman.sock';
  }

  override capabilities(): RuntimeCapabilities {
    const base = super.capabilities();
    return {
      ...base,
      runtime: 'podman',
      rootless: this._isRootless,
      socketPath: this.socketPath,
      storageDriver: 'overlay',
      limits: {
        ...base.limits,
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
          reason: 'Podman uses --oom-score-adj instead of --oom-kill-disable',
        },
      },
    };
  }

  override async createContainer(opts: any) {
    // Simulate Podman behavior: strip StorageOpt
    if (opts.HostConfig?.StorageOpt) {
      const { StorageOpt, ...restHostConfig } = opts.HostConfig;
      opts = { ...opts, HostConfig: restHostConfig };
    }

    // Simulate Podman rootless: strip NET_ADMIN
    if (this._isRootless && opts.HostConfig?.CapAdd) {
      const filtered = opts.HostConfig.CapAdd.filter((c: string) => c !== 'NET_ADMIN');
      if (filtered.length !== opts.HostConfig.CapAdd.length) {
        opts = {
          ...opts,
          HostConfig: { ...opts.HostConfig, CapAdd: filtered },
        };
      }
    }

    this.lastCreateOpts = opts;
    return super.createContainer(opts);
  }
}

/**
 * Mock HMAC verification for tests.
 * Returns null (valid) or error response.
 */
export function createMockHmacVerifier() {
  return async (req: Request, key: string, routeKey: string): Promise<Response | null> => {
    // In tests, we can either:
    // 1. Always return null (valid) for speed
    // 2. Actually verify signatures for contract tests

    const tsHeader = req.headers.get('x-airlink-timestamp');
    const sigHeader = req.headers.get('x-airlink-signature');
    const versionHeader = req.headers.get('x-airlink-payload-version');

    // Basic validation
    if (!tsHeader || !sigHeader) {
      return new Response(
        JSON.stringify({ error: 'missing HMAC headers', code: 'missing_hmac_headers' }),
        { status: 401 },
      );
    }

    if (versionHeader !== '1') {
      return new Response(
        JSON.stringify({ error: 'unsupported HMAC payload version', code: 'invalid_payload_version' }),
        { status: 401 },
      );
    }

    return null; // valid
  };
}
