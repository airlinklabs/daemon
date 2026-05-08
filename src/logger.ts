import { appendFileSync, mkdirSync } from 'node:fs';

mkdirSync('logs', { recursive: true });

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const YEL = `${ESC}[33m`;
const GRN = `${ESC}[32m`;
const BLU = `${ESC}[34m`;
const MAG = `${ESC}[35m`;
const GRAY = `${ESC}[90m`;

type Level = 'info' | 'warn' | 'error' | 'debug' | 'ok';

const levelColor: Record<Level, string> = {
  info: BLU,
  warn: YEL,
  error: RED,
  debug: MAG,
  ok: GRN,
};

const levelLabel: Record<Level, string> = {
  info: 'info ',
  warn: 'warn ',
  error: 'err  ',
  debug: 'dbg  ',
  ok: 'ok   ',
};

function ts(): string {
  return new Date().toTimeString().split(' ')[0];
}

function write(level: Level, msg: string, extra?: unknown) {
  const color = levelColor[level];
  const label = levelLabel[level];
  const extraStr =
    extra instanceof Error
      ? ` ${extra.message}\n  ${extra.stack?.split('\n').slice(1, 4).join('\n  ') ?? ''}`
      : extra !== undefined
        ? ` ${JSON.stringify(extra)}`
        : '';

  const line = `${GRAY}${ts()}${RESET} ${color}${BOLD}${label}${RESET} ${color}${msg}${extraStr}${RESET}`;
  process.stdout.write(`${line}\n`);

  const fileMsg = `[${ts()}] ${label}: ${msg}${extraStr}\n`;
  try {
    appendFileSync(`logs/${level === 'error' ? 'error' : 'combined'}.log`, fileMsg);
  } catch {
    /* don't crash the daemon if log write fails */
  }
}

export function drawHeader(version: string, port: number) {
  const art = [
    '  A I R L I N K D',
    '  =============',
    '  panel daemon',
  ];
  for (const line of art) {
    process.stdout.write(`${BOLD}${BLU}${line}${RESET}\n`);
  }
  process.stdout.write(`${DIM}  daemon v${version}  -  port ${port}  -  streaming logs below${RESET}\n`);
  process.stdout.write('\n');
}

const logger = {
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
  debug: (msg: string, extra?: unknown) => {
    if (Bun.env.DEBUG === 'true') write('debug', msg, extra);
  },
  ok: (msg: string, extra?: unknown) => write('ok', msg, extra),
};

export default logger;
