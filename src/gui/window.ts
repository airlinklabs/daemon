// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import config from '../config';
import { guiHtml } from './html';

function signRequest(key: string, method: string, path: string, ts: number): string {
  const payload = `${ts}:${method}:${path}:`;
  return createHmac('sha256', key).update(payload).digest('hex');
}

async function authenticatedGet(path: string): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signRequest(config.key, 'GET', path, ts);
  const basicAuth = btoa(`Airlink:${config.key}`);
  return fetch(`http://localhost:${config.port}${path}`, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'X-Airlink-Timestamp': String(ts),
      'X-Airlink-Signature': sig,
    },
  });
}

function spawnServerProcess(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, '--no-gui'], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, DAEMON_WORKER_MODE: '1' },
    cwd: process.cwd(),
  });
}

export async function runGui(): Promise<boolean> {
  let Webview: { new (debug: boolean): any };
  let SizeHint: any;

  try {
    const mod = await import('webview-bun');
    Webview = mod.Webview;
    SizeHint = mod.SizeHint ?? { NONE: 0 };
  } catch (err) {
    process.stderr.write(`[gui] webview-bun unavailable — falling back to headless\n[gui] reason: ${err}\n`);
    return false;
  }

  let daemonProc: ReturnType<typeof Bun.spawn> | null = spawnServerProcess();

  await new Promise<void>((resolve) => setTimeout(resolve, 2500));

  const htmlPath = join(tmpdir(), 'airlinkd-gui.html');
  try {
    writeFileSync(htmlPath, guiHtml, 'utf-8');
  } catch (err) {
    process.stderr.write(`[gui] failed to write temp html: ${err}\n`);
    daemonProc?.kill();
    return false;
  }

  let wv: any;
  try {
    wv = new Webview(false);
  } catch (err) {
    process.stderr.write(`[gui] failed to create webview — falling back to headless\n[gui] reason: ${err}\n`);
    if (process.platform === 'win32') {
      process.stderr.write(
        '[gui] install WebView2 runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n',
      );
    } else {
      process.stderr.write('[gui] on Linux, install: libwebkit2gtk-4.0 or libwebkit2gtk-4.1\n');
    }
    daemonProc?.kill();
    return false;
  }

  wv.title = 'Airlink Daemon';
  wv.size = { width: 960, height: 620, hint: SizeHint.NONE };
  wv.navigate(`file://${htmlPath}?${config.port}`);

  wv.bind('fetchStats', async () => {
    try {
      const [rootRes, statsRes] = await Promise.all([
        authenticatedGet('/'),
        authenticatedGet('/stats'),
      ]);
      if (!rootRes.ok || !statsRes.ok) {
        return JSON.stringify({ ok: false });
      }
      const root = await rootRes.json();
      const stats = await statsRes.json();
      return JSON.stringify({ ok: true, root, stats });
    } catch {
      return JSON.stringify({ ok: false });
    }
  });

  wv.bind('stopDaemon', () => {
    if (!daemonProc) return JSON.stringify({ ok: false, reason: 'not running' });
    try {
      daemonProc.kill();
    } catch {
      /* already dead */
    }
    daemonProc = null;
    return JSON.stringify({ ok: true });
  });

  wv.bind('startDaemon', () => {
    if (daemonProc) return JSON.stringify({ ok: false, reason: 'already running' });
    try {
      daemonProc = spawnServerProcess();
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('getDaemonStatus', () => {
    if (!daemonProc) return JSON.stringify({ running: false });
    const exited = daemonProc.exitCode !== null;
    if (exited) daemonProc = null;
    return JSON.stringify({ running: !exited });
  });

  wv.bind('pollLogs', (sinceStr: string) => {
    const since = parseInt(sinceStr, 10) || 0;
    const logPath = join(process.cwd(), 'logs/combined.log');
    try {
      if (!existsSync(logPath)) return JSON.stringify({ lines: [], next: 0 });
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      return JSON.stringify({ lines: lines.slice(since), next: lines.length });
    } catch {
      return JSON.stringify({ lines: [], next: since });
    }
  });

  wv.bind('listFiles', (pathArg: string) => {
    const cwd = process.cwd();
    const target = resolve(cwd, pathArg || '.');
    if (!target.startsWith(cwd)) return JSON.stringify([]);
    try {
      const entries = readdirSync(target, { withFileTypes: true });
      return JSON.stringify(
        entries.map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isFile()
            ? (() => {
                try {
                  return statSync(join(target, e.name)).size;
                } catch {
                  return 0;
                }
              })()
            : null,
        })),
      );
    } catch {
      return JSON.stringify([]);
    }
  });

  wv.run();

  try {
    daemonProc?.kill();
  } catch {
    /* already dead */
  }

  return true;
}
