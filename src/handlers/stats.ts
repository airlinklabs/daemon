import { existsSync, readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';
import logger from '../logger';

// ── Tunable limits ───────────────────────────────────────────────────────────
// Overridable through env so operators can tune behavior without a rebuild and
// so tests can shrink the caps to exercise the boundedness paths.

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Entries older than this are dropped from both the in-memory log and the file.
const STATS_MAX_AGE_MS = positiveIntEnv('AIRLINK_STATS_MAX_AGE_MS', 30 * 60 * 1000);
// Hard count cap: even with a very fast collection interval the array and the
// persisted file stay bounded.
const STATS_MAX_ENTRIES = positiveIntEnv('AIRLINK_STATS_MAX_ENTRIES', 2000);
const CPU_SAMPLE_INTERVAL_MS = 100;

interface SystemStat {
  timestamp: string;
  RamMax: string;
  Ram: string;
  CoresMax: number;
  Cores: string;
}

let statsLog: SystemStat[] = [];

// Storage paths resolved from the centralised DaemonPaths.
function storagePaths(): { storage: string; temp: string } {
  const dir = getPaths(config.paths).storageRoot;
  return { storage: join(dir, 'systemStats.json'), temp: join(dir, 'systemStats.tmp.json') };
}

// Sample CPU times, wait briefly, sample again, then compute the delta.
// This works in Bun and on all supported desktop/server platforms.
function getCpuPercent(): Promise<number> {
  const before = cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = cpus();
      let totalIdle = 0;
      let totalTick = 0;
      const count = Math.min(before.length, after.length);
      for (let i = 0; i < count; i++) {
        const b = before[i];
        const a = after[i];
        if (!b || !a) continue;
        const dIdle = a.times.idle - b.times.idle;
        const dTick =
          a.times.user +
          a.times.nice +
          a.times.sys +
          a.times.idle +
          a.times.irq -
          (b.times.user + b.times.nice + b.times.sys + b.times.idle + b.times.irq);
        totalIdle += dIdle;
        totalTick += dTick;
      }

      if (totalTick <= 0) {
        resolve(0);
        return;
      }

      const usage = 1 - totalIdle / totalTick;
      resolve(Math.max(0, Math.min(1, usage)));
    }, CPU_SAMPLE_INTERVAL_MS);
  });
}

export async function getCurrentStats(): Promise<SystemStat> {
  const timestamp = new Date().toISOString();
  const totalMemory = totalmem() / (1024 * 1024);
  const freeMemory = freemem() / (1024 * 1024);
  const usedMemory = totalMemory - freeMemory;
  const cpuUsage = await getCpuPercent();

  return {
    timestamp,
    RamMax: `${totalMemory.toFixed(2)} MB`,
    Ram: `${usedMemory.toFixed(2)} MB`,
    CoresMax: cpus().length,
    Cores: `${(cpuUsage * 100).toFixed(2)}%`,
  };
}

// Validates persisted entries without a cast. Only the timestamp is checked
// structurally; the numeric fields are reported exactly as stored.
function isSystemStat(value: unknown): value is SystemStat {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'timestamp') === 'string';
}

function pruneStats(): void {
  const now = Date.now();
  // Entries with an unparseable timestamp yield NaN, which fails the <= test
  // and are therefore dropped here.
  let kept = statsLog.filter((e) => now - new Date(e.timestamp).getTime() <= STATS_MAX_AGE_MS);
  if (kept.length > STATS_MAX_ENTRIES) kept = kept.slice(-STATS_MAX_ENTRIES);
  statsLog = kept;
}

// Persisted writes are serialized through a promise chain so concurrent
// saveStats calls can never interleave the temp-file write/rename.
let persistChain: Promise<void> = Promise.resolve();

function schedulePersist(): void {
  const snapshot = JSON.stringify(statsLog, null, 2);
  const { storage, temp } = storagePaths();
  persistChain = persistChain
    .then(async () => {
      await Bun.write(temp, snapshot);
      await rename(temp, storage);
    })
    .catch((err: unknown) => {
      logger.error('failed to write stats file', err);
    });
}

export function saveStats(stats: SystemStat): void {
  if (!stats?.timestamp) {
    logger.warn('invalid stats data passed to saveStats');
    return;
  }

  statsLog.push(stats);
  pruneStats();
  schedulePersist();
}

// Resolves once the last scheduled persistence write has landed. Useful for
// shutdown paths and for tests that assert on the persisted file.
export async function flushStatsPersistence(): Promise<void> {
  await persistChain;
}

export function getTotalStats(): SystemStat[] {
  // The in-memory log is authoritative once saveStats/initStatsCollection ran;
  // fall back to the persisted file when nothing is loaded yet.
  if (statsLog.length > 0) return [...statsLog];
  try {
    const { storage } = storagePaths();
    if (existsSync(storage)) {
      const data = readFileSync(storage, 'utf8');
      const parsed: unknown = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed.filter(isSystemStat);
    }
  } catch (err) {
    logger.error('error reading total stats', err);
  }
  return [];
}

// called once on startup to load persisted stats
export function initStatsCollection(): void {
  const { storage } = storagePaths();
  if (!existsSync(storage)) return;
  try {
    const data = readFileSync(storage, 'utf8').trim();
    if (!data) return;

    const parsed: unknown = JSON.parse(data);
    if (Array.isArray(parsed)) {
      statsLog = parsed.filter(isSystemStat);
      pruneStats();
    }
  } catch (err) {
    logger.error('error loading stats on startup', err);
    statsLog = [];
  }
}
