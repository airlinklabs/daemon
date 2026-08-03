import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendChunk } from '../../src/handlers/fs';

const TEST_ID = 'chunk-test-container';
const VOLUME = resolve(process.cwd(), 'volumes', TEST_ID);

beforeAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
  mkdirSync(VOLUME, { recursive: true });
});

afterAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
});

function fileAt(rel: string): string {
  return resolve(VOLUME, rel);
}

describe('appendChunk', () => {
  test('writes a single chunk directly (no session)', async () => {
    await appendChunk(TEST_ID, 'single.txt', Buffer.from('hello'));
    expect(readFileSync(fileAt('single.txt'), 'utf8')).toBe('hello');
  });

  test('assembles out-of-order chunks into the correct file (B-3)', async () => {
    const chunks = ['one-', 'two-', 'three', '-four'];
    // fire all at once — arrival order intentionally shuffled
    await Promise.all([
      appendChunk(TEST_ID, 'ordered.txt', Buffer.from(chunks[2]), { chunkIndex: 2, totalChunks: 4 }),
      appendChunk(TEST_ID, 'ordered.txt', Buffer.from(chunks[0]), { chunkIndex: 0, totalChunks: 4 }),
      appendChunk(TEST_ID, 'ordered.txt', Buffer.from(chunks[3]), { chunkIndex: 3, totalChunks: 4 }),
      appendChunk(TEST_ID, 'ordered.txt', Buffer.from(chunks[1]), { chunkIndex: 1, totalChunks: 4 }),
    ]);
    expect(readFileSync(fileAt('ordered.txt'), 'utf8')).toBe('one-two-three-four');
    // no stray part files left behind
    const leftovers = (await import('node:fs')).readdirSync(VOLUME).filter((f) => f.includes('.part-'));
    expect(leftovers).toHaveLength(0);
  });

  test('concurrent multi-chunk uploads of different files do not interleave', async () => {
    const a = ['aaa', 'bbb', 'ccc'];
    const b = ['111', '222', '333'];
    await Promise.all([
      ...a.map((c, i) => appendChunk(TEST_ID, 'a.txt', Buffer.from(c), { chunkIndex: i, totalChunks: 3 })),
      ...b.map((c, i) => appendChunk(TEST_ID, 'b.txt', Buffer.from(c), { chunkIndex: i, totalChunks: 3 })),
    ]);
    expect(readFileSync(fileAt('a.txt'), 'utf8')).toBe('aaabbbccc');
    expect(readFileSync(fileAt('b.txt'), 'utf8')).toBe('111222333');
  });

  test('rejects a chunk index outside the declared total', async () => {
    await expect(
      appendChunk(TEST_ID, 'bad.txt', Buffer.from('x'), { chunkIndex: 9, totalChunks: 2 }),
    ).rejects.toThrow();
  });
});
