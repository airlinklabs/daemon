import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/handlers/fsArchive.ts', import.meta.url), 'utf8');

describe('chunked upload finalization contract', () => {
  test('must use the centralized jailed rename primitive', () => {
    expect(source).toContain('jailRename');
    expect(source).not.toMatch(/await rename\(tmpPath, filePath\)/);
  });

  test('must not use pathname-only temporary file promotion', () => {
    expect(source).not.toMatch(/const tmpPath = `\$\{filePath\}\.part-/);
  });
});
