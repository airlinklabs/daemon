import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_HTTP_PORT } from "./config/ports";
import { LOCALHOST, LOOPBACK_IP } from "./config/server";
import { collectDaemon, collectHost, type DaemonCtx } from "./stats";
import { parseEnvFile } from "./utils/parseEnv";

function printHelp(): void {
  const bin = process.argv[1]?.split("/").pop() || "airlinkd";
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
  --config <path>       Override the default .env file path.
  --dry-run             Validate config, print effective config as JSON, then exit.
  --pid-file <path>     Write PID to file on start, remove on exit.
  --log-level <level>   Override log level (debug, info, warn, error).

Examples:
  ${bin}
  ${bin} start
  ${bin} status
  ${bin} start --json-logs
  ${bin} start --config /etc/airlink/production.env
  ${bin} start --pid-file /run/airlinkd.pid --log-level debug
  ${bin} dry-run
  ${bin} health
  ${bin} configure --panel http://panel.example.com:3000 --key your-node-key
  ${bin} configure -p http://localhost:3000 -k your-node-key`);
}

function findDaemonDir(): string {
  const self = import.meta.dir;
  const candidates = [
    resolve(self, "../.."),
    resolve(self, ".."),
    self,
    "/etc/daemon",
  ];
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
  return candidates[0]!;
}

function loadEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = {};

  // --config <path> takes precedence
  const override = process.env.AIRLINK_ENV_PATH;
  if (override) {
    try {
      Object.assign(out, parseEnvFile(readFileSync(override, "utf8")));
    } catch {
      /* unreadable override file */
    }
    return out;
  }

  for (const path of [`${dir}/.env`, "/etc/daemon/.env"]) {
    try {
      Object.assign(out, parseEnvFile(readFileSync(path, "utf8")));
    } catch {
      /* unreadable env file */
    }
  }
  return out;
}

declare const PKG_VERSION: string | undefined;
declare const GIT_COMMIT: string | undefined;
declare const BUILD_DATE: string | undefined;

function readVersion(dir: string): string {
  // Compile-time embedded version (bun build --define)
  if (typeof PKG_VERSION !== "undefined" && PKG_VERSION) return PKG_VERSION;
  for (const root of [dir, resolve(dir, "..")]) {
    try {
      const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
        version?: string;
      };
      if (pkg?.version) return pkg.version;
    } catch {
      /* no package.json */
    }
  }
  try {
    const cfg = JSON.parse(
      readFileSync(`${dir}/storage/config.json`, "utf8"),
    ) as { meta?: { version?: string } };
    if (cfg?.meta?.version) return cfg.meta.version;
  } catch {
    /* no storage config */
  }
  return "unknown";
}

async function cmdStatus(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const version = readVersion(dir);
  const ctx: DaemonCtx = {
    port: Number(env.port || String(DEFAULT_HTTP_PORT)),
    managedPid: null,
    managedSince: null,
    daemonDir: dir,
    runtime: env.CONTAINER_RUNTIME || "docker",
    remote: env.remote || LOCALHOST,
    version,
    logsDir: `${dir}/logs`,
  };
  const [daemon, host] = await Promise.all([
    collectDaemon(ctx),
    collectHost(Date.now()),
  ]);
  const memPct =
    host.memTotalGb > 0
      ? Number(((host.memUsedGb / host.memTotalGb) * 100).toFixed(1))
      : 0;
  const out = {
    name: "airlinkd",
    version,
    status: daemon.online ? "online" : "offline",
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
  const version = readVersion(findDaemonDir());
  const commit = typeof GIT_COMMIT !== "undefined" ? GIT_COMMIT : "unknown";
  const date = typeof BUILD_DATE !== "undefined" ? BUILD_DATE : "unknown";
  console.log(`airlinkd ${version} (${commit}, ${date})`);
}

function findFlagValue(cliArgs: string[], flag: string): string | undefined {
  const idx = cliArgs.indexOf(flag);
  if (idx === -1) return undefined;
  return cliArgs[idx + 1];
}

let pidFilePath: string | undefined;

function writePidFile(): void {
  if (!pidFilePath) return;
  try {
    writeFileSync(pidFilePath, String(process.pid), "utf8");
  } catch (err) {
    console.error(`failed to write PID file ${pidFilePath}:`, err);
  }
}

function removePidFile(): void {
  if (!pidFilePath) return;
  try {
    unlinkSync(pidFilePath);
  } catch {
    /* already gone or never created */
  }
}

function printDryRunConfig(): void {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^\d+$/.test(v)) out[k] = Number(v);
    else if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else out[k] = v;
  }
  out.port = Number(out.port ?? env.port ?? String(DEFAULT_HTTP_PORT));
  console.log(JSON.stringify(out, null, 2));
}

export async function runDaemon(cliArgs: string[]): Promise<void> {
  // ── Parse new flags BEFORE existing arg logic ──

  // --config <path> : override .env file path
  const configPath = findFlagValue(cliArgs, "--config");
  if (configPath) {
    process.env.AIRLINK_ENV_PATH = configPath;
  }

  // --log-level <level> : override log level (takes precedence over --verbose/--quiet)
  const logLevel = findFlagValue(cliArgs, "--log-level");
  if (logLevel && ["debug", "info", "warn", "error"].includes(logLevel)) {
    process.env.LOG_LEVEL = logLevel;
  }

  // --pid-file <path>
  const pidPath = findFlagValue(cliArgs, "--pid-file");
  if (pidPath) pidFilePath = pidPath;

  // --dry-run : validate config, print, exit
  if (cliArgs.includes("--dry-run")) {
    printDryRunConfig();
    process.exit(0);
  }

  // -v / --version : print version and exit
  if (cliArgs.includes("-v") || cliArgs.includes("--version")) {
    await cmdVersion();
    process.exit(0);
  }

  // ── Existing arg parsing ──

  if (cliArgs.includes("--json-logs")) process.env.AIRLINK_JSON_LOGS = "1";
  if (cliArgs.includes("--no-color")) process.env.NO_COLOR = "1";
  if (!logLevel && cliArgs.includes("--verbose"))
    process.env.LOG_LEVEL = "debug";
  if (!logLevel && cliArgs.includes("--quiet")) process.env.LOG_LEVEL = "error";

  const portFlag = cliArgs.find((a, i) => a === "--port" && cliArgs[i + 1]);
  if (portFlag) {
    const idx = cliArgs.indexOf(portFlag);
    const portVal = cliArgs[idx + 1];
    if (portVal && /^\d+$/.test(portVal)) process.env.PORT = portVal;
  }

  const args = cliArgs.filter(
    (a) =>
      a !== "--json-logs" &&
      a !== "--no-color" &&
      a !== "--verbose" &&
      a !== "--quiet" &&
      a !== "--port" &&
      a !== "--config" &&
      a !== "--dry-run" &&
      a !== "--pid-file" &&
      a !== "--log-level" &&
      !/^\d+$/.test(a),
  );
  const first = args[0];

  if (
    first === "help" ||
    args.includes("-help") ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    if (first === "configure") {
      const { printConfigureHelp } = await import("./configure");
      printConfigureHelp();
    } else {
      printHelp();
    }
    process.exit(0);
  }

  if (first === "configure") {
    const { runConfigure } = await import("./configure");
    await runConfigure(args.slice(1));
    process.exit(0);
  }

  if (first === "status") {
    await cmdStatus();
    process.exit(0);
  }

  if (first === "version") {
    await cmdVersion();
    process.exit(0);
  }

  if (first === "health") {
    await cmdHealth();
    process.exit(0);
  }

  if (first === "validate") {
    await cmdValidate();
    process.exit(0);
  }

  if (first === "logs") {
    await cmdLogs();
    process.exit(0);
  }

  if (first && first !== "start") {
    console.error(`Unknown command: ${first}`);
    console.log("Run with --help to see the available commands.");
    process.exit(1);
  }

  await import("./protobufLong");
  await import("./bootstrap");
  writePidFile();
  await import("./server");
}

export { removePidFile };

async function cmdHealth(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const port = Number(env.port || String(DEFAULT_HTTP_PORT));
  try {
    const res = await fetch(`http://${LOOPBACK_IP}:${port}/healthz`);
    if (res.ok) {
      console.log("healthy");
      process.exit(0);
    }
    console.log("unhealthy");
    process.exit(1);
  } catch {
    console.log("unhealthy");
    process.exit(1);
  }
}

async function cmdValidate(): Promise<void> {
  const dir = findDaemonDir();
  const env = loadEnv(dir);
  const errors: string[] = [];
  if (!env.DAEMON_KEY) errors.push("DAEMON_KEY is not set");
  if (!env.remote) errors.push("remote (panel URL) is not set");
  const port = Number(env.port || String(DEFAULT_HTTP_PORT));
  if (port < 1 || port > 65535) errors.push(`port ${port} is out of range`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("configuration OK");
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
  runDaemon(args).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
