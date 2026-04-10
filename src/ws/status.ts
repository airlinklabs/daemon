import type { ServerWebSocket } from "bun";
import type { WsData } from "./server";
import { getContainerStats } from "../handlers/docker";
import logger from "../logger";

const POLL_MS = 2000;

export function startStatusPolling(containerId: string, ws: ServerWebSocket<WsData>): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    if (ws.readyState !== 1) return;
    try {
      const stats = await getContainerStats(containerId);
      if (!stats) {
        ws.send(JSON.stringify({ running: false, exists: false }));
        return;
      }
      ws.send(JSON.stringify(stats));
    } catch (err) {
      logger.debug(`status poll error for ${containerId}`, err);
    }
  }, POLL_MS);
}

export function stopStatusPolling(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}
