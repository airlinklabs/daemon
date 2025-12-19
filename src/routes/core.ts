import { Router, Request, Response } from "express";
import { meta } from "../../storage/config.json";
import config from "../utils/config";
import {
  getTotalStats,
  getCurrentStats,
  getSystemStats,
  saveStats,
} from "../handlers/stats";
import logger from "../utils/logger";

const router = Router();

const STATS_INTERVAL = config.STATS_INTERVAL;

interface StatsResponse {
  totalStats: Awaited<ReturnType<typeof getSystemStats>>;
  uptime: string;
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

setInterval(async () => {
  try {
    const stats = await getCurrentStats();
    saveStats(stats);
  } catch (error) {
    logger.error("Error logging stats:", error);
  }
}, STATS_INTERVAL);

router.get("/", (_req: Request, res: Response) => {
  const response = {
    versionFamily: 1,
    versionRelease: `Airlinkd ${meta.version}`,
    status: "Online",
    remote: config.remote,
  };
  res.json(response);
});

router.get(
  "/stats",
  async (_req: Request, res: Response<StatsResponse | { error: string }>) => {
    try {
      const totalStats = getTotalStats();
      const uptime = formatUptime(process.uptime());

      res.json({ totalStats, uptime });
    } catch (error) {
      logger.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }
);

export default router;
