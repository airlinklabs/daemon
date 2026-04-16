import { cpus, freemem, totalmem } from 'node:os';
import config from './config';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const BLU = `${ESC}[34m`;
const CYN = `${ESC}[36m`;
const GRN = `${ESC}[32m`;
const YEL = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const GRAY = `${ESC}[90m`;
const WHITE = `${ESC}[97m`;

const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

// absolute cursor movement and line erase
const MOVE      = (row: number, col: number) => `${ESC}[${row};${col}H`;
const ERASE_EOL = `${ESC}[K`;

// scroll region: tell the terminal that rows 1..topRow are the scrolling area
const SET_SCROLL_REGION = (top: number, bottom: number) => `${ESC}[${top};${bottom}r`;
const RESET_SCROLL_REGION = `${ESC}[r`;

// how many rows the TUI panel occupies
// top border + title + mid border + 5 body rows + bottom border + hint = 9
const PANEL_ROWS = 9;

let lastCpuTimes: ReturnType<typeof cpus> | null = null;
let tuiActive = false;
let tuiInterval: ReturnType<typeof setInterval> | null = null;
let startTime = Date.now();
const logBuffer: string[] = [];
const MAX_LOGS = 200;

// first row of the fixed panel (1-indexed); rows above this scroll freely
let panelStartRow = 1;

function getCpuPercent(): number {
  const now = cpus();
  if (!lastCpuTimes) {
    lastCpuTimes = now;
    return 0;
  }
  let idle = 0;
  let total = 0;
  for (let i = 0; i < now.length; i++) {
    const nb = now[i].times;
    const ob = lastCpuTimes[i].times;
    idle += nb.idle - ob.idle;
    total +=
      nb.user + nb.nice + nb.sys + nb.idle + nb.irq -
      (ob.user + ob.nice + ob.sys + ob.idle + ob.irq);
  }
  lastCpuTimes = now;
  return total > 0 ? Math.min(100, ((total - idle) / total) * 100) : 0;
}

function bar(pct: number, width = 10, color = GRN): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return color + '█'.repeat(filled) + GRAY + '░'.repeat(empty) + RESET;
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function pad(s: string, len: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
  const visible = s.replace(/\u001b\[[0-9;]*m/g, '');
  const diff = len - visible.length;
  return s + (diff > 0 ? ' '.repeat(diff) : '');
}

function getTermWidth(): number {
  return process.stdout.columns || 120;
}

function getTermRows(): number {
  return process.stdout.rows || 24;
}

function buildPanelLines(): string[] {
  const cpu = getCpuPercent();
  const ramMB = (totalmem() - freemem()) / 1024 / 1024;
  const maxMB = totalmem() / 1024 / 1024;
  const ramPct = (ramMB / maxMB) * 100;
  const upMs = Date.now() - startTime;
  const uptStr = fmtUptime(upMs);
  const termW = getTermWidth();
  const narrow = termW < 100;

  const border = `${GRAY}│${RESET}`;
  const lines: string[] = [];

  if (!narrow) {
    const consoleW = Math.floor(termW * 0.55) - 2;
    const resourceW = termW - consoleW - 5;
    const innerConsoleW = consoleW - 2;
    const innerResourceW = resourceW - 2;

    lines.push(`${GRAY}┌${'─'.repeat(consoleW)}┬${'─'.repeat(resourceW)}┐${RESET}`);

    const titleLeft  = `${BOLD}${BLU} Console${RESET} ${DIM}logs${RESET}`;
    const titleRight = `${BOLD}${BLU} Resources${RESET} ${DIM}v${config.version} · port ${config.port} · up ${uptStr}${RESET}`;
    lines.push(`${border}${pad(' ' + titleLeft, innerConsoleW + 1)} ${border}${pad(' ' + titleRight, innerResourceW)} ${border}`);
    lines.push(`${GRAY}├${'─'.repeat(consoleW)}┼${'─'.repeat(resourceW)}┤${RESET}`);

    const visibleLogs = logBuffer.slice(-5);
    while (visibleLogs.length < 5) visibleLogs.unshift('');

    const cpuLine  = `  ${CYN}CPU${RESET}  ${BOLD}${WHITE}${cpu.toFixed(1).padStart(5)}%${RESET}  ${bar(cpu, 8, cpu > 80 ? RED : cpu > 50 ? YEL : GRN)}`;
    const ramLine  = `  ${CYN}RAM${RESET}  ${BOLD}${WHITE}${Math.round(ramMB)}/${Math.round(maxMB)} MB${RESET}  ${bar(ramPct, 8, ramPct > 85 ? RED : GRN)}`;
    const netLine  = `  ${CYN}Host${RESET} ${WHITE}${config.remote}${RESET}`;
    const keyLine  = `  ${CYN}Auth${RESET} ${GRN}●${RESET} ${GRAY}hmac active${RESET}`;
    const portLine = `  ${CYN}Port${RESET} ${WHITE}${config.port}${RESET}  ${GRN}● online${RESET}`;
    const resourceLines = [cpuLine, ramLine, netLine, keyLine, portLine];

    for (let i = 0; i < 5; i++) {
      const logText = visibleLogs[i]
        ? DIM + visibleLogs[i].slice(0, innerConsoleW - 2) + RESET
        : '';
      const resText = resourceLines[i] || '';
      lines.push(`${border}${pad(' ' + logText, innerConsoleW + 1)} ${border}${pad(resText, innerResourceW)} ${border}`);
    }

    lines.push(`${GRAY}└${'─'.repeat(consoleW)}┴${'─'.repeat(resourceW)}┘${RESET}`);
  } else {
    const W = Math.min(termW - 2, 70);
    const title = `${BOLD}${BLU} AirLink Daemon${RESET} ${DIM}v${config.version} · port ${config.port} · up ${uptStr}${RESET}`;
    lines.push(`${GRAY}┌${'─'.repeat(W)}┐${RESET}`);
    lines.push(`${border}${pad(' ' + title, W - 1)} ${border}`);
    lines.push(`${GRAY}├${'─'.repeat(W)}┤${RESET}`);
    const visibleLogs = logBuffer.slice(-3);
    while (visibleLogs.length < 3) visibleLogs.unshift('');
    for (const log of visibleLogs) {
      const text = log ? DIM + log.slice(0, W - 3) + RESET : '';
      lines.push(`${border}${pad(' ' + text, W - 1)} ${border}`);
    }
    lines.push(`${GRAY}└${'─'.repeat(W)}┘${RESET}`);
  }

  lines.push(`  ${DIM}[Q] quit   [Ctrl-C] stop daemon${RESET}`);
  return lines;
}

// redraw the panel in its fixed position at the bottom of the screen.
// uses absolute cursor addressing so it never drifts regardless of scroll activity.
function renderTui(): void {
  const lines = buildPanelLines();
  let out = '';

  // move to each panel row and overwrite it in place
  for (let i = 0; i < lines.length; i++) {
    out += MOVE(panelStartRow + i, 1) + ERASE_EOL + lines[i];
  }

  // put the cursor back just above the panel where log output will appear
  out += MOVE(panelStartRow - 1, 1);
  process.stdout.write(out);
}

export function startTui(): void {
  if (!process.stdout.isTTY) return;

  const termRows = getTermRows();
  panelStartRow = Math.max(2, termRows - PANEL_ROWS + 1);

  process.stdout.write(HIDE_CURSOR);
  startTime = Date.now();

  // restrict terminal scrolling to the rows above the panel so log output
  // scrolls normally in that region and never overwrites the panel rows
  process.stdout.write(SET_SCROLL_REGION(1, panelStartRow - 1));

  // move cursor into the scroll region before first render
  process.stdout.write(MOVE(panelStartRow - 1, 1));

  tuiActive = true;
  renderTui();
  tuiInterval = setInterval(renderTui, 2000);

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (key: Buffer) => {
    const k = key.toString();
    if (k === 'q' || k === 'Q' || k === '\x03') {
      stopTui();
      process.exit(0);
    }
  });
}

export function stopTui(): void {
  if (tuiInterval) {
    clearInterval(tuiInterval);
    tuiInterval = null;
  }
  tuiActive = false;
  process.stdout.write(RESET_SCROLL_REGION);
  process.stdout.write(SHOW_CURSOR);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

export function logBelowTui(line: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
  const clean = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (clean) {
    logBuffer.push(clean);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  }

  if (!tuiActive || !process.stdout.isTTY) {
    process.stdout.write(`${line}\n`);
    return;
  }

  // the scroll region is set to rows 1..(panelStartRow-1), so writing a newline
  // here scrolls only that region — the panel rows are untouched.
  // we just need to be on the last row of the scroll region when writing.
  process.stdout.write(MOVE(panelStartRow - 1, 1) + line + '\n');

  // redraw the panel to ensure it stays correct after the scroll region shifted
  renderTui();
}
