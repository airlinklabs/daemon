import os from 'os';
import fs from 'fs';
import path from 'path';
import osUtils from 'os-utils';

const storagePath = path.join(__dirname, '../../storage/systemStats.json');
const tempStoragePath = path.join(__dirname, '../../storage/systemStats.tmp.json');
const maxAge = 5 * 60 * 10000;

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
  if (stats && stats.timestamp) {
    statsLog.push(stats);
    cleanOldEntries();

    fs.writeFile(tempStoragePath, JSON.stringify(statsLog, null, 2), (err) => {
      if (err) {
        console.error('Error saving stats to temp JSON file:', err);
      } else {
        fs.rename(tempStoragePath, storagePath, (err) => {
          if (err) {
            console.error('Error renaming temp file to JSON file:', err);
          }
        });
      }
    });
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
      console.error('Error reading total stats:', error);
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
              console.error('Error saving stats to JSON file:', err);
            }
          });
        } else {
          console.error('Error parsing JSON data: Expected array but got:', parsedData);
          statsLog = [];
        }
      } else {
        console.warn('Stats file is empty, initializing with empty statsLog.');
        statsLog = [];
      }
    } catch (err) {
      console.error('Error reading stats from JSON file:', err);
      statsLog = [];
    }
  }
}

export function getSystemStats(periodInMs?: number): SystemStat[] | Promise<SystemStat> {
  if (periodInMs) {
    const now = Date.now();
    return statsLog.filter(entry => {
      const entryTime = new Date(entry.timestamp).getTime();
      return now - entryTime <= periodInMs;
    });
  } else {
    return getCurrentStats();
  }
}

(getSystemStats as any).total = (): SystemStat[] => statsLog;