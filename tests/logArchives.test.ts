import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { archiveLogHistory, listLogArchives, readLogArchive, resolveLogArchivePath } from '../src/handlers/logHistory';

const ORIGINAL_CWD = process.cwd();
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'airlinkd-log-archive-test-'));
  process.chdir(scratch);
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(scratch, { recursive: true, force: true });
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
});

const ARCHIVE_NAME = /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log\.tar\.gz$/;

function writeLogs(id: string, live: string, rotated?: string): void {
  const logsDir = join('.airlinkd', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, `${id}.log`), live, 'utf8');
  if (rotated !== undefined) writeFileSync(join(logsDir, `${id}.log.1`), rotated, 'utf8');
}

describe('archiveLogHistory', () => {
  test('archives live + rotated logs into a timestamped tar.gz under .airlinkd/logs/archive/<id>', async () => {
    const id = 'archiver-test-1';
    writeLogs(id, 'live line 1\nlive line 2\n', 'old line 1\nold line 2\n');

    const archivePath = await archiveLogHistory(id);
    expect(archivePath).not.toBeNull();

    const archiveDir = join('.airlinkd', 'logs', 'archive', id);
    expect(archivePath).toContain(archiveDir);
    expect(basename(archivePath!)).toMatch(ARCHIVE_NAME);
    expect(existsSync(archivePath!)).toBe(true);
  });

  test('returns null when the container has no log files', async () => {
    const id = 'archiver-test-empty';
    mkdirSync(join('.airlinkd', 'logs'), { recursive: true });

    expect(await archiveLogHistory(id)).toBeNull();
  });

  test('returns null when the logs contain only whitespace', async () => {
    const id = 'archiver-test-blank';
    writeLogs(id, '\n   \n');

    expect(await archiveLogHistory(id)).toBeNull();
  });
});

describe('listLogArchives', () => {
  test('returns the archive with a positive size and a parseable createdAt, newest first', async () => {
    const id = 'archiver-test-list';
    writeLogs(id, 'line one\nline two\n');

    const archivePath = await archiveLogHistory(id);
    expect(archivePath).not.toBeNull();

    const list = await listLogArchives(id);
    expect(list.length).toBe(1);
    expect(list[0].fileName).toMatch(ARCHIVE_NAME);
    expect(list[0].size).toBeGreaterThan(0);
    expect(new Date(list[0].createdAt).getTime()).not.toBeNaN();
  });

  test('returns [] when no archive dir exists yet', async () => {
    const id = 'archiver-test-none';
    expect(await listLogArchives(id)).toEqual([]);
  });
});

describe('readLogArchive', () => {
  test('extracts and returns the raw log lines', async () => {
    const id = 'archiver-test-read';
    writeLogs(id, 'live line\n', 'rotated line\n');

    const archivePath = await archiveLogHistory(id);
    expect(archivePath).not.toBeNull();

    const list = await listLogArchives(id);
    expect(list.length).toBe(1);

    const lines = await readLogArchive(id, list[0].fileName);
    expect(lines).toEqual(['rotated line', 'live line']);
  });

  test('returns null for a missing archive', async () => {
    const id = 'archiver-test-missing';
    expect(await readLogArchive(id, '2026-01-01_00-00-00.log.tar.gz')).toBeNull();
  });
});

describe('resolveLogArchivePath', () => {
  test('accepts a valid plain archive file name', () => {
    const id = 'archiver-test-secure';
    const p = resolveLogArchivePath(id, '2026-01-01_00-00-00.log.tar.gz');
    expect(p).not.toBeNull();
    expect(p).toContain(join('.airlinkd', 'logs', 'archive', id));
  });

  test('rejects path traversal via ../evil', () => {
    expect(resolveLogArchivePath('archiver-test-secure', '../evil')).toBeNull();
  });

  test('rejects a file name containing a separator (a/b)', () => {
    expect(resolveLogArchivePath('archiver-test-secure', 'a/b')).toBeNull();
  });
});
