import config from "./config";
import type { ServerWebSocket } from "bun";
import logger, { drawHeader, updateStatus } from "./logger";
import { checkDocker, checkDockerRunning, docker, initContainerStateMap } from "./handlers/docker";
import { getCurrentStats, initStatsCollection, saveStats } from "./handlers/stats";
import { handleHttpRequest } from "./router";
import { buildWsData, getOpenConnections, wsClose, wsMessage, wsOpen, type WsData } from "./ws/server";

console.clear();
drawHeader(config.version, config.port);

await checkDocker();
await checkDockerRunning();
await initContainerStateMap();
await initStatsCollection();

const startTime = Date.now();
setInterval(async () => {
  const containers = await docker.listContainers({ all: false }).catch(() => []);
  updateStatus(Math.floor((Date.now() - startTime) / 1000), containers.length);
}, 5000);

export const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  fetch(req: Request, server: { upgrade: (req: Request, options: { data: WsData }) => boolean }) {
    const wsData = buildWsData(req);
    if (wsData && server.upgrade(req, { data: wsData })) return;
    return handleHttpRequest(req);
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      wsOpen(ws);
    },
    message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
      wsMessage(ws, msg);
    },
    close(ws: ServerWebSocket<WsData>, code: number, why: string | Buffer) {
      wsClose(ws, code, String(why));
    },
    drain() {},
  },
  tls: config.tlsCertPath
    ? {
        cert: Bun.file(config.tlsCertPath),
        key: Bun.file(config.tlsKeyPath!),
      }
    : undefined,
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`received ${signal}, shutting down`);
  server.stop(false);
  for (const ws of getOpenConnections()) ws.close(1001, "server shutting down");
  try {
    await saveStats(await getCurrentStats());
  } catch {}
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  logger.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.ok(`listening on port ${config.port}`);
