import { meta } from "../../storage/config.json";
import config from "../config";
import { getTotalStats } from "../handlers/stats";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatUptime(uptimeSeconds: number): string {
  const minutes = Math.floor((uptimeSeconds / 60) % 60);
  const hours = Math.floor((uptimeSeconds / 3600) % 24);
  const days = Math.floor(uptimeSeconds / 86400);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export async function handleRoot(): Promise<Response> {
  return json({
    versionFamily: 1,
    versionRelease: `Airlinkd ${meta.version}`,
    status: "Online",
    remote: config.remote,
  });
}

export async function handleStats(): Promise<Response> {
  return json({ totalStats: getTotalStats(), uptime: formatUptime(process.uptime()) });
}
