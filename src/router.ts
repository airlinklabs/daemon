import config from "./config";
import logger from "./logger";
import { checkBasicAuth, getAllowedIpCheck, verifyHmac, withSecurityHeaders } from "./security/hmac";
import { checkRateLimit } from "./security/rateLimit";
import { handleRoot, handleStats } from "./routes/core";
import {
  handleContainerBackup,
  handleContainerBackupDelete,
  handleContainerBackupDownload,
  handleContainerCommand,
  handleContainerDelete,
  handleContainerInstall,
  handleContainerInstaller,
  handleContainerInstallStatus,
  handleContainerKill,
  handleContainerRestore,
  handleContainerStart,
  handleContainerStats,
  handleContainerStatus,
  handleContainerStop,
} from "./routes/instances";
import {
  handleFsAppend,
  handleFsCreateEmpty,
  handleFsDownload,
  handleFsFileRead,
  handleFsFileWrite,
  handleFsInfo,
  handleFsList,
  handleFsRename,
  handleFsRm,
  handleFsSize,
  handleFsUnzip,
  handleFsUpload,
  handleFsZip,
} from "./routes/fileSystem";
import { handleSftpCreate, handleSftpRevoke, handleSftpStatus } from "./routes/sftp";
import { handleMinecraftPlayers } from "./routes/minecraft";
import { handleRadarScan, handleRadarZip } from "./routes/radar";

type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

const exactRoutes = new Map<string, RouteHandler>([
  ["GET /", async (req) => handleRoot()],
  ["GET /stats", async (req) => handleStats()],
  ["POST /container/installer", async (req) => handleContainerInstaller(req)],
  ["POST /container/install", async (req) => handleContainerInstall(req)],
  ["POST /container/start", async (req) => handleContainerStart(req)],
  ["POST /container/stop", async (req) => handleContainerStop(req)],
  ["DELETE /container/kill", async (req) => handleContainerKill(req)],
  ["POST /container/command", async (req) => handleContainerCommand(req)],
  ["DELETE /container", async (req) => handleContainerDelete(req)],
  ["GET /container/status", async (req) => handleContainerStatus(req)],
  ["GET /container/stats", async (req) => handleContainerStats(req)],
  ["POST /container/backup", async (req) => handleContainerBackup(req)],
  ["POST /container/restore", async (req) => handleContainerRestore(req)],
  ["DELETE /container/backup", async (req) => handleContainerBackupDelete(req)],
  ["GET /container/backup/download", async (req) => handleContainerBackupDownload(req)],
  ["GET /fs/list", async (req) => handleFsList(req)],
  ["GET /fs/size", async (req) => handleFsSize(req)],
  ["GET /fs/info", async (req) => handleFsInfo(req)],
  ["GET /fs/file/content", async (req) => handleFsFileRead(req)],
  ["POST /fs/file/content", async (req) => handleFsFileWrite(req)],
  ["GET /fs/download", async (req) => handleFsDownload(req)],
  ["DELETE /fs/rm", async (req) => handleFsRm(req)],
  ["POST /fs/zip", async (req) => handleFsZip(req)],
  ["POST /fs/unzip", async (req) => handleFsUnzip(req)],
  ["POST /fs/rename", async (req) => handleFsRename(req)],
  ["POST /fs/upload", async (req) => handleFsUpload(req)],
  ["POST /fs/create-empty-file", async (req) => handleFsCreateEmpty(req)],
  ["POST /fs/append-file", async (req) => handleFsAppend(req)],
  ["POST /sftp/credentials", async (req) => handleSftpCreate(req)],
  ["DELETE /sftp/credentials", async (req) => handleSftpRevoke(req)],
  ["GET /sftp/status", async () => handleSftpStatus()],
  ["GET /minecraft/players", async (req) => handleMinecraftPlayers(req)],
  ["POST /radar/scan", async (req) => handleRadarScan(req)],
  ["POST /radar/zip", async (req) => handleRadarZip(req)],
]);

const dynamicRoutes: [RegExp, string[], RouteHandler][] = [
  [/^\/container\/status\/([a-zA-Z0-9_-]+)$/, ["id"], handleContainerInstallStatus],
];

export async function handleHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;

  const contentLength = Number.parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 100 * 1024 * 1024) {
    return withSecurityHeaders(new Response(JSON.stringify({ error: "request too large" }), { status: 413 }));
  }

  const ipErr = getAllowedIpCheck(req);
  if (ipErr) return withSecurityHeaders(ipErr);

  const authErr = checkBasicAuth(req, config.key);
  if (authErr) return withSecurityHeaders(authErr);

  const hmacErr = await verifyHmac(req, config.key);
  if (hmacErr) return withSecurityHeaders(hmacErr);

  const rlErr = checkRateLimit(req);
  if (rlErr) return withSecurityHeaders(rlErr);

  if (req.method !== "GET" && req.method !== "DELETE") {
    const ct = req.headers.get("content-type") ?? "";
    const ok =
      ct.startsWith("application/json") ||
      ct.startsWith("application/octet-stream") ||
      ct.startsWith("text/") ||
      ct.startsWith("multipart/");
    if (ct && !ok) {
      return withSecurityHeaders(new Response(JSON.stringify({ error: "unsupported content type" }), { status: 415 }));
    }
  }

  const handler = exactRoutes.get(key);
  if (handler) {
    try {
      return withSecurityHeaders(await handler(req, {}));
    } catch (err) {
      logger.error(`route error: ${key}`, err);
      return withSecurityHeaders(new Response(JSON.stringify({ error: "internal error" }), { status: 500 }));
    }
  }

  for (const [pattern, paramNames, dynHandler] of dynamicRoutes) {
    const match = url.pathname.match(pattern);
    if (!match || req.method !== "GET") continue;
    const params: Record<string, string> = {};
    paramNames.forEach((name, index) => {
      params[name] = match[index + 1] ?? "";
    });
    try {
      return withSecurityHeaders(await dynHandler(req, params));
    } catch (err) {
      logger.error(`route error: ${url.pathname}`, err);
      return withSecurityHeaders(new Response(JSON.stringify({ error: "internal error" }), { status: 500 }));
    }
  }

  return withSecurityHeaders(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
}
