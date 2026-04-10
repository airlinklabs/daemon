import { cpus, freemem, totalmem } from "node:os";
import { rename } from "node:fs/promises";

export type SystemStat = {
  timestamp: string;
  RamMax: string;
  Ram: string;
  CoresMax: number;
  Cores: string;
};

const statsPath = `${process.cwd()}/storage/systemStats.json`;
const tempPath = `${process.cwd()}/storage/systemStats.tmp.json`;
const maxAge = 30 * 60 * 1000;
let statsLog: SystemStat[] = [];

function cleanOldEntries(): void {
  const now = Date.now();
  statsLog = statsLog.filter((entry) => now - new Date(entry.timestamp).getTime() <= maxAge);
}

async function getCpuPercent(): Promise<number> {
  const before = cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = cpus();
      let totalIdle = 0;
      let totalTick = 0;
      for (let i = 0; i < before.length; i += 1) {
        const b = before[i]?.times;
        const a = after[i]?.times;
        if (!b || !a) continue;
        const dIdle = a.idle - b.idle;
        const dTick = Object.values(a).reduce((sum, value) => sum + value, 0)
          - Object.values(b).reduce((sum, value) => sum + value, 0);
        totalIdle += dIdle;
        totalTick += dTick;
      }
      const usage = totalTick > 0 ? 1 - totalIdle / totalTick : 0;
      resolve(Math.max(0, Math.min(1, usage)));
    }, 100);
  });
}

export async function getCurrentStats(): Promise<SystemStat> {
  const total = totalmem() / (1024 * 1024);
  const used = (totalmem() - freemem()) / (1024 * 1024);
  const cpuPercent = await getCpuPercent();
  return {
    timestamp: new Date().toISOString(),
    RamMax: `${total.toFixed(2)} MB`,
    Ram: `${used.toFixed(2)} MB`,
    CoresMax: cpus().length,
    Cores: `${(cpuPercent * 100).toFixed(2)}%`,
  };
}

export async function saveStats(stats: SystemStat): Promise<void> {
  statsLog.push(stats);
  cleanOldEntries();
  await Bun.write(tempPath, JSON.stringify(statsLog, null, 2));
  await rename(tempPath, statsPath);
}

export async function initStatsCollection(): Promise<void> {
  try {
    const text = await Bun.file(statsPath).text();
    const parsed = JSON.parse(text);
    statsLog = Array.isArray(parsed) ? parsed : [];
    cleanOldEntries();
  } catch {
    statsLog = [];
  }

  setInterval(async () => {
    await saveStats(await getCurrentStats()).catch(() => {});
  }, 10_000);
}

export function getTotalStats(): SystemStat[] {
  return statsLog;
}
