import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'worker_threads';
import { guiHtml } from './html';
import config from '../config';

// spawns the server as a background Worker thread
function spawnServerWorker(): Worker {
  return new Worker(new URL('../server.ts', import.meta.url).href, {
    env: { ...process.env, DAEMON_WORKER_MODE: '1' },
  });
}

function parseLogLine(raw: string): { time: string; level: string; msg: string } | null {
  const m = raw.match(/^\[(\d+:\d+:\d+)\] (\w+)\s*: (.*)/);
  if (!m) return null;
  return { time: m[1], level: m[2].toLowerCase().trim(), msg: m[3] };
}

// returns true if the GUI launched successfully, false if webview_bun isn't available
export async function runGui(): Promise<boolean> {
  // dynamic import so a missing native lib doesn't crash headless starts
  let Webview: { new (debug: boolean): any };
  let SizeHint: { NONE: number };

  try {
    const mod = await import('webview-bun');
    Webview   = mod.Webview;
    SizeHint  = mod.SizeHint ?? { NONE: 0 };
  } catch {
    process.stderr.write('[gui] webview-bun unavailable — falling back to headless\n');
    return false;
  }

  let daemonWorker: Worker | null = spawnServerWorker();

  // wait for the server worker to signal it has bound the port before navigating.
  // falls back after 3s so a slow start or a crash doesn't hang the window forever.
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, 3000);

    daemonWorker!.addEventListener('message', function handler(e: MessageEvent) {
      if (e.data?.type === 'ready') {
        clearTimeout(timeout);
        daemonWorker!.removeEventListener('message', handler);
        resolve();
      }
    });
  });

  // write HTML to a temp file so the WebView doesn't hit data: URL size limits
  const htmlPath = join(tmpdir(), 'airlinkd-gui.html');
  writeFileSync(htmlPath, guiHtml, 'utf-8');

  const wv = new Webview(false);
  wv.title  = 'Airlink Daemon';
  wv.size   = { width: 960, height: 620, hint: SizeHint.NONE };
  // pass port in the query string so the JS can pick it up
  wv.navigate(`file://${htmlPath}?${config.port}`);

  wv.bind('stopDaemon', () => {
    if (!daemonWorker) return JSON.stringify({ ok: false });
    daemonWorker.terminate();
    daemonWorker = null;
    return JSON.stringify({ ok: true });
  });

  wv.bind('startDaemon', () => {
    if (daemonWorker) return JSON.stringify({ ok: false, reason: 'already running' });
    daemonWorker = spawnServerWorker();
    return JSON.stringify({ ok: true });
  });

  // the WebView JS polls this instead of receiving pushed events,
  // avoiding cross-thread event loop conflicts with webview.run()
  wv.bind('pollLogs', (sinceStr: string) => {
    const since   = parseInt(sinceStr, 10) || 0;
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
    const cwd     = process.cwd();
    const target  = resolve(cwd, pathArg || '.');
    // path jail: never escape the working directory
    if (!target.startsWith(cwd)) return JSON.stringify([]);
    try {
      const entries = readdirSync(target, { withFileTypes: true });
      return JSON.stringify(entries.map(e => ({
        name:  e.name,
        isDir: e.isDirectory(),
        size:  e.isFile()
          ? (() => { try { return statSync(join(target, e.name)).size; } catch { return 0; } })()
          : null,
      })));
    } catch {
      return JSON.stringify([]);
    }
  });

  wv.run(); // blocks until the window is closed

  // clean up after window closes
  daemonWorker?.terminate();

  return true;
}
