import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachActivityHook,
  generateCredential,
  getActiveSessionCount,
  getSftpActivity,
  revokeCredentialForContainer,
} from '../../src/handlers/nativeSftp';

const TEST_ID = 'sftptest-server-001';

describe('nativeSFTP activity', () => {
  beforeEach(() => {
    rmSync(join(process.cwd(), 'volumes', TEST_ID), { recursive: true, force: true });
    mkdirSync(join(process.cwd(), 'volumes', TEST_ID), { recursive: true });
  });

  test('generates a credential with fixed daemon port and host', async () => {
    const cred = await generateCredential(TEST_ID);
    expect(cred.username).toMatch(/^alsftp_/);
    expect(cred.password.length).toBeGreaterThanOrEqual(16);
    expect(cred.port).toBe(3004);
    expect(cred.host).toBeTruthy();
    expect(cred.expiresAt).toBeGreaterThan(Date.now());
    expect(getActiveSessionCount()).toBe(1);
  });

  test('regenerating a credential revokes the previous server session', async () => {
    const first = await generateCredential(TEST_ID);
    const second = await generateCredential(TEST_ID);
    expect(getActiveSessionCount()).toBe(1);
    expect(second.username).not.toBe(first.username);
    expect(second.password).not.toBe(first.password);
  });

  test('attachActivityHook resolves on a live server session', async () => {
    await generateCredential(TEST_ID);
    expect(attachActivityHook(TEST_ID, () => {})).toBe(true);
    expect(attachActivityHook('nonexistent-server', () => {})).toBe(false);
  });

  test('activity buffer starts empty and revoke clears the session', async () => {
    await generateCredential(TEST_ID);
    expect(getSftpActivity(TEST_ID)).toEqual([]);
    await revokeCredentialForContainer(TEST_ID);
    expect(getActiveSessionCount()).toBe(0);
  });

  test('throws when the volume does not exist', async () => {
    rmSync(join(process.cwd(), 'volumes', TEST_ID), { recursive: true, force: true });
    expect(generateCredential(TEST_ID)).rejects.toThrow('volume for container');
  });
});