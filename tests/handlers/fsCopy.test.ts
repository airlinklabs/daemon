import { describe, expect, test, afterEach } from 'bun:test';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { handleFsCopy } from '../../src/routes/filesystem';

const ID = 'copy_test_server';
const BASE = join(process.cwd(), 'volumes', ID);

function postJson(body: unknown): Request {
  return new Request('http://localhost/fs/copy', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('handleFsCopy', () => {
  test('copies a file to an explicit target path inside the volume', async () => {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(join(BASE, 'src.txt'), 'hello world');

    const res = await handleFsCopy(postJson({ id: ID, source: 'src.txt', newPath: 'dest.txt' }));

    expect(res.status).toBe(200);
    expect(readFileSync(join(BASE, 'dest.txt'), 'utf-8')).toBe('hello world');
    expect(existsSync(join(BASE, 'src.txt'))).toBe(true);
  });

  test('derives a "-copy" target when newPath is omitted', async () => {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(join(BASE, 'plugin.jar'), 'jar-data');

    const res = await handleFsCopy(postJson({ id: ID, source: 'plugin.jar' }));

    expect(res.status).toBe(200);
    expect(readFileSync(join(BASE, 'plugin-copy.jar'), 'utf-8')).toBe('jar-data');
  });

  test('copies a directory recursively', async () => {
    mkdirSync(join(BASE, 'world'), { recursive: true });
    writeFileSync(join(BASE, 'world', 'level.dat'), 'level');
    writeFileSync(join(BASE, 'world', 'region.dat'), 'region');

    const res = await handleFsCopy(postJson({ id: ID, source: 'world', newPath: 'world-copy' }));

    expect(res.status).toBe(200);
    expect(readFileSync(join(BASE, 'world-copy', 'level.dat'), 'utf-8')).toBe('level');
    expect(readFileSync(join(BASE, 'world-copy', 'region.dat'), 'utf-8')).toBe('region');
  });

  test('rejects a source escaping the volume', async () => {
    mkdirSync(BASE, { recursive: true });

    const res = await handleFsCopy(postJson({ id: ID, source: '../../etc/passwd' }));

    expect(res.status).toBe(400);
  });

  test('rejects a missing source', async () => {
    const res = await handleFsCopy(postJson({ id: ID }));

    expect(res.status).toBe(400);
  });
});
