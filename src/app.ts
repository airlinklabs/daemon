import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectDaemon, collectHost, type DaemonCtx } from './tui/stats';
import { parseEnvFile } from './utils/parseEnv';

function printHelp(): void {
  const bin = process.argv[1]?.split('/').pop() || 'airlinkd';
  console.log(`Airlink daemon

Usage:
  ${bin}                  Run the supervised TUI (starts the daemon, shows logs)
  ${bin} start            Run the daemon headless. This is the default command.
  ${bin} status           Print daemon status as JSON and exit.
  ${bin} version          Print the daemon version and exit.
  ${bin} configure --panel <url> --key <key>
  ${bin} --help

Commands:
  start       Run the daemon. This is the default when a command is given.
  status      Print status as JSON (online, pid, mode, port, uptime, errors).
  version     Print the installed version.
  configure   Write .env values for the panel host and daemon key.

Options:
  -h, --help  Show this help.
  --no-tui    Run headless even when no command is given (or NO_TUI=1).
  --json-logs Emit structured JSON log lines to stdout.

Examples:
  ${bin}
  ${bin} start
  ${bin} status
  ${bin} start --json-logs
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

function readVersion(dir: string): string {
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
  const args = cliArgs.filter((a) => a !== '--json-logs' && a !== '--no-tui');
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

  if (first && first !== 'start') {
    console.error(`Unknown command: ${first}`);
    console.log('Run with --help to see the available commands.');
    process.exit(1);
  }

  await import('./protobufLong');
  await import('./bootstrap');
  await import('./server');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const noTui = args.includes('--no-tui') || process.env.NO_TUI === '1';
  if (args.length === 0 && !noTui) {
    const { runTui } = await import('./tui');
    await runTui();
  } else {
    await runDaemon(args);
  }
}
