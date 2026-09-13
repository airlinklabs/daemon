// polls container stats every 2s and pushes them over the WS
// the panel uses this to update the server card indicators in real time

import type { ServerWebSocket } from "bun";
import { CONTAINER_STATUS_POLL_MS } from "../config/timeouts";
import {
  getContainerState,
  getContainerStats,
  isContainerRunning,
} from "../handlers/docker";
import logger from "../logger";
import type { WsData } from "./server";

const POLL_MS = CONTAINER_STATUS_POLL_MS;

export function startStatusPolling(
  containerId: string,
  ws: ServerWebSocket<WsData>,
): ReturnType<typeof setInterval> {
  // send initial state right away — don't make the client wait 2s
  logger.debug(`status polling started for container ${containerId}`);
  sendState(containerId, ws);
  sendStats(containerId, ws);

  let tick = 0;
  return setInterval(async () => {
    if (ws.readyState !== 1) return; // connection is gone, interval will be cleared by wsClose
    tick++;
    await sendState(containerId, ws);
    // stats are expensive (docker API call) — only every other tick (~4s)
    if (tick % 2 === 0) await sendStats(containerId, ws);
  }, POLL_MS);
}

async function sendState(
  containerId: string,
  ws: ServerWebSocket<WsData>,
): Promise<void> {
  if (ws.readyState !== 1) return;
  const knownRunning = isContainerRunning(containerId);
  if (knownRunning === true) {
    ws.send(JSON.stringify({ event: "state", data: { running: true } }));
    return;
  }
  // stopped / unknown — inspect for the real reason (exit code distinguishes
  // a crash from a deliberate stop)
  const state = await getContainerState(containerId);
  logger.debug(
    `container state poll: serverId=${containerId} running=${state.running} exitCode=${(state as any).exitCode ?? "n/a"}`,
  );
  if (ws.readyState === 1)
    ws.send(JSON.stringify({ event: "state", data: state }));
}

async function sendStats(
  containerId: string,
  ws: ServerWebSocket<WsData>,
): Promise<void> {
  if (ws.readyState !== 1) return;
  try {
    const stats = await getContainerStats(containerId);
    if (stats && ws.readyState === 1) {
      logger.debug(`container stats collected: serverId=${containerId}`);
      ws.send(JSON.stringify({ event: "stats", data: stats }));
    }
  } catch (err) {
    logger.warn(
      `container stats failed: serverId=${containerId} error=${(err as Error).message}`,
    );
  }
}

export function stopStatusPolling(timer: ReturnType<typeof setInterval>): void {
  logger.debug("status polling stopped");
  clearInterval(timer);
}
