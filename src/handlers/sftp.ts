import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import config from "../config";
import logger from "../logger";
import { docker } from "./docker";

export type SftpCredential = {
  username: string;
  password: string;
  host: string;
  port: number;
  expiresAt: number;
};

type ActiveSession = {
  containerId: string;
  username: string;
  sftpContainerName: string;
  port: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SFTP_IMAGE = "atmoz/sftp";
const SFTP_USER_PREFIX = "alsftp_";
const PORT_RANGE_START = 3003;
const PORT_RANGE_END = 4000;
const BLOCKED_PORTS = new Set([3000, 3001, 3002, 3003, 3306, 3389, 4000, 5432, 5900, 6379, 8080, 8443, 8888]);
const activeSessions = new Map<string, ActiveSession>();

async function portIsBusy(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    server.stop(true);
    return false;
  } catch {
    return true;
  }
}

function generateUsername(containerId: string): string {
  return `${SFTP_USER_PREFIX}${crypto.createHash("sha256").update(containerId + Date.now().toString()).digest("hex").slice(0, 8)}`;
}

function generatePassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function allocatePort(): Promise<number> {
  const used = new Set(Array.from(activeSessions.values(), (session) => session.port));
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    if (used.has(port) || BLOCKED_PORTS.has(port)) continue;
    if (!(await portIsBusy(port))) return port;
  }
  throw new Error("No free SFTP ports available in range.");
}

async function pullSftpImage(): Promise<void> {
  try {
    await docker.getImage(SFTP_IMAGE).inspect();
  } catch {
    const stream = await docker.pull(SFTP_IMAGE);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

async function startSftpContainer(containerName: string, username: string, password: string, volumePath: string, port: number): Promise<void> {
  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {}

  fs.chownSync(volumePath, 1000, 1000);
  const container = await docker.createContainer({
    name: containerName,
    Image: SFTP_IMAGE,
    Cmd: [`${username}:${password}:::upload`],
    HostConfig: {
      Binds: [`${volumePath}:/home/${username}/upload`],
      PortBindings: { "22/tcp": [{ HostPort: String(port) }] },
      AutoRemove: true,
    },
  });
  await container.start();
}

async function revokeCredential(sessionKey: string): Promise<void> {
  const session = activeSessions.get(sessionKey);
  if (!session) return;
  clearTimeout(session.timer);
  activeSessions.delete(sessionKey);
  await docker.getContainer(session.sftpContainerName).stop({ t: 3 }).catch(() => {});
  logger.info(`SFTP session ended for ${session.containerId}`);
}

export async function generateCredential(containerId: string): Promise<SftpCredential> {
  const volumePath = path.resolve("volumes", containerId);
  if (!fs.existsSync(volumePath)) throw new Error(`Volume for container ${containerId} does not exist`);
  const sessionKey = `container:${containerId}`;
  if (activeSessions.has(sessionKey)) await revokeCredential(sessionKey);

  await pullSftpImage();
  const port = await allocatePort();
  const username = generateUsername(containerId);
  const password = generatePassword();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const sftpContainerName = `alsftp_${containerId}`;

  await startSftpContainer(sftpContainerName, username, password, volumePath, port);
  const timer = setTimeout(() => void revokeCredential(sessionKey), SESSION_TTL_MS);
  activeSessions.set(sessionKey, { containerId, username, sftpContainerName, port, expiresAt, timer });

  return { username, password, host: config.remote || "127.0.0.1", port, expiresAt };
}

export async function revokeCredentialForContainer(containerId: string): Promise<void> {
  await revokeCredential(`container:${containerId}`);
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}
