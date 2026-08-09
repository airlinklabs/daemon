// replaces the C addons that did openat/renameat. we get the same security
// guarantees by resolving symlinks and checking the result stays inside the
// volume dir. not as low-level but works cross-platform and doesn't need gcc.

import type { Stats } from 'node:fs';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';

export class BackupPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupPathError';
  }
}

// true when `p` is `base` itself or lives strictly beneath it
function isInside(base: string, p: string): boolean {
  return p === base || p.startsWith(base + sep);
}

// throws if resolvedPath escapes base. returns the safe resolved path.
export function jailPath(base: string, relative: string): string {
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
    const real = realpathSync(safePath);
    if (!isInside(realBase, real)) {
      throw new Error(`symlink escapes volume boundary: ${relative}`);
    }
  }

  return safePath;
}

// safe rename: validates both src and dest are inside base before renaming
export async function jailRename(base: string, oldRel: string, newRel: string): Promise<void> {
  const safeSrc = jailPath(base, oldRel);
  const safeDest = jailPath(base, newRel);

  // make sure dest parent exists
  const destParent = dirname(safeDest);
  await Bun.spawn(['mkdir', '-p', destParent], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;

  await rename(safeSrc, safeDest);
}

// ── Backup path jails ───────────────────────────────────────────────────────
// resolveBackupPath pins a raw path to ONE container's backup directory; the
// restore/delete/download/upload routes pass the panel-supplied backupPath
// (which includes the `backups/` prefix) and the container id. resolveBackupsRoot
// is the looser variant for the download/delete routes that accept any
// container's backup file. Both throw BackupPathError on any escape, so the
// coordinator can trust the returned absolute path.

const BACKUPS_DIR = 'backups';

function backupsRoot(): string {
  return getPaths(config.paths).backupsRoot;
}

// normalizes rawPath (trailing slashes, `..`, absolute vs relative) against
// the daemon's backup root and verifies the result stays inside `root` (or
// equals it). The lexical check mirrors the old behaviour; on top of it, the
// deepest existing ancestor of the resolved path is realpath'd and must resolve
// inside `root` too — this closes the symlink escape where `backups/<id> -> /etc`
// makes a lexical lookup look safe while the real file lives outside.
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

// Centralised backup path validation. Ensures the resolved path stays inside
// the container's backup directory. Throws BackupPathError if not.
export function resolveBackupPath(containerId: string, rawPath: string): string {
  const containerRoot = resolve(backupsRoot(), containerId);
  return jailToBackupsRoot(containerRoot, rawPath);
}

// Jails a raw path to the <cwd>/backups/ root — used by backup download/delete,
// which accept any container's backup file path.
export function resolveBackupsRoot(rawPath: string): string {
  return jailToBackupsRoot(backupsRoot(), rawPath);
}
