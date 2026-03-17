import Docker from "dockerode";
import fs from "fs";
import path from "path";
import afs from "../filesystem/fs";
import logger from "../../utils/logger";

export const docker = new Docker({
  socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock",
});

const parseJavaCommand = (env: Record<string, string>): string => {
  const startCommand = env["START"] || "";
  if (process.platform === "darwin") {
    return startCommand.replace(/^(java\s+)/, "$1-XX:UseSVE=0 ");
  }
  return startCommand;
};

export const parseEnvironmentVariables = (env: Record<string, string>): Record<string, string> => {
  const newEnv = { ...env };
  if (process.platform === "darwin" && newEnv["START"]) {
    newEnv["START"] = parseJavaCommand(env);
  }
  return newEnv;
};

export const parsePortBindings = (ports: string): Record<string, Array<{ HostPort: string }>> => {
  const result: Record<string, Array<{ HostPort: string }>> = {};
  ports.split(",").forEach((mapping) => {
    const [hostPort, containerPort] = mapping.split(":");
    if (hostPort && containerPort && !isNaN(Number(hostPort)) && !isNaN(Number(containerPort))) {
      result[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
    } else {
      logger.warn(`Invalid port mapping: ${mapping}`);
    }
  });
  return result;
};

export const initContainer = (id: string): string => {
  const volumesDir = path.resolve("volumes");
  const volumePath = path.join(volumesDir, id);

  if (!fs.existsSync(volumesDir)) {
    fs.mkdirSync(volumesDir, { recursive: true });
  }

  if (!fs.existsSync(volumePath)) {
    fs.mkdirSync(volumePath, { recursive: true });
  }

  return volumePath;
};

export const getContainerStats = async (id: string) => {
  try {
    const container = docker.getContainer(id);

    // Inspect first to get real container state
    const info = await container.inspect().catch(() => null);
    if (!info) return null;

    const state = info.State;
    const running  = state.Running === true;
    const starting = state.Status === 'created' || (running && state.StartedAt === state.FinishedAt);
    const stopping = state.Status === 'exited' || state.Status === 'removing' || state.Paused === true;

    if (!running) {
      return {
        running:  false,
        starting: false,
        stopping: stopping,
        memory:   { usage: 0, limit: 0, percentage: 'NaN' },
        cpu:      { percentage: 'NaN' },
        storage:  { usage: '0' },
      };
    }

    const statsStream = await container.stats({ stream: false });

    const memoryUsage = statsStream.memory_stats.usage;
    const memoryLimit = statsStream.memory_stats.limit;
    const memoryPercentage = ((memoryUsage / memoryLimit) * 100).toFixed(2);

    const cpuDelta = statsStream.cpu_stats.cpu_usage.total_usage - statsStream.precpu_stats.cpu_usage.total_usage;
    const systemCpuDelta = statsStream.cpu_stats.system_cpu_usage - statsStream.precpu_stats.system_cpu_usage;
    const cpuUsage = ((cpuDelta / systemCpuDelta) * statsStream.cpu_stats.online_cpus * 100).toFixed(2);

    const storageUsage = (await afs.getDirectorySizeHandler(id, './') / (1024 * 1000)).toFixed(2);

    return {
      running:  true,
      starting: false,
      stopping: false,
      memory:  { usage: memoryUsage, limit: memoryLimit, percentage: memoryPercentage },
      cpu:     { percentage: cpuUsage },
      storage: { usage: storageUsage },
    };
  } catch {
    return null;
  }
};

// Inspect-only state check — never times out waiting for stats collection.
// Use this for everything that needs to know running/stopped. Never use
// getContainerStats() for status — a stats failure must not mean "offline".
export const getContainerState = async (id: string) => {
  try {
    const container = docker.getContainer(id);
    const info = await container.inspect().catch(() => null);
    if (!info) return { running: false, startedAt: null };
    return {
      running:   info.State.Running === true,
      startedAt: info.State.StartedAt || null,
    };
  } catch {
    return { running: false, startedAt: null };
  }
};
