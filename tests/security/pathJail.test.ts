import { describe, expect, test, beforeEach } from 'bun:test';
import { jailPath, BackupPathError, resolveBackupPath } from '../../src/security/pathJail';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_BASE = '/tmp/pathjail-test';

beforeEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
  mkdirSync(TEST_BASE, { recursive: true });
});

describe('jailPath', () => {
  test('allows valid relative path', () => {
    const result = jailPath(TEST_BASE, 'files/test.txt');
    expect(result).toContain(TEST_BASE);
    expect(result).toContain('files/test.txt');
  });

  test('allows root path', () => {
    const result = jailPath(TEST_BASE, '/');
    expect(result).toBe(TEST_BASE);
  });

  test('blocks simple traversal', () => {
    expect(() => jailPath(TEST_BASE, '../../../etc/passwd')).toThrow('path traversal');
  });

  test('blocks traversal with encoded dots', () => {
    expect(() => jailPath(TEST_BASE, 'foo/../../etc/passwd')).toThrow('path traversal');
  });

  test('blocks traversal via parent directory reference', () => {
    expect(() => jailPath(TEST_BASE, '../outside')).toThrow('path traversal');
  });

  test('allows creating new files in subdirectories', () => {
    const result = jailPath(TEST_BASE, 'new/dir/file.txt');
    expect(result).toContain(TEST_BASE);
  });
});

describe('resolveBackupPath', () => {
  test('resolves valid backup path', () => {
    const result = resolveBackupPath('server-123', 'backups/server-123/backup.tar.gz');
    expect(result).toContain('backups/server-123/backup.tar.gz');
  });

  test('rejects path escaping backup directory', () => {
    expect(() => resolveBackupPath('server-123', 'backups/other-server/backup.tar.gz')).toThrow(BackupPathError);
  });

  test('rejects absolute path outside backups', () => {
    expect(() => resolveBackupPath('server-123', '/etc/passwd')).toThrow(BackupPathError);
  });
});
