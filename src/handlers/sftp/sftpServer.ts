import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { Server as SshServer, Connection, Session } from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import config from '../../utils/config';
import logger from '../../utils/logger';

const HOST_KEY_PATH = path.resolve(process.cwd(), 'storage/sftp_host_key');

function getHostKey(): Buffer {
  if (fs.existsSync(HOST_KEY_PATH)) {
    return fs.readFileSync(HOST_KEY_PATH);
  }

  const dir = path.dirname(HOST_KEY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
  });

  fs.writeFileSync(HOST_KEY_PATH, privateKey as string, { mode: 0o600 });
  logger.info('Generated new SFTP host key');
  return Buffer.from(privateKey as string);
}

const VOLUMES_DIR = path.join(process.cwd(), 'volumes');

const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
};

const SSH_FXF_READ   = 0x00000001;
const SSH_FXF_WRITE  = 0x00000002;
const SSH_FXF_APPEND = 0x00000004;
const SSH_FXF_CREAT  = 0x00000008;
const SSH_FXF_TRUNC  = 0x00000010;

async function validateCredentials(username: string, password: string): Promise<string | null> {
  const dotIndex = username.indexOf('.');
  if (dotIndex === -1) return null;

  const serverUUID = username.slice(0, dotIndex);

  try {
    const response = await axios.post(
      `http://${config.remote}/api/sftp/validate`,
      { username, password, serverUUID },
      {
        auth: { username: 'Airlink', password: config.key },
        timeout: 5000,
      },
    );

    return response.data?.valid === true ? serverUUID : null;
  } catch (err: any) {
    logger.error('SFTP validate request failed:', err?.message ?? String(err));
    return null;
  }
}

function resolveServerPath(serverUUID: string, requestedPath: string): string | null {
  const base = path.join(VOLUMES_DIR, serverUUID);
  const joined = path.join(base, requestedPath);
  const resolved = path.resolve(joined);

  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    return null;
  }

  return resolved;
}

function statAttrs(stats: fs.Stats): Record<string, number> {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function openFlagsToFsFlags(flags: number): string {
  const read   = (flags & SSH_FXF_READ)   !== 0;
  const write  = (flags & SSH_FXF_WRITE)  !== 0;
  const append = (flags & SSH_FXF_APPEND) !== 0;
  const creat  = (flags & SSH_FXF_CREAT)  !== 0;
  const trunc  = (flags & SSH_FXF_TRUNC)  !== 0;

  if (append) return 'a';
  if (write && trunc && creat) return 'w';
  if (write && creat && !trunc) return read ? 'r+' : 'r+';
  if (write && !creat) return 'r+';
  if (write && trunc) return 'w';
  return 'r';
}

function handleSftpSession(sftp: SFTPWrapper, serverUUID: string): void {
  const openFiles = new Map<number, { fd: number }>();
  const openDirs  = new Map<number, { entries: fs.Dirent[]; sent: boolean; absBase: string }>();
  let nextHandle  = 0;

  function makeHandle(): Buffer {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(nextHandle++, 0);
    return h;
  }

  function readHandle(h: Buffer): number {
    return h.readUInt32BE(0);
  }

  (sftp as any).on('OPEN', (reqid: number, filename: string, flags: number, _attrs: any) => {
    const absPath = resolveServerPath(serverUUID, filename);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    const fsFlags = openFlagsToFsFlags(flags);

    if ((flags & (SSH_FXF_WRITE | SSH_FXF_CREAT)) !== 0) {
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
      } catch {}
    }

    fs.open(absPath, fsFlags, (err, fd) => {
      if (err) {
        const code = err.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE;
        return (sftp as any).status(reqid, code);
      }

      const h = makeHandle();
      openFiles.set(h.readUInt32BE(0), { fd });
      (sftp as any).handle(reqid, h);
    });
  });

  (sftp as any).on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
    const file = openFiles.get(readHandle(handle));
    if (!file) return (sftp as any).status(reqid, STATUS.FAILURE);

    const buf = Buffer.alloc(length);
    fs.read(file.fd, buf, 0, length, offset, (err, bytesRead) => {
      if (err) return (sftp as any).status(reqid, STATUS.FAILURE);
      if (bytesRead === 0) return (sftp as any).status(reqid, STATUS.EOF);
      (sftp as any).data(reqid, buf.slice(0, bytesRead));
    });
  });

  (sftp as any).on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    const file = openFiles.get(readHandle(handle));
    if (!file) return (sftp as any).status(reqid, STATUS.FAILURE);

    fs.write(file.fd, data, 0, data.length, offset, (err) => {
      (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
    });
  });

  (sftp as any).on('FSTAT', (reqid: number, handle: Buffer) => {
    const file = openFiles.get(readHandle(handle));
    if (!file) return (sftp as any).status(reqid, STATUS.FAILURE);

    fs.fstat(file.fd, (err, stats) => {
      if (err) return (sftp as any).status(reqid, STATUS.FAILURE);
      (sftp as any).attrs(reqid, statAttrs(stats));
    });
  });

  (sftp as any).on('CLOSE', (reqid: number, handle: Buffer) => {
    const h = readHandle(handle);

    if (openFiles.has(h)) {
      const file = openFiles.get(h)!;
      fs.close(file.fd, (err) => {
        openFiles.delete(h);
        (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
      });
      return;
    }

    if (openDirs.has(h)) {
      openDirs.delete(h);
      return (sftp as any).status(reqid, STATUS.OK);
    }

    (sftp as any).status(reqid, STATUS.FAILURE);
  });

  (sftp as any).on('OPENDIR', (reqid: number, dirPath: string) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.readdir(absPath, { withFileTypes: true }, (err, entries) => {
      if (err) {
        const code = err.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE;
        return (sftp as any).status(reqid, code);
      }

      const h = makeHandle();
      openDirs.set(h.readUInt32BE(0), { entries, sent: false, absBase: absPath });
      (sftp as any).handle(reqid, h);
    });
  });

  (sftp as any).on('READDIR', (reqid: number, handle: Buffer) => {
    const dir = openDirs.get(readHandle(handle));
    if (!dir) return (sftp as any).status(reqid, STATUS.FAILURE);
    if (dir.sent) return (sftp as any).status(reqid, STATUS.EOF);

    const pending = dir.entries.length;

    if (pending === 0) {
      dir.sent = true;
      return (sftp as any).status(reqid, STATUS.EOF);
    }

    const names: any[] = new Array(pending);
    let done = 0;

    dir.entries.forEach((entry, i) => {
      const entryPath = path.join(dir.absBase, entry.name);
      fs.lstat(entryPath, (err, stats) => {
        if (err) {
          const isDir = entry.isDirectory();
          const mode  = isDir ? 0o40755 : 0o100644;
          names[i] = {
            filename: entry.name,
            longname: `${isDir ? 'd' : '-'}rwxr-xr-x 1 user group 0 Jan  1 00:00 ${entry.name}`,
            attrs: { mode, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
          };
        } else {
          const isDir = stats.isDirectory();
          names[i] = {
            filename: entry.name,
            longname: `${isDir ? 'd' : '-'}rwxr-xr-x 1 user group ${stats.size} Jan  1 00:00 ${entry.name}`,
            attrs: statAttrs(stats),
          };
        }

        done++;
        if (done === pending) {
          dir.sent = true;
          (sftp as any).name(reqid, names);
        }
      });
    });
  });

  (sftp as any).on('STAT', (reqid: number, filePath: string) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.stat(absPath, (err, stats) => {
      if (err) return (sftp as any).status(reqid, STATUS.NO_SUCH_FILE);
      (sftp as any).attrs(reqid, statAttrs(stats));
    });
  });

  (sftp as any).on('LSTAT', (reqid: number, filePath: string) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.lstat(absPath, (err, stats) => {
      if (err) return (sftp as any).status(reqid, STATUS.NO_SUCH_FILE);
      (sftp as any).attrs(reqid, statAttrs(stats));
    });
  });

  (sftp as any).on('REMOVE', (reqid: number, filePath: string) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.unlink(absPath, (err) => {
      (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
    });
  });

  (sftp as any).on('RMDIR', (reqid: number, dirPath: string) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.rm(absPath, { recursive: true, force: false }, (err) => {
      (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
    });
  });

  (sftp as any).on('MKDIR', (reqid: number, dirPath: string, _attrs: any) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.mkdir(absPath, { recursive: true }, (err) => {
      (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
    });
  });

  (sftp as any).on('RENAME', (reqid: number, oldPath: string, newPath: string) => {
    const absOld = resolveServerPath(serverUUID, oldPath);
    const absNew = resolveServerPath(serverUUID, newPath);
    if (!absOld || !absNew) return (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);

    fs.rename(absOld, absNew, (err) => {
      (sftp as any).status(reqid, err ? STATUS.FAILURE : STATUS.OK);
    });
  });

  (sftp as any).on('REALPATH', (reqid: number, reqPath: string) => {
    const normalized = path.posix.normalize(reqPath || '/');
    (sftp as any).name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
  });

  (sftp as any).on('SETSTAT', (reqid: number, _filePath: string, _attrs: any) => {
    (sftp as any).status(reqid, STATUS.OK);
  });

  (sftp as any).on('FSETSTAT', (reqid: number, _handle: Buffer, _attrs: any) => {
    (sftp as any).status(reqid, STATUS.OK);
  });

  (sftp as any).on('SYMLINK', (reqid: number, _linkPath: string, _targetPath: string) => {
    (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);
  });

  (sftp as any).on('READLINK', (reqid: number, _linkPath: string) => {
    (sftp as any).status(reqid, STATUS.PERMISSION_DENIED);
  });
}

function handleSession(session: Session, serverUUID: string): void {
  session.on('sftp', (accept, _reject) => {
    const sftp = accept();
    handleSftpSession(sftp, serverUUID);
  });

  session.on('exec',  (_accept, reject) => reject());
  session.on('shell', (_accept, reject) => reject());
  session.on('pty',   (_accept, reject) => reject());
}

export function startSftpServer(port: number): SshServer {
  const hostKey = getHostKey();

  const srv = new SshServer({ hostKeys: [hostKey] }, (client: Connection) => {
    let authenticatedUUID: string | null = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        return ctx.reject(['password']);
      }

      validateCredentials(ctx.username, ctx.password as string)
        .then((uuid) => {
          if (!uuid) return ctx.reject();
          authenticatedUUID = uuid;
          ctx.accept();
        })
        .catch(() => ctx.reject());
    });

    client.on('ready', () => {
      if (!authenticatedUUID) {
        client.end();
        return;
      }

      const uuid = authenticatedUUID;

      client.on('session', (accept) => {
        const session = accept();
        handleSession(session, uuid);
      });
    });

    client.on('error', (err) => {
      logger.error(`SFTP client error: ${err}`);
    });
  });

  srv.listen(port, '0.0.0.0', () => {
    logger.info(`SFTP server listening on port ${port}`);
  });

  srv.on('error', (err: unknown) => {
    logger.error(`SFTP server error: ${err}`);
  });

  return srv;
}
