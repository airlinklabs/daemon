import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachActivityHook,
  authenticateSftpSession,
  generateCredential,
  getActiveSessionCount,
  getSftpActivity,
  revokeCredentialForContainer,
  rooted,
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

// Pure path-mapping tests for the jail. Use a throwaway base under /tmp so they
// never touch the on-disk SFTP volumes used by the e2e suite.
const JAIL_BASE = '/tmp/airlink-sftp-jail-test';

describe('nativeSFTP path jailing (rooted)', () => {
  beforeEach(() => {
    rmSync(JAIL_BASE, { recursive: true, force: true });
    mkdirSync(JAIL_BASE, { recursive: true });
    mkdirSync(join(JAIL_BASE, 'sub'), { recursive: true });
    writeFileSync(join(JAIL_BASE, 'hello.txt'), 'hello');
  });

  test('maps a rooted remote path onto the jail root', () => {
    expect(rooted(JAIL_BASE, '/sub')).toBe(join(JAIL_BASE, 'sub'));
    expect(rooted(JAIL_BASE, '/hello.txt')).toBe(join(JAIL_BASE, 'hello.txt'));
    expect(rooted(JAIL_BASE, '/')).toBe(JAIL_BASE);
  });

  test('refuses ../ traversal out of the jail', () => {
    expect(() => rooted(JAIL_BASE, '/../etc/passwd')).toThrow(/traversal|boundary/);
    expect(() => rooted(JAIL_BASE, '/..')).toThrow(/traversal/);
  });

  test('refuses a final-component symlink that escapes the jail', () => {
    // A symlink inside the volume pointing OUTSIDE it (e.g. /etc/hostname) must
    // never be followed — the ST-1 jail checks would otherwise be bypassed.
    symlinkSync('/etc/hostname', join(JAIL_BASE, 'outside-link'));
    expect(() => rooted(JAIL_BASE, '/outside-link')).toThrow(/escapes volume boundary/);
  });

  test('allows a final-component symlink that resolves back inside the jail', () => {
    symlinkSync(join(JAIL_BASE, 'hello.txt'), join(JAIL_BASE, 'inside-link'));
    expect(rooted(JAIL_BASE, '/inside-link')).toBe(join(JAIL_BASE, 'inside-link'));
  });
});

describe('SFTP authentication validation', () => {
  beforeEach(() => {
    rmSync(join(process.cwd(), 'volumes', TEST_ID), { recursive: true, force: true });
    mkdirSync(join(process.cwd(), 'volumes', TEST_ID), { recursive: true });
  });

  test('accepts the correct per-container password', async () => {
    const cred = await generateCredential(TEST_ID);
    const outcome = authenticateSftpSession(cred.username, cred.password);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.session.serverId).toBe(TEST_ID);
  });

  test('rejects an unknown username without leaking existence', async () => {
    expect(authenticateSftpSession('alsftp_nobody', 'x')).toEqual({ ok: false, reason: 'invalid_credential' });
  });

  test('rejects an empty password', async () => {
    const cred = await generateCredential(TEST_ID);
    expect(authenticateSftpSession(cred.username, '')).toEqual({ ok: false, reason: 'invalid_credential' });
  });

  test('rejects a wrong password', async () => {
    const cred = await generateCredential(TEST_ID);
    // Wrong password of the SAME length keeps the SHA-256 comparison timing-safe
    expect(authenticateSftpSession(cred.username, 'x'.repeat(cred.password.length))).toEqual({
      ok: false,
      reason: 'invalid_password',
    });
  });

  test('rejects an expired credential and purges the session', async () => {
    const cred = await generateCredential(TEST_ID);
    // Far past TTL (24h): the session must be refused AND removed so a stale
    // password can never authenticate again.
    const farFuture = Date.now() + 24 * 60 * 60 * 1000 + 1;
    expect(authenticateSftpSession(cred.username, cred.password, farFuture)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(authenticateSftpSession(cred.username, cred.password)).toEqual({ ok: false, reason: 'invalid_credential' });
  });

  test('rejects a revoked credential', async () => {
    const cred = await generateCredential(TEST_ID);
    await revokeCredentialForContainer(TEST_ID);
    expect(authenticateSftpSession(cred.username, cred.password)).toEqual({ ok: false, reason: 'invalid_credential' });
  });
});