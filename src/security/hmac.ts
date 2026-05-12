import { timingSafeEqual } from 'node:crypto';
import config from '../config';
import logger from '../logger';

const WINDOW_SECS = 30;
const seenNonces = new Set<string>();

function sign(key: string, method: string, path: string, body: string, ts: number, nonce: string): string {
  const payload = nonce
    ? `${ts}:${nonce}:${method.toUpperCase()}:${path}:${body}`
    : `${ts}:${method.toUpperCase()}:${path}:${body}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

function rememberNonce(ts: number, nonceValue: string): Response | null {
  const now = Math.floor(Date.now() / 1000);
  for (const nonce of seenNonces) {
    const nonceTs = parseInt(nonce.split(':', 1)[0], 10);
    if (Number.isNaN(nonceTs) || Math.abs(now - nonceTs) > WINDOW_SECS) seenNonces.delete(nonce);
  }

  const cacheKey = `${ts}:${nonceValue}`;
  if (seenNonces.has(cacheKey)) {
    return new Response(JSON.stringify({ error: 'replayed request' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  seenNonces.add(cacheKey);
  return null;
}

// returns null if valid, returns a Response error if not
export async function verifyHmac(req: Request, key: string): Promise<Response | null> {
  const tsHeader = req.headers.get('x-airlink-timestamp');
  const sigHeader = req.headers.get('x-airlink-signature');
  const nonceHeader = req.headers.get('x-airlink-nonce') ?? '';

  if (!tsHeader || !sigHeader) {
    if (Bun.env.REQUIRE_HMAC === 'false') {
      logger.warn(`unsigned request allowed (REQUIRE_HMAC=false): ${req.method} ${new URL(req.url).pathname}`);
      return null;
    }
    return new Response(JSON.stringify({ error: 'missing HMAC headers' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ts = parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) {
    return new Response(JSON.stringify({ error: 'bad timestamp' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > WINDOW_SECS) {
    return new Response(JSON.stringify({ error: 'timestamp out of window' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const bodylessMethod = req.method === 'GET';
  const body = bodylessMethod ? '' : await req.clone().text();

  const expected = sign(key, req.method, url.pathname, body, ts, nonceHeader);
  let expBuf = Buffer.from(expected, 'hex');
  let gotBuf: Buffer;
  try {
    gotBuf = Buffer.from(sigHeader, 'hex');
  } catch {
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (expBuf.length !== gotBuf.length || !timingSafeEqual(expBuf, gotBuf)) {
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (nonceHeader) {
    const replayErr = rememberNonce(ts, nonceHeader);
    if (replayErr) return replayErr;
  } else if (req.method !== 'GET') {
    const replayErr = rememberNonce(ts, sigHeader);
    if (replayErr) return replayErr;
  }

  return null;
}

// parse the Authorization: Basic ... header ourselves — express-basic-auth is gone
export function checkBasicAuth(req: Request, expectedKey: string): Response | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="airlinkd"',
      },
    });
  }

  let decoded = '';
  try {
    decoded = atob(header.slice(6));
  } catch {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="airlinkd"',
      },
    });
  }

  const colon = decoded.indexOf(':');
  if (colon < 0) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="airlinkd"',
      },
    });
  }

  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  // constant-time compare — don't use ===
  const passBuf = Buffer.from(pass);
  const expBuf = Buffer.from(expectedKey);
  if (user !== 'Airlink' || passBuf.length !== expBuf.length || !timingSafeEqual(passBuf, expBuf)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Basic realm="airlinkd"',
      },
    });
  }

  return null;
}

// accepts the already-resolved effective IP — caller extracts it via server.requestIP()
export function getAllowedIpCheck(effectiveIp: string): Response | null {
  const allowed = config.allowedIps;
  if (allowed.length === 0) return null;

  if (!allowed.includes(effectiveIp)) {
    logger.warn(`blocked connection from ${effectiveIp} — not in ALLOWED_IPS`);
    return new Response(JSON.stringify({ error: 'access denied' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

// call this on every response before returning from the router
export function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('X-XSS-Protection', '0'); // deprecated but harmless
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'interest-cohort=()');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('Cache-Control', 'no-store');
  // not setting CSP — this is a JSON API, not HTML
  return new Response(res.body, { status: res.status, headers: h });
}
