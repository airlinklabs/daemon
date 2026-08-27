// Secure file open via an anchored directory FD.
// Linux/openat2 path resolution is constrained with RESOLVE_BENEATH and
// RESOLVE_NO_SYMLINKS. Older platforms use O_NOFOLLOW as a weaker fallback.

import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const isLinux = process.platform === 'linux';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let libc: any = null;
let libcLoaded = false;

function getLibc() {
  if (libcLoaded) return libc;
  libcLoaded = true;
  if (!isLinux) return null;
  try {
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

const SYS_OPENAT2 = 437;
const O_RDONLY = 0;
const O_CLOEXEC = 0x80000;
const O_WRONLY = constants.O_WRONLY ?? 1;
const O_CREAT = constants.O_CREAT ?? 64;
const O_TRUNC = constants.O_TRUNC ?? 512;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0x10000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0x20000;

const RESOLVE_NO_SYMLINKS = 0x04;
const RESOLVE_BENEATH = 0x08;
const ENOSYS = 38;
const ELOOP = 40;

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
  if (!lib) return -ENOSYS;
  return Number(lib.symbols.syscall(BigInt(SYS_OPENAT2), dirfd, path, how, BigInt(24)));
}

export interface SecureOpenResult {
  fd: number;
  path: string;
}

function openJailRoot(base: string): number {
  return openSync(base, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

function tryOpenat2(base: string, relative: string, flags: number, mode = 0): number {
  const rootFd = openJailRoot(base);
  try {
    return openat2Syscall(rootFd, relative, buildOpenHow(flags, mode, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS));
  } finally {
    closeSync(rootFd);
  }
}

export function secureOpenRead(base: string, relative: string): SecureOpenResult {
  if (isLinux) {
    const fd = tryOpenat2(base, relative, O_RDONLY | O_CLOEXEC);
    if (fd >= 0) return { fd, path: join(base, relative) };
    if (-fd === ELOOP) throw new Error(`symlink detected in path: ${relative}`);
    if (-fd !== ENOSYS && -fd !== 1) throw new Error(`openat2 failed for ${relative} (errno ${-fd})`);
  }

  const full = join(base, relative);
  const fd = openSync(full, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  return { fd, path: full };
}

export function secureOpenWrite(base: string, relative: string): SecureOpenResult {
  const flags = O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC;
  if (isLinux) {
    const fd = tryOpenat2(base, relative, flags, 0o644);
    if (fd >= 0) return { fd, path: join(base, relative) };
    if (-fd === ELOOP) throw new Error(`symlink detected in path: ${relative}`);
    if (-fd !== ENOSYS && -fd !== 1) throw new Error(`openat2 failed for ${relative} (errno ${-fd})`);
  }

  const full = join(base, relative);
  const fd = openSync(full, flags | O_NOFOLLOW, 0o644);
  return { fd, path: full };
}

export function secureReadFileSync(base: string, relative: string): Buffer {
  const { fd } = secureOpenRead(base, relative);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('path is not a file');
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

export function secureWriteFileSync(base: string, relative: string, data: Buffer | string): void {
  const { fd } = secureOpenWrite(base, relative);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    let written = 0;
    while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
  } finally {
    closeSync(fd);
  }
}

export function hasOpenat2(): boolean {
  if (!isLinux || !getLibc()) return false;
  const fd = tryOpenat2('/tmp', '.', O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    closeSync(fd);
    return true;
  }
  return -fd !== ENOSYS;
}
