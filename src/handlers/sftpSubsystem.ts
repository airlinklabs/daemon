import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Attributes, FileEntry, SFTPWrapper } from 'ssh2';
import { jailPath } from '../security/pathJail';
import type { NativeSftpSession, SftpActivityEvent } from './sftpAuth';
import { recordActivity } from './sftpAuth';

const OK = 0;
const EOF = 1;
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

const SSH_FXF_WRITE = 0x00000002;
const SSH_FXF_APPEND = 0x00000004;
const SSH_FXF_CREAT = 0x00000008;
const SSH_FXF_TRUNC = 0x00000010;

const READDIR_BATCH_SIZE = 100;

export const openFiles = new Map<string, { fd: number; path: string; size: number }>();

function toStatus(err: unknown): number {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENOTEMPTY') return NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EEXIST' || code === 'EISDIR') return PERMISSION_DENIED;
  return FAILURE;
}

export function rooted(base: string, remote: string): string {
  const rel = remote.replace(/^\/+/, '');
  if (rel === '') return base;

  const jailed = jailPath(base, rel);

  let resolved: string;
  try {
    resolved = realpathSync(jailed);
  } catch {
    return jailed;
  }
  const realBase = realpathSync(base);
  if (resolved !== realBase && !resolved.startsWith(realBase + sep)) {
    throw new Error(`symlink escapes volume boundary: ${rel}`);
  }

  return jailed;
}

function toAttributes(st: unknown): Attributes {
  const t = st as { mode: number; uid: number; gid: number; size: number; atimeMs: number; mtimeMs: number };
  return {
    mode: t.mode,
    uid: t.uid,
    gid: t.gid,
    size: t.size,
    atime: Math.floor(t.atimeMs / 1000),
    mtime: Math.floor(t.mtimeMs / 1000),
  };
}

const PERMS = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
function perms(mode: number): string {
  const oct = (mode & 0o777).toString(8).padStart(3, '0');
  let out = '';
  for (const c of oct) out += PERMS[parseInt(c, 10)];
  return out;
}

function longName(filename: string, st: unknown): string {
  const t = st as { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; size: number; mtimeMs: number };
  const type = t.isDirectory() ? 'd' : t.isSymbolicLink() ? 'l' : '-';
  const date = new Date(t.mtimeMs)
    .toISOString()
    .replace(/\.\d+Z$/, '+0000')
    .replace(/[-:]/g, '');
  return `${type}${perms(t.mode)} 1 owner group ${t.size} ${date} ${filename}`;
}

function relOf(root: string, full: string): string {
  const rel = full.slice(root.length).replace(/^\/?/, '/');
  return rel === '' ? '/' : rel;
}

export function serveSftp(sftp: SFTPWrapper, root: string, session: NativeSftpSession): void {
  const emit = (event: Partial<SftpActivityEvent>): void => {
    const full = { serverId: session.serverId, ...event } as SftpActivityEvent;
    recordActivity(full);
    if (session.hook) session.hook(full);
  };

  const sessionOpenFiles = new Set<string>();
  const closeSessionFiles = (): void => {
    for (const key of sessionOpenFiles) {
      const rec = openFiles.get(key);
      if (rec) {
        openFiles.delete(key);
        try {
          closeSync(rec.fd);
        } catch {}
      }
    }
    sessionOpenFiles.clear();
  };
  sftp.on('close', closeSessionFiles);
  sftp.on('end', closeSessionFiles);

  sftp.on('OPEN', (reqId, remote, flags, _attrs) => {
    let full: string;
    try {
      full = rooted(root, remote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }

    const wantsWrite = (flags & SSH_FXF_WRITE) !== 0;
    const wantsAppend = (flags & SSH_FXF_APPEND) !== 0;
    const wantsTrunc = (flags & SSH_FXF_TRUNC) !== 0;
    const wantsCreate = (flags & SSH_FXF_CREAT) !== 0;

    let mode = 'r';
    if (wantsWrite) mode = wantsAppend ? 'a' : wantsTrunc || wantsCreate ? 'w' : 'r+';

    try {
      if (wantsCreate) {
        mkdirSync(dirname(full), { recursive: true });
      }
      const fd = openSync(full, mode, 0o644);
      const st = statSync(full);
      const key = randomBytes(16).toString('hex');
      openFiles.set(key, { fd, path: full, size: st.size });
      sessionOpenFiles.add(key);
      sftp.handle(reqId, Buffer.from(key, 'hex'));
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('READ', (reqId, handle, offset, len) => {
    const state = openFiles.get(handle.toString('hex'));
    if (!state) {
      sftp.status(reqId, FAILURE);
      return;
    }
    if (offset >= state.size) {
      sftp.status(reqId, EOF);
      return;
    }
    const n = Math.min(len, state.size - offset);
    const buf = Buffer.alloc(n);
    try {
      const got = readSync(state.fd, buf, 0, n, offset);
      sftp.data(reqId, buf.subarray(0, got));
      emit({ kind: 'read', username: session.username, path: relOf(root, state.path), bytes: got });
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const state = openFiles.get(handle.toString('hex'));
    if (!state) {
      sftp.status(reqId, FAILURE);
      return;
    }
    try {
      writeSync(state.fd, data, 0, data.length, offset);
      const n = Math.max(state.size, offset + data.length);
      state.size = n;
      emit({ kind: 'write', username: session.username, path: relOf(root, state.path), bytes: data.length });
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('FSTAT', (reqId, handle) => {
    const state = openFiles.get(handle.toString('hex'));
    if (!state) {
      sftp.status(reqId, FAILURE);
      return;
    }
    try {
      sftp.attrs(reqId, toAttributes(statSync(state.path)));
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('CLOSE', (reqId, handle) => {
    const state = openFiles.get(handle.toString('hex'));
    if (!state) {
      sftp.status(reqId, OK);
      return;
    }
    openFiles.delete(handle.toString('hex'));
    sessionOpenFiles.delete(handle.toString('hex'));
    try {
      closeSync(state.fd);
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  const dirHandles = new Map<string, { full: string; names: string[] }>();

  sftp.on('OPENDIR', (reqId, remote) => {
    let full: string;
    try {
      full = rooted(root, remote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    if (!existsSync(full)) {
      sftp.status(reqId, NO_SUCH_FILE);
      return;
    }
    if (!statSync(full).isDirectory()) {
      sftp.status(reqId, FAILURE);
      return;
    }
    const key = randomBytes(16).toString('hex');
    let names: string[];
    try {
      names = readdirSync(full).sort();
    } catch (err) {
      sftp.status(reqId, toStatus(err));
      return;
    }
    dirHandles.set(key, { full, names });
    sftp.handle(reqId, Buffer.from(key, 'hex'));
  });

  sftp.on('READDIR', (reqId, handle) => {
    const key = handle.toString('hex');
    const state = dirHandles.get(key);
    if (!state) {
      sftp.status(reqId, EOF);
      return;
    }
    const batch = state.names.splice(0, READDIR_BATCH_SIZE);
    const entries: FileEntry[] = [];
    for (const filename of batch) {
      try {
        const st = statSync(join(state.full, filename));
        entries.push({ filename, longname: longName(filename, st), attrs: toAttributes(st) });
      } catch {}
    }
    emit({ kind: 'readdir', username: session.username, path: relOf(root, state.full) });
    if (state.names.length === 0) dirHandles.delete(key);
    sftp.name(reqId, entries);
  });

  sftp.on('REALPATH', (reqId, path) => {
    let full: string;
    try {
      full = rooted(root, path);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    sftp.name(reqId, [
      {
        filename: relOf(root, full),
        longname: relOf(root, full),
        attrs: { mode: 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
      },
    ]);
  });

  const statHandler = (reqId: number, path: string, useLstat: boolean): void => {
    let full: string;
    try {
      full = rooted(root, path);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    try {
      const st = useLstat ? lstatSync(full) : statSync(full);
      sftp.attrs(reqId, toAttributes(st));
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  };

  sftp.on('STAT', (reqId, p) => statHandler(reqId, p, false));
  sftp.on('LSTAT', (reqId, p) => statHandler(reqId, p, true));

  sftp.on('REMOVE', (reqId, remote) => {
    let full: string;
    try {
      full = rooted(root, remote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    try {
      unlinkSync(full);
      emit({ kind: 'remove', username: session.username, path: relOf(root, full) });
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('RMDIR', (reqId, remote) => {
    let full: string;
    try {
      full = rooted(root, remote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    try {
      rmdirSync(full);
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('MKDIR', (reqId, remote) => {
    let full: string;
    try {
      full = rooted(root, remote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    try {
      mkdirSync(full, { recursive: false });
      emit({ kind: 'mkdir', username: session.username, path: relOf(root, full) });
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('RENAME', (reqId, oldRemote, newRemote) => {
    let from: string;
    let to: string;
    try {
      from = rooted(root, oldRemote);
      to = rooted(root, newRemote);
    } catch {
      sftp.status(reqId, PERMISSION_DENIED);
      return;
    }
    try {
      if (existsSync(to)) unlinkSync(to);
      renameSync(from, to);
      emit({ kind: 'rename', username: session.username, from: relOf(root, from), to: relOf(root, to) });
      sftp.status(reqId, OK);
    } catch (err) {
      sftp.status(reqId, toStatus(err));
    }
  });

  sftp.on('SETSTAT', (reqId, _path, _attrs) => sftp.status(reqId, OK));
  sftp.on('FSETSTAT', (reqId, _handle, _attrs) => sftp.status(reqId, OK));
}
