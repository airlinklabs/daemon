import type { ServerWebSocket } from 'bun';
import { totalmem, freemem, cpus, uptime } from 'os';
import { statfsSync } from 'fs';
import { getCurrentStats } from '../handlers/stats';
import type { WsData } from './server';

const POLL_MS = 3000;

export function startNodeStatsPolling(ws: ServerWebSocket<WsData>): ReturnType<typeof setInterval> {
  sendNodeStats(ws);
  return setInterval(() => {
    if (ws.readyState !== 1) return;
    sendNodeStats(ws);
  }, POLL_MS);
}

async function sendNodeStats(ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.readyState !== 1) return;
  try {
    const totalRam = totalmem();
    const freeRam = freemem();
    const usedRam = totalRam - freeRam;
    const cpuCount = cpus().length;
    const cpuModel = cpus()[0]?.model || 'unknown';
    const uptimeSec = uptime();

    let disk = { total: 0, used: 0, available: 0 };
    try {
      const fs = statfsSync('/');
      disk = { total: fs.blocks * fs.bsize, used: (fs.blocks - fs.bfree) * fs.bsize, available: fs.bavail * fs.bsize };
    } catch {}

    const stats = await getCurrentStats();
    const totalStats = (await import('../handlers/stats')).getTotalStats();
    const latest = totalStats.length ? totalStats[totalStats.length - 1] : null;

    ws.send(JSON.stringify({
      event: 'nodestats',
      data: {
        host: { ram: { total: totalRam, used: usedRam, free: freeRam }, cpu: { cores: cpuCount, model: cpuModel }, disk, uptime: uptimeSec },
        stats: { totalStats: totalStats.slice(-30), uptime: formatUptime(uptimeSec) },
        current: latest,
      },
    }));
  } catch {}
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}

export function stopNodeStatsPolling(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}
