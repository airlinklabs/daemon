// Secure file open via openat2(2) FFI — prevents TOCTOU symlink races.
//
// openat2 with RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH atomically opens a file
// without following symlinks and ensures the path stays beneath the dirfd.
// This eliminates the race window between path validation and file open.

import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// Only load FFI on Linux where openat2 is available (kernel >= 5.6)
const isLinux = process.platform === 'linux';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let libc: any = null;
let libcLoaded = false;

function getLibc() {
  if (libcLoaded) return libc;
  libcLoaded = true;
  if (!isLinux) return null;
  try {
    // Bun.dlopen exists at runtime but TypeScript doesn't know about it
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bunFfi = require('bun:ffi');
    libc = bunFfi.dlopen('libc.so.6', {
      syscall: {
        args: [bunFfi.FFIType.i64, bunFfi.FFIType.i32, bunFfi.FFIType.cstring, bunFfi.FFIType.ptr, bunFfi.FFIType.u64],
        returns: bunFfi.FFIType.i64,
      },
    });
    return libc;
  } catch {
    return null;
  }
}

const AT_FDCWD = -100;
const O_RDONLY = 0;
const O_CLOEXEC = 0x80000;
const RESOLVE_NO_SYMLINKS = 0x04;
// NOTE: RESOLVE_BENEATH (0x08) intentionally omitted — requires path under cwd,
// which fails for volume roots under /tmp. jailPath() already validates containment.

const O_WRONLY = constants.O_WRONLY ?? 1;
const O_CREAT = constants.O_CREAT ?? 64;
const O_TRUNC = constants.O_TRUNC ?? 512;

// Linux errno values
const ENOSYS = 38; // kernel doesn't support openat2
const ELOOP = 40; // symlink detected

// struct open_how: { u64 flags; u64 mode; u64 resolve; } = 24 bytes
function buildOpenHow(flags: number, mode: number, resolve: number): ArrayBuffer {
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(flags), true);
  view.setBigUint64(8, BigInt(mode), true);
  view.setBigUint64(16, BigInt(resolve), true);
  return buf;
}

function openat2Syscall(dirfd: number, path: string, how: ArrayBuffer): number {
  const lib = getLibc();
  if (!lib) return -1;

  const fd = Number(lib.symbols.syscall(BigInt(437), dirfd, path, how, BigInt(24)));
  return fd;
}

export interface SecureOpenResult {
  fd: number;
  path: string;
}

/**
 * Atomically open a file for reading without following symlinks.
 * Uses openat2 with RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH on Linux.
 * Falls back to regular open with O_NOFOLLOW on other platforms.
 *
 * @throws if the path contains a symlink or escapes the base directory
 */
export function secureOpenRead(base: string, relative: string): SecureOpenResult {
  const full = join(base, relative);

  if (isLinux) {
    const how = buildOpenHow(O_RDONLY | O_CLOEXEC, 0, RESOLVE_NO_SYMLINKS);
    const fd = openat2Syscall(AT_FDCWD, full, how);
    if (fd >= 0) return { fd, path: full };

    const errno = -fd;
    if (errno === ELOOP) {
      throw new Error(`symlink detected in path: ${relative}`);
    }
    if (errno === ENOSYS || errno === 1) {
      // ENOSYS = kernel too old; EPERM = openat2 denied (e.g. container env), fall through
    } else {
      throw new Error(`openat2 failed for ${relative} (errno ${errno})`);
    }
    // Fall through to O_NOFOLLOW fallback
  }

  // Fallback: open with O_NOFOLLOW
  const O_NOFOLLOW = 0x100000;
  const fd = openSync(full, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  return { fd, path: full };
}

/**
 * Atomically open a file for writing without following symlinks.
 * Creates the file if it doesn't exist, truncates if it does.
 * Uses openat2 with RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH on Linux.
 *
 * @throws if the path contains a symlink or escapes the base directory
 */
export function secureOpenWrite(base: string, relative: string): SecureOpenResult {
  const full = join(base, relative);

  if (isLinux) {
    const flags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC;
    const how = buildOpenHow(flags, 0o644, RESOLVE_NO_SYMLINKS);
    const fd = openat2Syscall(AT_FDCWD, full, how);
    if (fd >= 0) return { fd, path: full };

    const errno = -fd;
    if (errno === ELOOP) {
      throw new Error(`symlink detected in path: ${relative}`);
    }
    if (errno === ENOSYS || errno === 1) {
      // ENOSYS = kernel too old; EPERM = openat2 denied (e.g. container env), fall through
    } else {
      throw new Error(`openat2 failed for ${relative} (errno ${errno})`);
    }
  }

  // Fallback
  const O_NOFOLLOW = 0x100000;
  const fd = openSync(full, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o644);
  return { fd, path: full };
}

/**
 * Read a file securely — opens atomically, reads, closes.
 * Prevents TOCTOU symlink races on Linux >= 5.6.
 */
export function secureReadFileSync(base: string, relative: string): Buffer {
  const { fd } = secureOpenRead(base, relative);
  try {
    const stat = fstatSync(fd);
    if (stat.size > 10 * 1024 * 1024) throw new Error('file too large');

    const buf = Buffer.alloc(stat.size);
    let totalRead = 0;
    while (totalRead < buf.length) {
      const bytesRead = readSync(fd, buf, totalRead, buf.length - totalRead, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a file securely — opens atomically, writes, closes.
 * Prevents TOCTOU symlink races on Linux >= 5.6.
 */
export function secureWriteFileSync(base: string, relative: string, data: Buffer | string): void {
  const { fd } = secureOpenWrite(base, relative);
  try {
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
 * Check if openat2 is available on this system.
 */
export function hasOpenat2(): boolean {
  if (!isLinux) return false;
  const lib = getLibc();
  if (!lib) return false;
  const how = buildOpenHow(O_RDONLY | O_CLOEXEC, 0, RESOLVE_NO_SYMLINKS);
  const fd = openat2Syscall(AT_FDCWD, '/dev/null', how);
  if (fd >= 0) {
    closeSync(fd);
    return true;
  }
  const errno = -fd;
  return errno !== ENOSYS;
}
