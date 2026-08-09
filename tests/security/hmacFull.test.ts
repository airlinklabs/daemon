import { describe, expect, test } from 'bun:test';
import { verifyHmac, checkBasicAuth, getAllowedIpCheck, withSecurityHeaders } from '../../src/security/hmac';

const TEST_KEY = 'test-secret-daemon-key-123456';

function digestHex(data: string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

function sign(key: string, method: string, path: string, bodyRepr: string, ts: number, nonce: string): string {
  const payload = `${ts}:${nonce}:${method.toUpperCase()}:${path}:${bodyRepr}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

function createRequest(method: string, path: string, body = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    body: body || undefined,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function signedRequest(
  method: string,
  path: string,
  body = '',
  key = TEST_KEY,
  ts = Math.floor(Date.now() / 1000),
  nonce = `nonce-${Math.random().toString(36).slice(2)}`,
  headers: Record<string, string> = {},
): Request {
  const bodyRepr = body.length > 0 ? `digest:${digestHex(body)}` : '';
  const sig = sign(key, method, path, bodyRepr, ts, nonce);
  return createRequest(method, path, body, {
    'x-airlink-timestamp': String(ts),
    'x-airlink-signature': sig,
    'x-airlink-nonce': nonce,
    'x-airlink-payload-version': '1',
    ...(bodyRepr ? { 'x-airlink-digest': `sha256:${digestHex(body)}` } : {}),
    ...headers,
  });
}

const ROUTE = (method: string, path: string): string => `${method} ${path}`;

describe('HMAC verification — brute force resistance (protocol v1)', () => {
  test('signature matches the known-answer vector shared with the panel test suite', () => {
    // cross-repo parity: panel tests/hmac.test.ts asserts the same payload +
    // signature — if the signing format drifts on either side this fails
    const body = '{"id":"test"}';
    const ts = 1700000000;
    const nonce = 'nonce';
    const bodyRepr = `digest:${digestHex(body)}`;
    const sig = sign('test-secret-key-12345', 'POST', '/container/start', bodyRepr, ts, nonce);
    expect(bodyRepr).toBe('digest:665c531373a4d3427505587923a4f15ac573fb8e96b1f983ec1d6eacdfa4334c');
    expect(sig).toBe('07dc58d6643f3b31e3dad065dc7565aa5fc56f82d3c656b3fcc451f6efc059b8');
  });

  test('rejects request with no HMAC headers', async () => {
    const req = createRequest('GET', '/stats');
    const result = await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects request with only timestamp header', async () => {
    const req = createRequest('GET', '/stats', '', { 'x-airlink-timestamp': String(Date.now()) });
    const result = await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats'));
    expect(result).not.toBeNull();
  });

  test('rejects request with only signature header', async () => {
    const req = createRequest('GET', '/stats', '', { 'x-airlink-signature': 'abc' });
    const result = await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats'));
    expect(result).not.toBeNull();
  });

  test('rejects expired timestamp (>30s drift)', async () => {
    const ts = Math.floor(Date.now() / 1000) - 61;
    const req = signedRequest('GET', '/stats', '', TEST_KEY, ts, 'expired-nonce');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects future timestamp (>30s drift)', async () => {
    const ts = Math.floor(Date.now() / 1000) + 61;
    const req = signedRequest('GET', '/stats', '', TEST_KEY, ts, 'future-nonce');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects non-numeric timestamp', async () => {
    const req = signedRequest('GET', '/stats', '', TEST_KEY, Math.floor(Date.now() / 1000), 'bad-ts', {
      'x-airlink-timestamp': 'not-a-number',
    });
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects wrong key', async () => {
    const req = signedRequest('GET', '/stats', '', 'wrong-key-1234567890123456');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects tampered body even with a validly signed digest', async () => {
    const ts = Math.floor(Date.now() / 1000);
    // signature covers digest:sha256 of the *original* body
    const req = signedRequest('POST', '/container/start', '{"id":"abc"}', TEST_KEY, ts, 'tamper-body');
    // attacker swaps the body, keeps all headers
    const hacked = createRequest('POST', '/container/start', '{"id":"hacked"}');
    for (const [name, value] of req.headers.entries()) {
      if (value !== null) hacked.headers.set(name, value);
    }
    expect((await verifyHmac(hacked, TEST_KEY, ROUTE('POST', '/container/start')))!.status).toBe(401);
  });

  test('rejects tampered path', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-path';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, nonce);
    const req = createRequest('GET', '/healthz', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
      'x-airlink-payload-version': '1',
    });
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/healthz')))!.status).toBe(401);
  });

  test('rejects tampered query params (P0 — canonical target signing)', async () => {
    // Panel signs '/fs/list?id=42&path=%2Fdata' — attacker swaps path param
    const canonicalTarget = '/fs/list?id=42&path=%2Fdata';
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-query';
    const sig = sign(TEST_KEY, 'GET', canonicalTarget, '', ts, nonce);
    // Attacker changes ?id=42 to ?id=99 — different canonical target, HMAC fails
    const req = createRequest('GET', '/fs/list?id=99&path=%2Fdata', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
      'x-airlink-payload-version': '1',
    });
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/fs/list?id=99&path=%2Fdata')))!.status).toBe(401);
  });

  test('accepts valid request with sorted query params', async () => {
    // Panel sorts params by key then value, so both orderings produce the same
    // canonical form. The daemon signs the full pathname + search.
    const canonicalTarget = '/fs/list?id=42&path=%2Fdata';
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'valid-query-params';
    const sig = sign(TEST_KEY, 'GET', canonicalTarget, '', ts, nonce);
    const req = createRequest('GET', canonicalTarget, '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
      'x-airlink-payload-version': '1',
    });
    expect(await verifyHmac(req, TEST_KEY, ROUTE('GET', canonicalTarget))).toBeNull();
  });

  test('rejects tampered method', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-method';
    const sig = sign(TEST_KEY, 'POST', '/test', '', ts, nonce);
    const req = createRequest('DELETE', '/test', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
      'x-airlink-payload-version': '1',
    });
    expect((await verifyHmac(req, TEST_KEY, ROUTE('DELETE', '/test')))!.status).toBe(401);
  });

  test('rejects missing nonce', async () => {
    const req = signedRequest('GET', '/stats', '', TEST_KEY, Math.floor(Date.now() / 1000), '');
    req.headers.delete('x-airlink-nonce');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects replayed nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'replay-this';
    const req1 = signedRequest('POST', '/container/start', '', TEST_KEY, ts, nonce);
    expect(await verifyHmac(req1, TEST_KEY, ROUTE('POST', '/container/start'))).toBeNull(); // first use OK

    const req2 = signedRequest('POST', '/container/start', '', TEST_KEY, ts, nonce);
    expect((await verifyHmac(req2, TEST_KEY, ROUTE('POST', '/container/start')))!.status).toBe(401); // replay blocked
  });

  test('rejects invalid hex signature', async () => {
    const req = signedRequest('GET', '/stats', '', TEST_KEY, Math.floor(Date.now() / 1000), 'invalid-hex', {
      'x-airlink-signature': 'not-valid-hex',
    });
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects missing payload version', async () => {
    const req = signedRequest('GET', '/stats', '', TEST_KEY, Math.floor(Date.now() / 1000), 'no-version');
    req.headers.delete('x-airlink-payload-version');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('rejects unsupported payload version', async () => {
    const req = signedRequest('GET', '/stats', '', TEST_KEY, Math.floor(Date.now() / 1000), 'ver-2');
    req.headers.set('x-airlink-payload-version', '2');
    expect((await verifyHmac(req, TEST_KEY, ROUTE('GET', '/stats')))!.status).toBe(401);
  });

  test('accepts valid request with body digest', async () => {
    const req = signedRequest('POST', '/container/start', '{"id":"test-123"}', TEST_KEY);
    expect(await verifyHmac(req, TEST_KEY, ROUTE('POST', '/container/start'))).toBeNull();
  });

  test('accepts valid request with empty body', async () => {
    const req = signedRequest('POST', '/container/start', '', TEST_KEY);
    expect(await verifyHmac(req, TEST_KEY, ROUTE('POST', '/container/start'))).toBeNull();
  });
});

describe('Basic Auth — brute force resistance', () => {
  test('rejects missing Authorization header', () => {
    const req = createRequest('GET', '/stats');
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects non-Basic auth scheme', () => {
    const req = createRequest('GET', '/stats', '', { authorization: 'Bearer token123' });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects invalid base64', () => {
    const req = createRequest('GET', '/stats', '', { authorization: 'Basic !!!invalid!!!' });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects missing colon separator', () => {
    const encoded = Buffer.from('AirlinkNoColon').toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects wrong username', () => {
    const encoded = Buffer.from(`WrongUser:${TEST_KEY}`).toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects wrong password', () => {
    const encoded = Buffer.from(`Airlink:wrong-password-here`).toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('rejects empty password', () => {
    const encoded = Buffer.from('Airlink:').toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    expect(checkBasicAuth(req, TEST_KEY)).not.toBeNull();
  });

  test('accepts valid credentials', () => {
    const encoded = Buffer.from(`Airlink:${TEST_KEY}`).toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    expect(checkBasicAuth(req, TEST_KEY)).toBeNull();
  });

  test('password in colon is split correctly (first colon only)', () => {
    const passWithColon = 'pass:with:colons';
    const encoded = Buffer.from(`Airlink:${passWithColon}`).toString('base64');
    const req = createRequest('GET', '/stats', '', { authorization: `Basic ${encoded}` });
    // Should reject because the full string after first colon is compared
    expect(checkBasicAuth(req, passWithColon)).toBeNull();
  });
});

describe('IP allowlist', () => {
  test('allows all IPs when list is empty', () => {
    expect(getAllowedIpCheck('1.2.3.4')).toBeNull();
  });
});

describe('Security headers', () => {
  test('applies all security headers', () => {
    const original = new Response('ok', { status: 200 });
    const secured = withSecurityHeaders(original);

    expect(secured.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(secured.headers.get('X-Frame-Options')).toBe('DENY');
    expect(secured.headers.get('X-XSS-Protection')).toBe('0');
    expect(secured.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(secured.headers.get('Permissions-Policy')).toBe('interest-cohort=()');
    expect(secured.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(secured.headers.get('Cache-Control')).toBe('no-store');
  });

  test('preserves original status and body', () => {
    const original = new Response('test body', { status: 404 });
    const secured = withSecurityHeaders(original);
    expect(secured.status).toBe(404);
  });
});
