// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
import { appendFileSync } from 'node:fs';

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
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  debug: 'DEBUG',
  ok: 'OK   ',
};

function ts(): string {
  return new Date().toTimeString().split(' ')[0];
}

function write(level: Level, msg: string, extra?: unknown) {
  const color = levelColor[level];
  const label = levelLabel[level];
  const extraStr = extra !== undefined ? ` ${extra instanceof Error ? extra.message : JSON.stringify(extra)}` : '';

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
  const inner = `airlinkd ${version} -- port ${port}`;
  const border = `+${'-'.repeat(inner.length + 2)}+`;
  process.stdout.write(`${BOLD}${BLU}${border}${RESET}\n`);
  process.stdout.write(`${BOLD}${BLU}| ${inner} |${RESET}\n`);
  process.stdout.write(`${DIM}  run as daemon for airlink panel${RESET}\n`);
  process.stdout.write(`${BOLD}${BLU}${border}${RESET}\n`);
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
