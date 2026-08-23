import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectDaemon, collectHost, type DaemonCtx } from './stats';
import { parseEnvFile } from './utils/parseEnv';

function printHelp(): void {
  const bin = process.argv[1]?.split('/').pop() || 'airlinkd';
  console.log(`Airlink daemon

Usage:
  ${bin} [command] [options]

Commands:
  start       Run the daemon (default).
  status      Print status as JSON (online, pid, mode, port, uptime, errors).
  version     Print the installed version.
  configure   Write .env values for the panel host and daemon key.
  health      Quick health check (exit 0 = healthy, 1 = unhealthy).
  validate    Validate .env and config without starting.
  logs        Tail daemon logs (combined.log).

Options:
  -h, --help            Show this help.
  -v, --version         Show version.
  --json-logs           Emit structured JSON log lines to stdout.
  --port <port>         Override listening port.
  --no-color            Disable colored output.
  --verbose             Debug-level logging.
  --quiet               Errors only.

Examples:
  ${bin}
  ${bin} start
  ${bin} status
  ${bin} start --json-logs
  ${bin} health
  ${bin} configure --panel http://panel.example.com:3000 --key your-node-key
  ${bin} configure -p http://localhost:3000 -k your-node-key`);
}

function findDaemonDir(): string {
  const self = import.meta.dir;
  const candidates = [resolve(self, '../..'), resolve(self, '..'), self, '/etc/daemon'];
  for (const dir of candidates) {
    try {
      if (
        existsSync(`${dir}/src/app.ts`) ||
        existsSync(`${dir}/airlinkd`) ||
        existsSync(`${dir}/dist/airlinkd`) ||
        existsSync(`${dir}/airlinkd-linux-x64`)
      ) {
        return dir;
      }
    } catch {
      /* unreadable candidate */
    }
  }
  return candidates[0];
}

function loadEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [`${dir}/.env`, '/etc/daemon/.env']) {
    try {
      Object.assign(out, parseEnvFile(readFileSync(path, 'utf8')));
    } catch {
      /* unreadable env file */
    }
  }
  return out;
}

declare const PKG_VERSION: string | undefined;

function readVersion(dir: string): string {
  // Compile-time embedded version (bun build --define)
  if (typeof PKG_VERSION !== 'undefined' && PKG_VERSION) return PKG_VERSION;
  for (const root of [dir, resolve(dir, '..')]) {
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
  return 'unknown';
}

async function cmdStatus(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const version = readVersion(dir);
  const ctx: DaemonCtx = {
    port: Number(env.port || '3002'),
    managedPid: null,
    managedSince: null,
    daemonDir: dir,
    runtime: env.CONTAINER_RUNTIME || 'docker',
    remote: env.remote || 'localhost',
    version,
    logsDir: `${dir}/logs`,
  };
  const [daemon, host] = await Promise.all([collectDaemon(ctx), collectHost(Date.now())]);
  const memPct = host.memTotalGb > 0 ? Number(((host.memUsedGb / host.memTotalGb) * 100).toFixed(1)) : 0;
  const out = {
    name: 'airlinkd',
    version,
    status: daemon.online ? 'online' : 'offline',
    pid: daemon.pid,
    mode: daemon.mode,
    port: daemon.port,
    runtime: daemon.runtime,
    remote: daemon.remote,
    kernel: daemon.kernel,
    uptimeSec: daemon.uptimeSec,
    errors24h: daemon.errors24h,
    host: {
      cpuPct: Number(host.cpuPct.toFixed(1)),
      memUsedGb: Number(host.memUsedGb.toFixed(1)),
      memTotalGb: Number(host.memTotalGb.toFixed(1)),
      memPct,
      load: `${host.load1.toFixed(2)} ${host.load5.toFixed(2)} ${host.load15.toFixed(2)}`,
      procs: host.procs,
      uptimeSec: host.sysUptimeSec,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

async function cmdVersion(): Promise<void> {
  console.log(`airlinkd ${readVersion(findDaemonDir())}`);
}

export async function runDaemon(cliArgs: string[]): Promise<void> {
  if (cliArgs.includes('--json-logs')) process.env.AIRLINK_JSON_LOGS = '1';
  if (cliArgs.includes('--no-color')) process.env.NO_COLOR = '1';
  if (cliArgs.includes('--verbose')) process.env.LOG_LEVEL = 'debug';
  if (cliArgs.includes('--quiet')) process.env.LOG_LEVEL = 'error';

  const portFlag = cliArgs.find((a, i) => a === '--port' && cliArgs[i + 1]);
  if (portFlag) {
    const idx = cliArgs.indexOf(portFlag);
    const portVal = cliArgs[idx + 1];
    if (portVal && /^\d+$/.test(portVal)) process.env.PORT = portVal;
  }

  const args = cliArgs.filter(
    (a) =>
      a !== '--json-logs' &&
      a !== '--no-color' &&
      a !== '--verbose' &&
      a !== '--quiet' &&
      a !== '--port' &&
      !/^\d+$/.test(a),
  );
  const first = args[0];

  if (first === 'help' || args.includes('-help') || args.includes('--help') || args.includes('-h')) {
    if (first === 'configure') {
      const { printConfigureHelp } = await import('./configure');
      printConfigureHelp();
    } else {
      printHelp();
    }
    process.exit(0);
  }

  if (first === 'configure') {
    const { runConfigure } = await import('./configure');
    await runConfigure(args.slice(1));
    process.exit(0);
  }

  if (first === 'status') {
    await cmdStatus();
    process.exit(0);
  }

  if (first === 'version') {
    await cmdVersion();
    process.exit(0);
  }

  if (first === 'health') {
    await cmdHealth();
    process.exit(0);
  }

  if (first === 'validate') {
    await cmdValidate();
    process.exit(0);
  }

  if (first === 'logs') {
    await cmdLogs();
    process.exit(0);
  }

  if (first && first !== 'start') {
    console.error(`Unknown command: ${first}`);
    console.log('Run with --help to see the available commands.');
    process.exit(1);
  }

  await import('./protobufLong');
  await import('./bootstrap');
  await import('./server');
}

async function cmdHealth(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const port = Number(env.port || '3002');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (res.ok) {
      console.log('healthy');
      process.exit(0);
    }
    console.log('unhealthy');
    process.exit(1);
  } catch {
    console.log('unhealthy');
    process.exit(1);
  }
}

async function cmdValidate(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const errors: string[] = [];
  if (!env.DAEMON_KEY) errors.push('DAEMON_KEY is not set');
  if (!env.remote) errors.push('remote (panel URL) is not set');
  const port = Number(env.port || '3002');
  if (port < 1 || port > 65535) errors.push(`port ${port} is out of range`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('configuration OK');
  process.exit(0);
}

async function cmdLogs(): Promise<void> {
  const dir = findDaemonDir();
  const logPath = `${dir}/logs/combined.log`;
  try {
    const file = Bun.file(logPath);
    if (!(await file.exists())) {
      console.error(`log file not found: ${logPath}`);
      process.exit(1);
    }
    const stream = file.stream();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    console.error(`unable to read log file: ${logPath}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await runDaemon(args);
}
