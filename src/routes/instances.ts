import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { create as tarCreate, extract as tarExtract } from 'tar';
import config from '../config';
import { getPaths } from '../paths';
import { apiError } from '../errors';
import { applyConfigFiles, type ConfigFileEntry } from '../handlers/configFiles';
import {
  createInstaller,
  deleteContainer,
  deleteContainerAndVolume,
  docker,
  getContainerStats,
  initContainer,
  isContainerRunning,
  killContainer,
  pullImageWithProgress,
  sendCommandToContainer,
  startContainer,
  stopContainer,
} from '../handlers/docker';
import { copyIntoVolume, downloadToVolume } from '../handlers/fs';
import { getInstallStatus, setServerState } from '../handlers/installState';
import {
  clearLogBuffer,
  clearLogHistory,
  getLogBuffer,
  getLogHistory,
  listLogArchives,
  readLogArchive,
  resolveLogArchivePath,
} from '../handlers/logHistory';
import { enqueueOperation, getOperation } from '../handlers/operationManager';
import logger from '../logger';
import {
  backupBodyCodes,
  backupBodySchema,
  backupDeleteBodyCodes,
  backupDeleteBodySchema,
  commandBodyCodes,
  commandBodySchema,
  containerIdBodyCodes,
  containerIdBodySchema,
  installBodyCodes,
  installBodySchema,
  installerBodyCodes,
  installerBodySchema,
  killDeleteBodyCodes,
  killDeleteBodySchema,
  logArchiveDownloadBodyCodes,
  logArchiveDownloadBodySchema,
  parseJsonBody,
  reinstallBodyCodes,
  reinstallBodySchema,
  restoreBodyCodes,
  restoreBodySchema,
  startBodyCodes,
  startBodySchema,
} from '../schemas';
import { createDownloadToken } from '../security/downloadTokens';
import { resolveBackupPath, resolveBackupsRoot } from '../security/pathJail';
import { validateContainerId } from '../validation';

// ── Last-used start config cache ─────────────────────────────────────────────
// Persisted per container so `restart` can replay the exact payload that
// launched it (image, env, ports, limits, mounts) without the panel resending
// anything. Written on every successful start, read on restart.
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

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  const norm = glob
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/$/, '');
  const segments = norm.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '**') {
      pattern += i === segments.length - 1 ? '(?:(?:^|/)[^/]*)*/?' : '(?:[^/]*/)*';
      continue;
    }
    let out = '';
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j];
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if (
        c === '.' ||
        c === '+' ||
        c === '(' ||
        c === ')' ||
        c === '[' ||
        c === ']' ||
        c === '{' ||
        c === '}' ||
        c === '^' ||
        c === '$' ||
        c === '|'
      )
        out += `\\${c}`;
      else out += c;
    }
    pattern += `${out}/?`;
  }
  return new RegExp(`^(?:${pattern}|(?:.*/)?${pattern})$`);
}

function buildIgnoreMatchers(patterns: string[]): Array<{ isDir: boolean; re: RegExp; raw: string }> {
  const matchers: { isDir: boolean; re: RegExp; raw: string }[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    const isDir = p.endsWith('/');
    matchers.push({ isDir, re: globToRegExp(p), raw: p });
  }
  return matchers;
}

function isPathIgnored(normalized: string, matchers: { isDir: boolean; re: RegExp }[]): boolean {
  for (const m of matchers) {
    if (m.re.test(normalized)) return true;
  }
  return false;
}

async function loadJson(filePath: string): Promise<unknown[]> {
  try {
    const file = Bun.file(filePath);
    if (file.size === 0) return [];
    return JSON.parse(await file.text());
  } catch {
    return [];
  }
}

async function saveJson(filePath: string, data: unknown): Promise<void> {
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}

export async function handleContainerInstaller(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, installerBodySchema, installerBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, script, container, entrypoint, env } = parsed.data;

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  try {
    await initContainer(id);
    await setServerState(id, 'installing');
    await createInstaller(id, container, script, envVars, entrypoint || 'bash');
    await setServerState(id, 'installed');
    return json({ message: `container ${id} installed successfully` });
  } catch (error) {
    logger.error('error installing container', error);
    await setServerState(id, 'failed', error instanceof Error ? error.message : String(error));
    return apiError('internal_error', `failed to install container ${id}`, 500);
  }
}

export async function handleContainerInstall(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, installBodySchema, installBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, image, scripts, env } = parsed.data;

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  await setServerState(id, 'installing');

  const { accepted, message } = enqueueOperation('install', id, async (signal) => {
    if (signal.aborted) return;
    await performInstall(id, image, scripts, envVars);
  });

  if (!accepted) {
    await setServerState(id, 'failed', message);
    return apiError('internal_error', message, 409);
  }

  return json({ message: 'install started' });
}

export async function handleContainerReinstall(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, reinstallBodySchema, reinstallBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, image, scripts, env, preserveData } = parsed.data;

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  await setServerState(id, 'reinstalling');

  const { accepted, message } = enqueueOperation('reinstall', id, async (signal) => {
    if (signal.aborted) return;
    // Remove the running container, then rebuild it from the install
    // scripts. The volume (worlds, configs, files) survives by default —
    // only an explicit preserveData:false (panel "delete all data"
    // confirmation) wipes it.
    if (preserveData === false) {
      await deleteContainerAndVolume(id);
    } else {
      await deleteContainer(id);
    }
    await performInstall(id, image, scripts, envVars);
  });

  if (!accepted) {
    await setServerState(id, 'failed', message);
    return apiError('internal_error', message, 409);
  }

  return json({ message: 'reinstall started' });
}

async function performInstall(
  id: string,
  image?: string,
  scripts?: unknown[],
  envVars: Record<string, string> = {},
): Promise<void> {
  await initContainer(id);

  if (image && typeof image === 'string') {
    let imageExists = false;
    try {
      await docker.getImage(image).inspect();
      imageExists = true;
    } catch {
      imageExists = false;
    }
    if (!imageExists) {
      await pullImageWithProgress(image, id);
    }
  }

  if (scripts && Array.isArray(scripts)) {
    const alcPath = join(getPaths(config.paths).storageRoot, 'alc.json');
    const locationsPath = join(getPaths(config.paths).storageRoot, 'alc', 'locations.json');
    const filesDir = getPaths(config.paths).alcFilesRoot;

    const alc = (await loadJson(alcPath)) as {
      Name: string;
      lasts: number;
    }[];
    const locations = (await loadJson(locationsPath)) as {
      Name: string;
      url: string;
      id: string;
    }[];

    if (!existsSync(filesDir)) mkdirSync(filesDir, { recursive: true });

    for (const script of scripts) {
      const s = script as {
        url?: string;
        fileName?: string;
        ALVKT?: boolean;
      };
      const { url, fileName } = s;

      if (!url || !fileName) {
        continue;
      }

      // resolve $ALVKT(VAR) in the URL itself before downloading
      const resolvedUrl = url.replace(/\$ALVKT\((\w+)\)/g, (_, v: string) => envVars[v] ?? '');
      if (!resolvedUrl) {
        continue;
      }

      const alcEntry = alc.find((e) => e.Name === fileName);
      const cachedFileId = `${fileName.replace(/\W+/g, '_')}_${alcEntry?.lasts ?? 0}_${Math.floor(Math.random() * 100000) + 1}`;
      const existingLoc = locations.find((l) => l.Name === fileName && l.url === resolvedUrl);
      const cachedFilePath = existingLoc?.id ? join(filesDir, existingLoc.id) : '';

      try {
        if (alcEntry && existingLoc && existsSync(cachedFilePath)) {
          // use cached copy — avoids re-downloading the same file on reinstall
          await copyIntoVolume(id, cachedFilePath, fileName);
        } else {
          // download with optional ALVKT substitution inside the file content
          await downloadToVolume(id, resolvedUrl, fileName, s.ALVKT === true ? envVars : undefined);

          if (alcEntry) {
            // cache it for next time
            const tempPath = join(getPaths(config.paths).volumesRoot, id, fileName);
            await Bun.spawn(['cp', tempPath, join(filesDir, cachedFileId)], { stdout: 'pipe', stderr: 'pipe' }).exited;
            locations.push({
              Name: fileName,
              url: resolvedUrl,
              id: cachedFileId,
            });
            await saveJson(locationsPath, locations);
          }
        }
      } catch (err) {
        logger.error(`error downloading file "${fileName}"`, err);
        throw new Error(`failed to download ${fileName}`);
      }
    }
  }
}

export async function handleContainerInstallStatus(_req: Request, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  const status = await getInstallStatus(id);
  if (!status) return json({ message: `no install state found for container ${id}` }, 404);
  return json({ containerId: id, state: status.state, error: status.error });
}

export async function handleContainerStart(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, startBodySchema, startBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, image, ports, env, Memory, Cpu, Storage, Swap, StartCommand, mounts, configFiles } = parsed.data;

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  if (configFiles && typeof configFiles === 'object') {
    await applyConfigFiles(id, configFiles, envVars);
  }

  // resolve both {{VAR}} (pterodactyl style) and $ALVKT(VAR) in the start command
  let updatedCmd = StartCommand ?? '';
  updatedCmd = updatedCmd.replace(/\{\{(\w+)\}\}/g, (_, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    return '';
  });
  updatedCmd = updatedCmd.replace(/\$ALVKT\((\w+)\)/g, (_, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    return '';
  });

  if (updatedCmd) {
    // older yolks images read $START, newer ones read $STARTUP — set both
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
  // DELETE with JSON body — intentional, the panel sends it this way
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

  // Canonical shape per D-005: { id, command } only. The data/value/payload/args
  // fallbacks were undocumented compatibility shims and are gone.
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
    clearLogHistory(id);
    return json({ message: `container ${id} deleted` });
  } catch (err) {
    logger.error('error deleting container', err);
    return apiError('internal_error', `failed to delete container ${id}`, 500);
  }
}

export async function handleContainerLogs(_req: Request, params: Record<string, string>): Promise<Response> {
  const { id } = params;
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  return json({ lines: getLogBuffer(id) });
}

export async function handleContainerLogHistory(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  const logs = await getLogHistory(id);
  return json({ containerId: id, logs });
}

export async function handleContainerLogArchives(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  return json({ logs: await listLogArchives(id) });
}

export async function handleContainerLogArchiveRead(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const file = params.get('file');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);
  const lines = await readLogArchive(id, file);
  if (!lines) return apiError('not_found', 'log archive not found', 404);
  return json({ lines });
}

export async function handleContainerLogArchiveDownload(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const file = params.get('file');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);
  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath) return apiError('not_found', 'log archive not found', 404);
  if (!existsSync(archivePath)) return apiError('not_found', 'log archive not found', 404);
  return new Response(Bun.file(archivePath), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${file}"`,
    },
  });
}

// Signed mint endpoint for log-archive direct downloads.
export async function handleContainerLogArchiveDownloadToken(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, logArchiveDownloadBodySchema, logArchiveDownloadBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, file } = parsed.data;

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!file) return apiError('invalid_request', 'file is required', 400);

  const archivePath = resolveLogArchivePath(id, file);
  if (!archivePath || !existsSync(archivePath)) return apiError('not_found', 'log archive not found', 404);

  const token = createDownloadToken({
    filePath: archivePath,
    fileName: file,
    contentType: 'application/gzip',
    disposition: 'attachment',
  });

  return json({ token, url: `/dl/${token}` });
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

export async function handleContainerBackup(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, backupBodySchema, backupBodyCodes);
  if ('response' in parsed) return parsed.response;
  const body = parsed.data;

  const volumePath = join(getPaths(config.paths).volumesRoot, body.id);
  if (!existsSync(volumePath)) return apiError('container_not_found', 'container volume not found', 404);

  try {
    const backupsDir = join(getPaths(config.paths).backupsRoot, body.id);
    mkdirSync(backupsDir, { recursive: true });

    const backupUuid = crypto.randomUUID();
    const backupFileName = `${backupUuid}.tar.gz`;
    const backupPath = join(backupsDir, backupFileName);

    const ignoreMatchers = buildIgnoreMatchers(body.ignore ?? []);

    await tarCreate(
      {
        gzip: true,
        file: backupPath,
        cwd: volumePath,
        filter: (p) => {
          const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
          if (norm === 'node_modules' || norm.endsWith('/node_modules') || norm.includes('/node_modules/'))
            return false;
          return !isPathIgnored(norm, ignoreMatchers);
        },
      },
      ['.'],
    );

    const size = statSync(backupPath).size;

    const hash = createHash('sha256');
    const fh = await fs.open(backupPath, 'r');
    try {
      const stream = fh.createReadStream();
      for await (const chunk of stream) hash.update(chunk);
    } finally {
      await fh.close();
    }
    const checksum = hash.digest('hex');

    return json({
      success: true,
      message: 'Backup created successfully',
      backup: {
        uuid: backupUuid,
        name: body.name,
        filePath: `backups/${body.id}/${backupFileName}`,
        size,
        checksum,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error(`error creating backup for container ${body.id}`, err);
    return apiError(
      'internal_error',
      `failed to create backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      500,
    );
  }
}

export async function handleContainerRestore(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, restoreBodySchema, restoreBodyCodes);
  if ('response' in parsed) return parsed.response;
  const body = parsed.data;

  // F-012/F-017: centralised jail — the path must resolve inside backups/<id>/
  let fullPath: string;
  try {
    fullPath = resolveBackupPath(body.id, body.backupPath);
  } catch {
    return apiError('path_traversal', 'invalid backup path', 400);
  }
  if (!existsSync(fullPath)) return apiError('not_found', 'backup file not found', 404);

  // verify integrity before touching anything
  if (typeof body.checksum === 'string' && body.checksum.length > 0) {
    try {
      const hash = createHash('sha256');
      const fh = await fs.open(fullPath, 'r');
      try {
        const stream = fh.createReadStream();
        for await (const chunk of stream) hash.update(chunk);
      } finally {
        await fh.close();
      }
      const actual = hash.digest('hex');
      if (actual !== body.checksum) {
        return apiError('checksum_mismatch', 'backup checksum mismatch, refusing to restore', 422);
      }
    } catch (err) {
      logger.error(`error verifying checksum for ${fullPath}`, err);
      return apiError('internal_error', 'failed to verify backup checksum', 500);
    }
  }

  const volumePath = join(getPaths(config.paths).volumesRoot, body.id);

  // F-012: restore is staged and swapped, not extracted into a wiped volume.
  // The existing volume stays intact until the backup has fully extracted; a
  // corrupt archive or disk error therefore can't destroy the live server.
  let staging: string | null = null;
  let wasRunning = false;

  try {
    const info = await docker
      .getContainer(body.id)
      .inspect()
      .catch(() => null);
    if (info?.State.Running) {
      wasRunning = true;
      await stopContainer(body.id);
    }
  } catch (err) {
    logger.warn(`could not stop container ${body.id}: ${err}`);
  }

  try {
    staging = mkdtempSync(resolve(getPaths(config.paths).storageRoot, `restore-${body.id}-`));
    await tarExtract({ file: fullPath, cwd: staging });

    // swap: only now is the old volume replaced
    if (existsSync(volumePath)) rmSync(volumePath, { recursive: true, force: true });
    mkdirSync(getPaths(config.paths).volumesRoot, { recursive: true });
    renameSync(staging, volumePath);
    staging = null;

    if (wasRunning) {
      const cached = await loadStartConfig(body.id);
      if (cached) {
        if (cached.configFiles && typeof cached.configFiles === 'object') {
          await applyConfigFiles(body.id, cached.configFiles, cached.env ?? {}).catch((err) => {
            logger.error(`restore: applying config files failed for ${body.id}`, err);
          });
        }
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
        ).catch((err) => {
          logger.error(`backup restored but failed to restart container ${body.id}`, err);
        });
      }
    }

    return json({ success: true, message: 'Backup restored successfully' });
  } catch (err) {
    logger.error(`error restoring backup for container ${body.id}`, err);
    return apiError('internal_error', 'failed to restore backup', 500);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

export async function handleContainerBackupDelete(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, backupDeleteBodySchema, backupDeleteBodyCodes);
  if ('response' in parsed) return parsed.response;
  const body = parsed.data;

  let fullPath: string;
  try {
    fullPath = resolveBackupsRoot(body.backupPath);
  } catch {
    return apiError('path_traversal', 'invalid backup path', 400);
  }
  if (!existsSync(fullPath)) return apiError('not_found', 'backup file not found', 404);

  try {
    unlinkSync(fullPath);
    return json({ success: true, message: 'Backup deleted successfully' });
  } catch (err) {
    logger.error('error deleting backup', err);
    return apiError('internal_error', 'failed to delete backup', 500);
  }
}

export function handleContainerBackupDownload(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const backupPath = params.get('backupPath');

  if (!backupPath || typeof backupPath !== 'string') return apiError('invalid_request', 'backup path is required', 400);

  let fullPath: string;
  try {
    fullPath = resolveBackupsRoot(backupPath);
  } catch {
    return apiError('path_traversal', 'invalid backup path', 400);
  }
  if (!existsSync(fullPath)) return apiError('not_found', 'backup file not found', 404);

  const fileName = basename(fullPath);

  return new Response(Bun.file(fullPath), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
}

// Signed mint endpoint for the direct-download backup flow. The panel calls
// this instead of proxying the file; the browser is 302'd to /dl/<token>.
export async function handleContainerBackupDownloadToken(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, backupDeleteBodySchema, backupDeleteBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { backupPath } = parsed.data;

  let fullPath: string;
  try {
    fullPath = resolveBackupsRoot(backupPath);
  } catch {
    return apiError('path_traversal', 'invalid backup path', 400);
  }
  if (!existsSync(fullPath)) return apiError('not_found', 'backup file not found', 404);

  const token = createDownloadToken({
    filePath: fullPath,
    fileName: basename(fullPath),
    contentType: 'application/gzip',
    disposition: 'attachment',
  });

  return json({ token, url: `/dl/${token}` });
}

export async function handleContainerBackupUpload(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const backupUuid = params.get('backupUuid');

  if (!id || typeof id !== 'string') return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);
  if (!backupUuid || typeof backupUuid !== 'string') return apiError('invalid_request', 'backup UUID is required', 400);

  // F-013: backupUuid is a path component; reject anything that isn't a plain
  // identifier so it can never smuggle separators or traversal out of the
  // container's backup directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(backupUuid)) {
    return apiError('invalid_request', 'invalid backup UUID', 400);
  }

  try {
    const backupsDir = join(getPaths(config.paths).backupsRoot, id);
    mkdirSync(backupsDir, { recursive: true });

    const backupFileName = `${backupUuid}.tar.gz`;
    const backupPath = join(backupsDir, backupFileName);

    if (!req.body) return apiError('invalid_request', 'request body is required', 400);
    await Bun.write(backupPath, new Response(req.body));

    const size = statSync(backupPath).size;
    logger.info(`backup uploaded: container=${id} uuid=${backupUuid} path=${backupPath} bytes=${size}`);

    return json({
      success: true,
      message: 'Backup uploaded successfully',
      filePath: `backups/${id}/${backupFileName}`,
    });
  } catch (err) {
    logger.error('error uploading backup', err);
    return apiError(
      'internal_error',
      `failed to upload backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      500,
    );
  }
}
