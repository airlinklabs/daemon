import crypto from "crypto";
import path from "path";
import fs from "fs";
import net from "net";
import logger from "../../utils/logger";
import { docker } from "../instances/utils";

export interface SftpCredential {
  username: string;
  password: string;
  port: number;
  expiresAt: number;
}

interface ActiveSession {
  containerId: string;
  username: string;
  sftpContainerName: string;
  port: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SFTP_IMAGE = process.env.SFTP_IMAGE || "lscr.io/linuxserver/openssh-server:latest";
const SFTP_USER_PREFIX = "alsftp_";
const SFTP_INTERNAL_PORT = "2222/tcp";
const PORT_RANGE_START = 3003;
const PORT_RANGE_END = 4000;

// Ports to never use — daemon, common services, etc.
const BLOCKED_PORTS = new Set([
  3000, 3001, 3002, 3003, 3306, 3389, 4000, 5432, 5900, 6379, 8080, 8443, 8888,
]);

const activeSessions = new Map<string, ActiveSession>();

function sanitizeContainerId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function generateUsername(containerId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(containerId + Date.now().toString())
    .digest("hex")
    .substring(0, 8);
  return `${SFTP_USER_PREFIX}${hash}`;
}

function generatePassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function getUsedPorts(): Set<number> {
  const used = new Set<number>();
  for (const session of activeSessions.values()) {
    used.add(session.port);
  }
  return used;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "0.0.0.0");
  });
}

async function allocatePort(): Promise<number> {
  const used = getUsedPorts();
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (BLOCKED_PORTS.has(port)) continue;
    if (used.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error("No free SFTP ports available in range.");
}

async function pullSftpImage(): Promise<void> {
  try {
    await docker.getImage(SFTP_IMAGE).inspect();
  } catch {
    logger.info(`Pulling ${SFTP_IMAGE} image...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(SFTP_IMAGE, (err: any, stream: any) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: any) => {
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
  port: number
): Promise<any> {
  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // didn't exist, fine
  }

  fs.chownSync(volumePath, 1000, 1000);

  const container = await docker.createContainer({
    name: containerName,
    Image: SFTP_IMAGE,
    Env: [
      "PUID=1000",
      "PGID=1000",
      "PASSWORD_ACCESS=true",
      "SUDO_ACCESS=false",
      `USER_NAME=${username}`,
      `USER_PASSWORD=${password}`,
    ],
    ExposedPorts: {
      [SFTP_INTERNAL_PORT]: {},
    },
    HostConfig: {
      Binds: [`${volumePath}:/config`],
      PortBindings: {
        [SFTP_INTERNAL_PORT]: [{ HostPort: String(port) }],
      },
      AutoRemove: false,
    },
  });

  await container.start();
  return container;
}

async function getContainerLogs(container: any): Promise<string> {
  try {
    const logs = await container.logs({ stdout: true, stderr: true, tail: 30 });
    return Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
  } catch {
    return "";
  }
}

async function assertSftpContainerRunning(container: any, containerName: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const info = await container.inspect();
  if (info.State?.Running) {
    return;
  }

  const logs = await getContainerLogs(container);
  await container.remove({ force: true }).catch(() => {});
  throw new Error(
    `SFTP container ${containerName} exited during startup.${logs ? ` Last logs: ${logs}` : ""}`
  );
}

async function stopSftpContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);

  try {
    await container.stop({ t: 3 });
  } catch {
    // already gone
  }

  await container.remove({ force: true }).catch(() => {});
}

function scheduleExpiry(sessionKey: string, ttl: number): NodeJS.Timeout {
  return setTimeout(async () => {
    await revokeCredential(sessionKey);
  }, ttl);
}

export async function generateCredential(containerId: string): Promise<SftpCredential> {
  if (!sanitizeContainerId(containerId)) {
    throw new Error("Invalid container ID");
  }

  const volumePath = path.resolve("volumes", containerId);

  if (!fs.existsSync(volumePath)) {
    throw new Error(`Volume for container ${containerId} does not exist`);
  }

  const existingKey = `container:${containerId}`;
  if (activeSessions.has(existingKey)) {
    await revokeCredential(existingKey);
  }

  await pullSftpImage();

  const port = await allocatePort();
  const username = generateUsername(containerId);
  const password = generatePassword();
  const sftpContainerName = `alsftp_${containerId}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;

  const container = await startSftpContainer(sftpContainerName, username, password, volumePath, port);
  await assertSftpContainerRunning(container, sftpContainerName);

  const timer = scheduleExpiry(existingKey, SESSION_TTL_MS);

  activeSessions.set(existingKey, {
    containerId,
    username,
    sftpContainerName,
    port,
    expiresAt,
    timer,
  });

  logger.info(`SFTP session started for container ${containerId}: user=${username} port=${port}`);

  return {
    username,
    password,
    port,
    expiresAt,
  };
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

export async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  for (const [key, session] of activeSessions.entries()) {
    if (session.expiresAt <= now) {
      await revokeCredential(key);
    }
  }
}

setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
