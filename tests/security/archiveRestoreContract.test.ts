import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const backups = readFileSync(new URL('../../src/routes/backups.ts', import.meta.url), 'utf8');
const archive = readFileSync(new URL('../../src/handlers/fsArchive.ts', import.meta.url), 'utf8');

describe('archive restore security contract', () => {
  test('backup restore must reuse the explicit archive validation path', () => {
    expect(backups).toContain('assertSafeArchiveEntry');
  });

  test('generic archive handling must retain post-extraction containment checks', () => {
    expect(archive).toContain('realpathSync');
  });
});
