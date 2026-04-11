import crypto from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync, chownSync } from 'node:fs';
import logger from '../logger';
import { docker } from './docker';
import config from '../config';

export interface SftpCredential {
  username:  string;
  password:  string;
  host:      string;
  port:      number;
  expiresAt: number;
}

interface ActiveSession {
  containerId:       string;
  username:          string;
  sftpContainerName: string;
  port:              number;
  expiresAt:         number;
  timer:             ReturnType<typeof setTimeout>;
}

const SESSION_TTL_MS  = 24 * 60 * 60 * 1000;
const SFTP_IMAGE      = 'atmoz/sftp';
const SFTP_USER_PREFIX = 'alsftp_';
const PORT_RANGE_START = 3003;
const PORT_RANGE_END   = 4000;

const BLOCKED_PORTS = new Set([
  3000, 3001, 3002, 3003, 3306, 3389, 4000, 5432, 5900, 6379, 8080, 8443, 8888,
]);

const activeSessions = new Map<string, ActiveSession>();

function generateUsername(containerId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(containerId + Date.now().toString())
    .digest('hex')
    .substring(0, 8);
  return `${SFTP_USER_PREFIX}${hash}`;
}

function generatePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

// check if a port is free by trying to bind it — Bun.listen throws if busy
async function portIsBusy(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } });
    server.stop(true);
    return false;
  } catch {
    return true;
  }
}

async function allocatePort(): Promise<number> {
  const used = new Set<number>();
  for (const s of activeSessions.values()) used.add(s.port);

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (BLOCKED_PORTS.has(port)) continue;
    if (used.has(port)) continue;
    if (!(await portIsBusy(port))) return port;
  }
  throw new Error('no free SFTP ports available in range');
}

async function pullSftpImage(): Promise<void> {
  try {
    await docker.getImage(SFTP_IMAGE).inspect();
  } catch {
    logger.info(`pulling ${SFTP_IMAGE} image...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(SFTP_IMAGE, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: unknown) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  }
}

async function startSftpContainer(
  containerName: string,
  username: string,
  password: string,
  volumePath: string,
  port: number,
): Promise<void> {
  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch { /* didn't exist, fine */ }

  // atmoz/sftp requires the upload dir to be owned by the user (uid 1000)
  chownSync(volumePath, 1000, 1000);

  const container = await docker.createContainer({
    name:  containerName,
    Image: SFTP_IMAGE,
    Cmd:   [`${username}:${password}:::upload`],
    HostConfig: {
      Binds:        [`${volumePath}:/home/${username}/upload`],
      PortBindings: { '22/tcp': [{ HostPort: String(port) }] },
      AutoRemove:   true,
    },
  });

  await container.start();
}

async function stopSftpContainer(containerName: string): Promise<void> {
  try {
    await docker.getContainer(containerName).stop({ t: 3 });
  } catch { /* already gone */ }
}

export async function generateCredential(containerId: string): Promise<SftpCredential> {
  const volumePath = resolve(process.cwd(), 'volumes', containerId);
  if (!existsSync(volumePath)) throw new Error(`volume for container ${containerId} does not exist`);

  const sessionKey = `container:${containerId}`;
  if (activeSessions.has(sessionKey)) {
    await revokeCredential(sessionKey);
  }

  await pullSftpImage();

  const port              = await allocatePort();
  const username          = generateUsername(containerId);
  const password          = generatePassword();
  const sftpContainerName = `alsftp_${containerId}`;
  const expiresAt         = Date.now() + SESSION_TTL_MS;

  await startSftpContainer(sftpContainerName, username, password, volumePath, port);

  const timer = setTimeout(() => revokeCredential(sessionKey), SESSION_TTL_MS);

  activeSessions.set(sessionKey, { containerId, username, sftpContainerName, port, expiresAt, timer });

  const host = config.remote;
  logger.info(`SFTP session started for container ${containerId}: user=${username} port=${port}`);

  return { username, password, host, port, expiresAt };
}

export async function revokeCredential(sessionKey: string): Promise<void> {
  const session = activeSessions.get(sessionKey);
  if (!session) return;

  clearTimeout(session.timer);
  activeSessions.delete(sessionKey);

  await stopSftpContainer(session.sftpContainerName);
  logger.info(`SFTP session ended for container ${session.containerId}: user=${session.username}`);
}

export async function revokeCredentialForContainer(containerId: string): Promise<void> {
  await revokeCredential(`container:${containerId}`);
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

// clean up expired sessions every hour — belt and braces on top of the per-session timer
setInterval(async () => {
  const now = Date.now();
  for (const [key, session] of activeSessions.entries()) {
    if (session.expiresAt <= now) await revokeCredential(key);
  }
}, 60 * 60 * 1000);
