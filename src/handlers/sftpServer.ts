import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Connection, Session, SFTPWrapper } from 'ssh2';
import { Server, utils } from 'ssh2';
import config from '../config';
import logger from '../logger';
import { getPaths } from '../paths';
import {
  authenticateSftpSession,
  clientSessions,
  recordActivity,
  sessionByServer,
  sessions,
  volumePathFor,
} from './sftpAuth';
import { serveSftp } from './sftpSubsystem';

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function hostKeyFile(): string {
  return resolve(getPaths(config.paths).storageRoot, 'sftp_host_ed25519');
}

function loadOrCreateHostKey(): string {
  try {
    const existing = readFileSync(hostKeyFile(), 'utf8').trim();
    if (existing) return existing;
  } catch {}

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

let server: Server | null = null;
let started = false;

export function getSftpServerPort(): number {
  return config.sftpPort;
}

export async function startNativeSftpServer(): Promise<void> {
  if (started) return;

  const priv = loadOrCreateHostKey();

  server = new Server({ hostKeys: [priv], banner: 'Airlink daemon SFTP' }, (client: Connection, info) => {
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
