// This code was written by thavanish(https://github.com/thavanish) for airlinklabs

import { existsSync, readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import logger from '../logger';

const storagePath = join(process.cwd(), 'storage/systemStats.json');
const tempStoragePath = join(process.cwd(), 'storage/systemStats.tmp.json');
const maxAge = 30 * 60 * 1000;

interface SystemStat {
  timestamp: string;
  RamMax: string;
  Ram: string;
  CoresMax: number;
  Cores: string;
}

let statsLog: SystemStat[] = [];

// os-utils doesn't exist in bun-land, so we do it the old fashioned way
// sample cpu times, wait 100ms, sample again, compute delta
function getCpuPercent(): Promise<number> {
  const before = cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (let i = 0; i < before.length; i++) {
        const b = before[i].times;
        const a = after[i].times;
        const dIdle = a.idle - b.idle;
        const dTick =
          (Object.values(a) as number[]).reduce((s, v) => s + v, 0) -
          (Object.values(b) as number[]).reduce((s, v) => s + v, 0);
        totalIdle += dIdle;
        totalTick += dTick;
      }

      const usage = 1 - totalIdle / totalTick;
      resolve(Math.max(0, Math.min(1, usage)));
    }, 100);
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

function cleanOldEntries(): void {
  const now = Date.now();
  statsLog = statsLog.filter((e) => now - new Date(e.timestamp).getTime() <= maxAge);
}

export function saveStats(stats: SystemStat): void {
  if (!stats?.timestamp) {
    logger.warn('invalid stats data passed to saveStats');
    return;
  }

  statsLog.push(stats);
  cleanOldEntries();

  // write to temp, then rename — same atomicity guarantee as before
  Bun.write(tempStoragePath, JSON.stringify(statsLog, null, 2))
    .then(() => rename(tempStoragePath, storagePath))
    .catch((err) => logger.error('failed to write stats file', err));
}

export function getTotalStats(): SystemStat[] {
  try {
    if (existsSync(storagePath)) {
      const data = readFileSync(storagePath, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed as SystemStat[];
    }
  } catch (err) {
    logger.error('error reading total stats', err);
  }
  return [];
}

// called once on startup to load persisted stats and wire up the collection interval
export function initStatsCollection(): void {
  // load existing stats from disk
  if (existsSync(storagePath)) {
    try {
      const data = readFileSync(storagePath, 'utf8').trim();
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          statsLog = parsed.filter((e: SystemStat) => e?.timestamp);
          cleanOldEntries();
        }
      }
    } catch (err) {
      logger.error('error loading stats on startup', err);
      statsLog = [];
    }
  }
}
