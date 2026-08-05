import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getInstallStatus,
  removeServerState,
  setInstallStateFileForTest,
  setServerState,
} from '../../src/handlers/installState';

const TEST_ID = 'install-state-test-container';
const TEST_FILE = resolve(process.cwd(), 'storage/install_logs.test.json');

beforeAll(() => {
  // point the module at a writable test file so we never touch the real state
  setInstallStateFileForTest(TEST_FILE);
  rmSync(TEST_FILE, { force: true });
});

beforeEach(async () => {
  await removeServerState(TEST_ID);
});

afterAll(async () => {
  await removeServerState(TEST_ID);
  rmSync(TEST_FILE, { force: true });
});

describe('setServerState enforces deterministic install transitions', () => {
  test('installs in order: installing -> installed', async () => {
    await setServerState(TEST_ID, 'installing');
    expect((await getInstallStatus(TEST_ID))?.state).toBe('installing');

    await setServerState(TEST_ID, 'installed');
    expect((await getInstallStatus(TEST_ID))?.state).toBe('installed');
  });

  test('an installed container refuses to be flipped back to installing (no contradictory states)', async () => {
    await setServerState(TEST_ID, 'installing');
    await setServerState(TEST_ID, 'installed');

    // installed -> installing is the exact contradiction the guard exists to
    // block; it must reject and leave the stored state untouched
    await expect(setServerState(TEST_ID, 'installing')).rejects.toThrow();
    expect((await getInstallStatus(TEST_ID))?.state).toBe('installed');
  });

  test('a failed install may retry as installing', async () => {
    await setServerState(TEST_ID, 'installing');
    await setServerState(TEST_ID, 'failed');

    await setServerState(TEST_ID, 'installing');
    expect((await getInstallStatus(TEST_ID))?.state).toBe('installing');
  });

  test('failed cannot jump straight to installed', async () => {
    await setServerState(TEST_ID, 'installing');
    await setServerState(TEST_ID, 'failed');

    await expect(setServerState(TEST_ID, 'installed')).rejects.toThrow();
    expect((await getInstallStatus(TEST_ID))?.state).toBe('failed');
  });

  test('reinstalling supersedes a finished install', async () => {
    await setServerState(TEST_ID, 'installing');
    await setServerState(TEST_ID, 'installed');

    await setServerState(TEST_ID, 'reinstalling');
    expect((await getInstallStatus(TEST_ID))?.state).toBe('reinstalling');
  });
});