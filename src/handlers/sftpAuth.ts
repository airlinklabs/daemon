import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../config';
import logger from '../logger';
import { getPaths } from '../paths';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

export interface NativeSftpSession {
  serverId: string;
  username: string;
  passwordHash: Buffer;
  expiresAt: number;
  hook: SftpActivityHook;
}

// keyed by generated username (what the client authenticates with)
export const sessions = new Map<string, NativeSftpSession>();
// serverId -> username so we can revoke by container id
export const sessionByServer = new Map<string, string>();
// WeakMap to attach session data to ssh2 Connection objects without monkey-patching
export const clientSessions = new WeakMap<object, NativeSftpSession>();

// Buffered SFTP activity per server, consumed by the panel for P3-4 auditing.
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

export function getSftpActivity(serverId: string): SftpActivityEvent[] {
  const list = activityBuffer.get(serverId);
  activityBuffer.delete(serverId);
  return list ?? [];
}

export function hashPassword(password: string): Buffer {
  return new Bun.CryptoHasher('sha256').update(password).digest() as Buffer;
}

export function timingSafeEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function volumePathFor(serverId: string): string {
  return resolve(getPaths(config.paths).volumesRoot, serverId);
}

function usernameForServer(serverId: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(`${serverId}${randomUUID()}`).digest('hex').substring(0, 16);
  return `alsftp_${hash}`;
}

export function revokeByServer(serverId: string): void {
  const username = sessionByServer.get(serverId);
  if (!username) return;
  const session = sessions.get(username);
  sessions.delete(username);
  sessionByServer.delete(serverId);
  if (session) logger.info(`SFTP session ended for server ${session.serverId}: user=${session.username}`);
}

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

export function getActiveSessionCount(): number {
  return sessions.size;
}

export type SftpAuthOutcome =
  | { ok: true; session: NativeSftpSession }
  | { ok: false; reason: 'invalid_credential' | 'expired' | 'invalid_password' };

export function authenticateSftpSession(username: string, password: string, now: number = Date.now()): SftpAuthOutcome {
  const session = sessions.get(username);
  if (!session || !password) {
    return { ok: false, reason: 'invalid_credential' };
  }
  if (now > session.expiresAt) {
    sessions.delete(username);
    sessionByServer.delete(session.serverId);
    return { ok: false, reason: 'expired' };
  }
  if (!timingSafeEq(session.passwordHash, hashPassword(password))) {
    return { ok: false, reason: 'invalid_password' };
  }
  return { ok: true, session };
}

export function attachActivityHook(serverId: string, hook: SftpActivityHook): boolean {
  const username = sessionByServer.get(serverId);
  const session = username ? sessions.get(username) : undefined;
  if (!session) return false;
  session.hook = hook;
  return true;
}

export { recordActivity };
