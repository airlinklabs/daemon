import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/handlers/docker.ts', import.meta.url), 'utf8');

describe('Docker volume initialization boundary', () => {
  test('initialization writes must use the hardened filesystem layer', () => {
    expect(source).toContain('secureWriteFile');
    expect(source).not.toMatch(/writeFileSync\(eulaPath/);
    expect(source).not.toMatch(/writeFileSync\(join\(airlinkdDir/);
  });
});
