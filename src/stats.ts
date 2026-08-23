// Re-export everything from split modules for backward compatibility.
export { collectDaemon, resolveExternalDir } from './stats/daemon';
export { collectDocker } from './stats/docker';
export { collectHost, cpuPct } from './stats/host';
export type { ContainerInfo, DaemonCtx, DaemonInfo, DockerStats, HostStats } from './stats/types';
