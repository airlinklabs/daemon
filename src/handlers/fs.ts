import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';
import { validatePublicUrl } from '../router';
import { jailPath, jailRename, secureReadFile, secureUnlink, secureWriteFile } from '../security/pathJail';
import fileSpecifier from '../utils/fileSpecifier';

function volumeRoot(id: string): string {
  return join(getPaths(config.paths).volumesRoot, id);
}

const listCache = new Map<
  string,
  {
    lastRequest: number;
    count: number;
    cache: unknown;
    path: string;
  }
>();

export const MAX_FILE_CONTENT_BYTES = 10 * 1024 * 1024;

async function getDirSize(dir: string, depth = 0): Promise<number> {
  if (depth > 20) return 0;
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      try {
        const s = await lstat(full);
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) total += await getDirSize(full, depth + 1);
        else total += s.size;
      } catch {}
    }
  } catch {}
  return total;
}

export async function listDir(id: string, relativePath = '/', filter?: string): Promise<unknown> {
  const now = Date.now();

  if (!listCache.has(id)) {
    listCache.set(id, {
      lastRequest: now,
      count: 0,
      cache: null,
      path: relativePath,
    });
  }

  const rateData = listCache.get(id);
  if (!rateData) throw new Error('list cache was not initialized');

  if (rateData.cache && now - rateData.lastRequest < 1000 && rateData.path === relativePath) {
    return rateData.cache;
  }

  if (now - rateData.lastRequest < 1000) rateData.count++;
  else rateData.count = 1;

  rateData.lastRequest = now;
  rateData.path = relativePath;

  if (rateData.count > 5) {
    rateData.cache = { error: 'Too many requests, please wait 3 seconds.' };
    setTimeout(() => listCache.delete(id), 3000);
    return rateData.cache;
  }

  const baseDirectory = volumeRoot(id);
  const targetDirectory = jailPath(baseDirectory, relativePath);
  const entries = await readdir(targetDirectory, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (dirent) => {
      const ext = extname(dirent.name).substring(1);
      const category = await fileSpecifier.getCategory(ext);
      const full = join(targetDirectory, dirent.name);

      let size: number;
      if (dirent.isDirectory()) {
        size = await getDirSize(full);
      } else {
        try {
          size = (await stat(full)).size;
        } catch {
          size = 0;
        }
      }

      return {
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
        extension: dirent.isDirectory() ? null : ext,
        category: dirent.isDirectory() ? null : category,
        size,
      };
    }),
  );

  const limited = results.slice(0, 256);
  const filtered = filter ? limited.filter((i) => i.name.includes(filter)) : limited;
  rateData.cache = filtered;
  return filtered;
}

export async function getDirSizeForId(id: string, relativePath = '/'): Promise<number> {
  const baseDirectory = volumeRoot(id);
  const dirPath = jailPath(baseDirectory, relativePath);
  return getDirSize(dirPath);
}

export async function getFileContent(id: string, relativePath = '/'): Promise<string | null> {
  try {
    const baseDirectory = volumeRoot(id);
    const filePath = jailPath(baseDirectory, relativePath);
    if (!existsSync(filePath)) return null;
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    if (s.size > MAX_FILE_CONTENT_BYTES) return null;
    // Use secure read to prevent TOCTOU symlink races
    const buf = secureReadFile(baseDirectory, relativePath);
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

export async function writeFileContent(id: string, relativePath: string, content: string | Buffer): Promise<void> {
  const baseDirectory = volumeRoot(id);
  await mkdir(baseDirectory, { recursive: true });
  const filePath = jailPath(baseDirectory, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  // Use secure write to prevent TOCTOU symlink races
  secureWriteFile(baseDirectory, relativePath, content);
}

export function getFilePath(id: string, relativePath = '/'): string {
  const baseDirectory = volumeRoot(id);
  return jailPath(baseDirectory, relativePath);
}

export async function rmPath(id: string, relativePath: string): Promise<void> {
  if (relativePath === '/') throw new Error('root directory cannot be deleted');
  const baseDirectory = volumeRoot(id);
  const targetPath = jailPath(baseDirectory, relativePath);
  const s = await lstat(targetPath);
  if (s.isDirectory()) await rm(targetPath, { recursive: true, force: true });
  else if (s.isFile()) {
    // Use secure unlink to prevent TOCTOU symlink races
    secureUnlink(baseDirectory, relativePath);
  } else throw new Error('path is neither a file nor a directory');
}

export async function renameFile(id: string, oldPath: string, newPath: string): Promise<void> {
  const baseDirectory = volumeRoot(id);

  const rawNewParent = resolve(join(baseDirectory, dirname(newPath)));
  if (!rawNewParent.startsWith(baseDirectory)) throw new Error('destination escapes volume boundary');
  await mkdir(rawNewParent, { recursive: true });

  await jailRename(baseDirectory, oldPath, newPath);
}

const MAX_REDIRECT_HOPS = 5;

export async function fetchPublicUrl(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const safeUrl = await validatePublicUrl(current);
    const response = await fetch(safeUrl.toString(), { redirect: 'manual', signal });

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new Error(`redirect response without a location header (${response.status})`);
      }
      current = new URL(location, safeUrl).toString();
      continue;
    }

    return response;
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECT_HOPS})`);
}

export async function downloadToVolume(
  id: string,
  url: string,
  relativePath: string,
  env?: Record<string, string>,
): Promise<void> {
  const baseDirectory = volumeRoot(id);
  const filePath = jailPath(baseDirectory, relativePath);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetchPublicUrl(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);

  await mkdir(dirname(filePath), { recursive: true });

  if (env) {
    let content = await response.text();
    content = content.replace(/\$ALVKT\((\w+)\)/g, (_, varName: string) => {
      if (env[varName] !== undefined) return env[varName];
      return '';
    });
    // Use secure write to prevent TOCTOU symlink races
    secureWriteFile(baseDirectory, relativePath, content);
  } else {
    const buffer = await response.arrayBuffer();
    // Use secure write to prevent TOCTOU symlink races
    secureWriteFile(baseDirectory, relativePath, Buffer.from(buffer));
  }
}

export async function copyIntoVolume(id: string, sourcePath: string, destRelative: string): Promise<void> {
  const baseDirectory = volumeRoot(id);
  const destPath = jailPath(baseDirectory, destRelative);
  const s = await lstat(sourcePath);

  if (s.isDirectory()) {
    await mkdir(destPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const e of entries) {
      await copyIntoVolume(id, join(sourcePath, e.name), join(destRelative, e.name));
    }
  } else {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
  }
}

export async function zipPaths(id: string, filePaths: string[], zipname: string): Promise<string> {
  const baseDirectory = volumeRoot(id);

  const clean = (f: string): string => f.replace(/[[\]"']/g, '').trim();
  const files = filePaths
    .flatMap((f) => (typeof f === 'string' ? f.split(',').map((s) => s.trim()) : [f]))
    .map((f) => {
      const cleanPath = clean(f);
      const fullPath = jailPath(baseDirectory, cleanPath);
      return { cleanPath, fullPath };
    });

  const firstFileRel = files[0].cleanPath.split('/').slice(0, -1).join('/');
  const zipPath = jailPath(baseDirectory, join(firstFileRel, `${zipname}.zip`));
  await mkdir(dirname(zipPath), { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), 'airlinkd-zip-'));
  try {
    for (const { cleanPath, fullPath } of files) {
      const dest = jailPath(staging, cleanPath);
      await Bun.spawn(['mkdir', '-p', dirname(dest)], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['cp', '-r', fullPath, dest], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
    }

    const proc = Bun.spawn(['zip', '-r', '-9', zipPath, '.'], {
      cwd: staging,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await (proc.stderr instanceof ReadableStream
        ? new Response(proc.stderr).text()
        : Promise.resolve(''));
      throw new Error(`zip failed (exit ${code}): ${err}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return zipPath;
}

// Re-export archive functions for backward compatibility.
export { appendChunk, unzipPath } from './fsArchive';
