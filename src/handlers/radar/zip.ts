// This code was written by thavanish(https://github.com/thavanish) for airlinklabs

import type { Dirent } from 'node:fs';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import logger from '../../logger';

// folders that are safe to include — contain plugins, mods, config
const DEFAULT_INCLUDE = ['plugins', 'mods', 'config', 'addons', 'datapacks'];

// never include these — world data is huge and has no executable content worth scanning
const HARDCODED_EXCLUDE = [
  'world',
  'world_nether',
  'world_the_end',
  'logs',
  'cache',
  'crash-reports',
  'debug',
  'backups',
  '.git',
  'node_modules',
];

// only file extensions worth scanning — skip everything else to keep the zip small
const SCANNABLE_EXTENSIONS = new Set([
  '.jar',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
  '.py',
  '.php',
  '.exe',
  '.dll',
  '.so',
  '.elf',
  '.bin',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.conf',
  '.cfg',
  '.ini',
  '.js',
  '.ts',
  '.rb',
  '.pl',
  '.lua',
]);

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

interface ZipOptions {
  include?: string[];
  exclude?: string[];
  maxFileSizeMb?: number;
}

// collect scannable files then zip with system zip — most secure approach
// no archiver library, no in-memory buffer growing without bound
export async function zipScanVolume(id: string, options: ZipOptions = {}): Promise<Buffer> {
  const baseDir = resolve(process.cwd(), `volumes/${id}`);
  const realVolumesDir = resolve(process.cwd(), 'volumes');

  let realVolumeDir: string;
  try {
    realVolumeDir = realpathSync(baseDir);
  } catch {
    throw new Error(`volume directory for ${id} does not exist`);
  }

  if (!realVolumeDir.startsWith(realVolumesDir + sep) && realVolumeDir !== realVolumesDir) {
    throw new Error('path escapes volumes directory');
  }

  const requestedInclude = (options.include ?? DEFAULT_INCLUDE)
    .map((f) => f.replace(/[^a-zA-Z0-9_\-.]/g, ''))
    .filter((f) => f.length > 0 && !HARDCODED_EXCLUDE.includes(f.toLowerCase()));

  const requestedExclude = new Set([...HARDCODED_EXCLUDE, ...(options.exclude ?? []).map((f) => f.toLowerCase())]);

  const maxFileSize = Math.min((options.maxFileSizeMb ?? 8) * 1024 * 1024, MAX_FILE_SIZE_BYTES);

  // collect all file paths to include, resolve symlinks, check they stay in volume
  const filesToZip: { diskPath: string; archivePath: string }[] = [];

  for (const folderName of requestedInclude) {
    if (requestedExclude.has(folderName.toLowerCase())) continue;

    const folderPath = join(realVolumeDir, folderName);
    let realFolderPath: string;
    try {
      realFolderPath = realpathSync(folderPath);
    } catch {
      continue; // folder doesn't exist
    }

    if (!realFolderPath.startsWith(realVolumeDir + sep)) {
      logger.warn(`skipping ${folderName}: resolves outside volume`);
      continue;
    }

    const folderStat = await stat(realFolderPath).catch(() => null);
    if (!folderStat?.isDirectory()) continue;

    await walkForFiles(realVolumeDir, realFolderPath, folderName, requestedExclude, maxFileSize, filesToZip);
  }

  if (filesToZip.length === 0) {
    logger.info(`no scannable files found in volume ${id}`);
  }

  logger.info(`zipping ${filesToZip.length} files from volume ${id} for scan`);

  // stage into a temp dir, then zip it, then read the zip, then clean up
  const staging = mkdtempSync(join(tmpdir(), 'airlinkd-radar-'));
  const zipPath = join(tmpdir(), `airlinkd-radar-${id}-${Date.now()}.zip`);

  try {
    for (const { diskPath, archivePath } of filesToZip) {
      const dest = join(staging, archivePath);
      await Bun.spawn(['mkdir', '-p', join(staging, archivePath.split('/').slice(0, -1).join('/') || '.')], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['cp', diskPath, dest], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
    }

    const proc = Bun.spawn(['zip', '-r', '-6', zipPath, '.'], {
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

    // read into buffer and return — caller streams it in the response
    const buffer = await Bun.file(zipPath).arrayBuffer();
    return Buffer.from(buffer);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  }
}

async function walkForFiles(
  volumeRoot: string,
  dir: string,
  archivePath: string,
  exclude: Set<string>,
  maxFileSize: number,
  out: { diskPath: string; archivePath: string }[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, {
      withFileTypes: true,
    })) as unknown as Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files

    const entryArchivePath = `${archivePath}/${entry.name}`;
    const entryDisk = join(dir, entry.name);

    let realEntryPath: string;
    try {
      realEntryPath = realpathSync(entryDisk);
    } catch {
      continue;
    }
    if (!realEntryPath.startsWith(volumeRoot + sep)) continue;

    if (entry.isDirectory()) {
      if (exclude.has(entry.name.toLowerCase())) continue;
      await walkForFiles(volumeRoot, realEntryPath, entryArchivePath, exclude, maxFileSize, out);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (!SCANNABLE_EXTENSIONS.has(ext)) continue;

      const fileStat = await stat(realEntryPath).catch(() => null);
      if (!fileStat || fileStat.size > maxFileSize) continue;

      out.push({ diskPath: realEntryPath, archivePath: entryArchivePath });
    }
  }
}
