import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EMBEDDED_STORAGE } from '../src/embedded';

describe('embedded storage assets', () => {
  test('bundles the git-tracked storage defaults', () => {
    const paths = EMBEDDED_STORAGE.map((a) => a.path);
    expect(paths).toContain('storage/config.json');
    expect(paths).toContain('storage/fileSpecifier.json');
  });

  test('never bundles runtime-only storage state', () => {
    const paths = EMBEDDED_STORAGE.map((a) => a.path);
    expect(paths).not.toContain('storage/sftp_host_ed25519');
    expect(paths.some((p) => p.startsWith('storage/containerConfigs'))).toBe(false);
    expect(paths.some((p) => p.startsWith('storage/alc/'))).toBe(false);
  });

  test('contents are byte-identical to the files on disk', () => {
    for (const asset of EMBEDDED_STORAGE) {
      const onDisk = readFileSync(asset.path, 'utf8');
      expect(asset.contents).toBe(onDisk);
    }
  });

  test('no duplicate or empty asset paths', () => {
    const paths = EMBEDDED_STORAGE.map((a) => a.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const asset of EMBEDDED_STORAGE) {
      expect(asset.contents.length).toBeGreaterThan(0);
    }
  });
});
