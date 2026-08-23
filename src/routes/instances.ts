import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../config';
import { apiError } from '../errors';
import { applyConfigFiles, type ConfigFileEntry } from '../handlers/configFiles';
import {
  deleteContainerAndVolume,
  docker,
  getContainerStats,
  isContainerRunning,
  killContainer,
  sendCommandToContainer,
  startContainer,
  stopContainer,
} from '../handlers/docker';
import { clearLogBuffer } from '../handlers/logHistory';
import logger from '../logger';
import { getPaths } from '../paths';
import {
  commandBodyCodes,
  commandBodySchema,
  containerIdBodyCodes,
  containerIdBodySchema,
  killDeleteBodyCodes,
  killDeleteBodySchema,
  parseJsonBody,
  startBodyCodes,
  startBodySchema,
} from '../schemas';
import { validateContainerId } from '../validation';

export type CachedStartConfig = {
  id: string;
  image: string;
  ports?: string;
  env?: Record<string, string>;
  Memory?: number;
  Cpu?: number;
  Storage?: number;
  Swap?: number;
  StartCommand?: string;
  mounts?: { source: string; target: string; readOnly?: boolean }[];
  configFiles?: Record<string, ConfigFileEntry>;
  savedAt: string;
};

function configCachePath(id: string): string {
  return resolve(getPaths(config.paths).storageRoot, 'containerConfigs', `${id}.json`);
}

export async function saveStartConfig(sc: CachedStartConfig): Promise<void> {
  try {
    const dir = resolve(getPaths(config.paths).storageRoot, 'containerConfigs');
    mkdirSync(dir, { recursive: true });
    await Bun.write(configCachePath(sc.id), JSON.stringify(sc, null, 2));
  } catch (err) {
    logger.error(`could not persist start config for ${sc.id}`, err);
  }
}

export async function loadStartConfig(id: string): Promise<CachedStartConfig | null> {
  try {
    const path = configCachePath(id);
    if (!existsSync(path)) return null;
    const file = Bun.file(path);
    if (file.size === 0) return null;
    const parsed = JSON.parse(await file.text()) as CachedStartConfig;
    if (!parsed || parsed.id !== id || !parsed.image) return null;
    return parsed;
  } catch (err) {
    logger.error(`could not read start config for ${id}`, err);
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleContainerStart(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, startBodySchema, startBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, image, ports, env, Memory, Cpu, Storage, Swap, StartCommand, mounts, configFiles } = parsed.data;

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  if (configFiles && typeof configFiles === 'object') {
    await applyConfigFiles(id, configFiles, envVars);
  }

  let updatedCmd = StartCommand ?? '';
  updatedCmd = updatedCmd.replace(/\{\{(\w+)\}\}/g, (_match: string, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    return '';
  });
  updatedCmd = updatedCmd.replace(/\$ALVKT\((\w+)\)/g, (_match: string, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    return '';
  });

  if (updatedCmd) {
    envVars.START = updatedCmd;
    envVars.STARTUP = updatedCmd;
  }

  try {
    clearLogBuffer(id);
    await startContainer(
      id,
      image,
      envVars,
      ports ?? '',
      Memory ?? 512,
      Cpu ?? 100,
      Storage ?? 0,
      Swap ?? 0,
      mounts ?? [],
    );
    await saveStartConfig({
      id,
      image,
      ports,
      env: envVars,
      Memory,
      Cpu,
      Storage,
      Swap,
      StartCommand,
      mounts,
      configFiles: configFiles ?? undefined,
      savedAt: new Date().toISOString(),
    });
    return json({ message: `container ${id} started successfully` });
  } catch (error) {
    logger.error('error starting container', error);
    const detail = String((error as Error).message ?? error);
    if (/port is already allocated|already in use|EADDRINUSE/i.test(detail)) {
      return apiError('port_conflict', 'port conflict', 409, detail);
    }
    return apiError('internal_error', 'failed to start container', 500, detail);
  }
}

export async function handleContainerRestart(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, containerIdBodySchema, containerIdBodyCodes);
  if ('response' in parsed) return parsed.response;
  const body = parsed.data;

  const cached = await loadStartConfig(body.id);
  if (!cached) {
    return apiError('container_not_found', `no cached start config for container ${body.id}, start it first`, 404);
  }

  try {
    clearLogBuffer(body.id);
    if (cached.configFiles && typeof cached.configFiles === 'object') {
      await applyConfigFiles(body.id, cached.configFiles, cached.env ?? {});
    }
    await stopContainer(body.id, body.stopCmd);
    await startContainer(
      body.id,
      cached.image,
      cached.env ?? {},
      cached.ports ?? '',
      cached.Memory ?? 512,
      cached.Cpu ?? 100,
      cached.Storage ?? 0,
      cached.Swap ?? 0,
      cached.mounts ?? [],
    );
    return json({ message: `container ${body.id} restarted successfully` });
  } catch (error) {
    logger.error('error restarting container', error);
    const message = error instanceof Error ? error.message : String(error);
    if (/port is already allocated|already in use|EADDRINUSE/i.test(message)) {
      return apiError('port_conflict', 'port conflict', 409, message);
    }
    return apiError('internal_error', `failed to restart container ${body.id}`, 500, message);
  }
}

export async function handleContainerStop(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, containerIdBodySchema, containerIdBodyCodes);
  if ('response' in parsed) return parsed.response;
  const body = parsed.data;

  try {
    await stopContainer(body.id, body.stopCmd);
    return json({ message: `container ${body.id} stopped successfully` });
  } catch (err) {
    logger.error('error stopping container', err);
    return apiError('internal_error', `failed to stop container ${body.id}`, 500);
  }
}

export async function handleContainerKill(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, killDeleteBodySchema, killDeleteBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id } = parsed.data;

  try {
    await killContainer(id);
    return json({ message: `container ${id} killed` });
  } catch (err) {
    logger.error('error killing container', err);
    return apiError('internal_error', `failed to kill container ${id}`, 500);
  }
}

export async function handleContainerCommand(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, commandBodySchema, commandBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, command } = parsed.data;

  const normalized = (command ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return apiError('invalid_request', 'container command is required', 400);

  try {
    await sendCommandToContainer(id, normalized);
    return json({ message: `command sent to container ${id}` });
  } catch (err) {
    logger.error('error sending command', err);
    return apiError('internal_error', `failed to send command to container ${id}`, 500);
  }
}

export async function handleContainerDelete(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, killDeleteBodySchema, killDeleteBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id } = parsed.data;

  try {
    await deleteContainerAndVolume(id);
    return json({ message: `container ${id} deleted` });
  } catch (err) {
    logger.error('error deleting container', err);
    return apiError('internal_error', `failed to delete container ${id}`, 500);
  }
}

export async function handleContainerStatus(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const knownRunning = isContainerRunning(id);
    if (knownRunning !== null) {
      return json({ running: knownRunning, exists: true, source: 'cache' });
    }

    const info = await docker
      .getContainer(id)
      .inspect()
      .catch(() => null);
    if (!info) return json({ running: false, exists: false });

    return json({
      running: info.State.Running,
      exists: true,
      status: info.State.Status,
      exitCode: typeof info.State.ExitCode === 'number' ? info.State.ExitCode : null,
      startedAt: info.State.StartedAt,
      finishedAt: info.State.FinishedAt,
      source: 'inspect',
    });
  } catch (err) {
    logger.error('error getting container status', err);
    return apiError('internal_error', `failed to get status for container ${id}`, 500);
  }
}

export async function handleContainerStats(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const stats = await getContainerStats(id);
    if (!stats) return json({ running: false, exists: false });
    return json(stats);
  } catch (err) {
    logger.error('error getting container stats', err);
    return apiError('internal_error', `failed to get stats for container ${id}`, 500);
  }
}

export { clearLogHistory } from '../handlers/logHistory';
