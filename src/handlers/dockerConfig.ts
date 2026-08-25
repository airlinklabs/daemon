import logger from '../logger';

// Resource limits applied to every container. These keep a noisy-neighbor
// game server from starving the host.
const PIDS_LIMIT = 256;
const BLKIO_WEIGHT = 500;
const CPU_NANO_FACTOR = 1e9;

// Mount sources that must never be passed through from the panel.
const FORBIDDEN_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run'];

export type MountSpec = { source: string; target: string; readOnly?: boolean };

export function validateMounts(mounts: MountSpec[] | undefined, daemonStorageRoot: string): void {
  if (!mounts || mounts.length === 0) return;
  for (const mount of mounts) {
    for (const prefix of FORBIDDEN_MOUNT_PREFIXES) {
      if (mount.source.startsWith(prefix)) {
        throw new Error(`mount source ${mount.source} is not allowed (matches forbidden prefix ${prefix})`);
      }
    }
    if (mount.source.startsWith(daemonStorageRoot)) {
      throw new Error(`mount source ${mount.source} is not allowed (inside daemon storage)`);
    }
  }
}

// Parse "hostPort:containerPort,hostPort:containerPort/udp" into Docker
// port bindings and exposed ports.
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

// Patch environment variables for platform quirks (e.g. macOS Apple Silicon
// needs a JVM flag that's harmless on Linux).
export function parseEnvironmentVariables(env: Record<string, string>): Record<string, string> {
  const newEnv = { ...env };
  if (process.platform === 'darwin' && newEnv.START) {
    newEnv.START = newEnv.START.replace(/^(java\s+)/, '$1-XX:UseSVE=0 ');
  }
  return newEnv;
}

// Build the Docker HostConfig object from panel-supplied limits.
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
    Memory: opts.Memory * 1024 * 1024,
    MemorySwap: opts.Swap === -1 ? -1 : (opts.Memory + Math.max(0, opts.Swap ?? 0)) * 1024 * 1024,
    OomKillDisable: false,
    PidsLimit: PIDS_LIMIT,
    BlkioWeight: BLKIO_WEIGHT,
    NanoCpus: Math.floor((opts.Cpu / 100) * CPU_NANO_FACTOR),
    RestartPolicy: { Name: 'unless-stopped' },
  };

  if (opts.networkRateMbps > 0 && opts.runtimeName === 'docker') {
    hostConfig.CapAdd = ['NET_ADMIN'];
  }

  if ((opts.Storage ?? 0) > 0 && opts.runtimeName === 'docker') {
    hostConfig.StorageOpt = { size: `${opts.Storage}M` };
  }

  return hostConfig;
}
