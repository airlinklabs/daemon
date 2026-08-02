import { describe, expect, test, beforeEach } from 'bun:test';
import { verifyHmac, checkBasicAuth, getAllowedIpCheck, withSecurityHeaders } from '../../src/security/hmac';

const TEST_KEY = 'test-secret-daemon-key-123456';

function sign(key: string, method: string, path: string, body: string, ts: number, nonce: string): string {
  const payload = `${ts}:${nonce}:${method.toUpperCase()}:${path}:${body}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

function createRequest(method: string, path: string, body = '', headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method,
    body: body || undefined,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('HMAC verification — brute force resistance', () => {
  test('rejects request with no HMAC headers', async () => {
    const req = createRequest('GET', '/stats');
    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects request with only timestamp header', async () => {
    const req = createRequest('GET', '/stats', '', { 'x-airlink-timestamp': String(Date.now()) });
    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
  });

  test('rejects request with only signature header', async () => {
    const req = createRequest('GET', '/stats', '', { 'x-airlink-signature': 'abc' });
    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
  });

  test('rejects expired timestamp (>30s drift)', async () => {
    const ts = Math.floor(Date.now() / 1000) - 61;
    const nonce = 'expired-nonce';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, nonce);
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects future timestamp (>30s drift)', async () => {
    const ts = Math.floor(Date.now() / 1000) + 61;
    const nonce = 'future-nonce';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, nonce);
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects non-numeric timestamp', async () => {
    const nonce = 'bad-ts';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', 12345, nonce);
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': 'not-a-number',
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects wrong key', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'wrong-key';
    const sig = sign('wrong-key-1234567890123456', 'GET', '/stats', '', ts, nonce);
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects tampered body', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-body';
    const sig = sign(TEST_KEY, 'POST', '/container/start', '{"id":"abc"}', ts, nonce);
    const req = createRequest('POST', '/container/start', '{"id":"hacked"}', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects tampered path', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-path';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, nonce);
    const req = createRequest('GET', '/healthz', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects tampered method', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'tamper-method';
    const sig = sign(TEST_KEY, 'POST', '/test', '', ts, nonce);
    const req = createRequest('DELETE', '/test', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects missing nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, '');
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('rejects replayed nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'replay-this';
    const sig = sign(TEST_KEY, 'POST', '/container/start', '', ts, nonce);

    const req1 = createRequest('POST', '/container/start', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect(await verifyHmac(req1, TEST_KEY)).toBeNull(); // first use OK

    const req2 = createRequest('POST', '/container/start', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req2, TEST_KEY))!.status).toBe(401); // replay blocked
  });

  test('rejects invalid hex signature', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'invalid-hex';
    const req = createRequest('GET', '/stats', '', {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': 'not-valid-hex',
      'x-airlink-nonce': nonce,
    });
    expect((await verifyHmac(req, TEST_KEY))!.status).toBe(401);
  });

  test('accepts valid request', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'valid-request';
    const body = '{"id":"test-123"}';
    const sig = sign(TEST_KEY, 'POST', '/container/start', body, ts, nonce);
    const req = createRequest('POST', '/container/start', body, {
      'x-airlink-timestamp': String(ts),
      'x-airlink-signature': sig,
      'x-airlink-nonce': nonce,
    });
    expect(await verifyHmac(req, TEST_KEY)).toBeNull();
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
