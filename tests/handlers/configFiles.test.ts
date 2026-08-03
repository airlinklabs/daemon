import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyConfigFiles } from '../../src/handlers/configFiles';

const TEST_ID = 'config-files-test-container';
const VOLUME = resolve(process.cwd(), 'volumes', TEST_ID);
const ENV = { SERVER_PORT: '25565', SERVER_MEMORY: '1024' };

beforeAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
  mkdirSync(VOLUME, { recursive: true });
});

afterAll(() => {
  rmSync(VOLUME, { recursive: true, force: true });
});

function fileAt(rel: string): string {
  return resolve(VOLUME, rel);
}

describe('applyConfigFiles', () => {
  test('properties parser rewrites matching keys and resolves {{port}} tokens', async () => {
    writeFileSync(fileAt('server.properties'), 'server-ip=0.0.0.0\nserver-port=1\nquery.port=2\n');
    await applyConfigFiles(TEST_ID, {
      'server.properties': {
        parser: 'properties',
        find: { 'server-port': '{{server.build.default.port}}', 'query.port': '{{server.build.default.port}}' },
      },
    }, ENV);
    const out = readFileSync(fileAt('server.properties'), 'utf8');
    expect(out).toContain('server-port=25565');
    expect(out).toContain('query.port=25565');
    expect(out).toContain('server-ip=0.0.0.0');
  });

  test('yaml parser rewrites dotted keys at the right depth', async () => {
    writeFileSync(
      fileAt('config.yml'),
      'server:\n  host: 0.0.0.0\n  port: 1\ndatabase:\n  host: localhost\n  port: 2\n',
    );
    await applyConfigFiles(TEST_ID, {
      'config.yml': {
        parser: 'yaml',
        find: { 'database.host': 'db.internal', 'database.port': '{{server.build.default.port}}' },
      },
    }, ENV);
    const out = readFileSync(fileAt('config.yml'), 'utf8');
    expect(out).toContain('database:\n  host: db.internal\n  port: 25565');
    expect(out).toContain('server:\n  host: 0.0.0.0');
  });

  test('json parser walks dotted paths', async () => {
    writeFileSync(fileAt('config.json'), JSON.stringify({ settings: { port: 1, quiet: false } }, null, 2));
    await applyConfigFiles(TEST_ID, {
      'config.json': {
        parser: 'json',
        find: { 'settings.port': '{{server.build.default.port}}' },
      },
    }, ENV);
    const out = JSON.parse(readFileSync(fileAt('config.json'), 'utf8'));
    expect(out.settings.port).toBe('25565');
    expect(out.settings.quiet).toBe(false);
  });

  test('plain parser does token substitution on whole file', async () => {
    writeFileSync(fileAt('motd.txt'), 'welcome on port 1\n');
    await applyConfigFiles(TEST_ID, {
      'motd.txt': { find: { 'port 1': '{{server.build.default.port}}' } },
    }, ENV);
    expect(readFileSync(fileAt('motd.txt'), 'utf8')).toContain('welcome on 25565');
  });

  test('path traversal entries are skipped', async () => {
    writeFileSync(fileAt('safe.txt'), 'a=1\n');
    await applyConfigFiles(TEST_ID, {
      '../escape.txt': { find: { a: 'b' } },
      'sub/../../escape2.txt': { find: { a: 'b' } },
    }, ENV);
    expect(existsSync(resolve(VOLUME, '../escape.txt'))).toBe(false);
    expect(readFileSync(fileAt('safe.txt'), 'utf8')).toBe('a=1\n');
  });

  test('missing files are skipped without error', async () => {
    await applyConfigFiles(TEST_ID, {
      'nope.conf': { parser: 'properties', find: { x: '1' } },
    }, ENV);
    expect(true).toBe(true);
  });
});
