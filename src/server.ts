import config from './config';
import { checkDocker, checkDockerRunning, initContainerStateMap } from './handlers/docker';
import { getCurrentStats, initStatsCollection, saveStats } from './handlers/stats';
import logger, { drawHeader } from './logger';
import { handleHttpRequest } from './router';
import { getAllowedIpCheck } from './security/hmac';
import { checkRateLimit } from './security/rateLimit';
import { validateContainerId } from './validation';
import type { WsData } from './ws/server';
import { buildWsData, openConnections, wsClose, wsMessage, wsOpen } from './ws/server';

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === 'localhost' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function resolveEffectiveIp(req: Request, server: ReturnType<typeof Bun.serve>): string {
  const rawIp = server.requestIP(req);
  const socketIp = rawIp?.address.replace(/^::ffff:/, '') ?? 'unknown';

  if (Bun.env.BEHIND_PROXY === 'true') {
    if (isPrivateIp(socketIp)) {
      return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || socketIp;
    }
    logger.warn(`BEHIND_PROXY=true but ${socketIp} is not a trusted proxy`);
  }

  return socketIp;
}

function attemptUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): boolean | Response {
  if (req.method !== 'GET') return false;

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const route = parts[0];
  const containerId = parts[1];

  const validRoutes = ['container', 'containerstatus', 'containerevents'];
  if (!validRoutes.includes(route) || !containerId) return false;
  if (parts.length !== 2) return false;
  if (!validateContainerId(containerId)) return false;

  const effectiveIp = resolveEffectiveIp(req, server);
  const ipErr = getAllowedIpCheck(effectiveIp);
  if (ipErr) return ipErr;

  const rlErr = checkRateLimit(effectiveIp, 60);
  if (rlErr) return rlErr;

  return server.upgrade(req, {
    data: buildWsData(route as 'container' | 'containerstatus' | 'containerevents', containerId),
  });
}

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', reason as Error);
});

drawHeader(config.version, config.port);

try {
  await checkDocker();
  await checkDockerRunning();
  await initContainerStateMap();
} catch (err) {
  logger.error('docker is not ready, so container actions are paused for now', err as Error);
}
initStatsCollection();

const tls =
  config.tlsCertPath && config.tlsKeyPath
    ? {
        cert: Bun.file(config.tlsCertPath),
        key: Bun.file(config.tlsKeyPath),
      }
    : undefined;

if (config.tlsCertPath && !config.tlsKeyPath) {
  logger.warn('TLS certificate configured without TLS key; TLS disabled');
}

export const server = Bun.serve<WsData>({
  port: config.port,
  hostname: '0.0.0.0',

  fetch(req, server) {
    const upgradeResult = attemptUpgrade(req, server);
    if (upgradeResult === true) return;
    if (upgradeResult instanceof Response) return upgradeResult;
    return handleHttpRequest(req, server);
  },

  websocket: {
    open(ws) {
      wsOpen(ws);
    },
    message(ws, msg) {
      wsMessage(ws, msg);
    },
    close(ws, code, why) {
      wsClose(ws, code, why);
    },
    drain() {
      /* bun requires this */
    },
  },

  tls,
});

logger.ok(`ready on port ${config.port}`);

if (process.env.DAEMON_WORKER_MODE === '1')
  (self as unknown as Worker).postMessage({ type: 'ready', port: config.port });

setInterval(async () => {
  try {
    const stats = await getCurrentStats();
    saveStats(stats);
  } catch (err) {
    logger.error('could not collect host stats', err);
  }
}, config.statsInterval);

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);

  server.stop(false);

  for (const ws of openConnections) ws.close(1001, 'server shutting down');

  try {
    const stats = await getCurrentStats();
    saveStats(stats);
  } catch {
    /* don't let a stats error block shutdown */
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));

  logger.info('shutdown finished');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
