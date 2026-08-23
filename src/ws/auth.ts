import { timingSafeEqual } from 'node:crypto';

export interface CapabilityClaims {
  v: number;
  nodeId: number;
  serverId: string;
  routes: string[];
  iat: number;
  exp: number;
  jti: string;
}

export function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function verifyCapabilityToken(
  token: string,
  expectedKey: string,
  containerId: string,
  route: string,
): { ok: true; claims: CapabilityClaims } | { ok: false; error: string } {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed token' };

  const payload = parts[0];
  const sig = parts[1];
  if (!payload || !sig) return { ok: false, error: 'malformed token' };

  const hasher = new Bun.CryptoHasher('sha256', expectedKey);
  hasher.update(payload);
  const expected = hasher.digest('base64url');
  const a = Buffer.from(sig, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid signature' };
  }

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

export function timingSafeKeyEquals(a: string, b: string): boolean {
  const digestA = new Bun.CryptoHasher('sha256').update(a, 'utf8').digest();
  const digestB = new Bun.CryptoHasher('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export type IncomingCommand = {
  event?: string;
  args?: string[];
  command?: string;
};

export function extractCommand(msg: IncomingCommand): string | null {
  if (typeof msg.command === 'string') {
    const trimmed = msg.command.replace(/\r\n?/g, '\n').trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function extractAuthKey(msg: IncomingCommand): string | null {
  if (Array.isArray(msg.args) && msg.args.length > 0) {
    const candidate = msg.args[0];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

export function isCommandEvent(event: string): boolean {
  return event.toLowerCase() === 'cmd';
}
