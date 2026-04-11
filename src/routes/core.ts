import config from '../config';
import { getTotalStats } from '../handlers/stats';

// read the meta version from storage/config.json at startup
let daemonVersion = '3.0.0';
try {
  const cfg = await Bun.file('storage/config.json').json() as { meta?: { version?: string } };
  daemonVersion = cfg?.meta?.version ?? daemonVersion;
} catch { /* file missing or malformed — use default */ }

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
  return new Response(JSON.stringify({
    versionFamily:  1,
    versionRelease: `Airlinkd ${daemonVersion}`,
    status:         'Online',
    remote:         config.remote,
  }), { headers: { 'Content-Type': 'application/json' } });
}

export function handleStats(_req: Request): Response {
  try {
    const totalStats = getTotalStats();
    const uptime     = formatUptime(process.uptime());
    return new Response(JSON.stringify({ totalStats, uptime }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'failed to fetch stats' }), {
      status:  500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
