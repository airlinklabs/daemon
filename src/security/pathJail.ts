// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
// replaces the C addons that did openat/renameat. we get the same security
// guarantees by resolving symlinks and checking the result stays inside the
// volume dir. not as low-level but works cross-platform and doesn't need gcc.

import { realpathSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

// throws if resolvedPath escapes base. returns the safe resolved path.
export function jailPath(base: string, relative: string): string {
  const realBase = realpathSync(base);

  // build the full target path before resolving
  const full = resolve(join(base, relative));

  // naive string check first — catches the obvious ../../../ attacks
  if (!full.startsWith(realBase + sep) && full !== realBase) {
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
  if (!safePath.startsWith(realBase + sep) && safePath !== realBase) {
    throw new Error(`symlink escapes volume boundary: ${relative}`);
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
