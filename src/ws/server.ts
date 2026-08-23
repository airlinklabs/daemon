import type { ServerWebSocket } from 'bun';
import config from '../config';
import { sendCommandToContainer } from '../handlers/docker';
import logger from '../logger';
import { attachToContainer } from './attach';
import { extractAuthKey, extractCommand, isCommandEvent, timingSafeKeyEquals, verifyCapabilityToken } from './auth';
import { subscribe } from './events';
import { startNodeStatsPolling, stopNodeStatsPolling } from './nodestats';
import { startStatusPolling, stopStatusPolling } from './status';

export type WsData = {
  route: 'container' | 'containerstatus' | 'containerevents' | 'nodestats';
  containerId: string;
  authed: boolean;
  authFailures: number;
  authTimer?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setInterval>;
  unsub?: () => void;
  _logCleanup?: () => void;
};

export function assertAuthed(data: WsData): asserts data is WsData & { authed: true } {
  if (!data.authed) throw new Error('WebSocket not authenticated');
}

let openWsCount = 0;
const MAX_WS = 200;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_AUTH_ATTEMPTS = 5;

export const openConnections = new Set<ServerWebSocket<WsData>>();

function clearAuthTimer(ws: ServerWebSocket<WsData>): void {
  if (ws.data.authTimer) {
    clearTimeout(ws.data.authTimer);
    ws.data.authTimer = undefined;
  }
}

function startAuthTimer(ws: ServerWebSocket<WsData>): void {
  clearAuthTimer(ws);
  ws.data.authTimer = setTimeout(() => {
    if (!ws.data.authed && ws.readyState === 1) {
      logger.warn(`ws auth timeout: ${ws.data.route}/${ws.data.containerId}`);
      ws.send(JSON.stringify({ error: 'authentication timeout' }));
      ws.close(1008, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);
}

export function wsOpen(ws: ServerWebSocket<WsData>): void {
  if (openWsCount >= MAX_WS) {
    ws.close(1013, 'too many connections');
    return;
  }
  openWsCount++;
  openConnections.add(ws);
  startAuthTimer(ws);
}

export function wsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  let msg: import('./auth').IncomingCommand | null = null;

  try {
    const payload = typeof raw === 'string' ? raw : raw.toString();
    msg = JSON.parse(payload) as import('./auth').IncomingCommand;
  } catch {
    ws.send(JSON.stringify({ error: 'invalid json' }));
    ws.close(1008, 'invalid json');
    return;
  }

  const event = (msg.event ?? '').trim();
  const eventName = event.toLowerCase();

  if (!event) {
    ws.send(JSON.stringify({ error: 'missing event field' }));
    ws.close(1008, 'missing event');
    return;
  }

  if (eventName === 'auth') {
    if (ws.data.authed) {
      ws.send(JSON.stringify({ error: 'already authenticated' }));
      ws.close(1008, 'auth rejected');
      return;
    }

    if (ws.data.authFailures >= MAX_AUTH_ATTEMPTS) {
      ws.close(1008, 'auth failed');
      return;
    }

    const key = extractAuthKey(msg);
    if (!key) {
      ws.data.authFailures += 1;
      if (ws.data.authFailures >= MAX_AUTH_ATTEMPTS) {
        ws.send(JSON.stringify({ error: 'auth failed' }));
        ws.close(1008, 'auth failed');
      } else {
        ws.send(JSON.stringify({ error: 'missing credentials' }));
        ws.close(1008, 'missing credentials');
      }
      return;
    }

    const capResult = verifyCapabilityToken(key, config.key, ws.data.containerId, ws.data.route);
    if (capResult.ok) {
      ws.data.authed = true;
      ws.data.authFailures = 0;
      clearAuthTimer(ws);
    } else {
      if (timingSafeKeyEquals(key, config.key)) {
        logger.warn(
          `ws legacy raw-key auth used for ${ws.data.route}/${ws.data.containerId} — deprecated, upgrade panel`,
        );
        ws.data.authed = true;
        ws.data.authFailures = 0;
        clearAuthTimer(ws);
      } else {
        ws.data.authFailures += 1;
        if (ws.data.authFailures >= MAX_AUTH_ATTEMPTS) {
          logger.warn(`ws auth failed ${MAX_AUTH_ATTEMPTS} times for ${ws.data.containerId}; closing`);
          ws.send(JSON.stringify({ error: 'auth failed' }));
          ws.close(1008, 'auth failed');
          return;
        }
        logger.warn(`ws auth rejected for ${ws.data.containerId} (${ws.data.authFailures}/${MAX_AUTH_ATTEMPTS})`);
        ws.send(JSON.stringify({ error: 'invalid credentials' }));
        return;
      }
    }

    if (ws.data.route === 'container') {
      attachToContainer(ws.data.containerId, ws);
    } else if (ws.data.route === 'containerstatus') {
      ws.data.timer = startStatusPolling(ws.data.containerId, ws);
    } else if (ws.data.route === 'containerevents') {
      ws.data.unsub = subscribe(ws.data.containerId, (event) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'lifecycle', data: event }));
      });
    } else if (ws.data.route === 'nodestats') {
      ws.data.timer = startNodeStatsPolling(ws);
    }
    return;
  }

  if (!ws.data.authed) {
    ws.send(JSON.stringify({ error: 'not authenticated' }));
    ws.close(1008, 'auth required');
    return;
  }

  if (isCommandEvent(eventName)) {
    if (ws.data.route !== 'container') {
      ws.send(JSON.stringify({ error: 'CMD only valid on /container route' }));
      ws.close(1008, 'invalid route');
      return;
    }
    const command = extractCommand(msg);
    if (!command) {
      ws.send(JSON.stringify({ error: 'missing command' }));
      return;
    }
    sendCommandToContainer(ws.data.containerId, command).catch((err) => {
      logger.error(`command send failed for ${ws.data.containerId}`, err);
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            event: 'error',
            data: { message: `command not sent: ${err instanceof Error ? err.message : 'unknown error'}` },
          }),
        );
      }
    });
    return;
  }
}

export function wsClose(ws: ServerWebSocket<WsData>, _code: number, _reason: string): void {
  openWsCount = Math.max(0, openWsCount - 1);
  openConnections.delete(ws);
  clearAuthTimer(ws);

  if (ws.data.timer) {
    if (ws.data.route === 'nodestats') stopNodeStatsPolling(ws.data.timer);
    else stopStatusPolling(ws.data.timer);
  }
  if (ws.data.unsub) ws.data.unsub();
  if (ws.data._logCleanup) ws.data._logCleanup();
}

export function buildWsData(
  route: 'container' | 'containerstatus' | 'containerevents' | 'nodestats',
  containerId: string,
): WsData {
  return { route, containerId, authed: false, authFailures: 0 };
}
