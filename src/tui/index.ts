import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  Box,
  type BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type Renderable,
  ScrollBoxRenderable,
  Text,
  TextNodeRenderable,
  TextRenderable,
} from '@opentui/core';
import {
  collectDaemon,
  collectDocker,
  collectHost,
  type DaemonCtx,
  type DaemonInfo,
  type DockerStats,
  type HostStats,
  resolveExternalDir,
} from './stats';

const IS_COMPILED = import.meta.dir.includes('$bunfs');
const RUNTIME_DIR = dirname(process.execPath);
const TUI_DIR = IS_COMPILED ? RUNTIME_DIR : import.meta.dir;
const DAEMON_DIR = findDaemonDir();
const DEFAULT_LOG_DIR = `${DAEMON_DIR}/logs`;
const LOG_FILES = ['combined.log', 'error.log'];
const VERSION = readVersion(DAEMON_DIR) || readVersion(resolve(TUI_DIR, '..')) || 'unknown';

function findDaemonDir(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [resolve(TUI_DIR, '../..'), resolve(TUI_DIR, '..'), TUI_DIR, RUNTIME_DIR, '/etc/daemon'];
  for (const dir of candidates) {
    try {
      if (
        existsSync(`${dir}/src/app.ts`) ||
        existsSync(`${dir}/airlinkd`) ||
        existsSync(`${dir}/airlinkd.exe`) ||
        existsSync(`${dir}/dist/airlinkd`) ||
        existsSync(`${dir}/dist/airlinkd.exe`) ||
        existsSync(`${dir}/airlinkd-${os}-${arch}${ext}`) ||
        existsSync(`${dir}/airlinkd-${os}-${arch}.exe`)
      ) {
        return dir;
      }
    } catch {
      /* unreadable candidate */
    }
  }
  return candidates[0];
}

const WIDE_MIN_WIDTH = 110;
const SHORT_MAX_HEIGHT = 27;
const INITIAL_TAIL_LINES = 1000;
const STATS_INTERVAL_MS = 5000;
const HISTORY_LEN = 30;
const SPARK_BLOCKS = '▁▂▃▄▅▆▇█';

const GREEN = '#4ADE80';
const BLUE = '#60A5FA';
const AMBER = '#FFD166';
const RED = '#FF6B6B';
const SPARK_GREEN = '#22C55E';
const TEXT = '#E5E7EB';
const SECONDARY = '#9CA3AF';
const MUTED = '#4B5563';
const DIM = '#6B7280';
const BORDER = '#374151';
const BORDER_FOCUS = '#4ADE80';

const ART = [
  '  /$$$$$$ /$$         /$$/$$         /$$      ',
  ' /$$__  $|__/        | $|__/        | $$      ',
  '| $$  \\ $$/$$ /$$$$$$| $$/$$/$$$$$$$| $$   /$$',
  '| $$$$$$$| $$/$$__  $| $| $| $$__  $| $$  /$$/',
  '| $$__  $| $| $$  \\__| $| $| $$  \\ $| $$$$$$/ ',
  '| $$  | $| $| $$     | $| $| $$  | $| $$_  $$ ',
  '|__/  |__|__|__/     |__|__|__/  |__|__/  \\__/',
];

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    /* unreadable env file */
  }
  return out;
}

const ENV_KEYS = [
  'key',
  'remote',
  'port',
  'version',
  'STATS_INTERVAL',
  'DEBUG',
  'CONTAINER_RUNTIME',
  'REQUIRE_HMAC',
  'ALLOWED_IPS',
  'TLS_CERT',
  'TLS_KEY',
] as const;

const repoEnv = parseEnvFile(`${DAEMON_DIR}/.env`);
const etcEnv = parseEnvFile('/etc/daemon/.env');
const env: Record<string, string> = {};
for (const k of ENV_KEYS) {
  env[k] = process.env[k] ?? repoEnv[k] ?? etcEnv[k] ?? '';
}

const DAEMON_PORT = Number(env.port || '3002');
const RUNTIME = env.CONTAINER_RUNTIME || 'docker';
const REMOTE = env.remote || 'localhost';
const KEY = env.key || '';
const REPO_VERSION = VERSION;

function readVersion(dir: string): string {
  const roots = [dir, resolve(dir, '..')];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { version?: string };
      if (pkg?.version) return pkg.version;
    } catch {
      /* no package.json */
    }
  }
  try {
    const cfg = JSON.parse(readFileSync(`${dir}/storage/config.json`, 'utf8')) as { meta?: { version?: string } };
    if (cfg?.meta?.version) return cfg.meta.version;
  } catch {
    /* no storage config */
  }
  return '';
}

function findBin(): { bin: string; args: string[]; cwd: string } | null {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    resolve(RUNTIME_DIR, `airlinkd-${os}-${arch}${ext}`),
    resolve(RUNTIME_DIR, `airlinkd${ext}`),
    resolve(RUNTIME_DIR, 'dist', `airlinkd-${os}-${arch}${ext}`),
    resolve(RUNTIME_DIR, 'dist', `airlinkd${ext}`),
    resolve(DAEMON_DIR, 'dist', `airlinkd-${os}-${arch}${ext}`),
    resolve(DAEMON_DIR, 'dist', `airlinkd${ext}`),
    resolve(DAEMON_DIR, `airlinkd${ext}`),
    resolve('/etc/daemon', `airlinkd${ext}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { bin: c, args: ['start'], cwd: DAEMON_DIR };
  }
  return null;
}

function logPath(name: string) {
  return `${LOG_DIR}/${name}`;
}

let LOG_DIR = process.env.AIRLINK_LOG_DIR ?? DEFAULT_LOG_DIR;

function readTail(name: string, from: number): { lines: string[]; nextOffset: number } {
  const path = logPath(name);
  const size = statSync(path).size;
  if (from > size) from = 0;
  if (from === size) return { lines: [], nextOffset: size };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    const parts = text.split('\n');
    const trailing = parts.pop() ?? '';
    return { lines: parts, nextOffset: size - trailing.length };
  } finally {
    closeSync(fd);
  }
}

function colorForLine(line: string): string {
  if (line.includes('ERROR')) return RED;
  if (line.includes('WARN')) return AMBER;
  if (line.includes('SUCCESS') || line.includes('READY') || line.includes('STARTED') || line.includes('OK'))
    return GREEN;
  if (line.includes('INFO')) return BLUE;
  return SECONDARY;
}

function fmtBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)} MB`;
  if (n >= 2 ** 10) return `${(n / 2 ** 10).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

function fmtDur(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${Math.floor(s)}s`;
}

function bar(pct: number, width = 10): string {
  const c = Math.max(0, Math.min(100, pct));
  const full = Math.round((c / 100) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

function severity(pct: number): string {
  if (pct >= 85) return RED;
  if (pct >= 60) return AMBER;
  return GREEN;
}

function sparkline(values: number[], width: number): string {
  if (values.length === 0) return '';
  const win = values.slice(-width);
  const min = Math.min(...win);
  const max = Math.max(...win);
  const range = max - min;
  if (range === 0) return SPARK_BLOCKS[3]?.repeat(win.length);
  let out = '';
  for (const v of win) {
    const idx = Math.min(7, Math.max(0, Math.floor(((v - min) / range) * 8)));
    out += SPARK_BLOCKS[idx]!;
  }
  return out;
}

function pushCapped(arr: number[], value: number) {
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
}

function seg(text: string, fg: string): TextNodeRenderable {
  const node = new TextNodeRenderable({ fg });
  node.add(text);
  return node;
}

function clearChildren(container: Renderable) {
  for (const child of Array.from(container.getChildren() as unknown as Renderable[])) {
    container.remove(child);
  }
}

function renderInto(container: Renderable, renderer: CliRenderer, lines: { text: string; fg: string }[]) {
  clearChildren(container);
  for (const line of lines) {
    container.add(new TextRenderable(renderer, { content: line.text, fg: line.fg, width: '100%' }));
  }
}

function brandMetaLines(d: DaemonInfo | null): { text: string; fg: string }[] {
  const mode = d ? (d.mode === 'managed' ? 'managed' : d.mode === 'external' ? 'external' : 'no daemon') : '…';
  const pid = d?.pid ? String(d.pid) : '–';
  const up = d?.uptimeSec != null ? ` · up ${fmtDur(d.uptimeSec)}` : '';
  return [
    { text: `Airlinkd v${VERSION} · AirlinkLabs · MIT`, fg: BLUE },
    { text: `Mode: ${mode} · PID: ${pid}${up}`, fg: BLUE },
    { text: `Port: ${DAEMON_PORT} · Panel: ${REMOTE}`, fg: BLUE },
  ];
}

export async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: '#0D1117',
  });

  let daemonChild: ChildProcess | null = null;
  let daemonStartedAt: number | null = null;
  let stopRequested = false;
  let shuttingDown = false;
  let extPid: number | null = null;
  let configError = '';
  const daemonEnv = { ...process.env, ...env, version: REPO_VERSION };

  function findBun(): string {
    const exe = process.execPath;
    const base = basename(exe).toLowerCase();
    if (base.includes('bun')) return exe;
    return 'bun';
  }

  function startDaemon() {
    if (daemonChild) return;
    if (!KEY || KEY.length < 16) {
      configError = 'no daemon key — create daemon/.env with key= (16+ chars)';
      return;
    }
    stopRequested = false;
    configError = '';
    const found = findBin();
    const child = found
      ? spawn(found.bin, found.args, { cwd: found.cwd, env: daemonEnv, stdio: 'ignore' })
      : spawn(findBun(), ['src/app.ts'], { cwd: DAEMON_DIR, env: daemonEnv, stdio: 'ignore' });
    daemonChild = child;
    daemonStartedAt = Date.now();
    child.on('error', (error) => {
      configError = `failed to start daemon: ${error.message}`;
      daemonChild = null;
    });
    child.on('exit', (code, signal) => {
      daemonChild = null;
      if (shuttingDown || stopRequested) return;
      setTimeout(() => {
        console.error(`Daemon exited (code ${code ?? '?'}${signal ? `, ${signal}` : ''}) — shutting down.`);
        renderer.destroy();
        process.exit(1);
      }, 2500);
    });
  }

  function stopDaemon() {
    const child = daemonChild;
    if (child) {
      stopRequested = true;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => clearTimeout(timer));
      return;
    }
    if (extPid) {
      try {
        process.kill(extPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  function shutdownDaemon() {
    const child = daemonChild;
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1500);
  }

  async function probeDaemon(): Promise<{ online: boolean; pid: number | null }> {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/healthz`);
      if (res.ok) {
        return { online: true, pid: null };
      }
    } catch {
      /* not running */
    }
    return { online: false, pid: null };
  }

  const brand = Box(
    {
      id: 'brand',
      width: '100%',
      flexDirection: 'column',
      gap: 1,
      paddingX: 1,
      paddingY: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Airlink Daemon',
      titleColor: GREEN,
    },
    Box({ id: 'art-box', flexDirection: 'column' }, Text({ content: ART.join('\n'), fg: GREEN })),
    Box({ id: 'meta-box', flexDirection: 'column', gap: 0 }, Text({ content: 'Collecting…', fg: MUTED })),
  );

  const status = Box(
    {
      id: 'status',
      width: '100%',
      height: 6,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Daemon',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const cont = Box(
    {
      id: 'cont',
      width: '100%',
      flexGrow: 1,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Containers',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const left = Box(
    { id: 'left', flexDirection: 'column', gap: 1, flexGrow: 0, flexShrink: 0, width: 52 },
    brand,
    status,
    cont,
  );

  const host = Box(
    {
      id: 'host',
      width: '100%',
      height: 12,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Host',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const net = Box(
    {
      id: 'net',
      width: '100%',
      height: 8,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Network I/O',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const diskio = Box(
    {
      id: 'diskio',
      width: '100%',
      height: 5,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'Disk I/O',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const sys = Box(
    {
      id: 'sys',
      width: '100%',
      height: 4,
      flexDirection: 'column',
      gap: 0,
      paddingX: 1,
      borderStyle: 'rounded',
      borderColor: BORDER,
      title: 'System',
      titleColor: SECONDARY,
    },
    Text({ content: 'Collecting…', fg: MUTED }),
  );

  const center = Box(
    { id: 'center', flexDirection: 'column', gap: 1, flexGrow: 0, flexShrink: 0, width: 36 },
    host,
    net,
    diskio,
    sys,
  );

  const logs = new ScrollBoxRenderable(renderer, {
    id: 'logs',
    width: '100%',
    height: '100%',
    stickyScroll: true,
    stickyStart: 'bottom',
    viewportCulling: true,
    scrollbarOptions: {
      trackOptions: { foregroundColor: '#4B5563', backgroundColor: '#1F2937' },
    },
  });

  const right = Box({ id: 'right', flexGrow: 1, flexDirection: 'column' }, logs);
  const mainRow = Box({ id: 'main-row', flexGrow: 1, flexDirection: 'row', gap: 1 }, left, center, right);
  const hintBox = Box({ id: 'hint-box', width: '100%', height: 1, paddingX: 1 });
  const outer = Box({ id: 'outer', width: '100%', height: '100%', flexDirection: 'column', gap: 1 }, mainRow, hintBox);
  renderer.root.add(outer);

  const realOuter = renderer.root.getRenderable('outer')!;
  const realMainRow = realOuter.getRenderable('main-row')! as unknown as BoxRenderable;
  const realLeft = realMainRow.getRenderable('left')! as unknown as BoxRenderable;
  const realCenter = realMainRow.getRenderable('center')! as unknown as BoxRenderable;
  const realBrand = realLeft.getRenderable('brand')! as unknown as BoxRenderable;
  const artBox = realBrand.getRenderable('art-box')! as unknown as BoxRenderable;
  const metaBox = realBrand.getRenderable('meta-box')! as unknown as BoxRenderable;
  const realStatus = realLeft.getRenderable('status')! as unknown as BoxRenderable;
  const realCont = realLeft.getRenderable('cont')! as unknown as BoxRenderable;
  const realHost = realCenter.getRenderable('host')! as unknown as BoxRenderable;
  const realNet = realCenter.getRenderable('net')! as unknown as BoxRenderable;
  const realDiskIo = realCenter.getRenderable('diskio')! as unknown as BoxRenderable;
  const realSys = realCenter.getRenderable('sys')! as unknown as BoxRenderable;
  const realLogs = realMainRow.getRenderable('right')?.getRenderable('logs')! as ScrollBoxRenderable;
  const realHint = realOuter.getRenderable('hint-box')! as unknown as BoxRenderable;
  let currentArt: string[] | null = ART;
  let shortMode = false;
  let hostDetail = false;
  let focus: 'left' | 'center' | 'logs' = 'left';
  let lastDaemon: DaemonInfo | null = null;
  let lastHost: HostStats | null = null;
  let pulseUntil = 0;
  const cpuHistory: number[] = [];
  const memHistory: number[] = [];
  const netRxHistory: number[] = [];
  const netTxHistory: number[] = [];
  const diskRxHistory: number[] = [];
  const diskTxHistory: number[] = [];

  function applyLayout() {
    const wide = renderer.width >= WIDE_MIN_WIDTH;
    const short = renderer.height <= SHORT_MAX_HEIGHT;
    shortMode = short;
    realMainRow.flexDirection = wide ? 'row' : 'column';
    realLeft.width = wide ? 52 : '100%';
    realLeft.height = wide ? '100%' : 'auto';
    realCenter.width = wide ? 36 : '100%';
    realCenter.height = wide ? '100%' : 'auto';
    realHost.height = short ? 7 : 12;
    realNet.height = short ? 5 : 8;
    realDiskIo.height = short ? 4 : 5;
    realSys.height = short ? 3 : 4;
    realStatus.height = short ? 5 : 6;
    realBrand.gap = wide && !short ? 1 : 0;
    realBrand.paddingY = wide && !short ? 1 : 0;
    artBox.height = wide ? 'auto' : 0;
    const artLines = wide ? (short ? null : ART) : null;
    if (currentArt !== artLines) {
      currentArt = artLines;
      clearChildren(artBox);
      if (artLines) {
        artBox.add(new TextRenderable(renderer, { content: artLines.join('\n'), fg: GREEN, width: '100%' }));
      }
    }
    renderHint();
  }

  function renderHint() {
    clearChildren(realHint);
    const hint = new TextRenderable(renderer, { width: '100%' });
    const wide = renderer.width >= WIDE_MIN_WIDTH;
    const parts: [string, string][] = wide
      ? [
          ['[', GREEN],
          ['Tab', TEXT],
          ['] logs', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['1', TEXT],
          ['] left', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['2', TEXT],
          ['] center', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['3', TEXT],
          ['] logs', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['n', TEXT],
          ['] logs', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['↑/↓', TEXT],
          ['] scroll', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['f', TEXT],
          ['] follow', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['c', TEXT],
          ['] clear', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['h', TEXT],
          ['] host detail', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['s', TEXT],
          ['] refresh', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['p', TEXT],
          ['] start', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['m', TEXT],
          ['] stop', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['Ctrl+C', TEXT],
          ['] quit', MUTED],
        ]
      : [
          ['[', GREEN],
          ['Tab', TEXT],
          ['] logs', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['n', TEXT],
          ['] focus', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['↑/↓', TEXT],
          ['] scroll', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['f', TEXT],
          ['] follow', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['c', TEXT],
          ['] clear', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['h', TEXT],
          ['] host', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['s', TEXT],
          ['] refresh', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['p', TEXT],
          ['] start', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['m', TEXT],
          ['] stop', MUTED],
          [' · ', BORDER],
          ['[', GREEN],
          ['Ctrl+C', TEXT],
          ['] quit', MUTED],
        ];
    for (const [text, fg] of parts) {
      hint.add(seg(text, fg));
    }
    realHint.add(hint);
  }

  function setFocus(next: 'left' | 'center' | 'logs') {
    focus = next;
    for (const box of [realBrand, realStatus, realCont]) {
      box.borderColor = focus === 'left' ? BORDER_FOCUS : BORDER;
    }
    for (const box of [realHost, realNet, realDiskIo, realSys]) {
      box.borderColor = focus === 'center' ? BORDER_FOCUS : BORDER;
    }
    realLogs.borderColor = focus === 'logs' ? BORDER_FOCUS : BORDER;
  }

  let currentFile = LOG_FILES[0];
  const offsets: Record<string, number> = {};

  function clearLogs() {
    clearChildren(realLogs);
  }

  function fillFromFile(name: string) {
    clearLogs();
    if (!existsSync(logPath(name))) {
      realLogs.add(
        new TextRenderable(renderer, {
          content: `(no ${name} yet — waiting for daemon logs)`,
          fg: DIM,
          width: '100%',
        }),
      );
      return;
    }
    offsets[name] = 0;
    const { lines, nextOffset } = readTail(name, 0);
    offsets[name] = nextOffset;
    for (const line of lines.slice(-INITIAL_TAIL_LINES)) {
      realLogs.add(new TextRenderable(renderer, { content: line, fg: colorForLine(line), width: '100%' }));
    }
  }

  function appendNewLines() {
    if (!existsSync(logPath(currentFile))) return;
    const { lines, nextOffset } = readTail(currentFile, offsets[currentFile] ?? 0);
    offsets[currentFile] = nextOffset;
    for (const line of lines) {
      realLogs.add(new TextRenderable(renderer, { content: line, fg: colorForLine(line), width: '100%' }));
    }
  }

  function switchFile() {
    const idx = LOG_FILES.indexOf(currentFile);
    currentFile = LOG_FILES[(idx + 1) % LOG_FILES.length] ?? currentFile;
    fillFromFile(currentFile);
    updateLogsTitle();
  }

  function updateLogsTitle() {
    realLogs.title = `Logs — ${currentFile}${realLogs.stickyScroll ? '' : ' (paused)'}`;
    realLogs.titleColor = realLogs.stickyScroll ? SECONDARY : AMBER;
  }

  function dot(online: boolean): string {
    if (!online) return '○';
    if (Date.now() < pulseUntil && Math.floor(Date.now() / 1000) % 2 === 0) return '○';
    return '●';
  }

  function renderBrandMeta(d: DaemonInfo | null) {
    renderInto(metaBox, renderer, brandMetaLines(d));
  }

  function renderStatus(d: DaemonInfo) {
    const lines: { text: string; fg: string }[] = [];
    const mode = d.mode === 'managed' ? 'managed' : d.mode === 'external' ? 'external' : 'no daemon';
    lines.push({
      text: `${dot(d.online)} Daemon  ${d.online ? 'online' : 'offline'} · ${mode}`,
      fg: d.online ? GREEN : RED,
    });
    lines.push({ text: d.pid ? `PID ${d.pid} · up ${fmtDur(d.uptimeSec ?? 0)}` : 'not running', fg: SECONDARY });
    if (!shortMode) lines.push({ text: `Port ${d.port} · Kernel ${d.kernel}`, fg: SECONDARY });
    lines.push({ text: `Remote ${d.remote} · Errors 24h ${d.errors24h}`, fg: SECONDARY });
    renderInto(realStatus, renderer, lines);
  }

  function renderHost(h: HostStats) {
    const lines: { text: string; fg: string }[] = [];
    const cpuBar = `${bar(h.cpuPct, 10)} ${String(Math.round(h.cpuPct)).padStart(3)}%`;
    lines.push({ text: `CPU  ${cpuBar}`, fg: severity(h.cpuPct) });
    if (hostDetail && !shortMode && cpuHistory.length > 0) {
      lines.push({ text: `     ${sparkline(cpuHistory, 14)}`, fg: SPARK_GREEN });
    }
    const memPct = h.memTotalGb > 0 ? (h.memUsedGb / h.memTotalGb) * 100 : 0;
    lines.push({
      text: `RAM  ${bar(memPct, 10)} ${String(Math.round(memPct)).padStart(3)}% ${h.memUsedGb.toFixed(1)}/${h.memTotalGb.toFixed(1)} GB`,
      fg: severity(memPct),
    });
    if (hostDetail && !shortMode && memHistory.length > 0) {
      lines.push({ text: `     ${sparkline(memHistory, 14)}`, fg: SPARK_GREEN });
    }
    if (!shortMode && h.swapTotalGb > 0.1) {
      const swapPct = (h.swapUsedGb / h.swapTotalGb) * 100;
      lines.push({
        text: `Swap ${bar(swapPct, 10)} ${String(Math.round(swapPct)).padStart(3)}% ${h.swapUsedGb.toFixed(1)}/${h.swapTotalGb.toFixed(1)} GB`,
        fg: severity(swapPct),
      });
    }
    lines.push({ text: '─'.repeat(16), fg: BORDER });
    if (hostDetail && !shortMode) {
      const cores = h.perCorePct.slice(0, 8);
      for (let i = 0; i < cores.length; i += 4) {
        const row = cores
          .slice(i, i + 4)
          .map((p, j) => `c${i + j} ${String(Math.round(p)).padStart(2)}%`)
          .join(' ');
        lines.push({ text: row, fg: SECONDARY });
      }
      if (cores.length === 0) lines.push({ text: 'no per-core data', fg: SECONDARY });
    } else {
      lines.push({
        text: `Cores ${h.perCorePct.length} · Load ${h.load1.toFixed(2)} ${h.load5.toFixed(2)} ${h.load15.toFixed(2)}`,
        fg: SECONDARY,
      });
      lines.push({ text: `Up ${fmtDur(h.sysUptimeSec)} · Procs ${h.procs}`, fg: SECONDARY });
    }
    if (!shortMode) {
      lines.push({ text: '─'.repeat(16), fg: BORDER });
      for (const d of h.disks.slice(0, 2)) {
        lines.push({
          text: `${(d.mount.length > 7 ? `${d.mount.slice(0, 6)}…` : d.mount).padEnd(7)} ${bar(d.pct, 8)} ${String(Math.round(d.pct)).padStart(3)}% ${d.usedGb.toFixed(1)}/${d.totalGb.toFixed(1)} GB`,
          fg: severity(d.pct),
        });
      }
    }
    renderInto(realHost, renderer, lines);
  }

  function renderNet(h: HostStats, docker: DockerStats) {
    clearChildren(realNet);
    const add = (text: string, fg: string) =>
      realNet.add(new TextRenderable(renderer, { content: text, fg, width: '100%' }));
    const ifaces = h.nets.slice(0, 2);
    if (ifaces.length === 0) {
      add('no network traffic', DIM);
    }
    for (const n of ifaces) {
      add(`${n.iface.slice(0, 8).padEnd(8)} ↓ ${fmtBytes(n.rxBps)}/s  ↑ ${fmtBytes(n.txBps)}/s`, SECONDARY);
      const sparkRow = new TextRenderable(renderer, { width: '100%' });
      const label = seg('       ↓ ', SECONDARY);
      const rx = seg(sparkline(netRxHistory, 10), BLUE);
      const sep = seg('  ↑ ', SECONDARY);
      const tx = seg(sparkline(netTxHistory, 10), GREEN);
      sparkRow.add(label);
      sparkRow.add(rx);
      sparkRow.add(sep);
      sparkRow.add(tx);
      realNet.add(sparkRow);
    }
    if (!shortMode) {
      if (docker.online) {
        add(`docker nets ${docker.networks} · vols ${docker.volumes} · images ${docker.images}`, SECONDARY);
        add(`docker disk ${docker.dockerDiskGb.toFixed(1)} GB`, SECONDARY);
      } else {
        add(`docker ${docker.error ?? 'unreachable'}`, RED);
      }
    }
  }

  function renderDiskIo(h: HostStats) {
    clearChildren(realDiskIo);
    const add = (text: string, fg: string) =>
      realDiskIo.add(new TextRenderable(renderer, { content: text, fg, width: '100%' }));
    if (h.diskIo.length === 0) {
      add('no block devices', DIM);
    } else {
      const d = h.diskIo[0]!;
      add(`${d.dev.padEnd(7)} R ${fmtBytes(d.rxBps)}/s  W ${fmtBytes(d.txBps)}/s`, SECONDARY);
      const sparkRow = new TextRenderable(renderer, { width: '100%' });
      const label = seg('        R ', SECONDARY);
      const rx = seg(sparkline(diskRxHistory, 9), BLUE);
      const sep = seg('  W ', SECONDARY);
      const tx = seg(sparkline(diskTxHistory, 9), GREEN);
      sparkRow.add(label);
      sparkRow.add(rx);
      sparkRow.add(sep);
      sparkRow.add(tx);
      realDiskIo.add(sparkRow);
    }
    if (h.temps.length > 0 && !shortMode) {
      const hot = h.temps.some((t) => t > 70);
      add(`Temp ${h.temps.map((t) => `${Math.round(t)}°C`).join(' · ')}`, hot ? RED : SECONDARY);
    }
  }

  function renderSys(h: HostStats) {
    const lines: { text: string; fg: string }[] = [];
    lines.push({
      text: `Load ${h.load1.toFixed(2)} ${h.load5.toFixed(2)} ${h.load15.toFixed(2)} · ${h.procs} procs`,
      fg: SECONDARY,
    });
    if (!shortMode) {
      const top = h.topProcs
        .slice(0, 2)
        .map((p) => `${p.name.length > 10 ? `${p.name.slice(0, 9)}…` : p.name} ${Math.round(p.cpuPct)}%`)
        .join(' · ');
      if (top) lines.push({ text: top, fg: SECONDARY });
    }
    renderInto(realSys, renderer, lines);
  }

  const refreshStats = async () => {
    const now = Date.now();
    const ctx: DaemonCtx = {
      port: DAEMON_PORT,
      managedPid: daemonChild?.pid ?? null,
      managedSince: daemonStartedAt,
      daemonDir: DAEMON_DIR,
      runtime: RUNTIME,
      remote: REMOTE,
      version: REPO_VERSION,
      logsDir: LOG_DIR,
    };
    try {
      const [hostStats, docker, daemon] = await Promise.all([collectHost(now), collectDocker(), collectDaemon(ctx)]);
      extPid = daemon.pid ?? extPid;
      if (daemon.mode === 'external' && daemon.pid) {
        const dir = resolveExternalDir(daemon.pid);
        if (dir) {
          if (existsSync(`${dir}/logs`)) LOG_DIR = process.env.AIRLINK_LOG_DIR ?? `${dir}/logs`;
          ctx.daemonDir = dir;
          ctx.logsDir = LOG_DIR;
          ctx.version = readVersion(dir) || env.version || VERSION;
          daemon.version = ctx.version;
        }
      }
      if (lastDaemon) {
        const changed =
          daemon.online !== lastDaemon.online || daemon.mode !== lastDaemon.mode || daemon.pid !== lastDaemon.pid;
        if (changed) pulseUntil = Date.now() + 3000;
      }
      lastDaemon = daemon;
      lastHost = hostStats;
      pushCapped(cpuHistory, hostStats.cpuPct);
      if (hostStats.memTotalGb > 0) pushCapped(memHistory, (hostStats.memUsedGb / hostStats.memTotalGb) * 100);
      if (hostStats.nets.length > 0) {
        const topNet = hostStats.nets[0]!;
        pushCapped(netRxHistory, topNet.rxBps);
        pushCapped(netTxHistory, topNet.txBps);
      }
      if (hostStats.diskIo.length > 0) {
        const topDisk = hostStats.diskIo[0]!;
        pushCapped(diskRxHistory, topDisk.rxBps);
        pushCapped(diskTxHistory, topDisk.txBps);
      }
      renderBrandMeta(daemon);
      renderStatus(daemon);
      renderCont(docker);
      renderHost(hostStats);
      renderNet(hostStats, docker);
      renderDiskIo(hostStats);
      renderSys(hostStats);
    } catch {
      /* keep previous stats if a collection fails */
    }
  };

  function renderCont(docker: DockerStats) {
    const lines: { text: string; fg: string }[] = [];
    if (!docker.online) {
      renderInto(realCont, renderer, [{ text: `docker ${docker.error ?? 'unreachable'}`, fg: RED }]);
      return;
    }
    const running = docker.containers.filter((c) => c.state === 'running');
    const sumCpu = running.reduce((a, c) => a + c.cpuPct, 0);
    const sumMemMb = running.reduce((a, c) => a + c.memUsedMb, 0);
    const sumLimitMb = running.reduce((a, c) => a + c.memLimitMb, 0);
    const memText = sumLimitMb > 0 ? `${sumMemMb.toFixed(1)}/${sumLimitMb.toFixed(1)} GB` : `${sumMemMb.toFixed(1)} GB`;
    if (docker.containers.length === 0) {
      lines.push({ text: 'no containers on this host', fg: DIM });
      lines.push({
        text: `docker online · images ${docker.images} · nets ${docker.networks} · vols ${docker.volumes}`,
        fg: SECONDARY,
      });
      renderInto(realCont, renderer, lines);
      return;
    }
    lines.push({
      text: `● ${running.length} active / ${docker.containers.length} total`,
      fg: running.length > 0 ? GREEN : DIM,
    });
    lines.push({ text: `Σ CPU ${sumCpu.toFixed(1)}% · Σ MEM ${memText}`, fg: SECONDARY });
    const maxRows = shortMode ? 3 : 6;
    for (const c of docker.containers.slice(0, maxRows)) {
      const name = c.name.length > 12 ? `${c.name.slice(0, 11)}…` : c.name;
      if (c.state === 'running') {
        const ramText =
          c.memLimitMb > 0 ? `${c.memUsedMb.toFixed(1)}/${c.memLimitMb.toFixed(1)} GB` : `${c.memUsedMb.toFixed(1)} GB`;
        lines.push({
          text: `● ${name.padEnd(12)} CPU ${bar(c.cpuPct, 8)} ${String(Math.round(c.cpuPct)).padStart(3)}%  RAM ${ramText}`,
          fg: severity(c.cpuPct),
        });
      } else {
        lines.push({ text: `○ ${name.padEnd(12)} ${c.state}`, fg: DIM });
      }
    }
    if (docker.containers.length > maxRows) {
      lines.push({ text: `+ ${docker.containers.length - maxRows} more`, fg: DIM });
    }
    renderInto(realCont, renderer, lines);
  }

  void refreshStats();
  const statsTimer = setInterval(() => void refreshStats(), STATS_INTERVAL_MS);

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    switch (key.name) {
      case 'tab':
        switchFile();
        break;
      case '1':
        setFocus('left');
        break;
      case '2':
        setFocus('center');
        break;
      case '3':
        setFocus('logs');
        break;
      case 'n':
        setFocus('logs');
        break;
      case 'up':
        realLogs.stickyScroll = false;
        updateLogsTitle();
        realLogs.scrollBy(-3);
        break;
      case 'down':
        realLogs.stickyScroll = false;
        updateLogsTitle();
        realLogs.scrollBy(3);
        break;
      case 'f':
        realLogs.stickyScroll = !realLogs.stickyScroll;
        updateLogsTitle();
        break;
      case 'c':
        clearLogs();
        break;
      case 's':
        void refreshStats();
        break;
      case 'h':
        hostDetail = !hostDetail;
        if (lastHost) renderHost(lastHost);
        break;
      case 'p':
      case 'r':
        void probeDaemon().then((p) => {
          if (!p.online) startDaemon();
        });
        break;
      case 'm':
      case 'k':
        stopDaemon();
        break;
    }
  });

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(LOG_DIR, { persistent: false }, (_evt, filename) => {
      if (filename && String(filename) === currentFile) appendNewLines();
    });
  } catch {
    /* log dir may not exist yet */
  }

  renderer.on('resize', () => applyLayout());
  process.on('SIGTERM', () => renderer.destroy());
  process.on('SIGHUP', () => renderer.destroy());
  process.on('SIGINT', () => renderer.destroy());
  renderer.on('destroy', () => {
    clearInterval(statsTimer);
    watcher?.close();
    shuttingDown = true;
    shutdownDaemon();
    setTimeout(() => process.exit(0), 2000);
  });

  const probe = await probeDaemon();
  if (probe.online) {
    extPid = null;
    const info = await collectDaemon({
      port: DAEMON_PORT,
      managedPid: null,
      managedSince: null,
      daemonDir: DAEMON_DIR,
      runtime: RUNTIME,
      remote: REMOTE,
      version: REPO_VERSION,
      logsDir: LOG_DIR,
    });
    if (info.pid) {
      extPid = info.pid;
      const dir = resolveExternalDir(info.pid);
      if (dir && existsSync(`${dir}/logs`)) LOG_DIR = process.env.AIRLINK_LOG_DIR ?? `${dir}/logs`;
    }
  } else if (KEY.length >= 16) {
    startDaemon();
  } else {
    configError = 'no daemon key — create daemon/.env with key= (16+ chars)';
  }
  applyLayout();
  setFocus('left');
  updateLogsTitle();
  renderBrandMeta(null);
  if (configError) {
    clearChildren(realHint);
    realHint.add(new TextRenderable(renderer, { content: configError, fg: RED, width: '100%' }));
    realHint.add(
      new TextRenderable(renderer, {
        content: '[Tab] logs · [p] start · [m] stop · [Ctrl+C] quit',
        fg: MUTED,
        width: '100%',
      }),
    );
  }
  fillFromFile(currentFile);
  void refreshStats();
}
