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

function digestHex(data: string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

// HMAC v1: non-GET bodies are signed as `digest:<sha256 hex>` and must carry
// an x-airlink-digest header so the daemon can bind the signature to the
// exact bytes it received.
function sign(key: string, method: string, path: string, bodyRepr: string, ts: number, nonce: string): string {
  const payload = `${ts}:${nonce}:${method.toUpperCase()}:${path}:${bodyRepr}`;
  return new Bun.CryptoHasher('sha256', key).update(payload).digest('hex');
}

function signedRequest(
  method: string,
  path: string,
  body = '',
  key = TEST_KEY,
  ts = Math.floor(Date.now() / 1000),
  nonce = `nonce-${Math.random().toString(36).slice(2)}`,
  { omitVersion = false, digestHeader }: { omitVersion?: boolean; digestHeader?: string } = {},
): Request {
  const bodyRepr = body.length > 0 ? `digest:${digestHex(body)}` : '';
  const sig = sign(key, method, path, bodyRepr, ts, nonce);

  const req = createRequest(method, path, body);
  req.headers.set('x-airlink-timestamp', String(ts));
  req.headers.set('x-airlink-signature', sig);
  req.headers.set('x-airlink-nonce', nonce);
  if (!omitVersion) req.headers.set('x-airlink-payload-version', '1');
  if (bodyRepr) req.headers.set('x-airlink-digest', digestHeader ?? `sha256:${digestHex(body)}`);
  return req;
}

describe('HMAC verification (protocol v1 — digest-signed bodies)', () => {
  test('rejects request missing HMAC headers', async () => {
    const req = createRequest('GET', '/healthz');
    const result = await verifyHmac(req, TEST_KEY, 'GET /healthz');
    // REQUIRE_HMAC defaults to true, so missing headers = rejection
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('accepts valid GET signature', async () => {
    const req = signedRequest('GET', '/stats');
    const result = await verifyHmac(req, TEST_KEY, 'GET /stats');
    expect(result).toBeNull();
  });

  test('accepts valid signed body with matching digest', async () => {
    const body = '{"id":"test"}';
    const req = signedRequest('POST', '/container/start', body);
    const result = await verifyHmac(req, TEST_KEY, 'POST /container/start');
    expect(result).toBeNull();
  });

  test('rejects missing payload version header', async () => {
    const body = '{"id":"test"}';
    const req = signedRequest('POST', '/container/start', body, TEST_KEY, undefined, undefined, {
      omitVersion: true,
    });
    const result = await verifyHmac(req, TEST_KEY, 'POST /container/start');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects unsupported payload version', async () => {
    const body = '{"id":"test"}';
    const req = signedRequest('POST', '/container/start', body, TEST_KEY, undefined, undefined, {
      digestHeader: 'sha256:invalid',
    });
    req.headers.set('x-airlink-payload-version', '2');
    const result = await verifyHmac(req, TEST_KEY, 'POST /container/start');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects missing digest header on non-empty body', async () => {
    const body = '{"id":"test"}';
    const bodyRepr = `digest:${digestHex(body)}`;
    const sig = sign(TEST_KEY, 'POST', '/container/start', bodyRepr, Math.floor(Date.now() / 1000), 'no-digest-hdr');

    const req = createRequest('POST', '/container/start', body);
    req.headers.set('x-airlink-timestamp', String(Math.floor(Date.now() / 1000)));
    req.headers.set('x-airlink-signature', sig);
    req.headers.set('x-airlink-nonce', 'no-digest-hdr');
    req.headers.set('x-airlink-payload-version', '1');
    // deliberately no x-airlink-digest header

    const result = await verifyHmac(req, TEST_KEY, 'POST /container/start');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects digest mismatch (tampered body keeps valid signature)', async () => {
    const body = '{"id":"abc"}';
    const req = signedRequest('POST', '/container/start', body);
    // replace the body after signing — digest no longer matches what is received
    const hacked = '{"id":"hacked"}';
    const replaced = createRequest('POST', '/container/start', hacked);
    replaced.headers.set('x-airlink-timestamp', req.headers.get('x-airlink-timestamp')!);
    replaced.headers.set('x-airlink-signature', req.headers.get('x-airlink-signature')!);
    replaced.headers.set('x-airlink-nonce', req.headers.get('x-airlink-nonce')!);
    replaced.headers.set('x-airlink-payload-version', '1');
    replaced.headers.set('x-airlink-digest', req.headers.get('x-airlink-digest')!);

    const result = await verifyHmac(replaced, TEST_KEY, 'POST /container/start');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects expired timestamp', async () => {
    const ts = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const req = signedRequest('GET', '/stats', '', TEST_KEY, ts, 'expired-nonce');
    const result = await verifyHmac(req, TEST_KEY, 'GET /stats');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects wrong key', async () => {
    const req = signedRequest('GET', '/stats', '', 'wrong-key', undefined, 'wrong-key-nonce');
    const result = await verifyHmac(req, TEST_KEY, 'GET /stats');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects replayed nonce', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'replay-me-once';

    const req1 = signedRequest('POST', '/container/start', '', TEST_KEY, ts, nonce);
    const result1 = await verifyHmac(req1, TEST_KEY, 'POST /container/start');
    expect(result1).toBeNull();

    const req2 = signedRequest('POST', '/container/start', '', TEST_KEY, ts, nonce);
    const result2 = await verifyHmac(req2, TEST_KEY, 'POST /container/start');
    expect(result2).not.toBeNull();
    expect(result2!.status).toBe(401);
  });

  test('rejects missing nonce', async () => {
    const req = signedRequest('POST', '/container/start', '', TEST_KEY, undefined, '');
    req.headers.delete('x-airlink-nonce');
    const result = await verifyHmac(req, TEST_KEY, 'POST /container/start');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test('rejects bad timestamp format', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const req = signedRequest('GET', '/stats', '', TEST_KEY, ts, 'nonce');
    req.headers.set('x-airlink-timestamp', 'not-a-number');
    const result = await verifyHmac(req, TEST_KEY, 'GET /stats');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});
