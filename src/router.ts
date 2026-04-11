import { checkBasicAuth, verifyHmac, getAllowedIpCheck, withSecurityHeaders } from './security/hmac';
import { checkRateLimit } from './security/rateLimit';
import config from './config';
import logger from './logger';

// route handlers — all imported up front so they hoist fine
import { handleRoot, handleStats } from './routes/core';
import {
  handleContainerInstaller,
  handleContainerInstall,
  handleContainerInstallStatus,
  handleContainerStart,
  handleContainerStop,
  handleContainerKill,
  handleContainerCommand,
  handleContainerDelete,
  handleContainerStatus,
  handleContainerStats,
  handleContainerBackup,
  handleContainerRestore,
  handleContainerBackupDelete,
  handleContainerBackupDownload,
} from './routes/instances';
import {
  handleFsList,
  handleFsSize,
  handleFsInfo,
  handleFsFileRead,
  handleFsFileWrite,
  handleFsDownload,
  handleFsRm,
  handleFsZip,
  handleFsUnzip,
  handleFsRename,
  handleFsUpload,
  handleFsCreateEmpty,
  handleFsAppend,
} from './routes/filesystem';
import { handleSftpCreate, handleSftpRevoke, handleSftpStatus } from './routes/sftp';
import { handleMinecraftPlayers } from './routes/minecraft';
import { handleRadarScan, handleRadarZip } from './routes/radar';

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

// exact route map: "METHOD /path" → handler
// using function declarations so they hoist above the Map
const exactRoutes = new Map<string, Handler>([
  ['GET /',                          handleRoot],
  ['GET /stats',                     handleStats],
  ['POST /container/installer',      handleContainerInstaller],
  ['POST /container/install',        handleContainerInstall],
  ['POST /container/start',          handleContainerStart],
  ['POST /container/stop',           handleContainerStop],
  ['DELETE /container/kill',         handleContainerKill],
  ['POST /container/command',        handleContainerCommand],
  ['DELETE /container',              handleContainerDelete],
  ['GET /container/status',          handleContainerStatus],
  ['GET /container/stats',           handleContainerStats],
  ['POST /container/backup',         handleContainerBackup],
  ['POST /container/restore',        handleContainerRestore],
  ['DELETE /container/backup',       handleContainerBackupDelete],
  ['GET /container/backup/download', handleContainerBackupDownload],
  ['GET /fs/list',                   handleFsList],
  ['GET /fs/size',                   handleFsSize],
  ['GET /fs/info',                   handleFsInfo],
  ['GET /fs/file/content',           handleFsFileRead],
  ['POST /fs/file/content',          handleFsFileWrite],
  ['GET /fs/download',               handleFsDownload],
  ['DELETE /fs/rm',                  handleFsRm],
  ['POST /fs/zip',                   handleFsZip],
  ['POST /fs/unzip',                 handleFsUnzip],
  ['POST /fs/rename',                handleFsRename],
  ['POST /fs/upload',                handleFsUpload],
  ['POST /fs/create-empty-file',     handleFsCreateEmpty],
  ['POST /fs/append-file',           handleFsAppend],
  ['POST /sftp/credentials',         handleSftpCreate],
  ['DELETE /sftp/credentials',       handleSftpRevoke],
  ['GET /sftp/status',               handleSftpStatus],
  ['GET /minecraft/players',         handleMinecraftPlayers],
  ['POST /radar/scan',               handleRadarScan],
  ['POST /radar/zip',                handleRadarZip],
]);

// dynamic routes for path segments like /container/status/:id
const dynamicRoutes: [RegExp, string[], string, Handler][] = [
  [
    /^\/container\/status\/([a-zA-Z0-9_-]+)$/,
    ['id'],
    'GET',
    (req, params) => handleContainerInstallStatus(req, params),
  ],
];

export async function handleHttpRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;

  // reject oversized requests before we read anything
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > 100 * 1024 * 1024) {
    return withSecurityHeaders(new Response(JSON.stringify({ error: 'request too large' }), {
      status: 413, headers: { 'Content-Type': 'application/json' },
    }));
  }

  // extract real socket IP — req.ip does not exist in Bun
  // server.requestIP(req) returns the actual socket address, no header spoofing possible
  const rawIp = server.requestIP(req);
  const socketIp = rawIp?.address.replace(/^::ffff:/, '') ?? 'unknown';

  const behindProxy = Bun.env['BEHIND_PROXY'] === 'true';
  const effectiveIp = behindProxy
    ? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? socketIp
    : socketIp;

  // security chain — runs on every request, no exceptions
  const ipErr = getAllowedIpCheck(effectiveIp);
  if (ipErr) return withSecurityHeaders(ipErr);

  const authErr = checkBasicAuth(req, config.key);
  if (authErr) return withSecurityHeaders(authErr);

  const hmacErr = await verifyHmac(req, config.key);
  if (hmacErr) return withSecurityHeaders(hmacErr);

  const rlErr = checkRateLimit(effectiveIp);
  if (rlErr) return withSecurityHeaders(rlErr);

  // reject unexpected content types on mutation requests
  // DELETE with body is intentional for several routes — don't block it
  if (req.method !== 'GET') {
    const ct = req.headers.get('content-type') ?? '';
    const ok = !ct
      || ct.startsWith('application/json')
      || ct.startsWith('application/octet-stream')
      || ct.startsWith('text/')
      || ct.startsWith('multipart/');
    if (!ok) {
      return withSecurityHeaders(new Response(JSON.stringify({ error: 'unsupported content type' }), { status: 415 }));
    }
  }

  // exact match
  const handler = exactRoutes.get(key);
  if (handler) {
    try {
      return withSecurityHeaders(await handler(req, {}));
    } catch (err) {
      logger.error(`route error: ${key}`, err);
      return withSecurityHeaders(new Response(JSON.stringify({ error: 'internal error' }), { status: 500 }));
    }
  }

  // dynamic match
  for (const [pattern, paramNames, method, dynHandler] of dynamicRoutes) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

    try {
      return withSecurityHeaders(await dynHandler(req, params));
    } catch (err) {
      logger.error(`route error: ${url.pathname}`, err);
      return withSecurityHeaders(new Response(JSON.stringify({ error: 'internal error' }), { status: 500 }));
    }
  }

  return withSecurityHeaders(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
}
