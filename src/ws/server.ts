import type { ServerWebSocket } from 'bun';
import { attachToContainer } from './attach';
import { startStatusPolling, stopStatusPolling } from './status';
import { subscribe } from './events';
import { sendCommandToContainer } from '../handlers/docker';
import { validateContainerId } from '../validation';
import config from '../config';
import logger from '../logger';

export type WsData = {
  route:       'container' | 'containerstatus' | 'containerevents';
  containerId: string;
  authed:      boolean;
  timer?:      ReturnType<typeof setInterval>;
  unsub?:      () => void;
  _logCleanup?: () => void;
};

let openWsCount = 0;
const MAX_WS    = 500;

export const openConnections = new Set<ServerWebSocket<WsData>>();

export function wsOpen(ws: ServerWebSocket<WsData>): void {
  if (openWsCount >= MAX_WS) {
    ws.close(1013, 'too many connections');
    return;
  }
  openWsCount++;
  openConnections.add(ws);
  logger.debug(`ws open: ${ws.data.route}/${ws.data.containerId} (${openWsCount} total)`);
}

export function wsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  let msg: { event: string; args?: string[]; command?: string } | null = null;

  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    ws.send(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  if (!msg || !msg.event) {
    ws.send(JSON.stringify({ error: 'missing event field' }));
    return;
  }

  if (msg.event === 'auth') {
    const key = msg.args?.[0];
    if (key !== config.key) {
      ws.send(JSON.stringify({ error: 'invalid key' }));
      ws.close(1008, 'auth failed');
      return;
    }
    ws.data.authed = true;

    // start the appropriate subscription now that we're authed
    if (ws.data.route === 'container') {
      attachToContainer(ws.data.containerId, ws);
    } else if (ws.data.route === 'containerstatus') {
      ws.data.timer = startStatusPolling(ws.data.containerId, ws);
    } else if (ws.data.route === 'containerevents') {
      ws.data.unsub = subscribe(ws.data.containerId, (event) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'lifecycle', data: event }));
      });
    }
    return;
  }

  if (!ws.data.authed) {
    ws.send(JSON.stringify({ error: 'not authenticated' }));
    return;
  }

  if (msg.event === 'CMD') {
    if (ws.data.route !== 'container') {
      ws.send(JSON.stringify({ error: 'CMD only valid on /container route' }));
      return;
    }
    if (!msg.command || typeof msg.command !== 'string') {
      ws.send(JSON.stringify({ error: 'missing command' }));
      return;
    }
    // fire and forget — same as the original
    sendCommandToContainer(ws.data.containerId, msg.command).catch(err => {
      logger.error(`command send failed for ${ws.data.containerId}`, err);
    });
    return;
  }

  logger.debug(`unknown ws event: ${msg.event}`);
}

export function wsClose(ws: ServerWebSocket<WsData>, code: number, _reason: string): void {
  openWsCount = Math.max(0, openWsCount - 1);
  openConnections.delete(ws);

  if (ws.data.timer) stopStatusPolling(ws.data.timer);
  if (ws.data.unsub) ws.data.unsub();
  if (ws.data._logCleanup) ws.data._logCleanup();

  logger.debug(`ws closed: ${ws.data.route}/${ws.data.containerId} code=${code}`);
}

// builds the data object attached to each WS upgrade
export function buildWsData(
  route: 'container' | 'containerstatus' | 'containerevents',
  containerId: string,
): WsData {
  return { route, containerId, authed: false };
}
