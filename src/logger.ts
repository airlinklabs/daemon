import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const RED = `${ESC}[31m`;
const YEL = `${ESC}[33m`;
const GRN = `${ESC}[32m`;
const BLU = `${ESC}[34m`;
const MAG = `${ESC}[35m`;
const GRAY = `${ESC}[90m`;
const BG_RED = `${ESC}[41m`;
const BG_YEL = `${ESC}[43m`;
const BG_BLU = `${ESC}[44m`;
const BG_GRN = `${ESC}[42m`;
const BG_MAG = `${ESC}[45m`;

type Level = 'info' | 'warn' | 'error' | 'debug' | 'ok';

const levels: Record<Level, { color: string; bg: string; icon: string; label: string }> = {
  info: { color: BLU, bg: BG_BLU, icon: 'i', label: 'INFO ' },
  warn: { color: YEL, bg: BG_YEL, icon: '!', label: 'WARN ' },
  error: { color: RED, bg: BG_RED, icon: 'x', label: 'ERROR' },
  debug: { color: MAG, bg: BG_MAG, icon: '*', label: 'DEBUG' },
  ok: { color: GRN, bg: BG_GRN, icon: '+', label: 'OK   ' },
};

// ── Bounded file output ──────────────────────────────────────────────────────
function positiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Log directory resolved from the centralised paths. config.paths is set by
// bootstrap.ts before this module is imported (server.ts imports logger after
// bootstrap completes).
const LOG_DIR = join(process.cwd(), 'logs');
// Rotate a level file once it would exceed this many bytes; at most one .1
// backup is kept per level, so on-disk output stays under ~2x the cap.
const LOG_FILE_MAX_BYTES = positiveIntEnv('AIRLINK_LOG_FILE_MAX_BYTES', 1024 * 1024);

mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded(filePath: string, incomingBytes: number): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0; // first write — nothing to rotate yet
  }
  if (size + incomingBytes <= LOG_FILE_MAX_BYTES) return;
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // rotation is best-effort; never crash the daemon over log housekeeping
  }
}

// ── Secret redaction ─────────────────────────────────────────────────────────
const REDACTED = '[REDACTED]';

// Key names that mark a value as sensitive; matched case-insensitively against
// JSON/config key tokens. The \b guards stop monster words (e.g. "keyboard",
// "monkey") from being treated as secrets.
const SECRET_KEY_PATTERN =
  /\b(?:key|token|secret|passwd|password|passphrase|authorization|signature|nonce|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|hmac|hmac[_-]?secret|daemon[_-]?key)\b/i;

// Scrub secrets out of an arbitrary log line. This is applied to every output
// destination (stdout, JSON logs, files) so a config.key, HMAC secret, token,
// password, or Authorization header can never reach a log.
function redactSecrets(input: string): string {
  let out = input;
  // Header style first: "Authorization: Basic <b64>". The bare-value matcher
  // below would only scrub the scheme word and leak the credential.
  out = out.replace(/(authorization|proxy-authorization):\s*(?:basic|bearer)\s+[^\s,;]+/gi, `$1: ${REDACTED}`);
  // JSON/config style: "password":"hunter2", token = abc, apiKey: xyz.
  out = out.replace(
    /(["'])?([A-Za-z0-9_.-]+)(["'])?\s*([:=])\s*(?:"([^"]*)"|'([^']*)'|([^\s,;}&]+))/gi,
    (full: string, open: string, key: string, close: string, sep: string) => {
      if (!SECRET_KEY_PATTERN.test(key)) return full;
      return `${open}${key}${close}${sep}${REDACTED}`;
    },
  );
  return out;
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function writeToFile(level: Level, fileMsg: string): void {
  const fileName = level === 'error' ? 'error' : 'combined';
  const filePath = join(LOG_DIR, `${fileName}.log`);
  try {
    rotateIfNeeded(filePath, Buffer.byteLength(fileMsg));
    appendFileSync(filePath, fileMsg);
  } catch {
    /* don't crash the daemon if log write fails */
  }
}

function write(level: Level, msg: string, extra?: unknown) {
  const { color, bg, icon, label } = levels[level];
  const extraStr =
    extra instanceof Error
      ? ` ${extra.message}\n  ${extra.stack?.split('\n').slice(1, 4).join('\n  ') ?? ''}`
      : extra !== undefined
        ? ` ${JSON.stringify(extra)}`
        : '';

  if (Bun.env.AIRLINK_JSON_LOGS === '1') {
    const json: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
    };
    if (extra instanceof Error) json.error = { message: extra.message, stack: extra.stack };
    else if (extra !== undefined) json.extra = extra;
    // Redact the serialized payload so nested secret fields are scrubbed too.
    process.stdout.write(`${redactSecrets(JSON.stringify(json))}\n`);
    return;
  }

  const line = `${GRAY}${ts()}${RESET} ${color}${icon} ${bg}${BOLD}${label}${RESET} ${color}${msg}${extraStr}${RESET}`;
  process.stdout.write(`${redactSecrets(line)}\n`);

  writeToFile(level, redactSecrets(`[${ts()}] ${label.trim()}: ${msg}${extraStr}\n`));
}

export function drawHeader(_version: string, _port: number) {
  const lines = [
    '',
    '                                              ',
    '  /$$$$$$ /$$         /$$/$$         /$$      ',
    ' /$$__  $|__/        | $|__/        | $$      ',
    '| $$   $$/$$ /$$$$$$| $$/$$/$$$$$$$| $$   /$$',
    '| $$$$$$$| $$/$$__  $| $| $| $$__  $| $$  /$$/',
    '| $$__  $| $| $$  __| $| $| $$   $| $$$$$$/ ',
    '| $$  | $| $| $$     | $| $| $$  | $| $$_  $$ ',
    '| $$  | $| $| $$     | $| $| $$  | $| $$ \\  $$',
    '|__/  |__|__|__/     |__|__|__/  |__|__/  __/',
    '                                              ',
    '-----Airlinkd - By Airlinklabs MIT LICENSE-----',
    '',
  ];
  for (const l of lines) process.stdout.write(`${l}\n`);
}

const logger = {
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
  ok: (msg: string, extra?: unknown) => write('ok', msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (Bun.env.DEBUG === 'true') write('debug', msg, extra);
  },
};

export default logger;
