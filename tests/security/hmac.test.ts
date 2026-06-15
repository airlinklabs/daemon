import { describe, expect, test } from 'bun:test';
import { verifyHmac } from '../../src/security/hmac';

const TEST_KEY = 'test-secret-key-for-hmac-testing-1234';

function createRequest(method: string, path: string, body = ''): Request {
  return new Request(`http://localhost${path}`, {
    method,
    body: body || undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sign(key: string, method: string, path: string, body: string, ts: number, nonce: string): string {
  const payload = `${ts}:${nonce}:${method.toUpperCase()}:${path}:${body}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

describe('HMAC verification', () => {
  test('rejects request missing HMAC headers', async () => {
    const req = createRequest('GET', '/healthz');
    const result = await verifyHmac(req, TEST_KEY);
    // REQUIRE_HMAC defaults to true, so missing headers = rejection
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('accepts valid signature with correct nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'test-nonce-12345';
    const body = '{"id":"test"}';
    const sig = sign(TEST_KEY, 'POST', '/container/start', body, ts, nonce);

    const req = createRequest('POST', '/container/start', body);
    req.headers.set('x-airlink-timestamp', String(ts));
    req.headers.set('x-airlink-signature', sig);
    req.headers.set('x-airlink-nonce', nonce);

    const result = await verifyHmac(req, TEST_KEY);
    expect(result).toBeNull();
  });

  test('rejects expired timestamp', async () => {
    const ts = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const nonce = 'expired-nonce';
    const sig = sign(TEST_KEY, 'GET', '/stats', '', ts, nonce);

    const req = createRequest('GET', '/stats');
    req.headers.set('x-airlink-timestamp', String(ts));
    req.headers.set('x-airlink-signature', sig);
    req.headers.set('x-airlink-nonce', nonce);

    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects wrong key', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'wrong-key-nonce';
    const sig = sign('wrong-key', 'GET', '/stats', '', ts, nonce);

    const req = createRequest('GET', '/stats');
    req.headers.set('x-airlink-timestamp', String(ts));
    req.headers.set('x-airlink-signature', sig);
    req.headers.set('x-airlink-nonce', nonce);

    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects replayed nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'replay-me-once';
    const sig = sign(TEST_KEY, 'POST', '/container/start', '', ts, nonce);

    const req1 = createRequest('POST', '/container/start');
    req1.headers.set('x-airlink-timestamp', String(ts));
    req1.headers.set('x-airlink-signature', sig);
    req1.headers.set('x-airlink-nonce', nonce);

    // First request should succeed
    const result1 = await verifyHmac(req1, TEST_KEY);
    expect(result1).toBeNull();

    // Second request with same nonce should fail
    const req2 = createRequest('POST', '/container/start');
    req2.headers.set('x-airlink-timestamp', String(ts));
    req2.headers.set('x-airlink-signature', sig);
    req2.headers.set('x-airlink-nonce', nonce);

    const result2 = await verifyHmac(req2, TEST_KEY);
    expect(result2).not.toBeNull();
    expect(result2!.status).toBe(401);
  });

  test('rejects missing nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(TEST_KEY, 'POST', '/container/start', '', ts, '');

    const req = createRequest('POST', '/container/start');
    req.headers.set('x-airlink-timestamp', String(ts));
    req.headers.set('x-airlink-signature', sig);
    // No nonce header

    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects bad timestamp format', async () => {
    const sig = sign(TEST_KEY, 'GET', '/stats', '', 12345, 'nonce');

    const req = createRequest('GET', '/stats');
    req.headers.set('x-airlink-timestamp', 'not-a-number');
    req.headers.set('x-airlink-signature', sig);
    req.headers.set('x-airlink-nonce', 'nonce');

    const result = await verifyHmac(req, TEST_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});
