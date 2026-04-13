// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
// polls container stats every 2s and pushes them over the WS
// the panel uses this to update the server card indicators in real time

import type { ServerWebSocket } from 'bun';
import { getContainerState, getContainerStats, isContainerRunning } from '../handlers/docker';
import type { WsData } from './server';

const POLL_MS = 2000;

export function startStatusPolling(containerId: string, ws: ServerWebSocket<WsData>): ReturnType<typeof setInterval> {
  // send initial state right away — don't make the client wait 2s
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

async function sendState(containerId: string, ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.readyState !== 1) return;
  const knownRunning = isContainerRunning(containerId);
  if (knownRunning !== null) {
    ws.send(JSON.stringify({ event: 'state', data: { running: knownRunning } }));
  } else {
    const state = await getContainerState(containerId);
    if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'state', data: state }));
  }
}

async function sendStats(containerId: string, ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.readyState !== 1) return;
  try {
    const stats = await getContainerStats(containerId);
    if (stats && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'stats', data: stats }));
    }
  } catch {
    // stats unavailable — send nothing, client keeps previous values
  }
}

export function stopStatusPolling(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}
