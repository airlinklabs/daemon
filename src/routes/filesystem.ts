import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
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
import { jailPath } from '../security/pathJail';
import { validateContainerId, validateFileName, validatePath } from '../validation';

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

  if (!id || typeof id !== 'string') return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  try {
    const contents = await listDir(id, path, filter);
    return json(contents);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsSize(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  try {
    const size = await getDirSizeForId(id, path);
    return json({ size });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsInfo(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  try {
    const contents = (await listDir(id, '/')) as {
      type: string;
      size: number;
    }[];
    if (!Array.isArray(contents)) return json({ error: 'could not list directory' }, 500);

    const totalSize = contents.reduce((a, i) => a + (i.size || 0), 0);
    const fileCount = contents.filter((i) => i.type === 'file').length;
    const dirCount = contents.filter((i) => i.type === 'directory').length;

    return json({ id, totalSize, fileCount, dirCount });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsFileRead(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

  try {
    const content = await getFileContent(id, path);
    if (content === null) {
      return json({ error: 'file not found or not a text file' }, 404);
    }
    return new Response(content, { headers: { 'Content-Type': 'text/plain' } });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsFileWrite(req: Request): Promise<Response> {
  let body: { id?: string; path?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, path, content } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!path || !validatePath(path)) return json({ error: 'invalid file path' }, 400);

  try {
    await writeFileContent(id, path, content ?? '');
    return json({ message: 'file content successfully saved' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export function handleFsDownload(req: Request): Response {
  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const path = params.get('path') ?? '/';

  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);

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
    return json({ error: err instanceof Error ? err.message : 'file not found' }, 404);
  }
}

export async function handleFsPull(req: Request): Promise<Response> {
  let body: { id?: string; url?: string; path?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!body.url || typeof body.url !== 'string') return json({ error: 'URL is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return json({ error: 'invalid URL' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ error: 'only http(s) URLs are allowed' }, 400);
  }
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    return json({ error: 'local URLs are not allowed' }, 400);
  }
  if (isPrivateIp(parsed.hostname)) {
    return json({ error: 'private network URLs are not allowed' }, 400);
  }

  const targetDir = body.path && typeof body.path === 'string' && body.path.trim() !== ''
    ? body.path.trim().replace(/^\/+/, '')
    : '';
  const resolvedDir = targetDir === '' ? '/' : targetDir;
  if (!validatePath(resolvedDir)) {
    return json({ error: 'invalid target path' }, 400);
  }

  try {
    const volumePath = resolve(process.cwd(), `volumes/${body.id}`);
    const resolvedTarget = resolvedDir === '/' ? volumePath : jailPath(volumePath, resolvedDir);
    mkdirSync(resolvedTarget, { recursive: true });

    const fileName = basename(parsed.pathname) || 'download';
    const targetFile = resolve(resolvedTarget, fileName);
    if (!targetFile.startsWith(`${volumePath}/`)) {
      return json({ error: 'path escapes container volume' }, 400);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const MAX_PULL_BYTES = 512 * 1024 * 1024; // 512MB
    let total = 0;

    try {
      const response = await fetch(body.url, { signal: controller.signal });
      if (!response.ok || !response.body) {
        return json({ error: `remote returned ${response.status}` }, 502);
      }
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_PULL_BYTES) {
        return json({ error: 'remote file exceeds the 512MB pull limit' }, 413);
      }

      const handle = await Bun.file(targetFile).writer();
      try {
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > MAX_PULL_BYTES) {
            return json({ error: 'remote file exceeds the 512MB pull limit' }, 413);
          }
          handle.write(chunk);
        }
        await handle.end();
      } catch {
        try { await handle.end(); } catch {}
        throw new Error('download interrupted');
      }
    } catch (err) {
      logger.error(`failed to pull ${body.url}`, err);
      return json({ error: 'failed to download file from URL' }, 502);
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
    logger.error(`error pulling file for container ${body.id}`, err);
    return json({ error: 'failed to pull file into container volume' }, 500);
  }
}

export async function handleFsRm(req: Request): Promise<Response> {
  let body: { id?: string; path?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  try {
    await rmPath(body.id, body.path ?? '/');
    return json({ message: 'file/folder successfully removed' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsZip(req: Request): Promise<Response> {
  let body: { id?: string; path?: string | string[]; zipname?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  const paths = Array.isArray(body.path) ? body.path : [body.path ?? '/'];

  try {
    const zipPath = await zipPaths(body.id, paths, body.zipname ?? 'archive');
    return json({ message: 'archive created', zipPath });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsUnzip(req: Request): Promise<Response> {
  let body: { id?: string; path?: string; zipname?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  try {
    await unzipPath(body.id, body.path ?? '/', body.zipname ?? '');
    return json({ message: 'file successfully unzipped' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsRename(req: Request): Promise<Response> {
  let body: { id?: string; path?: string; newName?: string; newPath?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  if (!body.id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(body.id)) return json({ error: 'invalid container ID' }, 400);

  const newPath = body.newPath ?? body.newName ?? '';

  try {
    await renameFile(body.id, body.path ?? '/', newPath);
    return json({ message: 'file successfully renamed' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsUpload(req: Request): Promise<Response> {
  let body: {
    id?: string;
    path?: string;
    fileName?: string;
    fileContent?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, path: relativePath, fileName, fileContent } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!fileName) return json({ error: 'file name is required' }, 400);
  if (!validateFileName(fileName)) return json({ error: 'invalid file name' }, 400);
  if (!validatePath(relativePath ?? '')) return json({ error: 'invalid file path' }, 400);
  if (!fileContent) return json({ error: 'file content is required' }, 400);

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;
    const baseDir = resolve(process.cwd(), `volumes/${id}`);
    const filePath = jailPath(baseDir, targetPath);

    mkdirSync(dirname(filePath), { recursive: true });

    let content: Buffer;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      const match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
      if (!match?.[1]) return json({ error: 'invalid base64 format' }, 400);
      content = Buffer.from(match[1], 'base64');
    } else if (typeof fileContent === 'string') {
      content = Buffer.from(fileContent, 'utf8');
    } else {
      return json({ error: 'unsupported content type' }, 400);
    }

    await Bun.write(filePath, content);
    return json({
      message: 'file successfully uploaded',
      fileName,
      path: targetPath,
    });
  } catch (err) {
    logger.error('error during file upload', err);
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsCreateEmpty(req: Request): Promise<Response> {
  let body: { id?: string; path?: string; fileName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, path: relativePath, fileName } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!fileName) return json({ error: 'file name is required' }, 400);

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
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}

export async function handleFsAppend(req: Request): Promise<Response> {
  let body: {
    id?: string;
    path?: string;
    fileName?: string;
    fileContent?: string;
    chunkIndex?: number;
    totalChunks?: number;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }

  const { id, path: relativePath, fileName, fileContent, chunkIndex = 0, totalChunks = 1 } = body;
  if (!id) return json({ error: 'container ID is required' }, 400);
  if (!validateContainerId(id)) return json({ error: 'invalid container ID' }, 400);
  if (!fileName) return json({ error: 'file name is required' }, 400);
  if (!fileContent) return json({ error: 'file content is required' }, 400);

  try {
    const targetPath = relativePath === '/' || !relativePath ? fileName : `${relativePath}/${fileName}`;

    let chunk: Buffer;
    if (typeof fileContent === 'string' && fileContent.startsWith('data:')) {
      const match = fileContent.match(/^data:[^;]+;base64,(.+)$/);
      if (!match?.[1]) return json({ error: 'invalid base64 format' }, 400);
      chunk = Buffer.from(match[1], 'base64');
    } else if (typeof fileContent === 'string') {
      chunk = Buffer.from(fileContent, 'utf8');
    } else {
      return json({ error: 'unsupported content type' }, 400);
    }

    await appendChunk(id, targetPath, chunk);
    return json({
      message: 'chunk successfully appended',
      fileName,
      path: targetPath,
      chunkIndex,
      totalChunks,
    });
  } catch (err) {
    logger.error('error appending to file', err);
    return json({ error: err instanceof Error ? err.message : 'unknown error' }, 500);
  }
}
