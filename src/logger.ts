const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const YEL = `${ESC}[33m`;
const GRN = `${ESC}[32m`;
const BLU = `${ESC}[34m`;
const MAG = `${ESC}[35m`;
const GRAY = `${ESC}[90m`;

type Level = "info" | "warn" | "error" | "debug" | "ok";

const levelColor: Record<Level, string> = {
  info: BLU,
  warn: YEL,
  error: RED,
  debug: MAG,
  ok: GRN,
};

const levelLabel: Record<Level, string> = {
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
  debug: "DEBUG",
  ok: "OK   ",
};

function ts(): string {
  return new Date().toTimeString().split(" ")[0] ?? "00:00:00";
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function drawHeader(version: string, port: number): void {
  process.stdout.write(`${ESC}[H`);
  process.stdout.write(`${BOLD}${BLU}+-- airlinkd ${version} -- port ${port} --+${RESET}\n`);
  process.stdout.write(`${DIM}  run as daemon for airlink panel${RESET}\n`);
  process.stdout.write(`${BOLD}${BLU}+--------------------------------------+${RESET}\n`);
  process.stdout.write("\n");
}

export function updateStatus(uptime: number, containers: number): void {
  process.stdout.write(`${ESC}[5;0H`);
  process.stdout.write(`${ESC}[2K`);
  process.stdout.write(
    `${GRAY}uptime: ${formatUptime(uptime)}  containers: ${containers}${RESET}\n`,
  );
  process.stdout.write(`${ESC}[999;0H`);
}

function write(level: Level, msg: string, extra?: unknown): void {
  const color = levelColor[level];
  const label = levelLabel[level];
  const extraStr =
    extra === undefined
      ? ""
      : ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`;
  const line = `${GRAY}${ts()}${RESET} ${color}${BOLD}${label}${RESET} ${color}${msg}${extraStr}${RESET}`;

  if (process.stdout.isTTY) {
    process.stdout.write(`${ESC}[6;0H`);
    process.stdout.write(`${ESC}[S`);
    process.stdout.write(`${ESC}[999;0H`);
  }

  process.stdout.write(`${line}\n`);
  Bun.write(`logs/${level === "error" ? "error" : "combined"}.log`, `[${ts()}] ${label}: ${msg}${extraStr}\n`, {
    append: true,
  }).catch(() => {});
}

const logger = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (Bun.env.DEBUG === "true") write("debug", msg, extra);
  },
  ok: (msg: string, extra?: unknown) => write("ok", msg, extra),
};

export default logger;
