import { describe, expect, test } from 'bun:test';
import { resolveBackupPath, BackupPathError } from '../../src/security/pathJail';
import { join, resolve } from 'node:path';

describe('resolveBackupPath', () => {
  const containerId = 'test-container-123';
  const allowedRoot = resolve(process.cwd(), 'backups', containerId);

  test('resolves valid backup path', () => {
    const result = resolveBackupPath(containerId, `backups/${containerId}/backup.tar.gz`);
    expect(result).toBe(join(allowedRoot, 'backup.tar.gz'));
  });

  test('rejects path traversal with ../', () => {
    expect(() => {
      resolveBackupPath(containerId, `backups/${containerId}/../../etc/passwd`);
    }).toThrow(BackupPathError);
  });

  test('rejects absolute path outside backup dir', () => {
    expect(() => {
      resolveBackupPath(containerId, '/etc/passwd');
    }).toThrow(BackupPathError);
  });

  test('accepts path at root of backup dir', () => {
    const result = resolveBackupPath(containerId, `backups/${containerId}`);
    expect(result).toBe(allowedRoot);
  });
});

describe('BackupPathError', () => {
  test('has correct name', () => {
    const err = new BackupPathError('test');
    expect(err.name).toBe('BackupPathError');
    expect(err.message).toBe('test');
  });

  test('is instance of Error', () => {
    const err = new BackupPathError('test');
    expect(err).toBeInstanceOf(Error);
  });
});
