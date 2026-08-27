import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const router = readFileSync(new URL('../../src/router.ts', import.meta.url), 'utf8');
const fsHandler = readFileSync(new URL('../../src/handlers/fs.ts', import.meta.url), 'utf8');

describe('SSRF connection contract', () => {
  test('must not validate one DNS result and then blindly fetch the hostname', () => {
    expect(router).not.toContain('This defeats DNS rebinding');
    expect(fsHandler).not.toMatch(/fetch\([^\n]*url[^\n]*\)/);
  });
});
