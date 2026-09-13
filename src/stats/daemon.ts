import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import {
  DAEMON_ERROR_LOG_TAIL_CAP,
  DAEMON_ERROR_COUNT_CUTOFF_MS,
  SYSTEM_CLK_TCK,
} from "../config/limits";
import { STATS_HEALTH_CHECK_TIMEOUT_MS } from "../config/timeouts";
import { LOOPBACK_IP } from "../config/server";
import type { DaemonCtx, DaemonInfo } from "./types";

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

function readProc(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readKernel(): string {
  const v = readProc("/proc/version").split(" ");
  return v[2] || "unknown";
}

export function resolveExternalDir(pid: number): string {
  try {
    const real = readFileSync(`/proc/${pid}/cwd`, "utf8").replace(/\0/g, "");
    if (real) return real;
  } catch {}
  if (existsSync("/etc/daemon/storage/config.json")) return "/etc/daemon";
  return "";
}

function pidStatField(pid: number, index: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const rest = stat.slice(close + 2).split(" ");
    return Number(rest[index] ?? 0);
  } catch {
    return 0;
  }
}

function findDaemonPid(): number | null {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (
        cmdline.includes("airlinkd") &&
        (cmdline.includes("start") ||
          cmdline.includes("src/app.ts") ||
          cmdline.includes("app.ts"))
      ) {
        const ppid = pidStatField(Number(entry), 1);
        if (ppid !== 1 && existsSync(`/proc/${ppid}`)) continue;
        return Number(entry);
      }
    } catch {}
  }
  return null;
}

function processUptime(pid: number): number | null {
  try {
    const startTicks = pidStatField(pid, 19);
    const up = Number(readProc("/proc/uptime").split(" ")[0] ?? 0);
    return Math.max(0, up - startTicks / SYSTEM_CLK_TCK);
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
    const take = Math.min(size, DAEMON_ERROR_LOG_TAIL_CAP);
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(take);
    readSync(fd, buf, 0, take, size - take);
    closeSync(fd);
    const text = buf.toString("utf8");
    const cutoff = Date.now() - DAEMON_ERROR_COUNT_CUTOFF_MS;
    for (const line of text.split("\n")) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
      if (!m) continue;
      if (Date.parse(`${m[1]}T${m[2]}Z`) >= cutoff) count++;
    }
  } catch {}
  return count;
}

export async function collectDaemon(ctx: DaemonCtx): Promise<DaemonInfo> {
  let online = false;
  try {
    const res = await withTimeout(
      fetch(`http://${LOOPBACK_IP}:${ctx.port}/healthz`),
      STATS_HEALTH_CHECK_TIMEOUT_MS,
      null,
    );
    online = !!res && res.ok;
  } catch {
    online = false;
  }
  let pid: number | null = ctx.managedPid;
  let mode: DaemonInfo["mode"] = ctx.managedPid ? "managed" : "none";
  if (!pid) {
    pid = findDaemonPid();
    if (pid) mode = "external";
    else if (online) mode = "external";
  } else {
    mode = "managed";
  }
  let uptimeSec: number | null = null;
  if (ctx.managedPid && ctx.managedSince)
    uptimeSec = (Date.now() - ctx.managedSince) / 1000;
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
