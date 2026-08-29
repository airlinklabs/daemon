import { existsSync, readFileSync } from "node:fs";
import boxen from "boxen";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const isTTY = process.stdout.isTTY;

// ── Raw ANSI — works everywhere including compiled binaries ──────────────────
const ESC = "\x1b";
const R = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;
const YEL = `${ESC}[33m`;
const GRN = `${ESC}[32m`;
const BLU = `${ESC}[34m`;
const MAG = `${ESC}[35m`;
const WHT = `${ESC}[37m`;
const CYA = `${ESC}[36m`;
const BG_RED = `${ESC}[41m`;
const BG_YEL = `${ESC}[43m`;
const BG_BLU = `${ESC}[44m`;
const BG_GRN = `${ESC}[42m`;
const BG_MAG = `${ESC}[45m`;

type Level = "info" | "warn" | "error" | "debug" | "ok";

// Match panel's pino-pretty format exactly
const levels: Record<Level, { badge: string; msgColor: string }> = {
  info: { badge: `${BG_BLU}${BOLD}${WHT} INFO  ${R}`, msgColor: BLU },
  warn: { badge: `${BG_YEL}${BOLD}${WHT} WARN  ${R}`, msgColor: YEL },
  error: { badge: `${BG_RED}${BOLD}${WHT} ERROR ${R}`, msgColor: RED },
  debug: { badge: `${BG_MAG}${BOLD}${WHT} DEBUG ${R}`, msgColor: MAG },
  ok: { badge: `${BG_GRN}${BOLD}${WHT}  OK   ${R}`, msgColor: GRN },
};

// ── Secret redaction ─────────────────────────────────────────────────────────
const REDACTED = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /\b(?:key|token|secret|passwd|password|passphrase|authorization|signature|nonce|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|hmac|hmac[_-]?secret|daemon[_-]?key)\b/i;

function redactSecrets(input: string): string {
  let out = input;
  out = out.replace(
    /(authorization|proxy-authorization):\s*(?:basic|bearer)\s+[^\s,;]+/gi,
    `$1: ${REDACTED}`,
  );
  out = out.replace(
    /(["'])?([A-Za-z0-9_.-]+)(["'])?\s*([:=])\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}&]+))/gi,
    (full: string, open: string, key: string, close: string, sep: string) => {
      if (!SECRET_KEY_PATTERN.test(key)) return full;
      return `${open}${key}${close}${sep}${REDACTED}`;
    },
  );
  return out;
}

// ── File rotation ────────────────────────────────────────────────────────────
function positiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE_MAX_BYTES = positiveIntEnv(
  "AIRLINK_LOG_FILE_MAX_BYTES",
  1024 * 1024,
);

mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded(filePath: string, incomingBytes: number): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size + incomingBytes <= LOG_FILE_MAX_BYTES) return;
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    /* best-effort */
  }
}

function ts(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function writeToFile(level: Level, fileMsg: string): void {
  const fileName = level === "error" ? "error" : "combined";
  const filePath = join(LOG_DIR, `${fileName}.log`);
  try {
    rotateIfNeeded(filePath, Buffer.byteLength(fileMsg));
    appendFileSync(filePath, fileMsg);
  } catch {
    /* don't crash */
  }
}

// ── Logger ───────────────────────────────────────────────────────────────────
function write(level: Level, msg: string, extra?: unknown) {
  const extraStr =
    extra instanceof Error
      ? ` ${extra.message}\n  ${extra.stack?.split("\n").slice(1, 4).join("\n  ") ?? ""}`
      : extra !== undefined
        ? ` ${JSON.stringify(extra)}`
        : "";

  if (Bun.env.AIRLINK_JSON_LOGS === "1") {
    const json: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (extra instanceof Error)
      json.error = { message: extra.message, stack: extra.stack };
    else if (extra !== undefined) json.extra = extra;
    process.stdout.write(`${redactSecrets(JSON.stringify(json))}\n`);
    writeToFile(
      level,
      redactSecrets(
        `[${ts()}] ${level.toUpperCase().padEnd(5)}: ${msg}${extraStr}\n`,
      ),
    );
    return;
  }

  const { badge, msgColor } = levels[level];

  if (isTTY) {
    const { msgColor } = levels[level];
    const line = `${DIM}[${ts()}]${R} ${msgColor}${level.toUpperCase()}:${R} ${msg}`;
    process.stdout.write(`${redactSecrets(line)}\n`);
  } else {
    process.stdout.write(
      `${redactSecrets(`${ts()} [${level.toUpperCase().padEnd(5)}] ${msg}${extraStr}`)}\n`,
    );
  }

  writeToFile(
    level,
    redactSecrets(
      `[${ts()}] ${level.toUpperCase().padEnd(5)}: ${msg}${extraStr}\n`,
    ),
  );
}

const logger = {
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
  ok: (msg: string, extra?: unknown) => write("ok", msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (Bun.env.DEBUG === "true") write("debug", msg, extra);
  },
};

export default logger;

// ── Read version + codename from storage/config.json (same source as panel) ─
function readMetaFromConfig(): { version: string; codename: string } {
  const candidates = [
    join(process.cwd(), "storage", "config.json"),
    "/etc/daemon/storage/config.json",
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      return {
        version: raw?.meta?.version || "unknown",
        codename: raw?.meta?.codename || "",
      };
    } catch {
      /* try next */
    }
  }
  return { version: "unknown", codename: "" };
}

// ── Startup banner ───────────────────────────────────────────────────────────
// Each line individually wrapped in cyan so boxen renders ALL lines in color.
const ASCII_LINES = [
  "  /$$$$$$ /$$         /$$/$$         /$$",
  " /$$__  $|__/        | $|__/        | $$",
  "| $$   $$/$$ /$$$$$$| $$/$$/$$$$$$$| $$   /$$",
  "| $$$$$$$| $$/$$__  $| $| $| $$__  $| $$  /$$/",
  "| $$__  $| $| $$  __| $| $| $$   $| $$$$$$/",
  "| $$  | $| $| $$     | $| $| $$  | $| $$_  $$",
  "| $$  | $| $| $$     | $| $| $$  | $| $$ \\  $$",
  "|__/  |__|__|__/     |__|__|__/  |__|__/  __/",
];

export function drawHeader(version: string, port: number) {
  if (!isTTY) {
    console.log(`Airlinkd v${version} — port ${port}`);
    return;
  }

  const meta = readMetaFromConfig();
  const displayVersion = meta.version !== "unknown" ? meta.version : version;
  const codename = meta.codename;

  // Each line fully wrapped in cyan+reset so boxen doesn't lose color mid-line
  const colored = ASCII_LINES.map((l) => `${CYA}${l}${R}`).join("\n");

  const lines: string[] = [];
  lines.push(colored);
  lines.push("");
  lines.push(`  ${BOLD}${CYA}Airlinkd${R} ${DIM}v${displayVersion}${R}`);
  if (codename) {
    lines.push(`  ${DIM}${codename}${R}`);
  }
  lines.push(`  ${DIM}Port ${port} · Airlinklabs · MIT License${R}`);

  console.log(
    boxen(lines.join("\n"), {
      padding: 1,
      margin: 1,
      borderStyle: "round",
      borderColor: "cyan",
    }),
  );
}
