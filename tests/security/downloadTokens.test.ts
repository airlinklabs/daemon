import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDownloadToken } from '../../src/routes/filesystem';
import { createDownloadToken, consumeDownloadToken, activeDownloadTokenCount } from '../../src/security/downloadTokens';

describe('download token store', () => {
  test('mints a long random token and records the entry', () => {
    const token = createDownloadToken({
      filePath: '/tmp/example.bin',
      fileName: 'example.bin',
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(/^[a-f0-9]{64,}$/.test(token)).toBe(true);
  });

  test('consume is single-use — the second read returns null', () => {
    const token = createDownloadToken({
      filePath: '/tmp/x.bin',
      fileName: 'x.bin',
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
    expect(consumeDownloadToken(token)).not.toBeNull();
    expect(consumeDownloadToken(token)).toBeNull();
  });

  test('unknown tokens are rejected', () => {
    expect(consumeDownloadToken('0000000000000000000000000000000000000000000000000000000000000000')).toBeNull();
  });

  test('empty store after a cleanup cycle', async () => {
    createDownloadToken({
      filePath: '/tmp/y.bin',
      fileName: 'y.bin',
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
    expect(activeDownloadTokenCount()).toBeGreaterThan(0);
  });
});

describe('handleDownloadToken (GET /dl/<token>)', () => {
  test('serves a minted file and consumes the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlinkd-dl-test-'));
    const file = join(dir, 'hello.txt');
    writeFileSync(file, 'hello from the daemon');

    const token = createDownloadToken({
      filePath: file,
      fileName: 'hello.txt',
      contentType: 'text/plain',
      disposition: 'attachment',
    });

    const res = await handleDownloadToken(new Request(`http://daemon/dl/${token}`), token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from the daemon');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(res.headers.get('Content-Disposition')).toContain('hello.txt');

    // consumed — a second request with the same token must 404
    const again = await handleDownloadToken(new Request(`http://daemon/dl/${token}`), token);
    expect(again.status).toBe(404);
  });

  test('rejects an unknown token with 404', async () => {
    const res = await handleDownloadToken(new Request('http://daemon/dl/deadbeef'), 'deadbeef');
    expect(res.status).toBe(404);
  });

  test('rejects a token pointing at a missing file', async () => {
    const token = createDownloadToken({
      filePath: join(tmpdir(), 'does-not-exist-anywhere.bin'),
      fileName: 'missing.bin',
      contentType: 'application/octet-stream',
      disposition: 'attachment',
    });
    const res = await handleDownloadToken(new Request(`http://daemon/dl/${token}`), token);
    expect(res.status).toBe(404);
  });
});
