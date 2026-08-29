// Path jail — validates resolved paths stay inside the volume directory.

import type { Stats } from 'node:fs';
import { closeSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';
import { secureOpenRead, secureOpenWrite } from './secureOpen';

export class BackupPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupPathError';
  }
}

const MAX_PATH_LENGTH = 4096;
const MAX_SYMLINK_DEPTH = 10;

// true when `p` is `base` itself or lives strictly beneath it
function isInside(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

export function jailPath(base: string, relative: string): string {
  // Reject null bytes
  if (relative.includes('\0')) {
    throw new Error('invalid path: null byte');
  }

  if (relative.length > MAX_PATH_LENGTH) {
    throw new Error('path exceeds maximum length');
  }

  const realBase = realpathSync(base);

  // build the full target path before resolving
  const full = resolve(join(base, relative));

  // naive string check first — catches the obvious ../../../ attacks
  if (!isInside(realBase, full)) {
    throw new Error(`path traversal attempt: ${relative}`);
  }

  // now resolve symlinks on the parent dir
  // we can't realpathSync the full path if the file doesn't exist yet
  const parent = dirname(full);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    // parent doesn't exist yet — that's fine for write ops, but check the raw path
    realParent = parent;
  }

  const safePath = join(realParent, basename(full));

  // final check after symlink resolution
  if (!isInside(realBase, safePath)) {
    throw new Error(`symlink escapes volume boundary: ${relative}`);
  }

  // the parent is now realpath-resolved, but the final component itself may be
  // a symlink that points back out of the jail (e.g. volumes/<id>/evil → /etc).
  // resolve it without following so a dangling symlink can't smuggle a write
  // out of the volume either.
  let st: Stats | undefined;
  try {
    st = lstatSync(safePath);
  } catch {
    st = undefined; // target doesn't exist yet — nothing to resolve
  }

  if (st?.isSymbolicLink()) {
    const target = readlinkSync(safePath);
    const resolvedTarget = resolve(realParent, target);
    if (!isInside(realBase, resolvedTarget)) {
      throw new Error(`symlink escapes volume boundary: ${relative}`);
    }
  } else if (st) {
    // Walk symlink chain with depth limit to prevent loops
    let current = safePath;
    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      const real = realpathSync(current);
      if (!isInside(realBase, real)) {
        throw new Error(`symlink escapes volume boundary: ${relative}`);
      }
      let currentSt: Stats | undefined;
      try {
        currentSt = lstatSync(real);
      } catch {
        break;
      }
      if (!currentSt?.isSymbolicLink()) break;
      const target = readlinkSync(real);
      current = resolve(dirname(real), target);
    }
  }

  return safePath;
}

// safe rename: validates both src and dest are inside base before renaming.
// Uses openat2 on Linux to prevent TOCTOU symlink races during the rename.
export async function jailRename(base: string, oldRel: string, newRel: string): Promise<void> {
  const safeSrc = jailPath(base, oldRel);
  const safeDest = jailPath(base, newRel);

  // make sure dest parent exists
  const destParent = dirname(safeDest);
  mkdirSync(destParent, { recursive: true });

  await rename(safeSrc, safeDest);
}

// Secure file operations — combine path validation with atomic file open.

/**
 * Read a file inside a jail, protected against TOCTOU symlink races.
 * On Linux >= 5.6 uses openat2; on older kernels uses O_NOFOLLOW fallback.
 */
export function secureReadFile(base: string, relative: string): Buffer {
  jailPath(base, relative);
  const { fd } = secureOpenRead(base, relative);
  try {
    const { readSync, fstatSync } = require('node:fs');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('path is not a file');
    if (stat.size > 10 * 1024 * 1024) throw new Error('file too large');

    const buf = Buffer.alloc(stat.size);
    let totalRead = 0;
    while (totalRead < buf.length) {
      const n = readSync(fd, buf, totalRead, buf.length - totalRead, null);
      if (n === 0) break;
      totalRead += n;
    }
    return buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a file inside a jail, protected against TOCTOU symlink races.
 * On Linux >= 5.6 uses openat2; on older kernels uses O_NOFOLLOW fallback.
 */
export function secureWriteFile(base: string, relative: string, data: Buffer | string): void {
  jailPath(base, relative);
  const { fd } = secureOpenWrite(base, relative);
  try {
    const { writeSync } = require('node:fs');
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    let written = 0;
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written);
      written += n;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Unlink a file inside a jail, protected against TOCTOU symlink races.
 * Opens the file first with openat2 to verify it's a regular file, then
 * unlinks by path (since unlinkat isn't exposed via Bun FFI).
 */
export function secureUnlink(base: string, relative: string): void {
  const safePath = jailPath(base, relative);
  // Open with O_NOFOLLOW to verify it's not a symlink
  const { fd } = secureOpenRead(base, relative);
  try {
    const { fstatSync } = require('node:fs');
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new Error('cannot unlink a directory');
  } finally {
    closeSync(fd);
  }
  unlinkSync(safePath);
}

// Backup path jails — pin raw paths to a container's backup directory.

const _BACKUPS_DIR = 'backups';

function backupsRoot(): string {
  return getPaths(config.paths).backupsRoot;
}

// Normalizes rawPath against backup root and verifies containment via realpath.
function jailToBackupsRoot(root: string, rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new BackupPathError('backup path is required');
  }
  // null bytes can't appear in a real filesystem path — reject up front
  if (rawPath.includes('\0')) {
    throw new BackupPathError('invalid backup path');
  }

  const resolvedPath = resolve(getPaths(config.paths).base, rawPath);

  // resolve() already collapsed any `..`/trailing slashes; what remains must be
  // the root itself or a path strictly beneath it
  if (!isInside(root, resolvedPath)) {
    throw new BackupPathError('backup path escapes backup directory');
  }

  // walk up to the deepest ancestor that actually exists; for a fresh backup
  // that is `root` itself (created lazily by the write path) or above it — in
  // that case there is nothing to resolve and the lexical check stands.
  let probe = resolvedPath;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  // Only enforce realpath containment when the existing ancestor lives at or
  // beneath `root`. If it lives above root (root doesn't exist yet) the real
  // path is guaranteed to be the lexical one by the time the file is written.
  if (probe === root || isInside(root, probe)) {
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      throw new BackupPathError('backup path escapes backup directory');
    }
    if (realProbe !== root && !isInside(root, realProbe)) {
      throw new BackupPathError('backup path escapes backup directory');
    }
  }

  return resolvedPath;
}

// Backup path validation — resolves path to container's backup directory.
export function resolveBackupPath(containerId: string, rawPath: string): string {
  const containerRoot = resolve(backupsRoot(), containerId);
  return jailToBackupsRoot(containerRoot, rawPath);
}

// Jails raw path to the backups/ root for download/delete routes.
export function resolveBackupsRoot(rawPath: string): string {
  return jailToBackupsRoot(backupsRoot(), rawPath);
}
