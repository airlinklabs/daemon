import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { apiError } from '../errors';
import {
  appendChunk,
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
import { isPrivateIp } from '../router';
import {
  fsAppendBodyCodes,
  fsAppendBodySchema,
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('not_found', err instanceof Error ? err.message : 'file not found', 404);
  }
}

export async function handleFsPull(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsPullBodySchema, fsPullBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, url, path } = parsed.data;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return apiError('invalid_request', 'invalid URL', 400);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return apiError('invalid_request', 'only http(s) URLs are allowed', 400);
  }
  if (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1') {
    return apiError('invalid_request', 'local URLs are not allowed', 400);
  }
  if (isPrivateIp(parsedUrl.hostname)) {
    return apiError('invalid_request', 'private network URLs are not allowed', 400);
  }

  const targetDir = path && path.trim() !== '' ? path.trim().replace(/^\/+/, '') : '';
  const resolvedDir = targetDir === '' ? '/' : targetDir;
  if (!validatePath(resolvedDir)) {
    return apiError('path_traversal', 'invalid target path', 400);
  }

  try {
    const volumePath = resolve(process.cwd(), `volumes/${id}`);
    const resolvedTarget = resolvedDir === '/' ? volumePath : jailPath(volumePath, resolvedDir);
    mkdirSync(resolvedTarget, { recursive: true });

    const fileName = basename(parsedUrl.pathname) || 'download';
    const targetFile = resolve(resolvedTarget, fileName);
    if (!targetFile.startsWith(`${volumePath}/`)) {
      return apiError('path_traversal', 'path escapes container volume', 400);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const MAX_PULL_BYTES = 512 * 1024 * 1024; // 512MB
    let total = 0;

    try {
      const response = await fetch(url, { signal: controller.signal });
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
      logger.error(`failed to pull ${url}`, err);
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
  } catch (err) {
    logger.error(`error pulling file for container ${id}`, err);
    return apiError('internal_error', 'failed to pull file into container volume', 500);
  }
}

export async function handleFsRm(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsPathOptionalBodySchema, fsPathOptionalBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path } = parsed.data;

  try {
    await rmPath(id, path ?? '/');
    return json({ message: 'file/folder successfully removed' });
  } catch (err) {
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
  }
}

export async function handleFsUpload(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsUploadBodySchema, fsUploadBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, fileName, fileContent } = parsed.data;

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;
    const baseDir = resolve(process.cwd(), `volumes/${id}`);
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
    return json({
      message: 'file successfully uploaded',
      fileName,
      path: targetPath,
    });
  } catch (err) {
    logger.error('error during file upload', err);
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    const baseDir = resolve(process.cwd(), `volumes/${id}`);
    const targetPath =
      relativePath && relativePath !== '/'
        ? `${relativePath.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
        : name.replace(/^\/+/, '');
    const dirPath = jailPath(baseDir, targetPath);
    mkdirSync(dirPath, { recursive: true });
    return json({ message: 'directory successfully created', path: targetPath });
  } catch (err) {
    logger.error('error creating directory', err);
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
  }
}

export async function handleFsCreateEmpty(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, fsCreateEmptyBodySchema, fsCreateEmptyBodyCodes);
  if ('response' in parsed) return parsed.response;
  const { id, path: relativePath, fileName } = parsed.data;

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;
    const baseDir = resolve(process.cwd(), `volumes/${id}`);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
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
    return apiError('internal_error', err instanceof Error ? err.message : 'unknown error', 500);
  }
}
