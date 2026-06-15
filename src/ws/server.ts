import type { ServerWebSocket } from 'bun';
import config from '../config';
import { sendCommandToContainer } from '../handlers/docker';
import logger from '../logger';
import { attachToContainer } from './attach';
import { subscribe } from './events';
import { startStatusPolling, stopStatusPolling } from './status';

export type WsData = {
  route: 'container' | 'containerstatus' | 'containerevents';
  containerId: string;
  authed: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setInterval>;
  unsub?: () => void;
  _logCleanup?: () => void;
};

// Type guard: asserts that the WebSocket is authenticated.
// Use before any non-auth handler to prevent accidental auth bypass.
export function assertAuthed(data: WsData): asserts data is WsData & { authed: true } {
  if (!data.authed) throw new Error('WebSocket not authenticated');
}

let openWsCount = 0;
const MAX_WS = 500;
const AUTH_TIMEOUT_MS = 10_000;

export const openConnections = new Set<ServerWebSocket<WsData>>();

type IncomingCommand = {
  event?: string;
  args?: string[];
  command?: string;
};

function extractCommand(msg: IncomingCommand): string | null {
  // panel specifically sends msg.command, check it first
  if (typeof msg.command === 'string') {
    const trimmed = msg.command.replace(/\r\n?/g, '\n').trim();
    if (trimmed) return trimmed;
  }

  if (Array.isArray(msg.args) && msg.args.length > 0) {
    const joined = msg.args
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (joined) return joined;
  }

  return null;
}

// Panel sends { event: 'auth', args: [key] } exactly.
// Removed: key, token, command field fallbacks were compatibility shims for
// undocumented clients. Accepting auth keys in unexpected fields was a
// security risk — an attacker could inject auth via any message field.
function extractAuthKey(msg: IncomingCommand): string | null {
  if (Array.isArray(msg.args) && msg.args.length > 0) {
    const candidate = msg.args[0];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function isCommandEvent(event: string): boolean {
  return ['cmd', 'command', 'input', 'stdin', 'sendcommand'].includes(event.toLowerCase());
}

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
  let msg: IncomingCommand | null = null;

  try {
    const payload = typeof raw === 'string' ? raw : raw.toString();
    msg = JSON.parse(payload) as IncomingCommand;
  } catch {
    const fallbackCommand = typeof raw === 'string' ? raw.trim() : raw.toString().trim();
    if (!fallbackCommand) {
      ws.send(JSON.stringify({ error: 'invalid json' }));
      ws.close(1008, 'invalid json');
      return;
    }
    msg = { event: 'CMD', command: fallbackCommand };
  }

  const event = (msg.event ?? (extractCommand(msg) ? 'CMD' : '')).trim();
  const eventName = event.toLowerCase();

  if (!event) {
    ws.send(JSON.stringify({ error: 'missing event field' }));
    ws.close(1008, 'missing event');
    return;
  }

  if (eventName === 'auth') {
    const key = extractAuthKey(msg);
    if (key !== config.key) {
      logger.warn(`ws auth rejected for ${ws.data.containerId}`);
      ws.send(JSON.stringify({ error: 'invalid key' }));
      ws.close(1008, 'auth failed');
      return;
    }

    ws.data.authed = true;
    clearAuthTimer(ws);

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
    });
    return;
  }
}

export function wsClose(ws: ServerWebSocket<WsData>, _code: number, _reason: string): void {
  openWsCount = Math.max(0, openWsCount - 1);
  openConnections.delete(ws);
  clearAuthTimer(ws);

  if (ws.data.timer) stopStatusPolling(ws.data.timer);
  if (ws.data.unsub) ws.data.unsub();
  if (ws.data._logCleanup) ws.data._logCleanup();
}

// builds the data object attached to each WS upgrade
export function buildWsData(route: 'container' | 'containerstatus' | 'containerevents', containerId: string): WsData {
  return { route, containerId, authed: false };
}
