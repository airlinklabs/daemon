import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const filesystemRoutes = readFileSync(new URL('../../src/routes/filesystem.ts', import.meta.url), 'utf8');
const configFiles = readFileSync(new URL('../../src/handlers/configFiles.ts', import.meta.url), 'utf8');

describe('download/config filesystem boundary contract', () => {
  test('download token consumption must not trust a mutable pathname directly', () => {
    expect(filesystemRoutes).not.toMatch(/Bun\.file\(entry\.filePath\)/);
  });

  test('config writes must not use resolve+startsWith as the final security check', () => {
    expect(configFiles).not.toMatch(/startsWith\([^\n]+volumeRoot/);
    expect(configFiles).not.toMatch(/Bun\.write\(target/);
  });
});
