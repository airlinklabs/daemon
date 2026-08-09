import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import config from './config';
import { docker } from './handlers/docker';
import { apiError } from './errors';
import { maxBodyBytesFor } from './limits';
import logger from './logger';
import { shutdownOperations } from './handlers/operationManager';
import { handleRoot, handleStats } from './routes/core';
import {
  handleDownloadToken,
  handleFsAppend,
  handleFsCopy,
  handleFsCreateEmpty,
  handleFsDownload,
  handleFsDownloadToken,
  handleFsFileRead,
  handleFsFileWrite,
  handleFsInfo,
  handleFsList,
  handleFsMkdir,
  handleFsPull,
  handleFsRename,
  handleFsRm,
  handleFsSize,
  handleFsUnzip,
  handleFsUpload,
  handleFsZip,
} from './routes/filesystem';
import {
  handleContainerBackup,
  handleContainerBackupDelete,
  handleContainerBackupDownload,
  handleContainerBackupDownloadToken,
  handleContainerBackupUpload,
  handleContainerCommand,
  handleContainerDelete,
  handleContainerInstall,
  handleContainerInstaller,
  handleContainerInstallStatus,
  handleContainerKill,
  handleContainerLogArchiveDownload,
  handleContainerLogArchiveDownloadToken,
  handleContainerLogArchiveRead,
  handleContainerLogArchives,
  handleContainerLogHistory,
  handleContainerLogs,
  handleContainerReinstall,
  handleContainerRestart,
  handleContainerRestore,
  handleContainerStart,
  handleContainerStats,
  handleContainerStatus,
  handleContainerStop,
} from './routes/instances';
import { handleMinecraftPlayers } from './routes/minecraft';
import { handleRadarScan, handleRadarZip } from './routes/radar';
import { handleSftpActivity, handleSftpCreate, handleSftpRevoke, handleSftpStatus } from './routes/sftp';
import { checkBasicAuth, getAllowedIpCheck, verifyHmac, withSecurityHeaders } from './security/hmac';
import { checkRateLimit } from './security/rateLimit';

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

const exactRoutes = new Map<string, Handler>([
  ['GET /', handleRoot],
  ['GET /stats', handleStats],
  ['GET /capabilities', (_req) => {
    const caps = docker.capabilities();
    return new Response(JSON.stringify(caps), {
      headers: { 'Content-Type': 'application/json' },
    });
  }],
  ['POST /container/installer', handleContainerInstaller],
  ['POST /container/install', handleContainerInstall],
  ['POST /container/reinstall', handleContainerReinstall],
  ['POST /container/start', handleContainerStart],
  ['POST /container/stop', handleContainerStop],
  ['POST /container/restart', handleContainerRestart],
  ['DELETE /container/kill', handleContainerKill],
  ['POST /container/command', handleContainerCommand],
  ['DELETE /container', handleContainerDelete],
  ['GET /container/status', handleContainerStatus],
  ['GET /container/logs/history', handleContainerLogHistory],
  ['GET /container/logs/archives', handleContainerLogArchives],
  ['GET /container/logs/archives/read', handleContainerLogArchiveRead],
  ['GET /container/logs/archives/download', handleContainerLogArchiveDownload],
  ['POST /container/logs/archives/download-token', handleContainerLogArchiveDownloadToken],
  ['GET /container/stats', handleContainerStats],
  ['POST /container/backup', handleContainerBackup],
  ['POST /container/restore', handleContainerRestore],
  ['DELETE /container/backup', handleContainerBackupDelete],
  ['GET /container/backup/download', handleContainerBackupDownload],
  ['POST /container/backup/download-token', handleContainerBackupDownloadToken],
  ['POST /container/backup/upload', handleContainerBackupUpload],
  ['GET /fs/list', handleFsList],
  ['GET /fs/size', handleFsSize],
  ['GET /fs/info', handleFsInfo],
  ['GET /fs/file/content', handleFsFileRead],
  ['POST /fs/file/content', handleFsFileWrite],
  ['GET /fs/download', handleFsDownload],
  ['POST /fs/download-token', handleFsDownloadToken],
  ['DELETE /fs/rm', handleFsRm],
  ['POST /fs/copy', handleFsCopy],
  ['POST /fs/pull', handleFsPull],
  ['POST /fs/zip', handleFsZip],
  ['POST /fs/unzip', handleFsUnzip],
  ['POST /fs/rename', handleFsRename],
  ['POST /fs/upload', handleFsUpload],
  ['POST /fs/create-empty-file', handleFsCreateEmpty],
  ['POST /fs/mkdir', handleFsMkdir],
  ['POST /fs/append-file', handleFsAppend],
  ['POST /sftp/credentials', handleSftpCreate],
  ['DELETE /sftp/credentials', handleSftpRevoke],
  ['GET /sftp/status', handleSftpStatus],
  ['GET /sftp/activity', handleSftpActivity],
  ['GET /minecraft/players', handleMinecraftPlayers],
  ['POST /radar/scan', handleRadarScan],
  ['POST /radar/zip', handleRadarZip],
]);

const dynamicRoutes: [RegExp, string[], string, Handler][] = [
  [
    /^\/container\/status\/([a-zA-Z0-9_-]+)$/,
    ['id'],
    'GET',
    (req, params) => handleContainerInstallStatus(req, params),
  ],
  [/^\/container\/logs\/([a-zA-Z0-9_-]+)$/, ['id'], 'GET', (req, params) => handleContainerLogs(req, params)],
];

// ── SSRF address classification ─────────────────────────────────────────────
// classifyPublicUrl guard is shared by both /fs/pull and downloadToVolume (the
// install-time URL fetcher), so every hostname an operator can point at the
// daemon is checked against the same rules. The rules are deliberately strict:
// only clearly-global unicast addresses pass. Anything loopback, link-local,
// private, CGNAT, ULA, multicast, documentation, or otherwise non-routable is
// rejected — an SSRF open to 127.0.0.1/x is a foothold into the host network.

function isUnsafeIpv4(octets: number[]): boolean {
  if (octets.length !== 4) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && octets[2] === 99) return true; // 192.88.99.0/24 — stale 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255 broadcast
  return false;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return octets;
}

// Parses an IPv6 (with optional zone id and trailing IPv4-mapped quad) into its
// eight 16-bit hextets, or null. The embedded IPv4 quad always occupies the
// last two hextets, so ::-compressed zeros are placed between the leading
// groups and the mapped address.
function parseIpv6ToHextets(ip: string): number[] | null {
  const raw = ip.split('%')[0]; // strip zone id (e.g. fe80::1%eth0)
  let embedded: number[] | null = null;

  let head = raw;
  if (raw.includes('.')) {
    const lastColon = raw.lastIndexOf(':');
    if (lastColon === -1) return null;
    const octets = raw
      .slice(lastColon + 1)
      .split('.')
      .map((p) => parseInt(p, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    embedded = octets;
    head = raw.slice(0, lastColon);
  }

  const parts = head.split('::');
  if (parts.length > 2) return null;

  const parseGroup = (seg: string): number[] | null => {
    if (seg === '') return [];
    const groups: number[] = [];
    for (const p of seg.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      groups.push(parseInt(p, 16));
    }
    return groups;
  };

  const left = parseGroup(parts[0]);
  if (!left) return null;

  const hasCompression = parts.length === 2;
  const right = hasCompression ? parseGroup(parts[1]) : [];
  if (!right) return null;

  if (embedded) {
    // embedded quad pins to hextets 6 & 7, leaving room for the leading groups
    const explicitBefore = left.length + right.length;
    if (explicitBefore > 6) return null;
    const zeros = 6 - explicitBefore;
    const result = [...left];
    for (let i = 0; i < zeros; i++) result.push(0);
    result.push(...right, (embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
    return result;
  }

  if (hasCompression) {
    const zeros = 8 - left.length - right.length;
    if (zeros < 0) return null;
    const result = [...left];
    for (let i = 0; i < zeros; i++) result.push(0);
    return [...result, ...right];
  }

  const result = [...left, ...right];
  return result.length === 8 ? result : null;
}

function isUnsafeIpv6(hextets: number[]): boolean {
  const [a, b] = hextets;

  // IPv4-mapped ::ffff:a.b.c.d — classify by the embedded IPv4 address
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const v4 = [(hextets[6] >> 8) & 0xff, hextets[6] & 0xff, (hextets[7] >> 8) & 0xff, hextets[7] & 0xff];
    return isUnsafeIpv4(v4);
  }

  if (a === 0x0064 && b === 0xff9b) return true; // 64:ff9b::/96 NAT64 well-known prefix
  if (a === 0x2001 && b === 0x0db8) return true; // 2001:db8::/32 documentation

  // only 2000::/3 (first hextet 0x2000–0x3fff) is global unicast; everything
  // else is loopback ::1, unspecified ::, multicast ff::, link-local fe80,
  // ULA fc/fd, or reserved — none are safe SSRF destinations
  if (a < 0x2000 || a > 0x3fff) return true;
  return false;
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

// True when an IP (or 'localhost' hostname) is not safely global. Non-IP input
// is treated as unsafe (true): this guard rejects every address that is not
// clearly a public unicast IP, and callers resolve hostnames via DNS and feed
// each resulting IP back through this classifier.
export function isPrivateIp(ip: string): boolean {
  const host = stripBrackets(ip).toLowerCase();
  if (host === 'localhost') return true;

  if (isIP(host) === 4) {
    const octets = parseIpv4(host);
    return octets ? isUnsafeIpv4(octets) : true;
  }
  if (isIP(host) === 6) {
    const hextets = parseIpv6ToHextets(host);
    return hextets ? isUnsafeIpv6(hextets) : true;
  }

  // not a literal IP and not 'localhost' — treat as unsafe unless a caller
  // proves otherwise through DNS resolution
  return true;
}

// true only for clearly-loopback destinations (drives the "local" vs "private"
// error message distinction; both are rejected regardless)
function isLoopbackAddress(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (isIP(h) === 4) {
    const octets = parseIpv4(h);
    return octets !== null && octets[0] === 127;
  }
  if (h.startsWith('::ffff:127.') || h.startsWith('::ffff:7f')) return true; // IPv4-mapped loopback
  return false;
}

export type PublicUrlRejection = 'invalid_url' | 'unsupported_scheme' | 'local' | 'private';

// Typed rejection so handlers can map to stable HTTP codes / messages without
// leaking the underlying assertion out to clients.
export class PublicUrlError extends Error {
  readonly reason: PublicUrlRejection;
  constructor(reason: PublicUrlRejection, message: string) {
    super(message);
    this.name = 'PublicUrlError';
    this.reason = reason;
  }
}

// Shared SSRF gate. Parses + resolves a URL and confirms every resolved address
// is globally routable. Throws PublicUrlError for known-bad inputs and a plain
// Error is throw only then is a lookup/DNS failure (callers treat that like any
// other fetch-time failure). Returns the normalized URL ready to fetch.
export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PublicUrlError('invalid_url', 'invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PublicUrlError('unsupported_scheme', 'only http(s) URLs are allowed');
  }

  await assertPublicHostname(parsed.hostname);
  return parsed;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const host = stripBrackets(hostname).toLowerCase();

  // IP literals classify directly; the WHATWG URL parser has already folded
  // degenerate encodings (decimal/hex/octal quads like 2130706433) into a
  // dotted-quad here, so we get the canonical address.
  if (isIP(host) === 4 || isIP(host) === 6) {
    if (isPrivateIp(host)) {
      throw new PublicUrlError(isLoopbackAddress(host) ? 'local' : 'private', `non-public address: ${host}`);
    }
    return;
  }

  // Hostname — resolve ALL records (v4+v6) and reject if ANY resolves to a
  // private address. This defeats DNS rebinding: an attacker who flips the
  // record to 127.0.0.1 after validation still gets a private record rejected.
  // Resolution failure (NXDOMAIN etc.) propagates for the caller to map to its
  // normal fetch-error path rather than a validation 4xx.
  const addresses = await lookup(host, { all: true });

  for (const record of addresses) {
    if (isPrivateIp(record.address)) {
      throw new PublicUrlError(
        isLoopbackAddress(record.address) ? 'local' : 'private',
        `resolves to non-public address: ${record.address}`,
      );
    }
  }
}

export async function handleHttpRequest(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;

  let effectiveIp = 'unknown';
  const finish = (res: Response): Response => {
    const wrapped = withSecurityHeaders(res);
    if (key !== 'GET /healthz') {
      logger.info(`${req.method} ${url.pathname} ${effectiveIp} → ${wrapped.status} [${Date.now() - started}ms]`);
    }
    return wrapped;
  };

  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (contentLength > maxBodyBytesFor(key)) {
    return finish(apiError('request_too_large', 'request too large', 413));
  }

  const rawIp = server.requestIP(req);
  const socketIp = rawIp?.address.replace(/^::ffff:/, '') ?? 'unknown';

  const behindProxy = Bun.env.BEHIND_PROXY === 'true';
  effectiveIp = socketIp;
  if (behindProxy) {
    if (isPrivateIp(socketIp)) {
      effectiveIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || socketIp;
    } else {
      logger.warn(`BEHIND_PROXY=true but ${socketIp} is not a trusted proxy`);
    }
  }

  if (key === 'GET /healthz') {
    const isLocalhost = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === 'localhost';
    if (!isLocalhost) {
      return finish(apiError('local_only', 'local only', 403));
    }
    return finish(new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
  }

  const rlErr = checkRateLimit(effectiveIp);
  if (rlErr) return finish(rlErr);

  const ipErr = getAllowedIpCheck(effectiveIp);
  if (ipErr) return finish(ipErr);

  // ── One-time download tokens ──────────────────────────────────────────────
  // GET /dl/<token> is the only route that skips Basic + HMAC auth. The token
  // IS the credential: 256 bits of CSPRNG entropy, single-use, 90s TTL, and
  // consumed on first read. It is still rate-limited and IP allowlisted above.
  const tokenMatch = req.method === 'GET' ? /^\/dl\/([a-zA-Z0-9_-]{40,})$/.exec(url.pathname) : null;
  if (tokenMatch) {
    const token = tokenMatch[1];
    const res = await handleDownloadToken(req, token);
    return finish(res);
  }

  const authErr = checkBasicAuth(req, config.key);
  if (authErr) return finish(authErr);

  const hmacErr = await verifyHmac(req, config.key, key);
  if (hmacErr) return finish(hmacErr);

  if (req.method !== 'GET') {
    const ct = req.headers.get('content-type') ?? '';
    const ok =
      !ct ||
      ct.startsWith('application/json') ||
      ct.startsWith('application/octet-stream') ||
      ct.startsWith('text/') ||
      ct.startsWith('multipart/');
    if (!ok) {
      return finish(apiError('unsupported_content_type', 'unsupported content type', 415));
    }
  }

  const handler = exactRoutes.get(key);
  if (handler) {
    try {
      return finish(await handler(req, {}));
    } catch (err) {
      logger.error(`route error: ${key}`, err);
      return finish(apiError('internal_error', 'internal error', 500));
    }
  }

  for (const [pattern, paramNames, method, dynHandler] of dynamicRoutes) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });

    try {
      return finish(await dynHandler(req, params));
    } catch (err) {
      logger.error(`route error: ${url.pathname}`, err);
      return finish(apiError('internal_error', 'internal error', 500));
    }
  }

  return finish(apiError('not_found', 'not found', 404));
}
