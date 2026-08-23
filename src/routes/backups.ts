import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { create as tarCreate, extract as tarExtract } from 'tar';
import { applyConfigFiles } from '../handlers/configFiles';
import { docker, startContainer, stopContainer } from '../handlers/docker';
import { createDownloadToken } from '../security/downloadTokens';
import { resolveBackupPath, resolveBackupsRoot } from '../security/pathJail';
import { loadStartConfig } from './instances';
import {
  apiError,
  backupBodyCodes,
  backupBodySchema,
  backupDeleteBodyCodes,
  backupDeleteBodySchema,
  buildIgnoreMatchers,
  config,
  getPaths,
  isPathIgnored,
  json,
  logger,
  parseJsonBody,
  restoreBodyCodes,
  restoreBodySchema,
  validateContainerId,
} from './instancesShared';

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

    const hash = new Bun.CryptoHasher('sha256');
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

  let fullPath: string;
  try {
    fullPath = resolveBackupPath(body.id, body.backupPath);
  } catch {
    return apiError('path_traversal', 'invalid backup path', 400);
  }
  if (!existsSync(fullPath)) return apiError('not_found', 'backup file not found', 404);

  if (typeof body.checksum === 'string' && body.checksum.length > 0) {
    try {
      const hash = new Bun.CryptoHasher('sha256');
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
    const { mkdtempSync } = await import('node:fs');
    const { renameSync, rmSync } = await import('node:fs');
    staging = mkdtempSync(resolve(getPaths(config.paths).storageRoot, `restore-${body.id}-`));
    await tarExtract({ file: fullPath, cwd: staging });

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
    if (staging) {
      const { rmSync } = await import('node:fs');
      rmSync(staging, { recursive: true, force: true });
    }
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
