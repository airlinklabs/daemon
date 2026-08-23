import Docker from 'dockerode';
import logger from '../logger';
import type { ContainerRuntime, RuntimeCapabilities } from './containerRuntime';
import { detectCgroupVersion, validateSocket } from './containerRuntime';

// Podman runtime differs from Docker in a few important ways:
// - No StorageOpt support (uses overlay instead of overlay2)
// - Rootless mode disables NET_ADMIN and blkio weight
// - Different socket paths for rootless users
// - cgroup v2 only

export class PodmanRuntime implements ContainerRuntime {
  private docker: Docker;
  readonly name: 'podman' = 'podman';
  private _socketPath: string;
  private _capabilities: RuntimeCapabilities | null = null;
  private _isRootless = false;

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
    // Podman doesn't support StorageOpt; strip it if the caller sent one
    if (opts.HostConfig?.StorageOpt) {
      logger.debug('removing StorageOpt from container create options (not supported by Podman)');
      const { StorageOpt, ...restHostConfig } = opts.HostConfig;
      opts = { ...opts, HostConfig: restHostConfig };
    }

    // Rootless Podman can't grant NET_ADMIN
    if (this._isRootless && opts.HostConfig?.CapAdd) {
      const filteredCaps = opts.HostConfig.CapAdd.filter((cap: string) => cap !== 'NET_ADMIN');
      if (filteredCaps.length !== opts.HostConfig.CapAdd.length) {
        logger.debug('removing NET_ADMIN capability (not supported in Podman rootless mode)');
        opts = {
          ...opts,
          HostConfig: { ...opts.HostConfig, CapAdd: filteredCaps },
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
      apiVersion: 'unknown',
      rootless: this._isRootless,
      socketValid: validateSocket(this._socketPath).valid,
      socketPath: this._socketPath,
      cgroupVersion: detectCgroupVersion(),
      storageDriver: 'overlay',
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

  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      const info = await this.docker.info();
      const caps = this.capabilities();
      caps.apiVersion = info.ApiVersion ?? 'unknown';
      caps.cgroupVersion = info.CgroupVersion ?? 2;
      caps.storageDriver = info.Driver ?? caps.storageDriver;

      this._isRootless = info.SecurityOptions?.some((o: string) => o.includes('rootless')) ?? false;
      caps.rootless = this._isRootless;

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
