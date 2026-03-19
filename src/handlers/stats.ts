import os from 'os';
import fs from 'fs';
import path from 'path';
import osUtils from 'os-utils';
import logger from '../utils/logger';

const storagePath = path.join(__dirname, '../../storage/systemStats.json');
const tempStoragePath = path.join(__dirname, '../../storage/systemStats.tmp.json');
const maxAge = 30 * 60 * 1000;

interface SystemStat {
  timestamp: string;
  RamMax: string;
  Ram: string;
  CoresMax: number;
  Cores: string;
}

let statsLog: SystemStat[] = [];

function ensureStorageDirectory(): void {
  const storageDir = path.dirname(storagePath);
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
}

function calculateCpuUsage(): Promise<{ coresMax: number; coresUsage: string }> {
  return new Promise((resolve) => {
    osUtils.cpuUsage((usage: number) => {
      resolve({
        coresMax: os.cpus().length,
        coresUsage: (usage * 100).toFixed(2)
      });
    });
  });
}

export async function getCurrentStats(): Promise<SystemStat> {
  const timestamp = new Date().toISOString();
  const totalMemory = os.totalmem() / (1024 * 1024);
  const freeMemory = os.freemem() / (1024 * 1024);
  const usedMemory = totalMemory - freeMemory;
  const cpuStats = await calculateCpuUsage();

  return {
    timestamp,
    RamMax: `${totalMemory.toFixed(2)} MB`,
    Ram: `${usedMemory.toFixed(2)} MB`,
    CoresMax: cpuStats.coresMax,
    Cores: `${cpuStats.coresUsage}%`
  };
}

function cleanOldEntries(): void {
  const now = Date.now();
  statsLog = statsLog.filter(entry => {
    const entryTime = new Date(entry.timestamp).getTime();
    return now - entryTime <= maxAge;
  });
}

export function saveStats(stats: SystemStat): void {
  if (!stats || !stats.timestamp) {
    logger.warn('Invalid stats data provided to saveStats');
    return;
  }

  try {
    statsLog.push(stats);
    cleanOldEntries();

    fs.writeFile(tempStoragePath, JSON.stringify(statsLog, null, 2), (err) => {
      if (err) {
        logger.error('Error saving stats to temp JSON file:', err);
        return;
      }

      fs.rename(tempStoragePath, storagePath, (err) => {
        if (err) {
          logger.error('Error renaming temp file to JSON file:', err);
          fs.unlink(tempStoragePath, (unlinkErr) => {
            if (unlinkErr) {
              logger.error('Error cleaning up temp file:', unlinkErr);
            }
          });
        }
      });
    });
  } catch (error) {
    logger.error('Unexpected error in saveStats:', error);
  }
}

export function getTotalStats(): SystemStat[] {
    try {
      if (fs.existsSync(storagePath)) {
        const data = fs.readFileSync(storagePath, 'utf8');
        const parsedData = JSON.parse(data);
        if (Array.isArray(parsedData)) {
          return parsedData as SystemStat[];
        }
      }
    } catch (error) {
      logger.error('Error reading total stats:', error);
    }
    return [];
  }

export function initLogger(): void {
  ensureStorageDirectory();

  if (fs.existsSync(storagePath)) {
    try {
      const data = fs.readFileSync(storagePath, 'utf8');

      if (data.trim()) {
        const parsedData = JSON.parse(data);
        if (Array.isArray(parsedData)) {
          statsLog = parsedData.filter((entry: SystemStat) => entry && entry.timestamp);
          cleanOldEntries();
          fs.writeFile(storagePath, JSON.stringify(statsLog, null, 2), (err) => {
            if (err) {
              logger.error('Error saving stats to JSON file:', err);
            }
          });
        } else {
          logger.error('Error parsing JSON data: Expected array but got:', parsedData);
          statsLog = [];
        }
      } else {
        logger.warn('Stats file is empty, initializing with empty statsLog.');
        statsLog = [];
      }
    } catch (err) {
      logger.error('Error reading stats from JSON file:', err);
      statsLog = [];
    }
  }
}

export function getStatsForPeriod(periodInMs: number): SystemStat[] {
  const now = Date.now();
  return statsLog.filter(entry => {
    const entryTime = new Date(entry.timestamp).getTime();
    return now - entryTime <= periodInMs;
  });
}

export function getSystemStats(periodInMs?: number): SystemStat[] | Promise<SystemStat> {
  if (periodInMs) {
    return getStatsForPeriod(periodInMs);
  }
  return getCurrentStats();
}
