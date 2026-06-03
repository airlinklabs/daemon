import { appendFileSync, mkdirSync } from 'node:fs';

mkdirSync('logs', { recursive: true });

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

function ts(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function write(level: Level, msg: string, extra?: unknown) {
  const { color, bg, icon, label } = levels[level];
  const extraStr =
    extra instanceof Error
      ? ` ${extra.message}\n  ${extra.stack?.split('\n').slice(1, 4).join('\n  ') ?? ''}`
      : extra !== undefined
        ? ` ${JSON.stringify(extra)}`
        : '';

  const line = `${GRAY}${ts()}${RESET} ${color}${icon} ${bg}${BOLD}${label}${RESET} ${color}${msg}${extraStr}${RESET}`;
  process.stdout.write(`${line}\n`);

  const fileMsg = `[${ts()}] ${label.trim()}: ${msg}${extraStr}\n`;
  try {
    appendFileSync(`logs/${level === 'error' ? 'error' : 'combined'}.log`, fileMsg);
  } catch {
    /* don't crash the daemon if log write fails */
  }
}

export function drawHeader(version: string, port: number) {
  const lines = [
    '',
    `  ${BOLD}${BLU}╳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╳${RESET}`,
    `  ${BOLD}${BLU}      AirLink - Open Source Project by AirlinkLabs${RESET}`,
    `  ${BOLD}${BLU}      Daemon v${version}  •  Port ${port}${RESET}`,
    `  ${BOLD}${BLU}╳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╳${RESET}`,
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
