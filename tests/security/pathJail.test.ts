import { describe, expect, test, beforeEach } from 'bun:test';
import {
  jailPath,
  BackupPathError,
  resolveBackupPath,
  resolveBackupsRoot,
} from '../../src/security/pathJail';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

describe('jailPath symlinked-parent escape (F-017 / traversal)', () => {
  beforeEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true });
    mkdirSync(TEST_BASE, { recursive: true });
  });

  test('blocks writing through a symlinked parent pointing outside', () => {
    mkdirSync('/tmp/pathjail-outside', { recursive: true });
    writeFileSync('/tmp/pathjail-outside/secret.txt', 'topsecret');
    symlinkSync('/tmp/pathjail-outside', join(TEST_BASE, 'link'));

    expect(() => jailPath(TEST_BASE, 'link/secret.txt')).toThrow('symlink');
  });

  test('blocks a file whose final component is a symlink to outside', () => {
    mkdirSync('/tmp/pathjail-outside', { recursive: true });
    writeFileSync('/tmp/pathjail-outside/secret.txt', 'topsecret');
    symlinkSync('/tmp/pathjail-outside/secret.txt', join(TEST_BASE, 'direct-link'));

    expect(() => jailPath(TEST_BASE, 'direct-link')).toThrow('symlink');
  });

  test('allows a symlink that resolves back inside the jail', () => {
    mkdirSync(join(TEST_BASE, 'real'), { recursive: true });
    writeFileSync(join(TEST_BASE, 'real', 'ok.txt'), 'data');
    symlinkSync('real/ok.txt', join(TEST_BASE, 'alias'));

    const result = jailPath(TEST_BASE, 'alias');
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

describe('resolveBackupPath robustness (F-017)', () => {
  test('collapses trailing slashes to a clean path', () => {
    const pretty = resolveBackupPath('server-123', 'backups/server-123/sub/');
    expect(pretty.endsWith('/sub')).toBe(true);
  });

  test('collapses internal ../ that stay inside the container boundary', () => {
    const result = resolveBackupPath('server-123', 'backups/server-123/sub/../snap.tar.gz');
    expect(result.endsWith('/backups/server-123/snap.tar.gz')).toBe(true);
  });

  test('rejects container-boundary escape via ..', () => {
    expect(() => resolveBackupPath('server-123', 'backups/server-123/../../sibling/a')).toThrow(BackupPathError);
  });

  test('rejects a sibling container path', () => {
    expect(() => resolveBackupPath('server-123', 'backups/server-456/snap.tar.gz')).toThrow(BackupPathError);
  });

  test('rejects a container id with path separators (boundary tampering)', () => {
    expect(() => resolveBackupPath('../escape', 'backups/x/y')).toThrow(BackupPathError);
  });

  test('accepts a path rooted at the container backups dir', () => {
    const result = resolveBackupPath('server-123', 'backups/server-123/a/b.tar.gz');
    expect(result.endsWith('/backups/server-123/a/b.tar.gz')).toBe(true);
  });

  test('rejects a bare relative path not rooted in the container dir', () => {
    expect(() => resolveBackupPath('server-123', 'a/b.tar.gz')).toThrow(BackupPathError);
  });

  test('rejects empty / null-byte paths', () => {
    expect(() => resolveBackupPath('server-123', '')).toThrow(BackupPathError);
    expect(() => resolveBackupPath('server-123', 'backups/\0')).toThrow(BackupPathError);
  });
});

describe('resolveBackupsRoot (F-017)', () => {
  test('jails a valid any-container backup path to the backups root', () => {
    const result = resolveBackupsRoot('backups/live-server/a.tar.gz');
    expect(result).toContain('/backups/live-server/a.tar.gz');
  });

  test('rejects a bare relative path not rooted in the backups dir', () => {
    expect(() => resolveBackupsRoot('any/folder/b.tgz')).toThrow(BackupPathError);
  });

  test('rejects traversal out of the root', () => {
    expect(() => resolveBackupsRoot('backups/x/../../etc/passwd')).toThrow(BackupPathError);
  });

  test('rejects absolute path outside the root', () => {
    expect(() => resolveBackupsRoot('/etc/passwd')).toThrow(BackupPathError);
  });

  test('rejects empty path', () => {
    expect(() => resolveBackupsRoot('')).toThrow(BackupPathError);
  });
});
