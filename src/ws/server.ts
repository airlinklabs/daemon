import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import config from '../config';
import { sendCommandToContainer } from '../handlers/docker';
import logger from '../logger';
import { attachToContainer } from './attach';
import { subscribe } from './events';
import { startStatusPolling, stopStatusPolling } from './status';

// ---------------------------------------------------------------------------
// WS in-band auth threat model (Ledger F-005).
//
// The panel authenticates each socket with an in-band `auth` message carrying
// the daemon key (`config.key`). The key is a long-lived static secret, so a
// socket that carries it is trusted for its whole lifetime. An attacker who can
// read network traffic can capture the key and replay it on a fresh socket —
// the daemon has no way to distinguish a replayed key from a fresh one. Closing
// that gap requires a per-connection challenge (a nonce signed with the shared
// key), which is a cross-repo protocol change: the panel client would have to
// participate. The current wire shape is pinned by the panel, so within it the
// meaningful mitigations are:
//
//   1. Constant-time key comparison — `===` leaks the byte-by-byte match length
//      via response timing, which a remote attacker can exploit to recover the
//      key over many guesses.
//   2. Per-socket auth attempt cap — retries are bounded, so a socket without
//      the key can only burn MAX_AUTH_ATTEMPTS guesses before being closed.
//   3. Auth timeout — a socket that never authenticates is closed after
//      AUTH_TIMEOUT_MS (bounded brute force window even with many sockets).
//   4. Close on auth failure — once the cap is reached the socket is closed and
//      can never be re-purposed, even by a later correct key.
//
// These make online guessing against a single socket impractical but do NOT
// defend against offline replay of a captured key. See the phase report for
// where a nonce challenge belongs.
// ---------------------------------------------------------------------------

export type WsData = {
  route: 'container' | 'containerstatus' | 'containerevents';
  containerId: string;
  authed: boolean;
  authFailures: number;
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
const MAX_AUTH_ATTEMPTS = 5;

export const openConnections = new Set<ServerWebSocket<WsData>>();

// Constant-time comparison of the WS auth key.
//
// `timingSafeEqual` requires equal-length inputs and throws otherwise, so we
// hash both candidates to fixed-size sha256 digests first. sha256 output length
// is constant, so the digest carries no information about the key length, and
// the comparison runs in constant time regardless of the wire value. Hashing
// the expected key once per message is cheap (32 bytes) and keeps the code
// simple; the expected digest could be precomputed, but that optimization is
// not worth the extra state.
function timingSafeKeyEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

type IncomingCommand = {
  event?: string;
  args?: string[];
  command?: string;
};

// ---------------------------------------------------------------------------
// Capability token verification (panel-minted, replaces raw key auth).
// Token format: base64url(payload).base64url(hmac-sha256)
// Signed with the daemon key; contains serverId, permitted routes, expiry, jti.
// ---------------------------------------------------------------------------
interface CapabilityClaims {
  v: number;
  nodeId: number;
  serverId: string;
  routes: string[];
  iat: number;
  exp: number;
  jti: string;
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function verifyCapabilityToken(
  token: string,
  expectedKey: string,
  containerId: string,
  route: string,
): { ok: true; claims: CapabilityClaims } | { ok: false; error: string } {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed token' };

  const [payload, sig] = [parts[0]!, parts[1]!];

  // Verify HMAC signature
  const expected = createHmac('sha256', expectedKey).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid signature' };
  }

  // Decode claims
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as CapabilityClaims;
  } catch {
    return { ok: false, error: 'invalid payload' };
  }

  if (claims.v !== 1) return { ok: false, error: 'unsupported version' };
  if (claims.serverId !== containerId) return { ok: false, error: 'server ID mismatch' };
  if (!claims.routes.includes(route)) return { ok: false, error: 'route not permitted' };
  if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return { ok: false, error: 'token expired' };

  return { ok: true, claims };
}

// Canonical shape per D-005: { event: 'CMD', command: string } only.
// The args/field fallbacks were undocumented compatibility shims and are gone.
function extractCommand(msg: IncomingCommand): string | null {
  if (typeof msg.command === 'string') {
    const trimmed = msg.command.replace(/\r\n?/g, '\n').trim();
    if (trimmed) return trimmed;
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

// One canonical command event per D-005: 'CMD' (case-insensitive).
function isCommandEvent(event: string): boolean {
  return event.toLowerCase() === 'cmd';
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
    // no raw-text coercion (D-005) — non-JSON frames are invalid
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
    // Reject a second auth message once the socket is authenticated. The route
    // handlers (attach / status polling / event subscription) are wired to this
    // socket on first auth; re-auth would re-wire them (duplicate log streams,
    // double polling intervals) and would let an attacker re-key a hijacked
    // socket. The panel sends auth exactly once, so this only fires on protocol
    // violations.
    if (ws.data.authed) {
      ws.send(JSON.stringify({ error: 'already authenticated' }));
      ws.close(1008, 'auth rejected');
      return;
    }

    // The cap already exhausted — the close above should be in flight, but
    // defend the "never authenticate after cap" invariant even if close is
    // delivered asynchronously.
    if (ws.data.authFailures >= MAX_AUTH_ATTEMPTS) {
      ws.close(1008, 'auth failed');
      return;
    }

    const key = extractAuthKey(msg);
    if (!key) {
      ws.send(JSON.stringify({ error: 'missing credentials' }));
      ws.close(1008, 'missing credentials');
      return;
    }

    // Try capability token first (panel-minted, scoped, short-lived).
    const capResult = verifyCapabilityToken(key, config.key, ws.data.containerId, ws.data.route);
    if (capResult.ok) {
      ws.data.authed = true;
      ws.data.authFailures = 0;
      clearAuthTimer(ws);
    } else {
      // Fallback: legacy raw key auth (static, unscoped).
      // DEPRECATED: will be removed in a future version. The panel should
      // always send capability tokens. Log a deprecation warning.
      if (timingSafeKeyEquals(key, config.key)) {
        logger.warn(`ws legacy raw-key auth used for ${ws.data.route}/${ws.data.containerId} — deprecated, upgrade panel`);
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

  if (ws.data.timer) stopStatusPolling(ws.data.timer);
  if (ws.data.unsub) ws.data.unsub();
  if (ws.data._logCleanup) ws.data._logCleanup();
}

// builds the data object attached to each WS upgrade
export function buildWsData(route: 'container' | 'containerstatus' | 'containerevents', containerId: string): WsData {
  return { route, containerId, authed: false, authFailures: 0 };
}
