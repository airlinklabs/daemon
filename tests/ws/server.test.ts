import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ServerWebSocket, WebSocketReadyState } from 'bun';
import config from '../../src/config';
import * as dockerMod from '../../src/handlers/docker';
import * as events from '../../src/ws/events';
import { buildWsData, openConnections, wsClose, wsMessage, wsOpen } from '../../src/ws/server';
import type { WsData } from '../../src/ws/server';

const KEY = config.key;

// A minimal but complete ServerWebSocket<WsData> double. The daemon handlers
// only touch `.data`, `.send`, `.close`, and `.readyState`, but the exported
// signatures are typed as the full Bun type, so the fake has to structurally
// satisfy every member. Unused methods are no-ops. A closure keeps the writeable
// state (`readyState`, close code) reachable from the read-only surface and from
// the `sent`/`closedCode` inspection helpers.
type FakeWs = ServerWebSocket<WsData> & {
  sent: Array<string | Bun.BufferSource>;
  closedCode: number | undefined;
  closedReason: string | undefined;
  setReadyState: (state: number) => void;
};

function makeFakeWs(route: WsData['route'], containerId = 'ctn'): FakeWs {
  const data: WsData = buildWsData(route, containerId);
  const sent: Array<string | Bun.BufferSource> = [];
  let ready: number = 1;
  let code: number | undefined;
  let reason: string | undefined;

  // Annotated as FakeWs so `this` inside the methods is typed as FakeWs, which
  // lets `cork` hand the socket to its callback without a cast.
  const ws: FakeWs = {
    data,
    get readyState(): WebSocketReadyState {
      return ready as WebSocketReadyState;
    },
    remoteAddress: '127.0.0.1',
    // Bun's `subscriptions` is a `readonly` property typed `string[]` (not
    // `readonly string[]`), so the fake must expose a mutable `string[]`. A
    // getter keeps the field read-only from the outside while satisfying the
    // mutable element type.
    get subscriptions(): string[] {
      return [];
    },
    binaryType: 'nodebuffer',

    get sent(): Array<string | Bun.BufferSource> {
      return sent;
    },
    get closedCode(): number | undefined {
      return code;
    },
    get closedReason(): string | undefined {
      return reason;
    },
    setReadyState(state: number): void {
      ready = state;
    },

    // Bun's `send`/`sendBinary` accept `Bun.BufferSource` (which includes
    // `SharedArrayBuffer`), a superset of the lib's global `BufferSource`.
    // Mirroring the exact param type lets the fake structurally satisfy the
    // interface and keeps `sent` consistent without narrowing.
    send(message: string | Bun.BufferSource): number {
      sent.push(message);
      return 0;
    },
    sendText(message: string): number {
      sent.push(message);
      return 0;
    },
    sendBinary(message: Bun.BufferSource): number {
      sent.push(message);
      return 0;
    },
    close(c: number | undefined = undefined, r: string | undefined = undefined): void {
      code = c;
      reason = r;
      ready = 3;
    },
    terminate(): void {
      ready = 3;
    },
    ping(): number {
      return 0;
    },
    pong(): number {
      return 0;
    },
    publish(): number {
      return 0;
    },
    publishText(): number {
      return 0;
    },
    publishBinary(): number {
      return 0;
    },
    subscribe(): void {},
    unsubscribe(): void {},
    isSubscribed(): boolean {
      return false;
    },
    getBufferedAmount(): number {
      return 0;
    },
    // Bun's real `cork` is generic over the socket data (`ServerWebSocket<T>`),
    // so `this` (a `ServerWebSocket<WsData>` intersection) can never be
    // assigned to the callback's param without a cast for an arbitrary `T`.
    // The daemon never calls `cork`, so the fake only needs to satisfy the
    // interface structurally; `any` is the one param type that both accepts
    // `this` and is accepted by the generic interface signature.
    cork<T>(callback: (sock: any) => T): T {
      return callback(this);
    },
  };
  return ws;
}

// The most recent text message sent by a fake ws (all auth/command/state
// responses are JSON strings; log payloads are binary and out of scope here).
function lastJson(f: FakeWs): unknown {
  for (let i = f.sent.length - 1; i >= 0; i--) {
    const m = f.sent[i];
    if (typeof m === 'string') return JSON.parse(m);
  }
  return null;
}

function sendText(f: FakeWs, payload: string): void {
  wsMessage(f, payload);
}

// Stub docker command delivery for the whole suite so the CMD routing tests run
// without a live container. `wsMessage` invokes it with `.catch(...)`, so a
// resolved mock sends nothing back downstream.
const commandSpy = spyOn(dockerMod, 'sendCommandToContainer').mockImplementation(async () => {});
afterEach(() => commandSpy.mockClear());

describe('ws auth (Ledger F-005)', () => {
  test('auth with correct key succeeds without closing', () => {
    const f = makeFakeWs('containerevents');
    sendText(f, JSON.stringify({ event: 'auth', args: [KEY] }));
    expect(f.data.authed).toBe(true);
    expect(f.data.authFailures).toBe(0);
    expect(f.closedCode).toBeUndefined();
    // auth timeout cleared on success
    expect(f.data.authTimer).toBeUndefined();
  });

  test('auth with wrong key is rejected but the socket stays open for retry', () => {
    const f = makeFakeWs('containerevents');
    sendText(f, JSON.stringify({ event: 'auth', args: ['wrong-key'] }));
    expect(f.data.authed).toBe(false);
    expect(f.data.authFailures).toBe(1);
    expect(f.closedCode).toBeUndefined();
    expect((lastJson(f) as { error: string }).error).toBe('invalid key');
    expect(commandSpy).not.toHaveBeenCalled();
  });

  test('wrong keys never authenticate and the cap (5) closes the socket', () => {
    const f = makeFakeWs('containerevents');
    const wrong = JSON.stringify({ event: 'auth', args: ['nope'] });

    for (let i = 1; i <= 5; i++) {
      sendText(f, wrong);
      if (i < 5) {
        expect(f.data.authFailures).toBe(i);
        expect(f.closedCode).toBeUndefined();
      }
    }

    expect(f.closedCode).toBe(1008);
    expect(f.closedReason).toBe('auth failed');
    expect(f.data.authed).toBe(false);
    expect((lastJson(f) as { error: string }).error).toBe('auth failed');

    // A correct key after the cap must NOT authenticate (invariant).
    const retry = makeFakeWs('containerevents');
    retry.data.authFailures = 5;
    sendText(retry, JSON.stringify({ event: 'auth', args: [KEY] }));
    expect(retry.data.authed).toBe(false);
    expect(retry.closedCode).toBe(1008);
  });

  test('auth with a differently-sized wrong key still fails safely', () => {
    const f = makeFakeWs('containerevents');
    // A very short key exercises the hash-normalized compare path: the key is
    // hashed to a fixed-size sha256 digest so output length never leaks.
    sendText(f, JSON.stringify({ event: 'auth', args: ['x'] }));
    expect(f.data.authed).toBe(false);
    expect(f.data.authFailures).toBe(1);
  });

  test('malformed auth payload (no args) increments the failure counter', () => {
    const f = makeFakeWs('containerevents');
    sendText(f, JSON.stringify({ event: 'auth' }));
    expect(f.data.authed).toBe(false);
    expect(f.data.authFailures).toBe(1);
  });

  test('a second auth message after success is rejected and the socket closed', () => {
    const f = makeFakeWs('containerevents');
    sendText(f, JSON.stringify({ event: 'auth', args: [KEY] }));
    expect(f.data.authed).toBe(true);

    sendText(f, JSON.stringify({ event: 'auth', args: [KEY] }));
    expect(f.closedCode).toBe(1008);
    expect(f.closedReason).toBe('auth rejected');
    expect((lastJson(f) as { error: string }).error).toBe('already authenticated');
  });
});

describe('ws command routing (D-005)', () => {
  test('non-JSON frame closes with 1008', () => {
    const f = makeFakeWs('container');
    sendText(f, 'this is not json');
    expect(f.closedCode).toBe(1008);
    expect(f.closedReason).toBe('invalid json');
    expect((lastJson(f) as { error: string }).error).toBe('invalid json');
  });

  test('CMD before auth is rejected', () => {
    const f = makeFakeWs('container');
    sendText(f, JSON.stringify({ event: 'CMD', command: 'ls' }));
    expect(f.closedCode).toBe(1008);
    expect(f.closedReason).toBe('auth required');
    expect(f.data.authed).toBe(false);
    expect(commandSpy).not.toHaveBeenCalled();
  });

  test('CMD on the containerstatus route is rejected', () => {
    const f = makeFakeWs('containerstatus');
    f.data.authed = true;
    sendText(f, JSON.stringify({ event: 'CMD', command: 'ls' }));
    expect(f.closedCode).toBe(1008);
    expect(f.closedReason).toBe('invalid route');
    expect(commandSpy).not.toHaveBeenCalled();
  });

  test('missing command is rejected without closing', () => {
    const f = makeFakeWs('container');
    f.data.authed = true;
    sendText(f, JSON.stringify({ event: 'CMD' }));
    expect(f.closedCode).toBeUndefined();
    expect((lastJson(f) as { error: string }).error).toBe('missing command');
    expect(commandSpy).not.toHaveBeenCalled();
  });

  test('CMD on an authed container route is forwarded to the handler trimmed', async () => {
    const f = makeFakeWs('container');
    f.data.authed = true;
    sendText(f, JSON.stringify({ event: 'CMD', command: '  ls  -la  ' }));
    expect(commandSpy).toHaveBeenCalledWith('ctn', 'ls  -la');
  });
});

describe('ws connection lifecycle / cleanup', () => {
  test('wsOpen registers and wsClose removes from openConnections (no leak)', () => {
    const before = openConnections.size;
    const f = makeFakeWs('containerevents');

    wsOpen(f);
    expect(openConnections.has(f)).toBe(true);
    expect(openConnections.size).toBe(before + 1);

    wsClose(f, 1006, 'closed');
    expect(openConnections.has(f)).toBe(false);
    expect(openConnections.size).toBe(before);
  });

  test('wsClose invokes all per-socket cleanup (unsub + logCleanup)', () => {
    const f = makeFakeWs('containerevents');
    let logCleanupCalled = false;
    f.data._logCleanup = () => {
      logCleanupCalled = true;
    };

    wsOpen(f);
    // The events subscription is created by auth; wsClose must tear it down.
    sendText(f, JSON.stringify({ event: 'auth', args: [KEY] }));

    // emit is delivered while subscribed
    events.emit(f.data.containerId, { type: 'started', message: 'up' });
    expect(lastJson(f)).toEqual({ event: 'lifecycle', data: { type: 'started', message: 'up' } });

    wsClose(f, 1000, 'bye');
    expect(logCleanupCalled).toBe(true);

    // After close the subscription is gone: emit is no longer delivered.
    const sentAfter = f.sent.length;
    events.emit(f.data.containerId, { type: 'started', message: 'again' });
    expect(f.sent.length).toBe(sentAfter);
  });

  test('auth timer is cleared on close', () => {
    const f = makeFakeWs('containerevents');
    wsOpen(f);
    expect(f.data.authTimer).toBeDefined();
    wsClose(f, 1006, 'closed');
    expect(f.data.authTimer).toBeUndefined();
  });
});