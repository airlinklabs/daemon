import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config';
import { applyConfigFiles, type ConfigFileEntry } from '../handlers/configFiles';
import {
  createInstaller,
  deleteContainer,
  deleteContainerAndVolume,
  docker,
  pullImageWithProgress,
  initContainer,
} from '../handlers/docker';
import { copyIntoVolume, downloadToVolume } from '../handlers/fs';
import { getInstallStatus, setServerState } from '../handlers/installState';
import { enqueueOperation } from '../handlers/operationManager';
import {
  apiError,
  config as _config,
  getPaths,
  installBodyCodes,
  installBodySchema,
  installerBodyCodes,
  installerBodySchema,
  json,
  loadJson,
  logger,
  parseJsonBody,
  reinstallBodyCodes,
  reinstallBodySchema,
  saveJson,
  validateContainerId,
} from './instancesShared';

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
    const alcPath = join(getPaths(_config.paths).storageRoot, 'alc.json');
    const locationsPath = join(getPaths(_config.paths).storageRoot, 'alc', 'locations.json');
    const filesDir = getPaths(_config.paths).alcFilesRoot;

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
          await copyIntoVolume(id, cachedFilePath, fileName);
        } else {
          await downloadToVolume(id, resolvedUrl, fileName, s.ALVKT === true ? envVars : undefined);

          if (alcEntry) {
            const tempPath = join(getPaths(_config.paths).volumesRoot, id, fileName);
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
