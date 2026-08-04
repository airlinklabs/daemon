import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statfsSync, statSync } from 'node:fs';

export interface HostStats {
  cpuPct: number;
  perCorePct: number[];
  memUsedGb: number;
  memTotalGb: number;
  memCachedGb: number;
  memAvailGb: number;
  swapUsedGb: number;
  swapTotalGb: number;
  load1: number;
  load5: number;
  load15: number;
  sysUptimeSec: number;
  procs: number;
  disks: { mount: string; usedGb: number; totalGb: number; pct: number }[];
  nets: { iface: string; rxBps: number; txBps: number }[];
  diskIo: { dev: string; rxBps: number; txBps: number }[];
  temps: number[];
  topProcs: { pid: number; name: string; cpuPct: number; rssMb: number }[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  cpuPct: number;
  memUsedMb: number;
  memLimitMb: number;
}

export interface DockerStats {
  online: boolean;
  error: string | null;
  containers: ContainerInfo[];
  images: number;
  networks: number;
  volumes: number;
  dockerDiskGb: number;
}

export interface DaemonInfo {
  online: boolean;
  pid: number | null;
  mode: 'managed' | 'external' | 'none';
  version: string;
  runtime: string;
  port: number;
  remote: string;
  kernel: string;
  uptimeSec: number | null;
  errors24h: number;
}

export interface DaemonCtx {
  port: number;
  managedPid: number | null;
  managedSince: number | null;
  daemonDir: string;
  runtime: string;
  remote: string;
  version: string;
  logsDir: string;
}

const CLK_TCK = 100;

let prevCpu: { time: number; perCore: number[] } | null = null;
let prevNet: { time: number; byIface: Map<string, { rx: number; tx: number }> } | null = null;
let prevDiskIo: { time: number; byDev: Map<string, { rx: number; tx: number }> } | null = null;
let prevProcs: Map<number, { ticks: number; at: number }> = new Map();

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

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

export function cpuPct(now: number): { total: number; perCore: number[] } {
  const cur = readCpu();
  if (!prevCpu) {
    prevCpu = { time: now, perCore: cur.perCore.slice() };
    return { total: 0, perCore: cur.perCore.map(() => 0) };
  }
  const dt = (cur.time - prevCpu.time) / (now - prevCpu.time);
  const total = Math.max(0, Math.min(100, dt * 100));
  const perCore = cur.perCore.map((v, i) => {
    const p = prevCpu?.perCore[i] ?? v;
    const d = (v - p) / (now - (prevCpu?.time ?? now));
    return Math.max(0, Math.min(100, d * 100));
  });
  prevCpu = { time: now, perCore: cur.perCore.slice() };
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
      } catch {
        /* skip unreadable mounts */
      }
    }
  } catch {
    /* no statfs */
  }
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
    } catch {
      /* skip */
    }
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
    } catch {
      /* process vanished */
    }
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

interface DockerResponse {
  status: number;
  body: string;
  json: unknown;
}

interface DockerContainerInfo {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
}

interface DockerContainerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
}

function decodeChunked(text: string): string {
  let out = '';
  let rest = text;
  while (rest.length > 0) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const size = parseInt(rest.slice(0, nl), 16);
    if (Number.isNaN(size) || size < 0) break;
    rest = rest.slice(nl + 2);
    if (size === 0) break;
    out += rest.slice(0, size);
    rest = rest.slice(size + 2);
  }
  return out;
}

function dockerFetch(path: string, socket: string, timeoutMs = 3000): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const req = `GET ${path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n`;
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timeout'));
    }, timeoutMs);
    Bun.connect({
      unix: socket,
      socket: {
        data(_socket, data) {
          buf += data.toString('utf8');
        },
        open(socket) {
          socket.write(req);
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const sep = buf.indexOf('\r\n\r\n');
          const head = sep >= 0 ? buf.slice(0, sep) : buf;
          let body = sep >= 0 ? buf.slice(sep + 4) : '';
          const status = Number(head.split(' ')[1] ?? 0);
          if (/transfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body);
          let json: unknown = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status, body, json });
        },
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

let dockerSocket: string | null | undefined;

function getDockerSocket(): string | null {
  if (dockerSocket !== undefined) return dockerSocket;
  const candidates = [process.env.AIRLINK_DOCKER_SOCKET, '/var/run/docker.sock', '/run/podman/podman.sock'].filter(
    (p): p is string => !!p,
  );
  for (const socket of candidates) {
    try {
      if (existsSync(socket)) {
        dockerSocket = socket;
        return socket;
      }
    } catch {
      /* try next */
    }
  }
  dockerSocket = null;
  return null;
}

function containerStatCpu(stats: DockerContainerStats): number {
  const cur = stats?.cpu_stats;
  const prev = stats?.precpu_stats;
  if (!cur || !prev) return 0;
  const cpuDelta = (cur.cpu_usage?.total_usage ?? 0) - (prev.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cur.system_cpu_usage ?? 0) - (prev.system_cpu_usage ?? 0);
  const cores = cur.online_cpus ?? 1;
  if (sysDelta <= 0 || cpuDelta <= 0) return 0;
  return Math.min(100, (cpuDelta / sysDelta) * cores * 100);
}

export async function collectDocker(): Promise<DockerStats> {
  const empty: DockerStats = {
    online: false,
    error: null,
    containers: [],
    images: 0,
    networks: 0,
    volumes: 0,
    dockerDiskGb: 0,
  };
  const socket = getDockerSocket();
  if (!socket) return { ...empty, error: 'no docker socket found' };
  const results = await Promise.allSettled([
    withTimeout(dockerFetch('/v1.41/containers/json?all=1', socket), 4000, null),
    withTimeout(dockerFetch('/v1.41/images/json', socket), 4000, null),
    withTimeout(dockerFetch('/v1.41/networks', socket), 4000, null),
    withTimeout(dockerFetch('/v1.41/volumes', socket), 4000, null),
    withTimeout(dockerFetch('/v1.41/system/df', socket), 4000, null),
  ]);
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const infos = (results[0].status === 'fulfilled' ? results[0].value?.json : null) as DockerContainerInfo[] | null;
  if (firstError && !infos) {
    const msg = String(firstError.reason?.message ?? firstError.reason);
    if (msg.includes('EACCES') || msg.includes('permission')) {
      return { ...empty, error: 'permission denied (run as root)' };
    }
    return { ...empty, error: msg.slice(0, 40) };
  }
  if (!Array.isArray(infos)) return { ...empty, error: 'docker API unreachable' };
  const running = infos.filter((c: DockerContainerInfo) => c.State === 'running').slice(0, 8);
  const stats = await Promise.allSettled(
    running.map((c: DockerContainerInfo) =>
      withTimeout(
        dockerFetch(`/v1.41/containers/${c.Id}/stats?stream=false`, socket, 3000),
        3500,
        null,
      ),
    ),
  );
  const perId = new Map<string, { cpu: number; memUsed: number; memLimit: number }>();
  running.forEach((c: DockerContainerInfo, i: number) => {
    const s = stats[i];
    if (s.status !== 'fulfilled' || !s.value?.json) return;
    const v = s.value.json as DockerContainerStats;
    const cpu = containerStatCpu(v);
    const memUsed = v.memory_stats?.usage ?? 0;
    const memLimit = v.memory_stats?.limit ?? 0;
    perId.set(c.Id, { cpu, memUsed, memLimit });
  });
  const containersOut: ContainerInfo[] = infos.map((c: DockerContainerInfo) => {
    const m = perId.get(c.Id);
    return {
      id: c.Id.slice(0, 12),
      name: (c.Names?.[0] ?? '?').replace(/^\//, ''),
      image: c.Image ?? '?',
      state: c.State ?? '?',
      status: c.Status ?? '',
      cpuPct: m?.cpu ?? 0,
      memUsedMb: m ? m.memUsed / 1e6 : 0,
      memLimitMb: m && m.memLimit > 0 ? m.memLimit / 1e6 : 0,
    };
  });
  containersOut.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return b.cpuPct - a.cpuPct;
  });
  return {
    online: true,
    error: null,
    containers: containersOut,
    images: results[1].status === 'fulfilled' ? ((results[1].value?.json as { length?: number })?.length ?? 0) : 0,
    networks: results[2].status === 'fulfilled' ? ((results[2].value?.json as { length?: number })?.length ?? 0) : 0,
    volumes: results[3].status === 'fulfilled' ? ((results[3].value?.json as { Volumes?: unknown[] })?.Volumes?.length ?? 0) : 0,
    dockerDiskGb: results[4].status === 'fulfilled' ? ((results[4].value?.json as { LayersSize?: number })?.LayersSize ?? 0) / 1e9 : 0,
  };
}

function readKernel(): string {
  const v = readProc('/proc/version').split(' ');
  return v[2] || 'unknown';
}

export function resolveExternalDir(pid: number): string {
  try {
    const real = readFileSync(`/proc/${pid}/cwd`, 'utf8').replace(/\0/g, '');
    if (real) return real;
  } catch {
    /* no cwd access (not root) */
  }
  if (existsSync('/etc/daemon/storage/config.json')) return '/etc/daemon';
  return '';
}

function pidStatField(pid: number, index: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    return Number(rest[index] ?? 0);
  } catch {
    return 0;
  }
}

function findDaemonPid(): number | null {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (
        cmdline.includes('airlinkd') &&
        (cmdline.includes('start') || cmdline.includes('src/app.ts') || cmdline.includes('app.ts'))
      ) {
        const ppid = pidStatField(Number(entry), 1);
        if (ppid !== 1 && existsSync(`/proc/${ppid}`)) continue;
        return Number(entry);
      }
    } catch {
      /* vanished */
    }
  }
  return null;
}

function processUptime(pid: number): number | null {
  try {
    const startTicks = pidStatField(pid, 19);
    const up = Number(readProc('/proc/uptime').split(' ')[0] ?? 0);
    return Math.max(0, up - startTicks / CLK_TCK);
  } catch {
    return null;
  }
}

function countErrors24h(logsDir: string): number {
  const file = `${logsDir}/error.log`;
  if (!existsSync(file)) return 0;
  let count = 0;
  try {
    const size = statSync(file).size;
    const take = Math.min(size, 4 * 1024 * 1024);
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(take);
    readSync(fd, buf, 0, take, size - take);
    closeSync(fd);
    const text = buf.toString('utf8');
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const line of text.split('\n')) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
      if (!m) continue;
      if (Date.parse(`${m[1]}T${m[2]}Z`) >= cutoff) count++;
    }
  } catch {
    /* ignore */
  }
  return count;
}

export async function collectDaemon(ctx: DaemonCtx): Promise<DaemonInfo> {
  let online = false;
  try {
    const res = await withTimeout(
      fetch(`http://127.0.0.1:${ctx.port}/healthz`),
      1500,
      null,
    );
    online = !!res && res.ok;
  } catch {
    online = false;
  }
  let pid: number | null = ctx.managedPid;
  let mode: DaemonInfo['mode'] = ctx.managedPid ? 'managed' : 'none';
  if (!pid) {
    pid = findDaemonPid();
    if (pid) mode = 'external';
    else if (online) mode = 'external';
  } else {
    mode = 'managed';
  }
  let uptimeSec: number | null = null;
  if (ctx.managedPid && ctx.managedSince) uptimeSec = (Date.now() - ctx.managedSince) / 1000;
  else if (pid) uptimeSec = processUptime(pid);
  return {
    online,
    pid,
    mode,
    version: ctx.version,
    runtime: ctx.runtime,
    port: ctx.port,
    remote: ctx.remote,
    kernel: readKernel(),
    uptimeSec,
    errors24h: countErrors24h(ctx.logsDir),
  };
}
