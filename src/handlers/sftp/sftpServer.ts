import { Server as SshServer, Connection, Session, SFTPStream } from 'ssh2';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import config from '../utils/config';
import logger from '../utils/logger';

const VOLUMES_DIR = path.resolve(process.cwd(), 'volumes');
const HOST_KEY_PATH = path.resolve(process.cwd(), 'storage/sftp_host_key');

function getHostKey(): Buffer {
  if (fs.existsSync(HOST_KEY_PATH)) {
    return fs.readFileSync(HOST_KEY_PATH);
  }

  const dir = path.dirname(HOST_KEY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { generateKeyPairSync } = crypto;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  fs.writeFileSync(HOST_KEY_PATH, privateKey, { mode: 0o600 });
  logger.info('Generated new SFTP host key');
  return Buffer.from(privateKey);
}

async function validateCredentials(username: string, password: string): Promise<string | null> {
  const parts = username.split('.');
  if (parts.length < 2) {
    return null;
  }

  const serverUUID = parts[0];

  try {
    const response = await axios.post(
      `http://${config.remote}/api/sftp/validate`,
      { username, password, serverUUID },
      {
        auth: { username: 'Airlink', password: config.key },
        timeout: 5000,
      }
    );

    if (response.data?.valid === true) {
      return serverUUID;
    }

    return null;
  } catch {
    return null;
  }
}

function resolveServerPath(serverUUID: string, requestedPath: string): string | null {
  const base = path.join(VOLUMES_DIR, serverUUID);
  const resolved = path.resolve(base, '.' + requestedPath);

  if (!resolved.startsWith(base)) {
    return null;
  }

  return resolved;
}

function sftpAttrs(stats: fs.Stats): Record<string, any> {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function handleSftpSession(sftp: SFTPStream, serverUUID: string): void {
  const openFiles = new Map<number, { fd: number; flags: string }>();
  let handleCounter = 0;
  const openDirs = new Map<number, { entries: fs.Dirent[]; sent: boolean }>();

  sftp.on('OPEN', (reqid, filename, flags, _attrs) => {
    const absPath = resolveServerPath(serverUUID, filename);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    let fsFlags = 'r';
    if (flags & 0x01) fsFlags = 'r';
    if (flags & 0x02) fsFlags = flags & 0x08 ? 'wx' : 'w';
    if (flags & 0x04) fsFlags = 'a';
    if (flags & 0x08 && flags & 0x02) fsFlags = 'wx';
    if (flags & 0x10 && flags & 0x02) fsFlags = 'w';

    try {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
    } catch {}

    fs.open(absPath, fsFlags, (err, fd) => {
      if (err) {
        const code = err.code === 'ENOENT'
          ? SFTPStream.STATUS_CODE.NO_SUCH_FILE
          : SFTPStream.STATUS_CODE.FAILURE;
        return sftp.status(reqid, code);
      }

      const handle = handleCounter++;
      openFiles.set(handle, { fd, flags: fsFlags });
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(handle, 0);
      sftp.handle(reqid, buf);
    });
  });

  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = handle.readUInt32BE(0);
    const file = openFiles.get(h);
    if (!file) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
    }

    const buf = Buffer.alloc(length);
    fs.read(file.fd, buf, 0, length, offset, (err, bytesRead) => {
      if (err) {
        return sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
      }
      if (bytesRead === 0) {
        return sftp.status(reqid, SFTPStream.STATUS_CODE.EOF);
      }
      sftp.data(reqid, buf.slice(0, bytesRead));
    });
  });

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = handle.readUInt32BE(0);
    const file = openFiles.get(h);
    if (!file) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
    }

    fs.write(file.fd, data, 0, data.length, offset, (err) => {
      if (err) {
        return sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
      }
      sftp.status(reqid, SFTPStream.STATUS_CODE.OK);
    });
  });

  sftp.on('CLOSE', (reqid, handle) => {
    const h = handle.readUInt32BE(0);

    if (openFiles.has(h)) {
      const file = openFiles.get(h)!;
      fs.close(file.fd, (err) => {
        openFiles.delete(h);
        sftp.status(reqid, err ? SFTPStream.STATUS_CODE.FAILURE : SFTPStream.STATUS_CODE.OK);
      });
      return;
    }

    if (openDirs.has(h)) {
      openDirs.delete(h);
      return sftp.status(reqid, SFTPStream.STATUS_CODE.OK);
    }

    sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
  });

  sftp.on('OPENDIR', (reqid, dirPath) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.readdir(absPath, { withFileTypes: true }, (err, entries) => {
      if (err) {
        const code = err.code === 'ENOENT'
          ? SFTPStream.STATUS_CODE.NO_SUCH_FILE
          : SFTPStream.STATUS_CODE.FAILURE;
        return sftp.status(reqid, code);
      }

      const handle = handleCounter++;
      openDirs.set(handle, { entries, sent: false });
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(handle, 0);
      sftp.handle(reqid, buf);
    });
  });

  sftp.on('READDIR', (reqid, handle) => {
    const h = handle.readUInt32BE(0);
    const dir = openDirs.get(h);
    if (!dir) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
    }

    if (dir.sent) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.EOF);
    }

    const names = dir.entries.map((entry) => {
      const isDir = entry.isDirectory();
      return {
        filename: entry.name,
        longname: `${isDir ? 'd' : '-'}rwxr-xr-x 1 user group 0 Jan  1 00:00 ${entry.name}`,
        attrs: {
          mode: isDir ? 0o40755 : 0o100644,
          uid: 0,
          gid: 0,
          size: 0,
          atime: 0,
          mtime: 0,
        },
      };
    });

    dir.sent = true;
    sftp.name(reqid, names);
  });

  sftp.on('STAT', (reqid, filePath) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.stat(absPath, (err, stats) => {
      if (err) {
        return sftp.status(reqid, SFTPStream.STATUS_CODE.NO_SUCH_FILE);
      }
      sftp.attrs(reqid, sftpAttrs(stats));
    });
  });

  sftp.on('LSTAT', (reqid, filePath) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.lstat(absPath, (err, stats) => {
      if (err) {
        return sftp.status(reqid, SFTPStream.STATUS_CODE.NO_SUCH_FILE);
      }
      sftp.attrs(reqid, sftpAttrs(stats));
    });
  });

  sftp.on('REMOVE', (reqid, filePath) => {
    const absPath = resolveServerPath(serverUUID, filePath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.unlink(absPath, (err) => {
      sftp.status(reqid, err ? SFTPStream.STATUS_CODE.FAILURE : SFTPStream.STATUS_CODE.OK);
    });
  });

  sftp.on('RMDIR', (reqid, dirPath) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.rmdir(absPath, (err) => {
      sftp.status(reqid, err ? SFTPStream.STATUS_CODE.FAILURE : SFTPStream.STATUS_CODE.OK);
    });
  });

  sftp.on('MKDIR', (reqid, dirPath, _attrs) => {
    const absPath = resolveServerPath(serverUUID, dirPath);
    if (!absPath) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.mkdir(absPath, { recursive: true }, (err) => {
      sftp.status(reqid, err ? SFTPStream.STATUS_CODE.FAILURE : SFTPStream.STATUS_CODE.OK);
    });
  });

  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const absOld = resolveServerPath(serverUUID, oldPath);
    const absNew = resolveServerPath(serverUUID, newPath);
    if (!absOld || !absNew) {
      return sftp.status(reqid, SFTPStream.STATUS_CODE.PERMISSION_DENIED);
    }

    fs.rename(absOld, absNew, (err) => {
      sftp.status(reqid, err ? SFTPStream.STATUS_CODE.FAILURE : SFTPStream.STATUS_CODE.OK);
    });
  });

  sftp.on('REALPATH', (reqid, reqPath) => {
    const normalized = path.posix.normalize(reqPath || '/');
    sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
  });
}

function handleSession(session: Session, serverUUID: string): void {
  session.on('sftp', (accept) => {
    const sftp = accept();
    handleSftpSession(sftp, serverUUID);
  });

  session.on('exec', (accept, reject) => {
    reject();
  });

  session.on('shell', (accept, reject) => {
    reject();
  });
}

export function startSftpServer(port: number): SshServer {
  const hostKey = getHostKey();

  const srv = new SshServer({ hostKeys: [hostKey] }, (client: Connection) => {
    let authenticatedUUID: string | null = null;

    client.on('authentication', async (ctx) => {
      if (ctx.method !== 'password') {
        return ctx.reject(['password']);
      }

      const serverUUID = await validateCredentials(ctx.username, ctx.password as string);
      if (!serverUUID) {
        return ctx.reject();
      }

      authenticatedUUID = serverUUID;
      ctx.accept();
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
      logger.error('SFTP client error:', err.message);
    });
  });

  srv.listen(port, '0.0.0.0', () => {
    logger.info(`SFTP server listening on port ${port}`);
  });

  srv.on('error', (err) => {
    logger.error('SFTP server error:', err.message);
  });

  return srv;
    }
