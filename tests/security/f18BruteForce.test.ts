import { describe, expect, it } from 'bun:test';
import { handleHttpRequest } from '../../src/router';
import { checkRateLimit } from '../../src/security/rateLimit';

// F-018: the per-IP/minute limiter runs BEFORE the Basic/HMAC auth checks so a
// brute-force loop of wrong-credential attempts consumes the budget. The
// router calls checkRateLimit(effectiveIp) with the default limit of 300.
function fakeServer(ip: string) {
  return { requestIP: () => ({ address: ip }) } as unknown as ReturnType<typeof Bun.serve>;
}

async function unauthStatus(ip: string): Promise<number> {
  const res = await handleHttpRequest(
    new Request('http://localhost/container/status', { method: 'GET' }),
    fakeServer(ip),
  );
  return res.status;
}

describe('F-018 brute-force rate limit ordering', () => {
  it('an unauthenticated attempt consumes the rate-limit budget and can trip 429', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250 + 1)}-f18`;

    // Fill the per-IP window up to the limit (300) but not past it.
    for (let i = 0; i < 300; i++) checkRateLimit(ip);

    // The router must estimate the budget BEFORE auth, so this single GET with
    // no Authorization header both fails auth AND consumes the last budget unit.
    const status = await unauthStatus(ip);

    // If the limiter ran after auth, this request would have been rejected with
    // 401 (auth) before the limiter ever ran, and would return 401. With the
    // fix it is throttled first.
    expect(status).toBe(429);
  });

  it('a fresh IP with a failed auth still gets the auth error (no throttle)', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250 + 1)}-f18-clean`;
    expect(await unauthStatus(ip)).toBe(401);
  });
});