import { realpathSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export function jailPath(base: string, relative: string): string {
  const realBase = realpathSync(base);
  const full = resolve(join(base, relative));

  if (!full.startsWith(realBase + sep) && full !== realBase) {
    throw new Error(`path traversal attempt: ${relative}`);
  }

  const parent = dirname(full);
  let realParent = parent;
  try {
    realParent = realpathSync(parent);
  } catch {
    realParent = parent;
  }

  const safePath = join(realParent, basename(full));
  if (!safePath.startsWith(realBase + sep) && safePath !== realBase) {
    throw new Error(`symlink escapes volume boundary: ${relative}`);
  }

  return safePath;
}

export async function jailRename(base: string, oldRel: string, newRel: string): Promise<void> {
  const oldPath = jailPath(base, oldRel);
  const newPath = jailPath(base, newRel);
  const parent = dirname(newPath);
  await Bun.spawn(["mkdir", "-p", parent], { stdout: "pipe", stderr: "pipe" }).exited;
  await rename(oldPath, newPath);
}
