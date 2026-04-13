// This code was written by thavanish(https://github.com/thavanish) for airlinklabs

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import logger from '../logger';
import { jailPath, jailRename } from '../security/pathJail';
import fileSpecifier from '../utils/fileSpecifier';

// per-container cache to avoid hammering the filesystem on every list request
const listCache = new Map<
  string,
  {
    lastRequest: number;
    count: number;
    cache: unknown;
    path: string;
  }
>();

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
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
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

  const rateData = listCache.get(id)!;

  // return cached result if the same path was requested within the last second
  if (rateData.cache && now - rateData.lastRequest < 1000 && rateData.path === relativePath) {
    return rateData.cache;
  }

  if (now - rateData.lastRequest < 1000) rateData.count++;
  else rateData.count = 1;

  rateData.lastRequest = now;
  rateData.path = relativePath;

  if (rateData.count > 5) {
    rateData.cache = { error: 'Too many requests, please wait 3 seconds.' };
    logger.warn('too many list requests from one container, throttling');
    setTimeout(() => listCache.delete(id), 3000);
    return rateData.cache;
  }

  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
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
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const dirPath = jailPath(baseDirectory, relativePath);
  return getDirSize(dirPath);
}

export async function getFileContent(id: string, relativePath = '/'): Promise<string | null> {
  try {
    const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
    if (!existsSync(join(baseDirectory, relativePath))) return null;
    const filePath = jailPath(baseDirectory, relativePath);
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function writeFileContent(id: string, relativePath: string, content: string | Buffer): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const filePath = jailPath(baseDirectory, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  if (typeof content === 'string') await writeFile(filePath, content, 'utf-8');
  else await writeFile(filePath, content);
  logger.debug(`file written: ${filePath}`);
}

export function getFilePath(id: string, relativePath = '/'): string {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  return jailPath(baseDirectory, relativePath);
}

export async function rmPath(id: string, relativePath: string): Promise<void> {
  if (relativePath === '/') throw new Error('root directory cannot be deleted');
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const targetPath = jailPath(baseDirectory, relativePath);
  const s = await lstat(targetPath);
  if (s.isDirectory()) await rm(targetPath, { recursive: true, force: true });
  else if (s.isFile()) await unlink(targetPath);
  else throw new Error('path is neither a file nor a directory');
}

export async function renameFile(id: string, oldPath: string, newPath: string): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);

  // pre-create destination parent so jailPath doesn't fail on realpathSync of a non-existent dir
  const rawNewParent = resolve(join(baseDirectory, dirname(newPath)));
  if (!rawNewParent.startsWith(baseDirectory)) throw new Error('destination escapes volume boundary');
  await mkdir(rawNewParent, { recursive: true });

  await jailRename(baseDirectory, oldPath, newPath);
}

// download a file from a URL into the container volume
export async function downloadToVolume(
  id: string,
  url: string,
  relativePath: string,
  env?: Record<string, string>,
): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const filePath = jailPath(baseDirectory, relativePath);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);

  await mkdir(dirname(filePath), { recursive: true });

  if (env) {
    // apply ALVKT variable substitution — only for text files
    let content = await response.text();
    content = content.replace(/\$ALVKT\((\w+)\)/g, (_, varName: string) => {
      if (env[varName] !== undefined) return env[varName];
      logger.warn(`ALVKT variable "${varName}" not found in env, replacing with empty string`);
      return '';
    });
    await writeFile(filePath, content, 'utf-8');
  } else {
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));
  }

  logger.debug(`file downloaded to ${filePath}`);
}

// copy a file from an arbitrary source path into the container volume
export async function copyIntoVolume(id: string, sourcePath: string, destRelative: string): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
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
    const buf = await readFile(sourcePath);
    await writeFile(destPath, buf);
  }
}

// zip multiple paths inside a container volume using system zip
export async function zipPaths(id: string, filePaths: string[], zipname: string): Promise<string> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);

  const files = filePaths
    .flatMap((f) => (typeof f === 'string' ? f.split(',').map((s) => s.trim()) : [f]))
    .map((f) => ({
      cleanPath: f.replace(/[[\]"']/g, '').trim(),
      fullPath: join(baseDirectory, f.replace(/[[\]"']/g, '').trim()),
    }));

  const firstFileDir = dirname(files[0].fullPath);
  const zipPath = join(firstFileDir, `${zipname}.zip`);
  await mkdir(dirname(zipPath), { recursive: true });

  // stage files into a temp dir so we control paths inside the zip
  // archiver is gone — system zip is fine, this is a server daemon
  const staging = mkdtempSync(join(tmpdir(), 'airlinkd-zip-'));
  try {
    for (const { cleanPath, fullPath } of files) {
      const dest = join(staging, cleanPath);
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

// unzip an archive inside a container volume using system unzip or tar
export async function unzipPath(id: string, relativePath: string, zipname: string): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const archivePath = join(baseDirectory, relativePath, zipname);
  const extractPath = dirname(archivePath);

  if (!existsSync(archivePath)) throw new Error(`file not found: ${archivePath}`);

  const ext = extname(archivePath).toLowerCase();
  let proc: ReturnType<typeof Bun.spawn>;

  if (ext === '.zip') {
    proc = Bun.spawn(['unzip', '-o', archivePath, '-d', extractPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else if (ext === '.tar') {
    proc = Bun.spawn(['tar', '-xf', archivePath, '-C', extractPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else if (ext === '.gz' || ext === '.tgz') {
    proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', extractPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else if (ext === '.rar') {
    proc = Bun.spawn(['unrar', 'x', archivePath, extractPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else if (ext === '.7z') {
    proc = Bun.spawn(['7z', 'x', archivePath, `-o${extractPath}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } else {
    throw new Error(`unsupported archive type: ${ext}`);
  }

  const code = await proc.exited;
  if (code !== 0) {
    const err = await (proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(''));
    throw new Error(`extraction failed (exit ${code}): ${err}`);
  }
}

export async function appendChunk(id: string, relativePath: string, chunk: Buffer): Promise<void> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);
  const filePath = jailPath(baseDirectory, relativePath);
  await appendFile(filePath, chunk);
}
