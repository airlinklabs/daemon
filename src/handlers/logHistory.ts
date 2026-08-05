import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import logger from '../logger';
import type { ContainerRuntime } from './containerRuntime';

const LOG_DIR = '.airlinkd/logs';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_HISTORY_LIMIT = 500;
const LOG_BUFFER_SIZE = 150;
const DOCKER_EVENT_RECONNECT_ERROR_MS = 5_000;
const DOCKER_EVENT_RECONNECT_END_MS = 2_000;

// ── Log directory ────────────────────────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });

function logPath(id: string): string {
  return join(LOG_DIR, `${id}.log`);
}

function rotatedPath(id: string): string {
  return join(LOG_DIR, `${id}.log.1`);
}

// ── Disk write streams ───────────────────────────────────────────────────────
const streams = new Map<string, WriteStream>();
const bytes = new Map<string, number>();

function streamFor(id: string): WriteStream {
  let s = streams.get(id);
  if (!s) {
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

function appendLogLine(id: string, line: string): void {
  const s = streamFor(id);
  const chunk = line + '\n';
  s.write(chunk);
  const written = (bytes.get(id) ?? 0) + Buffer.byteLength(chunk);
  bytes.set(id, written);
  if (written >= MAX_LOG_BYTES) rotate(id);
}

// ── Ring buffer (last N lines per container) ─────────────────────────────────
const logBuffers = new Map<string, string[]>();
const pendingLines = new Map<string, string>();

function appendLog(containerId: string, line: string): void {
  if (!logBuffers.has(containerId)) logBuffers.set(containerId, []);
  const buf = logBuffers.get(containerId)!;
  buf.push(line);
  if (buf.length > LOG_BUFFER_SIZE) buf.shift();
  appendLogLine(containerId, line);
}

export function getLogBuffer(containerId: string): string[] {
  return logBuffers.get(containerId) ?? [];
}

export function clearLogBuffer(containerId: string): void {
  logBuffers.delete(containerId);
  pendingLines.delete(containerId);
}

// Splits raw docker log chunks into lines, buffering partial lines until the
// next chunk completes them. Call this wherever container output is received.
export function appendRawLogChunk(containerId: string, chunk: Buffer): void {
  const pending = (pendingLines.get(containerId) ?? '') + chunk.toString('utf8');
  const lines = pending.split('\n');
  pendingLines.set(containerId, lines.pop() ?? '');
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed) appendLog(containerId, trimmed);
  }
}

// ── Disk history ─────────────────────────────────────────────────────────────

export async function getLogHistory(id: string, limit = DEFAULT_LOG_HISTORY_LIMIT): Promise<string[]> {
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

// ── Background log capture ───────────────────────────────────────────────────

const activeStreams = new Map<string, NodeJS.ReadableStream>();
let runtimeRef: ContainerRuntime | null = null;

export function isCapturing(containerId: string): boolean {
  return activeStreams.has(containerId);
}

export function beginCapture(containerId: string): void {
  if (isCapturing(containerId)) return;
  if (!runtimeRef) return;

  const runtime = runtimeRef;
  runtime
    .getContainer(containerId)
    .logs({ follow: true, stdout: true, stderr: true, tail: 0 })
    .then((logStream) => {
      if (isCapturing(containerId)) {
        // double-begin race — close the duplicate
        try {
          (logStream as unknown as { destroy(): void }).destroy();
        } catch {}
        return;
      }

      activeStreams.set(containerId, logStream);

      logStream.on('data', (chunk: Buffer) => {
        appendRawLogChunk(containerId, chunk);
      });

      logStream.on('error', (err: Error) => {
        logger.warn(`background log stream error for ${containerId}: ${err.message}`);
        activeStreams.delete(containerId);
      });

      logStream.on('end', () => {
        activeStreams.delete(containerId);
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`could not begin log capture for ${containerId}: ${msg}`);
    });
}

export function endCapture(containerId: string): void {
  const stream = activeStreams.get(containerId);
  if (!stream) return;
  try {
    (stream as unknown as { destroy(): void }).destroy();
  } catch {}
  activeStreams.delete(containerId);
}

async function subscribeToContainerEvents(): Promise<void> {
  if (!runtimeRef) return;

  try {
    const stream = await runtimeRef.getEvents({
      filters: JSON.stringify({ type: ['container'] }),
    });

    stream.on('data', (chunk: Buffer) => {
      try {
        const event = JSON.parse(chunk.toString()) as {
          Action: string;
          id: string;
          Actor?: { Attributes?: { name?: string } };
        };
        const id = event.id;
        const name = event.Actor?.Attributes?.name ?? '';
        const target = name || id;

        if (event.Action === 'start') {
          beginCapture(target);
        } else if (event.Action === 'die' || event.Action === 'stop' || event.Action === 'destroy') {
          endCapture(target);
        }
      } catch {
        /* malformed event chunk, skip */
      }
    });

    stream.on('error', (err: Error) => {
      logger.warn(`background log event stream error, reconnecting in ${DOCKER_EVENT_RECONNECT_ERROR_MS}ms: ${err.message}`);
      setTimeout(subscribeToContainerEvents, DOCKER_EVENT_RECONNECT_ERROR_MS);
    });

    stream.on('end', () => {
      logger.warn(`background log event stream dropped, reconnecting in ${DOCKER_EVENT_RECONNECT_END_MS}ms`);
      setTimeout(subscribeToContainerEvents, DOCKER_EVENT_RECONNECT_END_MS);
    });

    logger.info('background log collector event stream connected');
  } catch (err) {
    logger.error('could not start background log event stream, retrying', err);
    setTimeout(subscribeToContainerEvents, DOCKER_EVENT_RECONNECT_ERROR_MS);
  }
}

export async function startBackgroundLogCollector(runtime: ContainerRuntime): Promise<void> {
  runtimeRef = runtime;

  // Enumerate currently running containers and begin capturing their logs
  try {
    const containers = await runtime.listContainers({ all: false });
    for (const c of containers) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const target = name || c.Id;
      beginCapture(target);
    }
    logger.info(`background log collector started for ${containers.length} running containers`);
  } catch (err) {
    logger.error('could not enumerate running containers for log capture', err);
  }

  await subscribeToContainerEvents();
}
