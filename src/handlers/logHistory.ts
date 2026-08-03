import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

const logsDir = join(process.cwd(), 'storage/logs');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function logPath(id: string): string {
  return join(logsDir, `${id}.log`);
}

function rotatedPath(id: string): string {
  return join(logsDir, `${id}.log.1`);
}

// Append-mode write streams, one per container. Persist survives restarts so
// crashes can be investigated after the fact (post-mortem).
const streams = new Map<string, WriteStream>();
const bytes = new Map<string, number>();

function streamFor(id: string): WriteStream {
  let s = streams.get(id);
  if (!s) {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    s = createWriteStream(logPath(id), { flags: 'a' });
    s.on('error', () => streams.delete(id));
    s.on('close', () => streams.delete(id));
    streams.set(id, s);
    bytes.set(id, 0);
  }
  return s;
}

function rotate(id: string): void {
  const s = streams.get(id);
  if (s) {
    s.end();
    streams.delete(id);
  }
  bytes.delete(id);
  try {
    renameSync(logPath(id), rotatedPath(id));
  } catch {
    // nothing to rotate yet
  }
}

export function appendLogLine(id: string, line: string): void {
  const s = streamFor(id);
  const chunk = line + '\n';
  s.write(chunk);
  const written = (bytes.get(id) ?? 0) + Buffer.byteLength(chunk);
  bytes.set(id, written);
  if (written >= MAX_LOG_BYTES) rotate(id);
}

export async function getLogHistory(id: string, limit = 500): Promise<string[]> {
  const file = Bun.file(logPath(id));
  const text = await file.text().catch(() => '');
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-limit);
}

export function clearLogHistory(id: string): void {
  const s = streams.get(id);
  if (s) {
    s.end();
    streams.delete(id);
  }
  bytes.delete(id);
  try {
    unlinkSync(logPath(id));
  } catch {
    // no file on disk yet
  }
}
