import { timingSafeEqual } from 'node:crypto';
import config from '../config';
import logger from '../logger';

const WINDOW_SECS = 30;

function sign(key: string, method: string, path: string, body: string, ts: number): string {
  const payload = `${ts}:${method.toUpperCase()}:${path}:${body}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

// returns null if valid, returns a Response error if not
export async function verifyHmac(req: Request, key: string): Promise<Response | null> {
  const tsHeader  = req.headers.get('x-airlink-timestamp');
  const sigHeader = req.headers.get('x-airlink-signature');

  if (!tsHeader || !sigHeader) {
    return new Response(JSON.stringify({ error: 'missing HMAC headers' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ts = parseInt(tsHeader, 10);
  if (isNaN(ts)) return new Response(JSON.stringify({ error: 'bad timestamp' }), {
    status:  401,
    headers: { 'Content-Type': 'application/json' },
  });

  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > WINDOW_SECS) {
    return new Response(JSON.stringify({ error: 'timestamp out of window' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url  = new URL(req.url);
  const body = req.method === 'GET' || req.method === 'DELETE'
    ? ''
    : await req.clone().text();

  const expected = sign(key, req.method, url.pathname, body, ts);
  const expBuf   = Buffer.from(expected, 'hex');
  const gotBuf   = Buffer.from(sigHeader, 'hex');

  if (expBuf.length !== gotBuf.length || !timingSafeEqual(expBuf, gotBuf)) {
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

// parse the Authorization: Basic ... header ourselves — express-basic-auth is gone
export function checkBasicAuth(req: Request, expectedKey: string): Response | null {
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Basic ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="airlinkd"' },
    });
  }

  const decoded = atob(header.slice(6));
  const colon   = decoded.indexOf(':');
  const user    = decoded.slice(0, colon);
  const pass    = decoded.slice(colon + 1);

  // constant-time compare — don't use ===
  const passBuf = Buffer.from(pass);
  const expBuf  = Buffer.from(expectedKey);
  if (user !== 'Airlink' || passBuf.length !== expBuf.length || !timingSafeEqual(passBuf, expBuf)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status:  401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="airlinkd"' },
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
      status:  403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

// call this on every response before returning from the router
export function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options',          'nosniff');
  h.set('X-Frame-Options',                 'DENY');
  h.set('X-XSS-Protection',               '0'); // deprecated but harmless
  h.set('Referrer-Policy',                 'no-referrer');
  h.set('Permissions-Policy',              'interest-cohort=()');
  h.set('Cross-Origin-Resource-Policy',    'same-origin');
  h.set('Cache-Control',                   'no-store');
  // not setting CSP — this is a JSON API, not HTML
  return new Response(res.body, { status: res.status, headers: h });
}
