import Docker from 'dockerode';
import type { ContainerRuntime, RuntimeCapabilities } from './containerRuntime';
import { detectCgroupVersion, validateSocket } from './containerRuntime';

// Docker runtime wraps the Docker Engine API. Straightforward pass-through
// since Docker's API is the reference implementation Dockerode targets.

export class DockerRuntime implements ContainerRuntime {
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
      apiVersion: 'unknown',
      rootless: false,
      socketValid: validateSocket(this._socketPath).valid,
      socketPath: this._socketPath,
      cgroupVersion: detectCgroupVersion(),
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
