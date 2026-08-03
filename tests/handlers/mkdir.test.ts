import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleFsMkdir } from '../../src/routes/filesystem';

const TEST_ID = 'mkdir-test-container';
const VOLUME = resolve(process.cwd(), 'volumes', TEST_ID);

beforeAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
  mkdirSync(VOLUME, { recursive: true });
});

afterAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
});

function post(body: unknown): Request {
  return new Request('http://daemon/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleFsMkdir', () => {
  test('creates a folder inside the container volume (B-5)', async () => {
    const res = await handleFsMkdir(post({ id: TEST_ID, path: '/', folderName: 'worlds' }));
    expect(res.status).toBe(200);
    expect(existsSync(resolve(VOLUME, 'worlds'))).toBe(true);
  });

  test('creates nested folders', async () => {
    const res = await handleFsMkdir(post({ id: TEST_ID, path: 'worlds', folderName: 'nether' }));
    expect(res.status).toBe(200);
    expect(existsSync(resolve(VOLUME, 'worlds', 'nether'))).toBe(true);
  });

  test('rejects traversal attempts (jail check)', async () => {
    const res = await handleFsMkdir(post({ id: TEST_ID, path: '/', folderName: '..' }));
    expect(res.status).toBe(400);
    expect(existsSync(resolve(VOLUME, '..', '..', 'escaped'))).toBe(false);
  });

  test('requires a container id and folder name', async () => {
    expect((await handleFsMkdir(post({ path: '/', folderName: 'x' }))).status).toBe(400);
    expect((await handleFsMkdir(post({ id: TEST_ID }))).status).toBe(400);
  });
});
