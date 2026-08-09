import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';
import { apiError } from '../errors';
import {
  appendChunk,
  copyIntoVolume,
  fetchPublicUrl,
  getDirSizeForId,
  getFileContent,
  getFilePath,
  listDir,
  renameFile,
  rmPath,
  unzipPath,
  writeFileContent,
  zipPaths,
} from '../handlers/fs';
import logger from '../logger';
import { PublicUrlError, validatePublicUrl } from '../router';
import {
  fsAppendBodyCodes,
  fsAppendBodySchema,
  fsCopyBodyCodes,
  fsCopyBodySchema,
  fsCreateEmptyBodyCodes,
  fsCreateEmptyBodySchema,
  fsMkdirBodyCodes,
  fsMkdirBodySchema,
  fsPathOptionalBodyCodes,
  fsPathOptionalBodySchema,
  fsPullBodyCodes,
  fsPullBodySchema,
  fsRenameBodyCodes,
  fsRenameBodySchema,
  fsUnzipBodyCodes,
  fsUnzipBodySchema,
  fsUploadBodyCodes,
  fsUploadBodySchema,
  fsWriteBodyCodes,
  fsWriteBodySchema,
  fsZipBodyCodes,
  fsZipBodySchema,
  parseJsonBody,
} from '../schemas';
import { consumeDownloadToken, createDownloadToken } from '../security/downloadTokens';
import { jailPath } from '../security/pathJail';
import { validateContainerId, validatePath } from '../validation';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleFsList(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';
  const filter = params.get('filter') ?? undefined;

  if (!id || typeof id !== 'string') return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const contents = await listDir(id, path, filter);
    return json(contents);
  } catch (err) {
    logger.error(`failed to list directory contents for container ${id}`, err);
    return apiError('internal_error', 'failed to list directory contents', 500);
  }
}

export async function handleFsSize(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const size = await getDirSizeForId(id, path);
    return json({ size });
  } catch (err) {
    logger.error(`failed to compute directory size for container ${id}`, err);
    return apiError('internal_error', 'failed to compute directory size', 500);
  }
}

export async function handleFsInfo(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const contents = (await listDir(id, '/')) as {
      type: string;
      size: number;
    }[];
    if (!Array.isArray(contents)) return apiError('internal_error', 'could not list directory', 500);

    const totalSize = contents.reduce((a, i) => a + (i.size || 0), 0);
    const fileCount = contents.filter((i) => i.type === 'file').length;
    const dirCount = contents.filter((i) => i.type === 'directory').length;

    return json({ id, totalSize, fileCount, dirCount });
  } catch (err) {
    logger.error(`failed to read container info for container ${id}`, err);
    return apiError('internal_error', 'failed to read container info', 500);
  }
}

export async function handleFsFileRead(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const content = await getFileContent(id, path);
    if (content === null) {
      return apiError('not_found', 'file not found or not a text file', 404);
    }
    return new Response(content, { headers: { 'Content-Type': 'text/plain' } });
  } catch (err) {
    logger.error(`failed to read file for container ${id}`, err);
    return apiError('internal_error', 'failed to read file', 500);
  }
}

export async function handleFsFileWrite(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsWriteBodySchema, fsWriteBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, content } = parsed.data;

  try {
    await writeFileContent(id, path, content ?? '');
    return json({ message: 'file content successfully saved' });
  } catch (err) {
    logger.error(`failed to save file for container ${id}`, err);
    return apiError('internal_error', 'failed to save file', 500);
  }
}

export function handleFsDownload(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const filePath = getFilePath(id, path);
    // streams the file without loading it into memory — Bun handles this
    return new Response(Bun.file(filePath), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${basename(filePath)}"`,
      },
    });
  } catch (err) {
    logger.error(`file download failed for container ${id}`, err);
    return apiError('not_found', 'file not found', 404);
  }
}

// Signed (HMAC) mint endpoint. Called by the panel when a user asks for a file.
// Returns a one-time URL the browser is redirected to — the panel never proxies
// the file bytes itself.
export async function handleFsDownloadToken(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsPathOptionalBodySchema, fsPathOptionalBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path } = parsed.data;

  if (!id) return apiError('container_not_found', 'container ID is required', 400);
  if (!validateContainerId(id)) return apiError('container_not_found', 'invalid container ID', 400);

  try {
    const filePath = getFilePath(id, path ?? '/');
    if (!existsSync(filePath)) return apiError('not_found', 'file not found', 404);
    const s = statSync(filePath);
    if (!s.isFile()) return apiError('not_found', 'not a file', 404);

    const token = createDownloadToken({
      filePath,
      fileName: basename(filePath),
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });

    return json({ token, url: `/dl/${token}` });
  } catch (err) {
    logger.error(`failed to mint download token for container ${id}`, err);
    return apiError('not_found', 'file not found', 404);
  }
}

// Browser-facing route (GET /dl/<token>). No Basic/HMAC auth — the token itself
// is the credential — but it is single-use, short-lived, rate-limited, and IP
// allowlisted (enforced by the router before this handler runs). Serves the
// already-jailed file directly to the browser, cross-origin so the panel's
// <img> previews can render it.
export async function handleDownloadToken(_req: Request, token: string): Promise<Response> {
  const entry = consumeDownloadToken(token);
  if (!entry) return apiError('not_found', 'download link is invalid or expired', 404);

  if (!existsSync(entry.filePath)) {
    logger.warn(`download token referenced a missing file: ${entry.filePath}`);
    return apiError('not_found', 'file not found', 404);
  }

  const disposition = `${entry.disposition}; filename="${entry.fileName}"`;
  return new Response(Bun.file(entry.filePath), {
    headers: {
      'Content-Type': entry.contentType,
      'Content-Disposition': disposition,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

function pullUrlError(err: PublicUrlError): Response {
  switch (err.reason) {
    case 'invalid_url':
      return apiError('invalid_request', 'invalid URL', 400);
    case 'unsupported_scheme':
      return apiError('invalid_request', 'only http(s) URLs are allowed', 400);
    case 'local':
      return apiError('invalid_request', 'local URLs are not allowed', 400);
    default:
      return apiError('invalid_request', 'private network URLs are not allowed', 400);
  }
}

export async function handleFsPull(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsPullBodySchema, fsPullBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, url, path } = parsed.data;

  // SSRF gate: reject loopback/private/link-local targets and non-http(s)
  // schemes up front, and resolve hostnames so DNS-rebinding to a private
  // address is caught before any bytes move.
  let safeUrl: URL;
  try {
    safeUrl = await validatePublicUrl(url);
  } catch (err) {
    if (err instanceof PublicUrlError) return pullUrlError(err);
    logger.error(`failed to resolve pull URL ${url}`, err);
    return apiError('internal_error', 'failed to download file from URL', 502);
  }

  const targetDir = path && path.trim() !== '' ? path.trim().replace(/^\/+/, '') : '';
  const resolvedDir = targetDir === '' ? '/' : targetDir;
  if (!validatePath(resolvedDir)) {
    return apiError('path_traversal', 'invalid target path', 400);
  }

  let volumePath: string;
  let resolvedTarget: string;
  try {
    volumePath = resolve(getPaths(config.paths).volumesRoot, id);
    resolvedTarget = resolvedDir === '/' ? volumePath : jailPath(volumePath, resolvedDir);
    mkdirSync(resolvedTarget, { recursive: true });
  } catch (err) {
    logger.error(`invalid pull target directory for container ${id}`, err);
    return apiError('path_traversal', 'path escapes container volume', 400);
  }

  const fileName = basename(safeUrl.pathname) || 'download';
  const relativeTarget = (resolvedDir === '/' ? '' : resolvedDir) + (resolvedDir === '/' ? '' : '/') + fileName;
  let targetFile: string;
  try {
    targetFile = jailPath(volumePath, relativeTarget);
  } catch (err) {
    logger.error(`invalid pull target file for container ${id}`, err);
    return apiError('path_traversal', 'path escapes container volume', 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const MAX_PULL_BYTES = 512 * 1024 * 1024; // 512MB
  let total = 0;

  try {
    const response = await fetchPublicUrl(url, controller.signal);
    if (!response.ok || !response.body) {
      return apiError('internal_error', `remote returned ${response.status}`, 502);
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_PULL_BYTES) {
      return apiError('invalid_request', 'remote file exceeds the 512MB pull limit', 413);
    }

    const handle = await Bun.file(targetFile).writer();
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_PULL_BYTES) {
          return apiError('invalid_request', 'remote file exceeds the 512MB pull limit', 413);
        }
        handle.write(chunk);
      }
      await handle.end();
    } catch {
      try {
        await handle.end();
      } catch {}
      throw new Error('download interrupted');
    }
  } catch (err) {
    // a redirect hop or second-stage resolution may still land on a private
    // address — surface it with the same stable code/message as the upfront gate
    if (err instanceof PublicUrlError) return pullUrlError(err);
    logger.error(`failed to pull ${url} for container ${id}`, err);
    return apiError('internal_error', 'failed to download file from URL', 502);
  } finally {
    clearTimeout(timeout);
  }

  return json({
    success: true,
    message: 'File pulled successfully',
    file: fileName,
    path: resolvedDir === '/' ? `/${fileName}` : `${resolvedDir}/${fileName}`,
    size: total,
  });
}

export async function handleFsRm(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsPathOptionalBodySchema, fsPathOptionalBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path } = parsed.data;

  try {
    await rmPath(id, path ?? '/');
    return json({ message: 'file/folder successfully removed' });
  } catch (err) {
    logger.error(`failed to remove path for container ${id}`, err);
    return apiError('internal_error', 'failed to remove path', 500);
  }
}

export async function handleFsZip(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsZipBodySchema, fsZipBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, zipname } = parsed.data;

  const paths = Array.isArray(path) ? path : [path ?? '/'];

  try {
    const zipPath = await zipPaths(id, paths, zipname ?? 'archive');
    return json({ message: 'archive created', zipPath });
  } catch (err) {
    logger.error(`failed to create archive for container ${id}`, err);
    return apiError('internal_error', 'failed to create archive', 500);
  }
}

export async function handleFsUnzip(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsUnzipBodySchema, fsUnzipBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, zipname } = parsed.data;

  try {
    await unzipPath(id, path ?? '/', zipname ?? '');
    return json({ message: 'file successfully unzipped' });
  } catch (err) {
    logger.error(`failed to extract archive for container ${id}`, err);
    return apiError('internal_error', 'failed to extract archive', 500);
  }
}

export async function handleFsRename(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsRenameBodySchema, fsRenameBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path, newName, newPath } = parsed.data;

  const newTarget = newPath ?? newName ?? '';

  try {
    await renameFile(id, path ?? '/', newTarget);
    return json({ message: 'file successfully renamed' });
  } catch (err) {
    logger.error(`failed to rename path for container ${id}`, err);
    return apiError('internal_error', 'failed to rename path', 500);
  }
}

function defaultCopyTarget(source: string): string {
  const base = basename(source);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const dir = dirname(source);
  return dir === '.' ? `${stem}-copy${ext}` : `${dir}/${stem}-copy${ext}`;
}

export async function handleFsCopy(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsCopyBodySchema, fsCopyBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, source, newPath } = parsed.data;

  if (!validatePath(source)) return apiError('path_traversal', 'source escapes container volume', 400);
  if (newPath && !validatePath(newPath)) return apiError('path_traversal', 'invalid target path', 400);

  try {
    // getFilePath jails the source into the container's volume (no arbitrary
    // host reads); copyIntoVolume jails the destination. If newPath is omitted,
    // derive a same-basename "-copy" target.
    const destRelative = newPath?.trim() ? newPath.trim() : defaultCopyTarget(source);
    await copyIntoVolume(id, getFilePath(id, source), destRelative);
    return json({ message: 'file successfully copied', path: destRelative });
  } catch (err) {
    logger.error(`failed to copy path for container ${id}`, err);
    return apiError('internal_error', 'failed to copy path', 500);
  }
}

export async function handleFsUpload(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsUploadBodySchema, fsUploadBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, fileName, fileContent } = parsed.data;

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;
    const baseDir = resolve(getPaths(config.paths).volumesRoot, id);
    const filePath = jailPath(baseDir, targetPath);

    mkdirSync(dirname(filePath), { recursive: true });

    let content: Buffer;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      const match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
      if (!match?.[1]) return apiError('invalid_request', 'invalid base64 format', 400);
      content = Buffer.from(match[1], 'base64');
    } else if (typeof fileContent === 'string') {
      content = Buffer.from(fileContent, 'utf8');
    } else {
      return apiError('invalid_request', 'unsupported content type', 400);
    }

    await Bun.write(filePath, content);
    logger.info(`file uploaded: container=${id} path=${targetPath} bytes=${content.byteLength}`);
    return json({
      message: 'file successfully uploaded',
      fileName,
      path: targetPath,
    });
  } catch (err) {
    logger.error('error during file upload', err);
    return apiError('internal_error', 'failed to upload file', 500);
  }
}

export async function handleFsMkdir(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsMkdirBodySchema, fsMkdirBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, folderName } = parsed.data;

  const name = folderName ?? relativePath ?? '';
  if (!name) return apiError('invalid_request', 'folder name is required', 400);
  if (!validatePath(name)) return apiError('path_traversal', 'invalid folder path', 400);

  try {
    const baseDir = resolve(getPaths(config.paths).volumesRoot, id);
    const targetPath =
      relativePath && relativePath !== '/'
        ? `${relativePath.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
        : name.replace(/^\/+/, '');
    const dirPath = jailPath(baseDir, targetPath);
    mkdirSync(dirPath, { recursive: true });
    return json({ message: 'directory successfully created', path: targetPath });
  } catch (err) {
    logger.error('error creating directory', err);
    return apiError('internal_error', 'failed to create directory', 500);
  }
}

export async function handleFsCreateEmpty(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsCreateEmptyBodySchema, fsCreateEmptyBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, fileName } = parsed.data;

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;
    const baseDir = resolve(getPaths(config.paths).volumesRoot, id);
    const filePath = jailPath(baseDir, targetPath);

    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, '');
    return json({
      message: 'empty file successfully created',
      fileName,
      path: targetPath,
    });
  } catch (err) {
    logger.error('error creating empty file', err);
    return apiError('internal_error', 'failed to create empty file', 500);
  }
}

export async function handleFsAppend(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsAppendBodySchema, fsAppendBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, fileName, fileContent, chunkIndex = 0, totalChunks = 1 } = parsed.data;

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;

    let chunk: Buffer;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      const match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
      if (!match?.[1]) return apiError('invalid_request', 'invalid base64 format', 400);
      chunk = Buffer.from(match[1], 'base64');
    } else if (typeof fileContent === 'string') {
      chunk = Buffer.from(fileContent, 'utf8');
    } else {
      return apiError('invalid_request', 'unsupported content type', 400);
    }

    await appendChunk(id, targetPath, chunk, { chunkIndex, totalChunks });
    return json({
      message: 'chunk successfully appended',
      fileName,
      path: targetPath,
      chunkIndex,
      totalChunks,
    });
  } catch (err) {
    logger.error('error appending to file', err);
    return apiError('internal_error', 'failed to append to file', 500);
  }
}
