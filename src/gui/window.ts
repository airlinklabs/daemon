import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { buildGuiHtml } from './loader';

export type SpawnedProc = ReturnType<typeof Bun.spawn>;

export function spawnDaemonProcess(): SpawnedProc {
  const entry = process.argv[1];
  return Bun.spawn(entry ? [process.execPath, entry, '--no-gui'] : [process.execPath, '--no-gui'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DAEMON_WORKER_MODE: '1' },
    cwd: process.cwd(),
  });
}

export function isProcAlive(proc: SpawnedProc): boolean {
  try {
    return proc.exitCode === null;
  } catch {
    return false;
  }
}

async function installWebviewBun(): Promise<boolean> {
  process.stderr.write('[gui] webview-bun not found — installing...\n');
  const proc = Bun.spawn(['bun', 'add', 'webview-bun'], {
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: process.cwd(),
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write('[gui] install failed — falling back to headless\n');
    return false;
  }
  return true;
}

async function bunIsAvailable(): Promise<boolean> {
  try {
    const p = Bun.spawn(['bun', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

function webviewPackagePath(): string {
  try {
    return require.resolve('webview-bun');
  } catch {
    return '';
  }
}

async function ensureWebviewNativeLib(): Promise<boolean> {
  if (!(await bunIsAvailable())) {
    process.stderr.write('[gui] bun is not installed — install bun from https://bun.sh\n');
    return false;
  }
  if (webviewPackagePath()) return true;
  return installWebviewBun();
}

export async function runGui(): Promise<boolean> {
  const hasLib = await ensureWebviewNativeLib();
  if (!hasLib) return false;

  let WebviewCtor: { new (debug: boolean): any };
  let SizeHint: any;

  try {
    const mod = await import('webview-bun');
    WebviewCtor = mod.Webview;
    SizeHint = mod.SizeHint ?? { NONE: 0 };
  } catch (err) {
    process.stderr.write(`[gui] webview-bun load failed — headless fallback\n[gui] reason: ${err}\n`);
    if (platform() === 'linux') {
      process.stderr.write('[gui] on Linux install: sudo apt-get install libwebkit2gtk-4.1-dev\n');
    } else if (platform() === 'win32') {
      process.stderr.write('[gui] on Windows install WebView2: https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n');
    }
    return false;
  }

  let daemonProc: SpawnedProc | null = null;
  const logLines: string[] = [];

  try {
    daemonProc = spawnDaemonProcess();

    if (daemonProc.stdout && typeof daemonProc.stdout === 'object') {
      const reader = (daemonProc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const line of text.split('\n')) {
            if (line.trim()) logLines.push(line);
            if (logLines.length > 2000) logLines.shift();
          }
        }
      })().catch(() => {});
    }

    if (daemonProc.stderr && typeof daemonProc.stderr === 'object') {
      const reader = (daemonProc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const line of text.split('\n')) {
            if (line.trim()) logLines.push(line);
            if (logLines.length > 2000) logLines.shift();
          }
        }
      })().catch(() => {});
    }
  } catch (err) {
    process.stderr.write(`[gui] failed to start daemon: ${err}\n`);
  }

  let guiHtml: string;
  try {
    guiHtml = buildGuiHtml();
  } catch (err) {
    process.stderr.write(`[gui] failed to build gui html: ${err}\n`);
    return false;
  }

  const htmlPath = join(process.cwd(), '_airlinkd-gui.html');
  try {
    writeFileSync(htmlPath, guiHtml, 'utf-8');
  } catch (err) {
    process.stderr.write(`[gui] failed to write temp html: ${err}\n`);
    return false;
  }

  let wv: any;
  try {
    wv = new WebviewCtor(false);
  } catch (err) {
    process.stderr.write(`[gui] failed to create webview window: ${err}\n`);
    return false;
  }

  const resolveAssetPath = (...parts: string[]) => {
    const candidatePaths = [ resolve(process.cwd(), ...parts) ];

    try {
      candidatePaths.push(resolve(resolve(process.execPath, '..'), ...parts));
    } catch {}

    try {
      candidatePaths.push(resolve(new URL('.', import.meta.url).pathname, ...parts));
    } catch {}

    for (const p of candidatePaths) {
      if (existsSync(p)) return p;
    }

    return resolve(process.cwd(), ...parts);
  };

  const iconSrc = resolveAssetPath('assets', 'airlink_logo.png');
  if (existsSync(iconSrc)) {
    try { wv.icon = iconSrc; } catch {}
  }

  wv.title = 'Airlink Daemon';
  wv.size = { width: 1180, height: 720, hint: SizeHint.NONE };
  wv.navigate(`file://${htmlPath}`);

  wv.bind('getDaemonStatus', () => {
    if (!daemonProc) return JSON.stringify({ running: false });
    const alive = isProcAlive(daemonProc);
    if (!alive) daemonProc = null;
    return JSON.stringify({ running: alive });
  });

  wv.bind('stopDaemon', () => {
    if (daemonProc && isProcAlive(daemonProc)) {
      try { daemonProc.kill(); } catch {}
      const fallback = setTimeout(() => {
        if (daemonProc && isProcAlive(daemonProc)) {
          try { daemonProc.kill('SIGKILL'); } catch {}
        }
        daemonProc = null;
      }, 6000);

      daemonProc.exited.then(() => {
        clearTimeout(fallback);
        daemonProc = null;
      }).catch(() => {
        clearTimeout(fallback);
      });
    }

    return JSON.stringify({ ok: true });
  });

  wv.bind('pollLogs', (sinceStr: string) => {
    const since = parseInt(sinceStr, 10) || 0;
    const logPath = join(process.cwd(), 'logs/combined.log');
    try {
      const fileLines = existsSync(logPath)
        ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
        : [];
      const merged = [...fileLines, ...logLines].slice(-2000);
      const slice = merged.slice(since);
      return JSON.stringify({ lines: slice, next: merged.length });
    } catch {
      return JSON.stringify({ lines: [], next: since });
    }
  });

  wv.bind('getSystemStats', async () => {
    const { cpus, freemem, totalmem } = await import('node:os');
    const before = cpus();
    await new Promise<void>((r) => setTimeout(r, 200));
    const after = cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < before.length; i++) {
      const b = before[i].times;
      const a = after[i].times;
      idle += a.idle - b.idle;
      total +=
        (Object.values(a) as number[]).reduce((s, v) => s + v, 0) -
        (Object.values(b) as number[]).reduce((s, v) => s + v, 0);
    }
    const cpuPct = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    const totalMb = Math.round(totalmem() / 1024 / 1024);
    const usedMb = Math.round((totalmem() - freemem()) / 1024 / 1024);
    return JSON.stringify({ cpuPct, usedMb, totalMb, cores: before.length });
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

  wv.bind('readFile', (pathArg: string) => {
    const cwd = process.cwd();
    const target = resolve(cwd, pathArg);
    if (!target.startsWith(cwd)) return JSON.stringify({ ok: false, reason: 'path outside cwd' });
    try {
      return JSON.stringify({ ok: true, content: readFileSync(target, 'utf-8') });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('writeFile', (pathArg: string, content: string) => {
    const cwd = process.cwd();
    const target = resolve(cwd, pathArg);
    if (!target.startsWith(cwd)) return JSON.stringify({ ok: false, reason: 'path outside cwd' });
    try {
      writeFileSync(target, content, 'utf-8');
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('deleteFile', (pathArg: string) => {
    const cwd = process.cwd();
    const target = resolve(cwd, pathArg);
    if (!target.startsWith(cwd)) return JSON.stringify({ ok: false, reason: 'path outside cwd' });
    try {
      rmSync(target, { recursive: true, force: true });
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('listContainers', async () => {
    try {
      const { default: Docker } = await import('dockerode');
      const docker = new Docker({
        socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
      });
      const list = await docker.listContainers({ all: true });
      return JSON.stringify(list);
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('containerAction', async (id: string, action: string) => {
    try {
      const { default: Docker } = await import('dockerode');
      const docker = new Docker({
        socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
      });
      const c = docker.getContainer(id);
      if (action === 'start') await c.start();
      else if (action === 'stop') await c.stop({ t: 5 });
      else if (action === 'remove') await c.remove({ force: true });
      else return JSON.stringify({ ok: false, reason: 'unknown action' });
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('containerExec', async (id: string, cmd: string) => {
    try {
      const { default: Docker } = await import('dockerode');
      const docker = new Docker({
        socketPath: process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock',
      });
      const exec = await docker.getContainer(id).exec({
        Cmd: ['/bin/sh', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await new Promise<string>((res) => {
        let buf = '';
        stream.on('data', (chunk: Buffer) => { buf += chunk.toString('utf-8'); });
        stream.on('end', () => res(buf));
        stream.on('error', () => res(buf));
        setTimeout(() => res(buf), 8000);
      });
      return JSON.stringify({ ok: true, output });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('readEnvFile', () => {
    try {
      const envPath = join(process.cwd(), '.env');
      if (!existsSync(envPath)) return JSON.stringify({});
      const lines = readFileSync(envPath, 'utf-8').split('\n');
      const result: Record<string, string> = {};
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        result[k] = v;
      }
      return JSON.stringify(result);
    } catch {
      return JSON.stringify({});
    }
  });

  wv.bind('writeEnvFile', (dataJson: string) => {
    try {
      const data = JSON.parse(dataJson) as Record<string, string>;
      const content = Object.entries(data).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
      writeFileSync(join(process.cwd(), '.env'), content, 'utf-8');
      return JSON.stringify({ ok: true });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.bind('sendCommand', async (cmd: string) => {
    try {
      const cfg = (await import('../config')).default;
      const port = cfg.port;
      const key = cfg.key;
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ command: cmd });
      const sig = new Bun.CryptoHasher('sha256', key)
        .update(`${ts}:POST:/container/command:${body}`)
        .digest('hex');
      const r = await fetch(`http://127.0.0.1:${port}/container/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`Airlink:${key}`)}`,
          'X-Airlink-Timestamp': String(ts),
          'X-Airlink-Signature': sig,
        },
        body,
      });
      const json = (await r.json()) as Record<string, unknown>;
      return JSON.stringify({ ok: r.ok, reason: json.error as string | undefined });
    } catch (err) {
      return JSON.stringify({ ok: false, reason: String(err) });
    }
  });

  wv.run();

  try { daemonProc?.kill(); } catch {}
  try { rmSync(htmlPath, { force: true }); } catch {}
  return true;
}
