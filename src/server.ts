import config from './config';
import logger, { drawHeader } from './logger';
import { checkDocker, checkDockerRunning, initContainerStateMap } from './handlers/docker';
import { initStatsCollection, getCurrentStats, saveStats } from './handlers/stats';
import { handleHttpRequest } from './router';
import { wsOpen, wsMessage, wsClose, buildWsData, openConnections } from './ws/server';
import type { WsData } from './ws/server';
import { validateContainerId } from './validation';

function tryUpgrade(req: Request, server: ReturnType<typeof Bun.serve>): boolean {
  const url   = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const route = parts[0];
  const containerId = parts[1];

  const validRoutes = ['container', 'containerstatus', 'containerevents'];
  if (!validRoutes.includes(route) || !containerId) return false;
  if (!validateContainerId(containerId)) return false;

  return server.upgrade(req, {
    data: buildWsData(
      route as 'container' | 'containerstatus' | 'containerevents',
      containerId,
    ),
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
  logger.error('docker init failed — container operations will not work', err as Error);
}
initStatsCollection();

export const server = Bun.serve<WsData>({
  port:     config.port,
  hostname: '0.0.0.0',

  fetch(req, server) {
    if (tryUpgrade(req, server)) return;
    return handleHttpRequest(req, server);
  },

  websocket: {
    open(ws)             { wsOpen(ws); },
    message(ws, msg)     { wsMessage(ws, msg); },
    close(ws, code, why) { wsClose(ws, code, why); },
    drain()              { /* bun requires this */ },
  },

  tls: config.tlsCertPath ? {
    cert: Bun.file(config.tlsCertPath),
    key:  Bun.file(config.tlsKeyPath!),
  } : undefined,
});

logger.ok(`listening on port ${config.port}`);

if (process.env.DAEMON_WORKER_MODE === '1') {
  // tell the GUI thread the port is bound and we're ready to receive requests
  (self as unknown as Worker).postMessage({ type: 'ready', port: config.port });
}

setInterval(async () => {
  try {
    const stats = await getCurrentStats();
    saveStats(stats);
  } catch (err) {
    logger.error('error collecting stats', err);
  }
}, config.statsInterval);

async function shutdown(signal: string): Promise<void> {
  logger.info(`received ${signal}, shutting down`);

  server.stop(false);

  for (const ws of openConnections) ws.close(1001, 'server shutting down');

  try {
    const stats = await getCurrentStats();
    saveStats(stats);
  } catch { /* don't let a stats error block shutdown */ }

  await new Promise<void>(resolve => setTimeout(resolve, 10_000));

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));
