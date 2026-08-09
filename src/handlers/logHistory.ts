import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  type WriteStream,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { create as tarCreate, extract as tarExtract } from 'tar';
import config from '../config';
import { getPaths } from '../paths';
import logger from '../logger';
import type { ContainerRuntime } from './containerRuntime';

// ── Tunable limits ───────────────────────────────────────────────────────────
// Every cap is overridable through env so operators can tune behavior without a
// rebuild, and so tests can shrink the caps to exercise the boundedness paths.
// Defaults keep per-container memory and on-disk history small and bounded.

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const LOG_BUFFER_SIZE = positiveIntEnv('AIRLINK_LOG_BUFFER_SIZE', 150); // ring buffer lines per container
const LOG_BUFFER_TTL_MS = positiveIntEnv('AIRLINK_LOG_BUFFER_TTL_MS', 10 * 60 * 1000); // drop lines older than this
const MAX_LOG_LINE_BYTES = positiveIntEnv('AIRLINK_LOG_LINE_MAX_BYTES', 32 * 1024); // truncate a single line at this
const MAX_PENDING_BYTES = positiveIntEnv('AIRLINK_LOG_PENDING_MAX_BYTES', 64 * 1024); // cap partial-line accumulation
const LOG_MAX_BYTES = positiveIntEnv('AIRLINK_LOG_MAX_BYTES', 5 * 1024 * 1024); // rotate a container log file at this size
const DEFAULT_LOG_HISTORY_LIMIT = 500;
const DOCKER_EVENT_RECONNECT_ERROR_MS = 5_000;
const DOCKER_EVENT_RECONNECT_END_MS = 2_000;

// ── Log directory ────────────────────────────────────────────────────────────
// Uses the centralised paths — no more process.cwd() per call. Tests supply a
// fixture root via config.paths instead of chdir-ing.
function logDir(): string {
  return getPaths(config.paths).logsRoot;
}

function logPath(id: string): string {
  return join(logDir(), `${id}.log`);
}

function rotatedPath(id: string): string {
  return join(logDir(), `${id}.log.1`);
}

// ── Disk write streams ───────────────────────────────────────────────────────
const streams = new Map<string, WriteStream>();
const bytes = new Map<string, number>();
// Resolves once a rotated-out write stream has flushed its buffered data to the
// renamed file; getLogHistory/flushLogHistory await it so readers never observe
// a half-flushed rotation.
const pendingFlush = new Map<string, Promise<void>>();

function dropStream(id: string): void {
  streams.delete(id);
  bytes.delete(id);
  pendingFlush.delete(id);
}

function streamFor(id: string): WriteStream {
  let s = streams.get(id);
  if (!s) {
    mkdirSync(logDir(), { recursive: true });
    s = createWriteStream(logPath(id), { flags: 'a' });
    s.on('error', () => dropStream(id));
    s.on('close', () => dropStream(id));
    streams.set(id, s);
    bytes.set(id, 0);
  }
  return s;
}

function rotate(id: string): void {
  const s = streams.get(id);
  if (s) {
    // Register the flush promise before ending so the 'finish' listener is
    // already attached when the stream begins draining.
    const flushed = new Promise<void>((resolve) => {
      s.once('finish', () => resolve());
      s.once('close', () => resolve());
      s.once('error', () => resolve());
    });
    pendingFlush.set(id, flushed);
    s.end();
  }
  streams.delete(id);
  bytes.delete(id);
  try {
    renameSync(logPath(id), rotatedPath(id));
  } catch {
    // nothing to rotate yet
  }
}

function appendLogLine(id: string, line: string): void {
  const s = streamFor(id);
  const chunk = `${line}\n`;
  s.write(chunk);
  const written = (bytes.get(id) ?? 0) + Buffer.byteLength(chunk);
  bytes.set(id, written);
  if (written >= LOG_MAX_BYTES) rotate(id);
}

// ── Ring buffer (last N lines per container) ─────────────────────────────────
interface BufferedLine {
  at: number; // epoch ms the line arrived — used by the TTL sweep
  text: string;
}

const logBuffers = new Map<string, BufferedLine[]>();
const pendingLines = new Map<string, string>();

// Drop entries older than the TTL from the front. Lines arrive in order so the
// oldest are always at the head; a linear scan is enough for the tiny buffer.
function pruneStale(buf: BufferedLine[]): void {
  const cutoff = Date.now() - LOG_BUFFER_TTL_MS;
  let stale = 0;
  while (stale < buf.length && buf[stale].at < cutoff) stale++;
  if (stale > 0) buf.splice(0, stale);
}

function appendLog(containerId: string, line: string): void {
  // A single pathological line (huge stack trace, binary blob) must not blow up
  // the ring buffer or the per-container disk file, so truncate it up front.
  const bounded = line.length > MAX_LOG_LINE_BYTES ? line.slice(0, MAX_LOG_LINE_BYTES) : line;
  let buf = logBuffers.get(containerId);
  if (!buf) {
    buf = [];
    logBuffers.set(containerId, buf);
  }
  pruneStale(buf);
  buf.push({ at: Date.now(), text: bounded });
  // Oldest-dropped cap: splice off whatever exceeds the line budget.
  if (buf.length > LOG_BUFFER_SIZE) buf.splice(0, buf.length - LOG_BUFFER_SIZE);
  appendLogLine(containerId, bounded);
}

export function getLogBuffer(containerId: string): string[] {
  const buf = logBuffers.get(containerId);
  if (!buf) return [];
  pruneStale(buf);
  // Return a copy so route handlers can't mutate the internal ring buffer.
  return buf.map((e) => e.text);
}

export function clearLogBuffer(containerId: string): void {
  logBuffers.delete(containerId);
  pendingLines.delete(containerId);
  // Stop any in-flight docker log stream so the next start begins with a fresh
  // capture instead of two competing streams for the same container.
  endCapture(containerId);
}

// Splits raw docker log chunks into lines, buffering partial lines until the
// next chunk completes them. Call this wherever container output is received.
export function appendRawLogChunk(containerId: string, chunk: Buffer): void {
  let pending = (pendingLines.get(containerId) ?? '') + chunk.toString('utf8');
  // A stream that never emits a newline (progress bars, spinners) would grow
  // `pending` without bound, so keep only the last MAX_PENDING_BYTES.
  if (pending.length > MAX_PENDING_BYTES) pending = pending.slice(-MAX_PENDING_BYTES);
  const lines = pending.split('\n');
  pendingLines.set(containerId, lines.pop() ?? '');
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed) appendLog(containerId, trimmed);
  }
}

// ── Disk history ─────────────────────────────────────────────────────────────

// Drains pending writes for a container so callers can read its file with
// confidence. Used by getLogHistory and by shutdown paths.
export async function flushLogHistory(id: string): Promise<void> {
  const rotated = pendingFlush.get(id);
  if (rotated) {
    await rotated;
    pendingFlush.delete(id);
  }
  const s = streams.get(id);
  if (s && s.writableLength > 0) {
    await new Promise<void>((resolve) => {
      const done = () => {
        s.off('drain', done);
        s.off('error', done);
        s.off('close', done);
        resolve();
      };
      s.once('drain', done);
      s.once('error', done);
      s.once('close', done);
    });
  }
}

export async function getLogHistory(id: string, limit = DEFAULT_LOG_HISTORY_LIMIT): Promise<string[]> {
  // Wait for pending disk writes so the caller always sees the latest lines.
  await flushLogHistory(id);
  const parts: string[] = [];
  // Read the rotated file first (older data), then the live file, so history is
  // preserved across a rotation instead of silently resetting.
  for (const path of [rotatedPath(id), logPath(id)]) {
    const text = await Bun.file(path)
      .text()
      .catch(() => '');
    if (text) parts.push(text);
  }
  const all = parts.join('\n').split('\n').filter(Boolean);
  return all.slice(-limit);
}

// ── Log archival ─────────────────────────────────────────────────────────────
// When a container stops or is killed, its console log is frozen into a
// timestamped tar.gz under `.airlinkd/logs/archive/<id>/`. The archive holds a
// single `<timestamp>.txt` file with the raw log text so the panel can list,
// read, and download past sessions.

function archiveDir(id: string): string {
  return join(logDir(), 'archive', id);
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

// Archives a container's rotated + live log into a timestamped tar.gz. Returns
// the archive path, or null when the container has no log content. Never throws
// for "no logs"; only real I/O failures propagate.
export async function archiveLogHistory(id: string): Promise<string | null> {
  await flushLogHistory(id);
  const parts: string[] = [];
  // Mirror getLogHistory's read order: rotated (older) first, then live.
  for (const path of [rotatedPath(id), logPath(id)]) {
    const text = await Bun.file(path)
      .text()
      .catch(() => '');
    if (text) parts.push(text);
  }
  const combined = parts.join('\n');
  if (!combined.trim()) return null;

  const stamp = timestamp();
  const archivePath = join(archiveDir(id), `${stamp}.log.tar.gz`);
  mkdirSync(archiveDir(id), { recursive: true });

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'airlinkd-log-archive-'));
    writeFileSync(join(tempDir, `${stamp}.txt`), combined, 'utf8');
    await tarCreate({ gzip: true, file: archivePath, cwd: tempDir }, [`${stamp}.txt`]);
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
  return archivePath;
}

export async function listLogArchives(id: string): Promise<{ fileName: string; size: number; createdAt: string }[]> {
  const dir = archiveDir(id);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((fileName) => {
      try {
        const st = statSync(join(dir, fileName));
        return { fileName, size: st.size, createdAt: st.mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter((e): e is { fileName: string; size: number; createdAt: string } => e !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Resolves an archive file name to a path jailed inside the container's archive
// dir. Returns null for anything that isn't a plain basename.
export function resolveLogArchivePath(id: string, fileName: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
  const dir = archiveDir(id);
  const path = resolve(join(dir, fileName));
  if (!path.startsWith(dir)) return null;
  return path;
}

// Reads the raw txt back out of an archive. Returns the non-empty lines, or
// null when the file is missing/unsafe/unreadable.
export async function readLogArchive(id: string, fileName: string): Promise<string[] | null> {
  const archivePath = resolveLogArchivePath(id, fileName);
  if (!archivePath) return null;
  if (!existsSync(archivePath)) return null;

  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'airlinkd-log-read-'));
    await tarExtract({ file: archivePath, cwd: tempDir });
    const txt = readdirSync(tempDir).find((f) => f.endsWith('.txt'));
    if (!txt) return null;
    return readFileSync(join(tempDir, txt), 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

export function clearLogHistory(id: string): void {
  const s = streams.get(id);
  if (s) s.end();
  dropStream(id);
  endCapture(id);
  logBuffers.delete(id);
  pendingLines.delete(id);
  // Remove both the live and rotated files so a deleted container leaves no
  // history (or stale memory) behind.
  try {
    unlinkSync(logPath(id));
  } catch {
    // no file on disk yet
  }
  try {
    unlinkSync(rotatedPath(id));
  } catch {
    // no rotated file on disk yet
  }
}

// ── Background log capture ───────────────────────────────────────────────────

const activeStreams = new Map<string, NodeJS.ReadableStream>();
let runtimeRef: ContainerRuntime | null = null;
let eventStreamActive = false;

export function isCapturing(containerId: string): boolean {
  return activeStreams.has(containerId);
}

// dockerode log/event streams are node Readables which expose destroy(); the
// ambient ReadableStream type omits it, so narrow via `in` instead of a cast.
function destroyStream(stream: NodeJS.ReadableStream): void {
  if ('destroy' in stream && typeof stream.destroy === 'function') {
    stream.destroy();
  }
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
        destroyStream(logStream);
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
  destroyStream(stream);
  activeStreams.delete(containerId);
}

async function subscribeToContainerEvents(): Promise<void> {
  if (!runtimeRef) return;
  // Guard against overlapping reconnect timers (an error + end can fire for the
  // same dead stream), which would otherwise open duplicate event streams.
  if (eventStreamActive) return;
  eventStreamActive = true;

  try {
    const stream = await runtimeRef.getEvents({
      filters: JSON.stringify({ type: ['container'] }),
    });

    stream.on('data', (chunk: Buffer) => {
      const parsed: { Action?: string; id?: string; Actor?: { Attributes?: { name?: string } } } = JSON.parse(
        chunk.toString(),
      );
      const id = parsed.id;
      const name = parsed.Actor?.Attributes?.name ?? '';
      const target = name || id || '';

      if (parsed.Action === 'start') {
        beginCapture(target);
      } else if (parsed.Action === 'die' || parsed.Action === 'stop' || parsed.Action === 'destroy') {
        endCapture(target);
      }
    });

    stream.on('error', (err: Error) => {
      eventStreamActive = false;
      logger.warn(
        `background log event stream error, reconnecting in ${DOCKER_EVENT_RECONNECT_ERROR_MS}ms: ${err.message}`,
      );
      setTimeout(subscribeToContainerEvents, DOCKER_EVENT_RECONNECT_ERROR_MS);
    });

    stream.on('end', () => {
      eventStreamActive = false;
      logger.warn(`background log event stream dropped, reconnecting in ${DOCKER_EVENT_RECONNECT_END_MS}ms`);
      setTimeout(subscribeToContainerEvents, DOCKER_EVENT_RECONNECT_END_MS);
    });

    logger.info('background log collector event stream connected');
  } catch (err) {
    eventStreamActive = false;
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
