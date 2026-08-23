import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import config from '../config';
import { getTotalStats } from '../handlers/stats';

// read the meta version from storage/config.json at startup, fall back to env
let daemonVersion = config.version || '3.0.0';
let daemonCodename = '';
try {
  const cfg = (await Bun.file('storage/config.json').json()) as {
    meta?: { version?: string; codename?: string };
  };
  daemonVersion = cfg?.meta?.version ?? daemonVersion;
  daemonCodename = cfg?.meta?.codename ?? '';
} catch {
  /* file missing or malformed — use env or default */
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

export function handleRoot(_req: Request): Response {
  const release = daemonCodename ? `${daemonVersion} ${daemonCodename}` : daemonVersion;
  return new Response(
    JSON.stringify({
      versionFamily: 1,
      versionRelease: release,
      status: 'Online',
      remote: config.remote,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

export function handleStats(_req: Request): Response {
  try {
    const totalStats = getTotalStats();
    const uptimeStr = formatUptime(process.uptime());
    return new Response(JSON.stringify({ totalStats, uptime: uptimeStr }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_err) {
    return new Response(JSON.stringify({ error: 'failed to fetch stats' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export function handleHostInfo(_req: Request): Response {
  try {
    const totalRam = totalmem();
    const freeRam = freemem();
    const usedRam = totalRam - freeRam;
    const cpuCount = cpus().length;
    const uptimeSec = uptime();

    let disk = { total: 0, used: 0, available: 0 };
    try {
      const fs = statfsSync('/');
      disk = {
        total: fs.blocks * fs.bsize,
        used: (fs.blocks - fs.bfree) * fs.bsize,
        available: fs.bavail * fs.bsize,
      };
    } catch {
      /* statfs not available */
    }

    return new Response(
      JSON.stringify({
        ram: { total: totalRam, used: usedRam, free: freeRam },
        cpu: { cores: cpuCount, model: cpus()[0]?.model || 'unknown' },
        disk,
        uptime: uptimeSec,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (_err) {
    return new Response(JSON.stringify({ error: 'failed to fetch host info' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
