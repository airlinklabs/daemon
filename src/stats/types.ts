export interface HostStats {
  cpuPct: number;
  perCorePct: number[];
  memUsedGb: number;
  memTotalGb: number;
  memCachedGb: number;
  memAvailGb: number;
  swapUsedGb: number;
  swapTotalGb: number;
  load1: number;
  load5: number;
  load15: number;
  sysUptimeSec: number;
  procs: number;
  disks: { mount: string; usedGb: number; totalGb: number; pct: number }[];
  nets: { iface: string; rxBps: number; txBps: number }[];
  diskIo: { dev: string; rxBps: number; txBps: number }[];
  temps: number[];
  topProcs: { pid: number; name: string; cpuPct: number; rssMb: number }[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  cpuPct: number;
  memUsedMb: number;
  memLimitMb: number;
}

export interface DockerStats {
  online: boolean;
  error: string | null;
  containers: ContainerInfo[];
  images: number;
  networks: number;
  volumes: number;
  dockerDiskGb: number;
}

export interface DaemonInfo {
  online: boolean;
  pid: number | null;
  mode: 'managed' | 'external' | 'none';
  version: string;
  runtime: string;
  port: number;
  remote: string;
  kernel: string;
  uptimeSec: number | null;
  errors24h: number;
}

export interface DaemonCtx {
  port: number;
  managedPid: number | null;
  managedSince: number | null;
  daemonDir: string;
  runtime: string;
  remote: string;
  version: string;
  logsDir: string;
}
