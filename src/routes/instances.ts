// This code was written by thavanish(https://github.com/thavanish) for airlinklabs

import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { create as tarCreate, extract as tarExtract } from 'tar';
import {
  createInstaller,
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
import { getServerState, setServerState } from '../handlers/installState';
import logger from '../logger';
import { validateContainerId } from '../validation';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  let body: {
    id?: string;
    script?: string;
    container?: string;
    entrypoint?: string;
    env?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, script, container, entrypoint, env } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!script || !container) return json({ error: 'script and container are required' }, 400);

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  try {
    await initContainer(id);
    await setServerState(id, 'installing');
    await createInstaller(id, container, script, envVars, entrypoint || 'bash');
    await setServerState(id, 'installed');
    return json({ message: `container ${id} installed successfully` });
  } catch (error) {
    logger.error('error installing container', error);
    await setServerState(id, 'failed');
    return json({ error: `failed to install container ${id}` }, 500);
  }
}

export async function handleContainerInstall(req: Request): Promise<Response> {
  let body: {
    id?: string;
    image?: string;
    scripts?: unknown[];
    env?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, image, scripts, env } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  await setServerState(id, 'installing');

  // fire-and-forget — response returned immediately, panel polls /container/status/:id
  (async () => {
    try {
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
          logger.info(`pulling image ${image} for container ${id}`);
          await pullImageWithProgress(image, id);
        }
      }

      if (scripts && Array.isArray(scripts)) {
        const alcPath = join(process.cwd(), 'storage/alc.json');
        const locationsPath = join(process.cwd(), 'storage/alc/locations.json');
        const filesDir = join(process.cwd(), 'storage/alc/files');

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
            logger.warn(`invalid script entry: ${JSON.stringify(s)}`);
            continue;
          }

          // resolve $ALVKT(VAR) in the URL itself before downloading
          const resolvedUrl = url.replace(/\$ALVKT\((\w+)\)/g, (_, v: string) => envVars[v] ?? '');
          if (!resolvedUrl) {
            logger.warn(`failed to resolve URL for script: ${JSON.stringify(s)}`);
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
                const tempPath = resolve(process.cwd(), `volumes/${id}/${fileName}`);
                await Bun.spawn(['cp', tempPath, join(filesDir, cachedFileId)], { stdout: 'pipe', stderr: 'pipe' })
                  .exited;
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

      await setServerState(id, 'installed');
    } catch (err) {
      logger.error('error during async install', err);
      await setServerState(id, 'failed');
    }
  })();

  return json({ message: 'install started' });
}

export async function handleContainerInstallStatus(_req: Request, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  const state = await getServerState(id);
  if (!state) return json({ message: `no install state found for container ${id}` }, 404);
  return json({ containerId: id, state });
}

export async function handleContainerStart(req: Request): Promise<Response> {
  let body: {
    id?: string;
    image?: string;
    ports?: string;
    env?: Record<string, string>;
    Memory?: number;
    Cpu?: number;
    StartCommand?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, image, ports, env, Memory, Cpu, StartCommand } = body;
  if (!id || !image) return json({ error: 'container ID and image are required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  const envVars: Record<string, string> = typeof env === 'object' && env !== null ? { ...env } : {};

  // resolve both {{VAR}} (pterodactyl style) and $ALVKT(VAR) in the start command
  let updatedCmd = StartCommand ?? '';
  updatedCmd = updatedCmd.replace(/\{\{(\w+)\}\}/g, (_, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    logger.warn(`variable "${v}" not found in environment ({{}} style)`);
    return '';
  });
  updatedCmd = updatedCmd.replace(/\$ALVKT\((\w+)\)/g, (_, v: string) => {
    if (envVars[v] !== undefined) return envVars[v];
    logger.warn(`variable "${v}" not found in environment ($ALVKT style)`);
    return '';
  });

  if (updatedCmd) {
    // older yolks images read $START, newer ones read $STARTUP — set both
    envVars.START = updatedCmd;
    envVars.STARTUP = updatedCmd;
  }

  logger.warn(`starting ${id}: image=${image} START=${(envVars.START ?? '').slice(0, 120)}`);

  try {
    await startContainer(id, image, envVars, ports ?? '', Memory ?? 512, Cpu ?? 100);
    return json({ message: `container ${id} started successfully` });
  } catch (error) {
    logger.error('error starting container', error);
    return json({ error: `failed to start container ${id}` }, 500);
  }
}

export async function handleContainerStop(req: Request): Promise<Response> {
  let body: { id?: string; stopCmd?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  try {
    await stopContainer(body.id, body.stopCmd);
    return json({ message: `container ${body.id} stopped successfully` });
  } catch (err) {
    logger.error('error stopping container', err);
    return json({ error: `failed to stop container ${body.id}` }, 500);
  }
}

export async function handleContainerKill(req: Request): Promise<Response> {
  // DELETE with JSON body — intentional, the panel sends it this way
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id || !validateContainerId(body.id)) return json({ error: 'valid container ID required' }, 400);

  try {
    await killContainer(body.id);
    return json({ message: `container ${body.id} killed` });
  } catch (err) {
    logger.error('error killing container', err);
    return json({ error: `failed to kill container ${body.id}` }, 500);
  }
}

export async function handleContainerCommand(req: Request): Promise<Response> {
  let body: { id?: string; command?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id || !body.command) return json({ error: 'container ID and command are required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  try {
    await sendCommandToContainer(body.id, body.command);
    return json({ message: `command sent to container ${body.id}` });
  } catch (err) {
    logger.error('error sending command', err);
    return json({ error: `failed to send command to container ${body.id}` }, 500);
  }
}

export async function handleContainerDelete(req: Request): Promise<Response> {
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id || !validateContainerId(body.id)) return json({ error: 'valid container ID required' }, 400);

  try {
    await deleteContainerAndVolume(body.id);
    return json({ message: `container ${body.id} deleted` });
  } catch (err) {
    logger.error('error deleting container', err);
    return json({ error: `failed to delete container ${body.id}` }, 500);
  }
}

export async function handleContainerStatus(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

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
      startedAt: info.State.StartedAt,
      finishedAt: info.State.FinishedAt,
      source: 'inspect',
    });
  } catch (err) {
    logger.error('error getting container status', err);
    return json({ error: `failed to get status for container ${id}` }, 500);
  }
}

export async function handleContainerStats(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  try {
    const stats = await getContainerStats(id);
    if (!stats) return json({ running: false, exists: false });
    return json(stats);
  } catch (err) {
    logger.error('error getting container stats', err);
    return json({ error: `failed to get stats for container ${id}` }, 500);
  }
}

export async function handleContainerBackup(req: Request): Promise<Response> {
  let body: { id?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!body.name) return json({ error: 'backup name is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  const volumePath = resolve(process.cwd(), `volumes/${body.id}`);
  if (!existsSync(volumePath)) return json({ error: 'container volume not found' }, 404);

  try {
    const backupsDir = resolve(process.cwd(), 'backups', body.id);
    mkdirSync(backupsDir, { recursive: true });

    const backupId = crypto.randomUUID();
    const fileName = `${backupId}.tar.gz`;
    const backupPath = join(backupsDir, fileName);

    await tarCreate(
      {
        gzip: true,
        file: backupPath,
        cwd: volumePath,
        filter: (p) => {
          const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
          return !(norm === 'node_modules' || norm.endsWith('/node_modules') || norm.includes('/node_modules/'));
        },
      },
      ['.'],
    );

    const size = statSync(backupPath).size;
    logger.debug(`backup created: ${backupPath} (${size} bytes)`);

    return json({
      success: true,
      message: 'backup created successfully',
      backup: {
        uuid: backupId,
        filePath: `${body.id}/${fileName}`,
        size,
      },
      backupId,
      fileName,
    });
  } catch (err) {
    logger.error(`error creating backup for container ${body.id}`, err);
    return json(
      {
        error: `failed to create backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      },
      500,
    );
  }
}

export async function handleContainerRestore(req: Request): Promise<Response> {
  let body: { id?: string; backupId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!body.backupId || typeof body.backupId !== 'string') return json({ error: 'backup ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  // construct and validate path from id + backupId — no user-controlled path traversal possible
  const backupsDir = resolve(process.cwd(), 'backups', body.id);
  const fullPath = join(backupsDir, `${body.backupId}.tar.gz`);
  if (!fullPath.startsWith(`${backupsDir}/`)) return json({ error: 'invalid backup ID' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup not found' }, 404);

  try {
    const volumePath = resolve(process.cwd(), `volumes/${body.id}`);

    try {
      const info = await docker
        .getContainer(body.id)
        .inspect()
        .catch(() => null);
      if (info?.State.Running) await stopContainer(body.id);
    } catch (err) {
      logger.warn(`could not stop container ${body.id}: ${err}`);
    }

    if (existsSync(volumePath)) rmSync(volumePath, { recursive: true, force: true });
    mkdirSync(volumePath, { recursive: true });

    await tarExtract({ file: fullPath, cwd: volumePath });

    return json({ success: true, message: 'backup restored successfully' });
  } catch (err) {
    logger.error(`error restoring backup for container ${body.id}`, err);
    return json(
      {
        error: `failed to restore backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      },
      500,
    );
  }
}

export async function handleContainerBackupDelete(req: Request): Promise<Response> {
  let body: { id?: string; backupId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id || !validateContainerId(body.id)) return json({ error: 'valid container ID required' }, 400);
  if (!body.backupId || typeof body.backupId !== 'string') return json({ error: 'backup ID is required' }, 400);

  const backupsDir = resolve(process.cwd(), 'backups', body.id);
  const fullPath = join(backupsDir, `${body.backupId}.tar.gz`);
  if (!fullPath.startsWith(`${backupsDir}/`)) return json({ error: 'invalid backup ID' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup not found' }, 404);

  try {
    unlinkSync(fullPath);
    return json({ message: 'backup deleted successfully' });
  } catch (err) {
    logger.error('error deleting backup', err);
    return json(
      {
        error: `failed to delete backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      },
      500,
    );
  }
}

export function handleContainerBackupDownload(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const backupId = params.get('backupId');

  if (!id || !validateContainerId(id)) return json({ error: 'valid container ID required' }, 400);
  if (!backupId || typeof backupId !== 'string') return json({ error: 'backup ID is required' }, 400);

  const backupsDir = resolve(process.cwd(), 'backups', id);
  const fullPath = join(backupsDir, `${backupId}.tar.gz`);
  if (!fullPath.startsWith(`${backupsDir}/`)) return json({ error: 'invalid backup ID' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup not found' }, 404);

  // streams the file without loading it into memory — Bun handles this
  return new Response(Bun.file(fullPath), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${backupId}.tar.gz"`,
    },
  });
}
