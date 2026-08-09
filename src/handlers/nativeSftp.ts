// Native SFTP server for the Airlink daemon.
//
// Replaces the old `atmoz/sftp` sidecar-container approach:
//   - no external image dependency (no docker pull)
//   - no per-session ephemeral port (one fixed SFTP port on the daemon)
//   - per-session jailing: every path resolves against the owning
//     server's volume root via security/pathJail, so a client can never
//     escape its server's volume.
//   - structured activity hooks (connect / disconnect / write / read /
//     rename / remove / mkdir) forwarded to the panel for SFTP auditing.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Attributes, Connection, FileEntry, Session, SFTPWrapper } from 'ssh2';
import { Server, utils } from 'ssh2';
import config from '../config';
import { getPaths } from '../paths';
import logger from '../logger';
import { jailPath } from '../security/pathJail';

// ---------------------------------------------------------------------------
// Types & activity
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const READDIR_BATCH_SIZE = 100;

export type SftpActivityEvent =
  | { kind: 'connect'; serverId: string; username: string; ip: string }
  | { kind: 'disconnect'; serverId: string; username: string }
  | { kind: 'write'; serverId: string; username: string; path: string; bytes: number }
  | { kind: 'read'; serverId: string; username: string; path: string; bytes: number }
  | { kind: 'remove'; serverId: string; username: string; path: string }
  | { kind: 'rename'; serverId: string; username: string; from: string; to: string }
  | { kind: 'mkdir'; serverId: string; username: string; path: string }
  | { kind: 'readdir'; serverId: string; username: string; path: string };

export type SftpActivityHook = (event: SftpActivityEvent) => void;

interface NativeSftpSession {
  serverId: string;
  username: string;
  passwordHash: Buffer;
  expiresAt: number;
  hook: SftpActivityHook;
}

// keyed by generated username (what the client authenticates with)
const sessions = new Map<string, NativeSftpSession>();
// serverId -> username so we can revoke by container id
const sessionByServer = new Map<string, string>();
// WeakMap to attach session data to ssh2 Connection objects without monkey-patching
const clientSessions = new WeakMap<object, NativeSftpSession>();

const openFiles = new Map<string, { fd: number; path: string; size: number }>();

// Buffered SFTP activity per server, consumed by the panel for P3-4 auditing.
// Kept bounded per server to avoid unbounded memory growth under heavy load.
const activityBuffer = new Map<string, SftpActivityEvent[]>();
const ACTIVITY_BUFFER_LIMIT = 500;

function recordActivity(event: SftpActivityEvent): void {
  const list = activityBuffer.get(event.serverId);
  if (list) {
    list.push(event);
    if (list.length > ACTIVITY_BUFFER_LIMIT) list.shift();
  } else {
    activityBuffer.set(event.serverId, [event]);
  }
}

// Returns and clears buffered SFTP activity for a server (the panel drains
// this via `GET /sftp/activity`). No-op when the server has no session.
export function getSftpActivity(serverId: string): SftpActivityEvent[] {
  const list = activityBuffer.get(serverId);
  activityBuffer.delete(serverId);
  return list ?? [];
}

function hashPassword(password: string): Buffer {
  return createHash('sha256').update(password).digest();
}

function timingSafeEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function volumePathFor(serverId: string): string {
  return resolve(getPaths(config.paths).volumesRoot, serverId);
}

function usernameForServer(serverId: string): string {
  const hash = createHash('sha256').update(`${serverId}${randomUUID()}`).digest('hex').substring(0, 16);
  return `alsftp_${hash}`;
}

// ---------------------------------------------------------------------------
// Host key
// ---------------------------------------------------------------------------

function hostKeyFile(): string {
  return resolve(getPaths(config.paths).storageRoot, 'sftp_host_ed25519');
}

function loadOrCreateHostKey(): string {
  try {
    const existing = readFileSync(hostKeyFile(), 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* will generate below */
  }

  const pair = utils.generateKeyPairSync('ed25519');
  const priv = pair.private.trim();
  try {
    mkdirSync(dirname(hostKeyFile()), { recursive: true });
    writeFileSync(hostKeyFile(), `${priv.trim()}\n`, { mode: 0o600 });
  } catch (err) {
    logger.error('could not persist SFTP host key', err);
  }
  return priv.trim();
}

// ---------------------------------------------------------------------------
// Credential lifecycle (public API used by routes/sftp.ts)
// ---------------------------------------------------------------------------

export interface SftpCredential {
  username: string;
  password: string;
  host: string;
  port: number;
  expiresAt: number;
}

export async function generateCredential(containerId: string): Promise<SftpCredential> {
  const volume = volumePathFor(containerId);
  if (!existsSync(volume)) throw new Error(`volume for container ${containerId} does not exist`);

  // invalidate any prior credential for this server
  const prior = sessionByServer.get(containerId);
  if (prior) revokeByServer(containerId);

  const username = usernameForServer(containerId);
  const password = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;

  sessions.set(username, {
    serverId: containerId,
    username,
    passwordHash: hashPassword(password),
    expiresAt,
    hook: () => {},
  });
  sessionByServer.set(containerId, username);

  logger.info(`SFTP session registered for server ${containerId}: user=${username}`);
  return { username, password, host: config.remote, port: config.sftpPort, expiresAt };
}

export async function revokeCredential(sessionKey: string): Promise<void> {
  // legacy: sessionKey was `container:<id>`
  if (sessionKey.startsWith('container:')) {
    revokeByServer(sessionKey.slice('container:'.length));
    return;
  }
  const session = sessions.get(sessionKey);
  if (session) revokeByServer(session.serverId);
}

export async function revokeCredentialForContainer(containerId: string): Promise<void> {
  revokeByServer(containerId);
}

function revokeByServer(serverId: string): void {
  const username = sessionByServer.get(serverId);
  if (!username) return;
  const session = sessions.get(username);
  sessions.delete(username);
  sessionByServer.delete(serverId);
  if (session) logger.info(`SFTP session ended for server ${session.serverId}: user=${session.username}`);
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

export type SftpAuthOutcome =
  | { ok: true; session: NativeSftpSession }
  | { ok: false; reason: 'invalid_credential' | 'expired' | 'invalid_password' };

// Pure, unit-testable authentication decision. The ssh2 connection handler
// delegates here so the login rules — existence, expiry, and a timing-safe
// password comparison — are exercised without requiring a live TCP server.
export function authenticateSftpSession(username: string, password: string, now: number = Date.now()): SftpAuthOutcome {
  const session = sessions.get(username);
  if (!session || !password) {
    // Absent session or missing password: fall through without logging, so we
    // do not disclose whether a username exists (enumeration hardening).
    return { ok: false, reason: 'invalid_credential' };
  }
  if (now > session.expiresAt) {
    // Expired credentials are removed so a stale password can never resurface.
    sessions.delete(username);
    sessionByServer.delete(session.serverId);
    return { ok: false, reason: 'expired' };
  }
  if (!timingSafeEq(session.passwordHash, hashPassword(password))) {
    return { ok: false, reason: 'invalid_password' };
  }
  return { ok: true, session };
}

// gone the panel wires a hook (P3-4 auditing) attached to any live session
// for a given server. used by the daemon when an SFTP activity reporter is
// configured; returns false when no session exists yet.
export function attachActivityHook(serverId: string, hook: SftpActivityHook): boolean {
  const username = sessionByServer.get(serverId);
  const session = username ? sessions.get(username) : undefined;
  if (!session) return false;
  session.hook = hook;
  return true;
}

// ---------------------------------------------------------------------------
// SFTP status codes
// ---------------------------------------------------------------------------

const OK = 0;
const EOF = 1;
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

const SSH_FXF_WRITE = 0x00000002;
const SSH_FXF_APPEND = 0x00000004;
const SSH_FXF_CREAT = 0x00000008;
const SSH_FXF_TRUNC = 0x00000010;

function toStatus(err: unknown): number {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENOTEMPTY') return NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EEXIST' || code === 'EISDIR') return PERMISSION_DENIED;
  return FAILURE;
}

export function rooted(base: string, remote: string): string {
  // SFTP always sends rooted paths; strip the leading slash and jail.
  const rel = remote.replace(/^\/+/, '');
  if (rel === '') return base;

  const jailed = jailPath(base, rel);

  // jailPath resolves the PARENT directory against the real volume root, but it
  // leaves the FINAL path component for the following syscall to follow. A
  // final-component symlink pointing outside the volume (e.g. a link to
  // /etc/hostname) would otherwise be followed on open/read/write, escaping the
  // jail entirely. Resolve the whole path ourselves and reject any outcome that
  // lands outside the real volume root.
  let resolved: string;
  try {
    resolved = realpathSync(jailed);
  } catch {
    // Dangling or not-yet-created final component (typical for new writes). The
    // parent was already bounded by jailPath, so the path is still in-jail.
    return jailed;
  }
  const realBase = realpathSync(base);
  if (resolved !== realBase && !resolved.startsWith(realBase + sep)) {
    throw new Error(`symlink escapes volume boundary: ${rel}`);
  }

  // Keep returning the jailed (symlink) path, not its realpath, so activity
  // paths and longnames keep the name the client actually addressed while the
  // boundary check above guarantees following it cannot leave the volume.
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

// ---------------------------------------------------------------------------
// Rooted SFTP session
// ---------------------------------------------------------------------------

function serveSftp(sftp: SFTPWrapper, root: string, session: NativeSftpSession): void {
  const emit = (event: Partial<SftpActivityEvent>): void => {
    // route to the server's hook (auditing) and buffer for the panel to drain
    const full = { serverId: session.serverId, ...event } as SftpActivityEvent;
    recordActivity(full);
    if (session.hook) session.hook(full);
  };

  // Track this session's open file descriptors so they are closed on an abnormal
  // disconnect. Without this, a client that drops the TCP connection without
  // sending CLOSE for each handle would leak fds until process exit.
  const sessionOpenFiles = new Set<string>();
  const closeSessionFiles = (): void => {
    for (const key of sessionOpenFiles) {
      const rec = openFiles.get(key);
      if (rec) {
        openFiles.delete(key);
        try {
          closeSync(rec.fd);
        } catch {
          /* fd already closed elsewhere — nothing left to clean up */
        }
      }
    }
    sessionOpenFiles.clear();
  };
  // Wait for both stream-end signals so a hard drop still triggers cleanup.
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

    // map ssh2 OPEN flags to node open flags
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

  // read-only-ish setstat/fsetstat: accept them (chmod/chown) best-effort
  sftp.on('SETSTAT', (reqId, _path, _attrs) => sftp.status(reqId, OK));
  sftp.on('FSETSTAT', (reqId, _handle, _attrs) => sftp.status(reqId, OK));
}

// ---------------------------------------------------------------------------
// SSH server bootstrap
// ---------------------------------------------------------------------------

let server: Server | null = null;
let started = false;

export function getSftpServerPort(): number {
  return config.sftpPort;
}

export async function startNativeSftpServer(): Promise<void> {
  if (started) return;

  const priv = loadOrCreateHostKey();

  server = new Server({ hostKeys: [priv], banner: 'Airlink daemon SFTP' }, (client: Connection, info) => {
    // ssh2 exposes the peer address via the connection event's ClientInfo, not
    // on the Connection itself. Captured here once and threaded into activity.
    const clientIp = info.ip;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject(['password']);
        return;
      }
      const outcome = authenticateSftpSession(ctx.username, ctx.password ?? '');
      if (!outcome.ok) {
        if (outcome.reason === 'invalid_password') {
          logger.info(`SFTP auth password mismatch for ${ctx.username}`);
        }
        ctx.reject(['password']);
        return;
      }
      const session = outcome.session;
      // Bind the session to the connection BEFORE accept(): ssh2 emits
      // 'ready' synchronously when accept() is called, so it would miss a
      // pointer set after.
      clientSessions.set(client, session);
      ctx.accept();
    });

    client.on('ready', () => {
      const session = clientSessions.get(client);
      if (!session) {
        logger.warn(`SFTP client ready but no authed session bound (ownKeys=${Reflect.ownKeys(client).length})`);
        return;
      }

      client.on('session', (accept: () => Session) => {
        const channel = accept();
        channel.on('sftp', (sftpAccept: () => SFTPWrapper) => {
          const sftp = sftpAccept();
          const root = volumePathFor(session.serverId);
          client.on('close', () => {
            const ev = { kind: 'disconnect' as const, serverId: session.serverId, username: session.username };
            recordActivity(ev);
            session.hook?.(ev);
          });
          const connEvent = {
            kind: 'connect' as const,
            serverId: session.serverId,
            username: session.username,
            ip: clientIp,
          };
          recordActivity(connEvent);
          session.hook?.(connEvent);
          if (!existsSync(root)) {
            sftp.end();
            return;
          }
          serveSftp(sftp, root, session);
        });
      });
    });
  });

  await new Promise<void>((resolveOk, reject) => {
    const srv = server;
    if (srv) {
      srv.once('error', reject);
      srv.listen(config.sftpPort, '0.0.0.0', () => resolveOk());
    } else {
      reject(new Error('SFTP server was not created'));
    }
  });

  started = true;
  logger.info(`native SFTP server listening on 0.0.0.0:${config.sftpPort}`);
}

// periodic cleanup of expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [user, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(user);
      sessionByServer.delete(session.serverId);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);
