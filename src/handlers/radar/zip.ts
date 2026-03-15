import path from 'path';
import fs from 'fs';
import fsAsync from 'fs/promises';
import archiver from 'archiver';
import logger from '../../utils/logger';

// Folders that are safe to include in a VT scan zip.
// These contain plugins, mods, and config — not user data or world saves.
const DEFAULT_INCLUDE = ['plugins', 'mods', 'config', 'addons', 'datapacks'];

// Folders that must never be included regardless of what the panel requests.
// World data is large and contains no executable content worth scanning.
const HARDCODED_EXCLUDE = [
  'world', 'world_nether', 'world_the_end',
  'logs', 'cache', 'crash-reports', 'debug',
  'backups', '.git', 'node_modules',
];

// File extensions that are worth scanning — everything else is skipped to keep the zip small.
const SCANNABLE_EXTENSIONS = new Set([
  '.jar', '.sh', '.bat', '.cmd', '.ps1', '.py',
  '.php', '.exe', '.dll', '.so', '.elf', '.bin',
  '.json', '.yml', '.yaml', '.toml', '.conf', '.cfg', '.ini',
  '.js', '.ts', '.rb', '.pl', '.lua',
]);

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // skip individual files over 8 MB

interface ZipOptions {
  include?: string[];
  exclude?: string[];
  maxFileSizeMb?: number;
}

export const zipScanVolume = (
  id: string,
  options: ZipOptions = {}
): Promise<Buffer> => {
  return new Promise(async (resolve, reject) => {
    const baseDir = path.resolve(`volumes/${id}`);

    // Validate the base directory exists and is a real path under volumes/
    const realBase = path.resolve('volumes');
    let realVolumeDir: string;
    try {
      realVolumeDir = fs.realpathSync(baseDir);
    } catch {
      return reject(new Error(`Volume directory for ${id} does not exist`));
    }

    if (!realVolumeDir.startsWith(realBase + path.sep) && realVolumeDir !== realBase) {
      return reject(new Error('Path escapes volumes directory'));
    }

    // Build the final include/exclude lists, always enforcing hardcoded exclusions
    const requestedInclude = (options.include || DEFAULT_INCLUDE)
      .map(f => f.replace(/[^a-zA-Z0-9_\-\.]/g, '')) // strip anything non-alphanumeric
      .filter(f => f.length > 0 && !HARDCODED_EXCLUDE.includes(f.toLowerCase()));

    const requestedExclude = new Set([
      ...HARDCODED_EXCLUDE,
      ...(options.exclude || []).map(f => f.toLowerCase()),
    ]);

    const maxFileSize = Math.min(
      (options.maxFileSizeMb || 8) * 1024 * 1024,
      MAX_FILE_SIZE_BYTES
    );

    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('data', chunk => chunks.push(Buffer.from(chunk)));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', err => reject(err));
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') logger.warn(`Archiver warning: ${err.message}`);
    });

    let filesAdded = 0;

    for (const folderName of requestedInclude) {
      if (requestedExclude.has(folderName.toLowerCase())) continue;

      const folderPath = path.join(realVolumeDir, folderName);

      // Resolve symlinks and confirm it still lives under the volume
      let realFolderPath: string;
      try {
        realFolderPath = fs.realpathSync(folderPath);
      } catch {
        continue; // folder doesn't exist, skip silently
      }

      if (!realFolderPath.startsWith(realVolumeDir + path.sep)) {
        logger.warn(`Skipping ${folderName}: resolves outside volume`);
        continue;
      }

      try {
        const stat = await fsAsync.stat(realFolderPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Walk the folder and add each scannable file individually so we can
      // enforce size limits and extension filtering without trusting archiver globs.
      await walkAndAdd(archive, realVolumeDir, realFolderPath, folderName, requestedExclude, maxFileSize, SCANNABLE_EXTENSIONS, (added) => {
        filesAdded += added;
      });
    }

    if (filesAdded === 0) {
      // Produce a valid but empty zip rather than erroring
      logger.info(`No scannable files found in volume ${id}`);
    }

    logger.info(`Zipping ${filesAdded} files from volume ${id} for VT scan`);
    archive.finalize();
  });
};

async function walkAndAdd(
  archive: archiver.Archiver,
  volumeRoot: string,
  dir: string,
  archivePath: string,
  exclude: Set<string>,
  maxFileSize: number,
  allowedExtensions: Set<string>,
  onFile: (count: number) => void
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsAsync.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files

    const entryArchivePath = `${archivePath}/${entry.name}`;
    const entryDisk = path.join(dir, entry.name);

    // Resolve symlinks — must stay inside volume
    let realEntryPath: string;
    try {
      realEntryPath = fs.realpathSync(entryDisk);
    } catch {
      continue;
    }
    if (!realEntryPath.startsWith(volumeRoot + path.sep)) continue;

    if (entry.isDirectory()) {
      if (exclude.has(entry.name.toLowerCase())) continue;
      await walkAndAdd(archive, volumeRoot, realEntryPath, entryArchivePath, exclude, maxFileSize, allowedExtensions, onFile);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;

      let stat: fs.Stats;
      try {
        stat = await fsAsync.stat(realEntryPath);
      } catch {
        continue;
      }
      if (stat.size > maxFileSize) continue;

      archive.file(realEntryPath, { name: entryArchivePath });
      onFile(1);
    }
  }
}
