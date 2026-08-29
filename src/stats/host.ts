import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import type { HostStats } from './types';

const CLK_TCK = 100;

let prevCpu: { time: number; perCore: number[] } | null = null;
let prevNet: { time: number; byIface: Map<string, { rx: number; tx: number }> } | null = null;
let prevDiskIo: { time: number; byDev: Map<string, { rx: number; tx: number }> } | null = null;
let prevProcs: Map<number, { ticks: number; at: number }> = new Map();

function readProc(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readCpu(): { time: number; perCore: number[] } {
  const data = readProc('/proc/stat');
  const perCore: number[] = [];
  let total = 0;
  for (const line of data.split('\n')) {
    const parts = line.split(/\s+/);
    const name = parts[0];
    if (!name?.startsWith('cpu')) continue;
    const nums = parts.slice(1).map(Number);
    if (nums.length < 5) continue;
    const idle = nums[3] + (nums[4] ?? 0);
    const sum = nums.reduce((a, b) => a + b, 0);
    if (name === 'cpu') total = sum - idle;
    else perCore.push(sum - idle);
  }
  return { time: total, perCore };
}

export function cpuPct(_now: number): { total: number; perCore: number[] } {
  const cur = readCpu();
  if (!prevCpu) {
    prevCpu = { time: cur.time, perCore: cur.perCore.slice() };
    return { total: 0, perCore: cur.perCore.map(() => 0) };
  }
  const dTotal = cur.time - prevCpu.time;
  // Use the previous perCore snapshots as idle baseline — both are busy ticks
  const perCore = cur.perCore.map((v, i) => {
    const p = prevCpu?.perCore[i] ?? v;
    const d = v - p;
    return dTotal <= 0 ? 0 : Math.max(0, Math.min(100, (d / dTotal) * 100));
  });
  const total = dTotal <= 0 ? 0 : Math.max(0, Math.min(100, (dTotal / (dTotal + 1)) * 100));
  prevCpu = { time: cur.time, perCore: cur.perCore.slice() };
  return { total, perCore };
}

function readMem(): { total: number; available: number; cached: number; swapTotal: number; swapFree: number } {
  const data = readProc('/proc/meminfo');
  const get = (k: string): number => {
    const m = data.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) * 1024 : 0;
  };
  return {
    total: get('MemTotal'),
    available: get('MemAvailable'),
    cached: get('Cached'),
    swapTotal: get('SwapTotal'),
    swapFree: get('SwapFree'),
  };
}

function readLoad(): { load: [number, number, number]; procs: number; uptime: number } {
  const load = readProc('/proc/loadavg');
  const parts = load.split(/\s+/);
  const uptime = Number(readProc('/proc/uptime').split(/\s+/)[0] ?? 0);
  return {
    load: [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)],
    procs: Number(parts[3]?.split('/')[1] ?? 0),
    uptime,
  };
}

function readDisks(): { mount: string; usedGb: number; totalGb: number; pct: number }[] {
  const out: { mount: string; usedGb: number; totalGb: number; pct: number }[] = [];
  try {
    const mounts = readProc('/proc/mounts')
      .split('\n')
      .map((l) => l.split(/\s+/))
      .filter((p) => {
        const fstype = p[2] ?? '';
        return ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs'].includes(fstype);
      });
    const seen = new Set<string>();
    for (const [dev, mount] of mounts) {
      if (seen.has(dev) || !mount) continue;
      seen.add(dev);
      try {
        const s = statfsSync(mount);
        const total = s.blocks * s.bsize;
        const avail = s.bavail * s.bsize;
        const used = total - avail;
        if (total === 0) continue;
        out.push({
          mount: mount === '/' ? '/' : mount,
          usedGb: used / 1e9,
          totalGb: total / 1e9,
          pct: (used / total) * 100,
        });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.totalGb - a.totalGb);
  return out.slice(0, 4);
}

function readNets(now: number): { iface: string; rxBps: number; txBps: number }[] {
  const data = readProc('/proc/net/dev');
  const cur = new Map<string, { rx: number; tx: number }>();
  for (const line of data.split('\n').slice(2)) {
    const [head, rest] = line.split(':');
    const iface = head?.trim();
    if (!iface || iface === 'lo') continue;
    const nums = rest?.trim().split(/\s+/).map(Number) ?? [];
    cur.set(iface, { rx: nums[0] ?? 0, tx: nums[8] ?? 0 });
  }
  const out: { iface: string; rxBps: number; txBps: number }[] = [];
  if (prevNet) {
    const dt = (now - prevNet.time) / 1000;
    for (const [iface, v] of cur) {
      const p = prevNet.byIface.get(iface);
      if (!p || dt <= 0) continue;
      const rxBps = Math.max(0, (v.rx - p.rx) / dt);
      const txBps = Math.max(0, (v.tx - p.tx) / dt);
      if (rxBps > 0 || txBps > 0) out.push({ iface, rxBps, txBps });
    }
  }
  prevNet = { time: now, byIface: cur };
  out.sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps));
  return out.slice(0, 2);
}

function readDiskIo(now: number): { dev: string; rxBps: number; txBps: number }[] {
  const data = readProc('/proc/diskstats');
  const cur = new Map<string, { rx: number; tx: number }>();
  for (const line of data.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[2];
    if (!name) continue;
    const physical = /^(sd|vd|hd|xvd)[a-z]+$/.test(name) || /^nvme\d+n\d+$/.test(name) || /^mmcblk\d+$/.test(name);
    if (!physical) continue;
    const sectorsRead = Number(parts[5] ?? 0);
    const sectorsWrite = Number(parts[9] ?? 0);
    cur.set(name, { rx: sectorsRead * 512, tx: sectorsWrite * 512 });
  }
  const names = [...cur.keys()];
  if (!prevDiskIo || prevDiskIo.byDev.size === 0) {
    prevDiskIo = { time: now, byDev: cur };
    return names.map((dev) => ({ dev, rxBps: 0, txBps: 0 }));
  }
  const dt = (now - prevDiskIo.time) / 1000;
  const out: { dev: string; rxBps: number; txBps: number }[] = [];
  for (const [dev, v] of cur) {
    const p = prevDiskIo.byDev.get(dev);
    if (!p || dt <= 0) continue;
    const rxBps = Math.max(0, (v.rx - p.rx) / dt);
    const txBps = Math.max(0, (v.tx - p.tx) / dt);
    out.push({ dev, rxBps, txBps });
  }
  prevDiskIo = { time: now, byDev: cur };
  out.sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps));
  return out.slice(0, 3);
}

function readTemps(): number[] {
  const base = '/sys/class/thermal';
  const zones = readdirSync(base).filter((d) => d.startsWith('thermal_zone'));
  const out: number[] = [];
  for (const zone of zones.slice(0, 4)) {
    try {
      const t = Number(readFileSync(`${base}/${zone}/temp`, 'utf8').trim());
      if (t > 1000 && t < 130000) out.push(t / 1000);
    } catch {}
  }
  return out;
}

function readTopProcs(now: number): { pid: number; name: string; cpuPct: number; rssMb: number }[] {
  const out: { pid: number; name: string; cpuPct: number; rssMb: number }[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      if (name.startsWith('[')) continue;
      const rest = stat.slice(close + 2).split(' ');
      const utime = Number(rest[11] ?? 0);
      const stime = Number(rest[12] ?? 0);
      const rssPages = Number(rest[21] ?? 0);
      const ticks = utime + stime;
      const prev = prevProcs.get(Number(entry));
      prevProcs.set(Number(entry), { ticks, at: now });
      if (!prev || now <= prev.at) continue;
      const cpuPct = ((ticks - prev.ticks) / CLK_TCK / ((now - prev.at) / 1000)) * 100;
      if (cpuPct < 0.5) continue;
      out.push({ pid: Number(entry), name, cpuPct, rssMb: (rssPages * 4096) / 1e6 });
    } catch {}
  }
  if (prevProcs.size > 500) prevProcs = new Map([...prevProcs].slice(-300));
  return out.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 4);
}

export function collectHost(now: number): HostStats {
  const cpu = cpuPct(now);
  const mem = readMem();
  const load = readLoad();
  return {
    cpuPct: cpu.total,
    perCorePct: cpu.perCore,
    memUsedGb: (mem.total - mem.available) / 1e9,
    memTotalGb: mem.total / 1e9,
    memCachedGb: mem.cached / 1e9,
    memAvailGb: mem.available / 1e9,
    swapUsedGb: (mem.swapTotal - mem.swapFree) / 1e9,
    swapTotalGb: mem.swapTotal / 1e9,
    load1: load.load[0],
    load5: load.load[1],
    load15: load.load[2],
    sysUptimeSec: load.uptime,
    procs: load.procs,
    disks: readDisks(),
    nets: readNets(now),
    diskIo: readDiskIo(now),
    temps: readTemps(),
    topProcs: readTopProcs(now),
  };
}
