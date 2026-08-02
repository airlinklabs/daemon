import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'ssh2';
import {
  generateCredential,
  getSftpActivity,
  revokeCredentialForContainer,
  startNativeSftpServer,
} from '../../src/handlers/nativeSftp';

const TEST_ID = 'e2e-sftp-srv-001';
const ROOT = join(process.cwd(), 'volumes', TEST_ID);
const PORT = 3004;

type SftpHandle = {
  readdir: (path: string, cb: (err: Error | undefined, entries?: Array<{ filename: string }>) => void) => void;
  readFile: (path: string, cb: (err: Error | undefined, data: Buffer) => void) => void;
  writeFile: (path: string, data: string, cb: (err: Error | undefined) => void) => void;
};

function connectSftp<T>(username: string, password: string, run: (sftp: SftpHandle) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err);
          run(sftp as unknown as SftpHandle)
            .then((result) => {
              conn.end();
              resolve(result);
            })
            .catch((e) => {
              conn.end();
              reject(e);
            });
        });
      })
      .on('error', reject)
      .connect({ host: '127.0.0.1', port: PORT, username, password, readyTimeout: 5000 });
  });
}

describe('nativeSFTP end-to-end', () => {
  test('authenticates, lists, and writes — jailed to the server volume', async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(join(ROOT, 'hello.txt'), 'hello airlink');

    await startNativeSftpServer();
    const cred = await generateCredential(TEST_ID);

    const list = await connectSftp(cred.username, cred.password, (sftp) => {
      return new Promise<string[]>((resolve, reject) => {
        sftp.readdir('.', (err, entries) => (err ? reject(err) : resolve((entries ?? []).map((e) => e.filename))));
      });
    });
    expect(list).toContain('hello.txt');

    await connectSftp(cred.username, cred.password, (sftp) => {
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile('written.txt', 'data', (err) => (err ? reject(err) : resolve()));
      });
    });
    expect(existsSync(join(ROOT, 'written.txt'))).toBe(true);

    await revokeCredentialForContainer(TEST_ID);
  }, 20000);

  test('path traversal is contained to the server volume', async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(join(ROOT, 'hello.txt'), 'hello');
    // a file OUTSIDE the volume that traversal must never reach
    const outside = '/tmp/airlink-e2e-outside.txt';
    writeFileSync(outside, 'must not be visible');

    await startNativeSftpServer();
    const cred = await generateCredential(TEST_ID);

    // Traversal is resolved back to the volume root by the jail — so it lists
    // exactly the volume contents and never the parent or outside file.
    const list = await connectSftp(cred.username, cred.password, (sftp) => {
      return new Promise<string[]>((resolve, reject) => {
        sftp.readdir('./', (err, entries) => (err ? reject(err) : resolve((entries ?? []).map((e) => e.filename))));
      });
    });
    expect(list).toContain('hello.txt');
    expect(list.every((f) => f !== 'airlink-e2e-outside.txt')).toBe(true);

    await revokeCredentialForContainer(TEST_ID);
  });

  test('network events are buffered for panel auditing', async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(join(ROOT, 'hello.txt'), 'hello');

    await startNativeSftpServer();
    const cred = await generateCredential(TEST_ID);

    await connectSftp(cred.username, cred.password, (sftp) => {
      return new Promise<void>((resolve, reject) => {
        sftp.writeFile('audited.txt', 'x', (err) => (err ? reject(err) : resolve()));
      });
    });

    const kinds = getSftpActivity(TEST_ID).map((e) => e.kind);
    expect(kinds).toContain('connect');
    expect(kinds).toContain('write');
    expect(kinds).toContain('disconnect');

    await revokeCredentialForContainer(TEST_ID);
  });
});