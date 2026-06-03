import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
  let body: { id?: string; command?: string; args?: string[]; data?: unknown; value?: unknown; payload?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id || !validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  const commandCandidate =
    typeof body.command === 'string'
      ? body.command
      : typeof body.data === 'string'
        ? body.data
        : typeof body.value === 'string'
          ? body.value
          : typeof body.payload === 'string'
            ? body.payload
            : typeof body.args?.[0] === 'string'
              ? body.args[0]
              : '';

  const command = commandCandidate.replace(/\r\n?/g, '\n').trim();
  if (!command) return json({ error: 'container command is required' }, 400);

  try {
    await sendCommandToContainer(body.id, command);
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

    const backupUuid = crypto.randomUUID();
    const backupFileName = `${backupUuid}.tar.gz`;
    const backupPath = join(backupsDir, backupFileName);

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
    return json({
      success: true,
      message: 'Backup created successfully',
      backup: {
        uuid: backupUuid,
        name: body.name,
        filePath: `backups/${body.id}/${backupFileName}`,
        size,
        createdAt: new Date().toISOString(),
      },
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
  let body: { id?: string; backupPath?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!body.backupPath || typeof body.backupPath !== 'string') return json({ error: 'backup path is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  // constrain path to the backups directory for this container
  const allowedBackupsDir = resolve(process.cwd(), 'backups', body.id);
  const fullPath = resolve(process.cwd(), body.backupPath);
  if (!fullPath.startsWith(`${allowedBackupsDir}/`)) return json({ error: 'invalid backup path' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup file not found' }, 404);

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

    return json({ success: true, message: 'Backup restored successfully' });
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
  let body: { backupPath?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.backupPath || typeof body.backupPath !== 'string') return json({ error: 'backup path is required' }, 400);

  const allowedBackupsRoot = resolve(process.cwd(), 'backups');
  const fullPath = resolve(process.cwd(), body.backupPath);
  if (!fullPath.startsWith(`${allowedBackupsRoot}/`)) return json({ error: 'invalid backup path' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup file not found' }, 404);

  try {
    unlinkSync(fullPath);
    return json({ success: true, message: 'Backup deleted successfully' });
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
  const backupPath = params.get('backupPath');

  if (!backupPath || typeof backupPath !== 'string') return json({ error: 'backup path is required' }, 400);

  const allowedBackupsRoot = resolve(process.cwd(), 'backups');
  const fullPath = resolve(process.cwd(), backupPath);
  if (!fullPath.startsWith(`${allowedBackupsRoot}/`)) return json({ error: 'invalid backup path' }, 400);
  if (!existsSync(fullPath)) return json({ error: 'backup file not found' }, 404);

  const fileName = basename(fullPath);

  return new Response(Bun.file(fullPath), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    },
  });
}

export async function handleContainerBackupUpload(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const backupUuid = params.get('backupUuid');

  if (!id || typeof id !== 'string') return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!backupUuid || typeof backupUuid !== 'string') return json({ error: 'backup UUID is required' }, 400);

  try {
    const backupsDir = resolve(process.cwd(), 'backups', id);
    mkdirSync(backupsDir, { recursive: true });

    const backupFileName = `${backupUuid}.tar.gz`;
    const backupPath = join(backupsDir, backupFileName);

    const buffer = await req.arrayBuffer();
    await Bun.write(backupPath, buffer);

    return json({
      success: true,
      message: 'Backup uploaded successfully',
      filePath: `backups/${id}/${backupFileName}`,
    });
  } catch (err) {
    logger.error('error uploading backup', err);
    return json(
      {
        error: `failed to upload backup: ${err instanceof Error ? err.message : 'unknown error'}`,
      },
      500,
    );
  }
}
