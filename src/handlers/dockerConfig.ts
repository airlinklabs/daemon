import logger from '../logger';

// Resource limits applied to every container. These keep a noisy-neighbor
// game server from starving the host.
const PIDS_LIMIT = 256;
const BLKIO_WEIGHT = 500;
const CPU_NANO_FACTOR = 1e9;

// Wings-compatible security drop set: capabilities dropped from every container.
const WINGS_CAP_DROP = [
  'setpcap',
  'mknod',
  'audit_write',
  'net_raw',
  'dac_override',
  'fowner',
  'fsetid',
  'net_bind_service',
  'sys_chroot',
  'setfcap',
];

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

// Apply Wings-compatible memory overhead multiplier to prevent JVM OOM kills.
// Wings uses: <=2GB -> 15%, <=4GB -> 10%, >4GB -> 5%.
export function memoryOverheadMultiplier(memoryMb: number): number {
  if (memoryMb <= 2048) return 1.15;
  if (memoryMb <= 4096) return 1.1;
  return 1.05;
}

// Build the Docker HostConfig object from panel-supplied limits.
// Includes Wings-compatible security hardening: ReadonlyRootfs, CapDrop,
// SecurityOpt (no-new-privileges), DNS, LogConfig.
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
  tmpfsSizeMb?: number;
}): Record<string, unknown> {
  const overhead = memoryOverheadMultiplier(opts.Memory);
  const boundedMemory = Math.ceil(opts.Memory * overhead);

  const hostConfig: Record<string, unknown> = {
    Binds: [
      `${opts.volumePath}:/home/container`,
      ...(opts.mounts ?? []).map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
    ],
    PortBindings: opts.portBindings,
    Memory: boundedMemory * 1024 * 1024,
    MemoryReservation: opts.Memory * 1024 * 1024,
    MemorySwap: opts.Swap === -1 ? -1 : (boundedMemory + Math.max(0, opts.Swap ?? 0)) * 1024 * 1024,
    OomKillDisable: false,
    PidsLimit: PIDS_LIMIT,
    BlkioWeight: BLKIO_WEIGHT,
    NanoCpus: Math.floor((opts.Cpu / 100) * CPU_NANO_FACTOR),
    RestartPolicy: { Name: 'unless-stopped' },
    // Wings-compatible security hardening
    ReadonlyRootfs: true,
    SecurityOpt: ['no-new-privileges'],
    CapDrop: WINGS_CAP_DROP,
    Dns: ['1.1.1.1', '1.0.0.1'],
    LogConfig: { Type: 'local', Config: {} },
  };

  if (opts.tmpfsSizeMb && opts.tmpfsSizeMb > 0) {
    (hostConfig as Record<string, unknown>).Tmpfs = {
      '/tmp': `rw,exec,nosuid,size=${opts.tmpfsSizeMb}M`,
    };
  }

  if (opts.networkRateMbps > 0 && opts.runtimeName === 'docker') {
    hostConfig.CapAdd = ['NET_ADMIN'];
  }

  if ((opts.Storage ?? 0) > 0 && opts.runtimeName === 'docker') {
    hostConfig.StorageOpt = { size: `${opts.Storage}M` };
  }

  return hostConfig;
}

// Build the Docker HostConfig for installer containers.
// Wings uses max(server limits, global installer limits) and removes PID limits.
export function buildInstallerHostConfig(opts: {
  volumePath: string;
  Memory: number;
  Cpu: number;
  installerMemoryMb?: number;
  installerCpuPercent?: number;
  tmpfsSizeMb?: number;
}): Record<string, unknown> {
  const installerMem = Math.max(opts.Memory, opts.installerMemoryMb ?? 2048);
  const installerCpu = Math.max(opts.Cpu, opts.installerCpuPercent ?? 100);
  const overhead = memoryOverheadMultiplier(installerMem);
  const boundedMemory = Math.ceil(installerMem * overhead);

  const hostConfig: Record<string, unknown> = {
    Binds: [`${opts.volumePath}:/mnt/server`],
    AutoRemove: false,
    // Wings uses default bridge network, not host
    NetworkMode: 'bridge',
    Memory: boundedMemory * 1024 * 1024,
    MemoryReservation: installerMem * 1024 * 1024,
    NanoCpus: Math.floor((installerCpu / 100) * CPU_NANO_FACTOR),
    // Wings removes PID limits for installer containers
    // Security hardening matching Wings
    ReadonlyRootfs: true,
    SecurityOpt: ['no-new-privileges'],
    CapDrop: WINGS_CAP_DROP,
    Dns: ['1.1.1.1', '1.0.0.1'],
    LogConfig: { Type: 'local', Config: {} },
  };

  if (opts.tmpfsSizeMb && opts.tmpfsSizeMb > 0) {
    (hostConfig as Record<string, unknown>).Tmpfs = {
      '/tmp': `rw,exec,nosuid,size=${opts.tmpfsSizeMb}M`,
    };
  }

  return hostConfig;
}
