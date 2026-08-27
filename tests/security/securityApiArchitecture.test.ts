import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const pathJail = readFileSync(new URL('../../src/security/pathJail.ts', import.meta.url), 'utf8');
const secureOpen = readFileSync(new URL('../../src/security/secureOpen.ts', import.meta.url), 'utf8');

describe('filesystem security API architecture', () => {
  test('the low-level open implementation must be the single source of openat2 policy', () => {
    expect(pathJail).not.toContain('openat2Syscall');
    expect(secureOpen).toContain('RESOLVE_BENEATH');
  });

  test('security helpers should expose documented operation-level primitives', () => {
    expect(pathJail).toContain('secureReadFile');
    expect(pathJail).toContain('secureWriteFile');
    expect(pathJail).toContain('secureUnlink');
  });
});
