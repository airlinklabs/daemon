import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/handlers/sftpSubsystem.ts', import.meta.url), 'utf8');

describe('SFTP filesystem boundary contract', () => {
  test('does not reintroduce pathname-based destructive operations', () => {
    expect(source).not.toMatch(/unlinkSync\(/);
    expect(source).not.toMatch(/rmdirSync\(/);
    expect(source).not.toMatch(/renameSync\(/);
  });

  test('does not derive security-sensitive child paths solely with join()', () => {
    expect(source).not.toMatch(/statSync\(join\(/);
  });
});
