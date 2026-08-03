import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadStartConfig, saveStartConfig, type CachedStartConfig } from '../../src/routes/instances';

const TEST_ID = 'restart-config-test';
const CONFIG_DIR = resolve(process.cwd(), 'storage/containerConfigs');

beforeAll(() => {
  rmSync(resolve(CONFIG_DIR, `${TEST_ID}.json`), { force: true });
});

afterAll(() => {
  rmSync(resolve(CONFIG_DIR, `${TEST_ID}.json`), { force: true });
});

describe('start config cache (B-7)', () => {
  test('saves and replays the exact start payload', async () => {
    const config: CachedStartConfig = {
      id: TEST_ID,
      image: 'ghcr.io/airlink/yolks:minecraft-java',
      ports: '25565:25565',
      env: { START: 'java -jar server.jar' },
      Memory: 2048,
      Cpu: 150,
      Storage: 10240,
      Swap: 0,
      StartCommand: 'java -jar server.jar',
      mounts: [{ source: '/tmp/extra', target: '/extra', readOnly: true }],
      savedAt: new Date().toISOString(),
    };

    await saveStartConfig(config);
    expect(existsSync(resolve(CONFIG_DIR, `${TEST_ID}.json`))).toBe(true);

    const loaded = await loadStartConfig(TEST_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(TEST_ID);
    expect(loaded!.image).toBe(config.image);
    expect(loaded!.ports).toBe(config.ports);
    expect(loaded!.env).toEqual(config.env);
    expect(loaded!.Memory).toBe(2048);
    expect(loaded!.Cpu).toBe(150);
    expect(loaded!.mounts).toEqual(config.mounts);
  });

  test('returns null for unknown containers', async () => {
    expect(await loadStartConfig('does-not-exist')).toBeNull();
  });

  test('rejects corrupted configs', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(CONFIG_DIR, `${TEST_ID}.json`), '{not json');
    expect(await loadStartConfig(TEST_ID)).toBeNull();
  });
});
