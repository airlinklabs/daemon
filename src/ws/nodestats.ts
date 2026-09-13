import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem, uptime } from "node:os";
import type { ServerWebSocket } from "bun";
import { NODE_STATS_POLL_MS } from "../config/timeouts";
import { NODE_STATS_HISTORY_SLICE } from "../config/limits";
import { getTotalStats } from "../handlers/stats";
import logger from "../logger";
import type { WsData } from "./server";

const POLL_MS = NODE_STATS_POLL_MS;

export function startNodeStatsPolling(
  ws: ServerWebSocket<WsData>,
): ReturnType<typeof setInterval> {
  logger.debug("node stats polling started");
  sendNodeStats(ws);
  return setInterval(() => {
    if (ws.readyState !== 1) return;
    sendNodeStats(ws);
  }, POLL_MS);
}

function sendNodeStats(ws: ServerWebSocket<WsData>): void {
  if (ws.readyState !== 1) return;
  try {
    const totalRam = totalmem();
    const freeRam = freemem();
    const usedRam = totalRam - freeRam;
    const cpuCount = cpus().length;
    const cpuModel = cpus()[0]?.model || "unknown";
    const uptimeSec = uptime();

    let disk = { total: 0, used: 0, available: 0 };
    try {
      const fs = statfsSync("/");
      disk = {
        total: fs.blocks * fs.bsize,
        used: (fs.blocks - fs.bfree) * fs.bsize,
        available: fs.bavail * fs.bsize,
      };
    } catch {
      logger.warn("disk stats unavailable");
    }

    const totalStats = getTotalStats();
    const latest = totalStats.length ? totalStats[totalStats.length - 1] : null;

    logger.debug(
      `nodestats collected: ram_used=${(usedRam / 1024 / 1024).toFixed(0)}MB cpu_cores=${cpuCount} stats_entries=${totalStats.length}`,
    );

    ws.send(
      JSON.stringify({
        event: "nodestats",
        data: {
          host: {
            ram: { total: totalRam, used: usedRam, free: freeRam },
            cpu: { cores: cpuCount, model: cpuModel },
            disk,
            uptime: uptimeSec,
          },
          stats: {
            totalStats: totalStats.slice(-NODE_STATS_HISTORY_SLICE),
            uptime: formatUptime(uptimeSec),
          },
          current: latest,
        },
      }),
    );
    logger.debug("nodestats broadcast sent");
  } catch (err) {
    logger.warn("nodestats send failed", err);
  }
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(" ");
}

export function stopNodeStatsPolling(
  timer: ReturnType<typeof setInterval>,
): void {
  clearInterval(timer);
}
