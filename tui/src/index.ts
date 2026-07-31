import {
  createCliRenderer,
  Box,
  Text,
  ScrollBoxRenderable,
  TextRenderable,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { watch, openSync, readSync, closeSync, statSync, existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { collectHost, collectDocker, collectDaemon, resolveExternalDir, type DaemonCtx, type HostStats, type DockerStats, type DaemonInfo } from "./stats";

const IS_COMPILED = import.meta.dir.includes("$bunfs");
const RUNTIME_DIR = dirname(process.execPath);
const TUI_DIR = IS_COMPILED ? RUNTIME_DIR : import.meta.dir;
const DAEMON_DIR = findDaemonDir();
const DEFAULT_LOG_DIR = `${DAEMON_DIR}/logs`;
const LOG_FILES = ["combined.log", "error.log"];
const VERSION = readVersion(DAEMON_DIR) || readVersion(resolve(TUI_DIR, "..")) || "unknown";

function findDaemonDir(): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [resolve(TUI_DIR, ".."), resolve(TUI_DIR, "../.."), TUI_DIR, RUNTIME_DIR, "/etc/daemon"];
  for (const dir of candidates) {
    try {
      if (
        existsSync(`${dir}/src/app.ts`) ||
        existsSync(`${dir}/airlinkd`) ||
        existsSync(`${dir}/airlinkd.exe`) ||
        existsSync(`${dir}/dist/airlinkd`) ||
        existsSync(`${dir}/dist/airlinkd.exe`) ||
        existsSync(`${dir}/airlinkd-${os}-${arch}${ext}`) ||
        existsSync(`${dir}/airlinkd-${os}-${arch}.exe`)
      ) return dir;
    } catch {
      /* unreadable candidate */
    }
  }
  return candidates[0];
}
const WIDE_MIN_WIDTH = 110;
const BRAND_WIDTH = 58;
const INITIAL_TAIL_LINES = 1000;
const STATS_INTERVAL_MS = 5000;

const ART = [
  "  /$$$$$$ /$$         /$$/$$         /$$      ",
  " /$$__  $|__/        | $|__/        | $$      ",
  "| $$  \\ $$/$$ /$$$$$$| $$/$$/$$$$$$$| $$   /$$",
  "| $$$$$$$| $$/$$__  $| $| $| $$__  $| $$  /$$/",
  "| $$__  $| $| $$  \\__| $| $| $$  \\ $| $$$$$$/ ",
  "| $$  | $| $| $$     | $| $| $$  | $| $$_  $$ ",
  "|__/  |__|__|__/     |__|__|__/  |__|__/  \\__/",
];

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    /* unreadable env file */
  }
  return out;
}

const ENV_KEYS = [
  "key",
  "remote",
  "port",
  "version",
  "STATS_INTERVAL",
  "DEBUG",
  "CONTAINER_RUNTIME",
  "REQUIRE_HMAC",
  "ALLOWED_IPS",
  "TLS_CERT",
  "TLS_KEY",
] as const;

const repoEnv = parseEnvFile(`${DAEMON_DIR}/.env`);
const etcEnv = parseEnvFile("/etc/daemon/.env");
const env: Record<string, string> = {};
for (const k of ENV_KEYS) {
  env[k] = process.env[k] ?? repoEnv[k] ?? etcEnv[k] ?? "";
}

const DAEMON_PORT = Number(env.port || "3002");
const RUNTIME = env.CONTAINER_RUNTIME || "docker";
const REMOTE = env.remote || "localhost";
const KEY = env.key || "";
const REPO_VERSION = VERSION;

function readVersion(dir: string): string {
  const roots = [dir, resolve(dir, "..")];
  for (const root of roots) {
    try {
      const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { version?: string };
      if (pkg?.version) return pkg.version;
    } catch {
      /* no package.json */
    }
  }
  try {
    const cfg = JSON.parse(readFileSync(`${dir}/storage/config.json`, "utf8")) as { meta?: { version?: string } };
    if (cfg?.meta?.version) return cfg.meta.version;
  } catch {
    /* no storage config */
  }
  return "";
}

function findBin(): { bin: string; args: string[]; cwd: string } | null {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch;
  const ext = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    resolve(RUNTIME_DIR, `airlinkd-${os}-${arch}${ext}`),
    resolve(RUNTIME_DIR, `airlinkd${ext}`),
    resolve(RUNTIME_DIR, "dist", `airlinkd-${os}-${arch}${ext}`),
    resolve(RUNTIME_DIR, "dist", `airlinkd${ext}`),
    resolve(DAEMON_DIR, "dist", `airlinkd-${os}-${arch}${ext}`),
    resolve(DAEMON_DIR, "dist", `airlinkd${ext}`),
    resolve(DAEMON_DIR, `airlinkd${ext}`),
    resolve("/etc/daemon", `airlinkd${ext}`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { bin: c, args: ["start"], cwd: DAEMON_DIR };
  }
  return null;
}

function logPath(name: string) {
  return `${LOG_DIR}/${name}`;
}

let LOG_DIR = process.env.AIRLINK_LOG_DIR ?? DEFAULT_LOG_DIR;

function readTail(name: string, from: number): { lines: string[]; nextOffset: number } {
  const path = logPath(name);
  const size = statSync(path).size;
  if (from > size) from = 0;
  if (from === size) return { lines: [], nextOffset: size };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString("utf8");
    const parts = text.split("\n");
    const trailing = parts.pop() ?? "";
    return { lines: parts, nextOffset: size - trailing.length };
  } finally {
    closeSync(fd);
  }
}

function colorForLine(line: string): string {
  if (line.includes("ERROR")) return "#FF6B6B";
  if (line.includes("WARN")) return "#FFD166";
  if (line.includes("INFO")) return "#7CB7FF";
  if (line.includes("OK")) return "#4ADE80";
  return "#9CA3AF";
}

function fmtBytes(n: number): string {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)} MB`;
  if (n >= 2 ** 10) return `${(n / 2 ** 10).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

function fmtDur(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${Math.floor(s)}s`;
}

function bar(pct: number, width = 14): string {
  const c = Math.max(0, Math.min(100, pct));
  const full = Math.floor((c / 100) * width);
  const frac = ((c / 100) * width - full) * 8;
  let s = "█".repeat(full);
  if (full < width) s += "▏▎▍▌▋▊▉█"[Math.floor(frac)];
  s += "░".repeat(Math.max(0, width - full - 1));
  return s;
}

function severity(pct: number): string {
  if (pct >= 85) return "#F87171";
  if (pct >= 65) return "#FBBF24";
  return "#34D399";
}

function daemonLines(d: DaemonInfo, docker: DockerStats): { text: string; fg: string }[] {
  const lines: { text: string; fg: string }[] = [];
  const status = d.online ? "online" : d.mode === "none" ? "down" : "down";
  lines.push({
    text: `● Daemon ${status} · Airlinkd ${d.version || VERSION}`,
    fg: d.online ? "#4ADE80" : "#FF6B6B",
  });
  const mode = d.mode === "managed" ? "managed" : d.mode === "external" ? "external" : "no daemon";
  lines.push({
    text: `  ${RUNTIME} runtime · port ${d.port} · remote ${d.remote}`,
    fg: "#9CA3AF",
  });
  lines.push({
    text: `  ${mode}${d.pid ? ` · pid ${d.pid}` : ""}${d.uptimeSec != null ? ` · up ${fmtDur(d.uptimeSec)}` : ""}`,
    fg: "#9CA3AF",
  });
  lines.push({ text: `  kernel ${d.kernel} · errors 24h ${d.errors24h}`, fg: "#9CA3AF" });
  lines.push({
    text: `  docker ${docker.online ? `online · containers ${docker.containers.filter((c) => c.state === "running").length}/${docker.containers.length}` : docker.error ? docker.error.slice(0, 30) : "offline"}`,
    fg: docker.online ? "#9CA3AF" : "#FF6B6B",
  });
  return lines;
}

function hostLines(h: HostStats): { text: string; fg: string }[] {
  const lines: { text: string; fg: string }[] = [];
  lines.push({ text: `CPU  ${h.cpuPct.toFixed(1).padStart(5)}% ${bar(h.cpuPct, 18)}`, fg: severity(h.cpuPct) });
  const cores = h.perCorePct.slice(0, 8);
  for (let i = 0; i < cores.length; i += 4) {
    const chunk = cores.slice(i, i + 4).map((p, j) => `c${i + j} ${Math.round(p).toString().padStart(2)}%`).join(" ");
    lines.push({ text: `${i === 0 ? "CORE" : "    "} ${chunk}`, fg: "#9CA3AF" });
  }
  if (h.perCorePct.length > 8) {
    lines.push({ text: `     +${h.perCorePct.length - 8} more cores`, fg: "#6B7280" });
  }
  const memPct = h.memTotalGb > 0 ? (h.memUsedGb / h.memTotalGb) * 100 : 0;
  lines.push({
    text: `MEM  ${h.memUsedGb.toFixed(1)}/${h.memTotalGb.toFixed(1)} GB ${bar(memPct, 16)} cached ${h.memCachedGb.toFixed(1)}`,
    fg: severity(memPct),
  });
  if (h.swapTotalGb > 0.1) {
    const swapPct = (h.swapUsedGb / h.swapTotalGb) * 100;
    lines.push({ text: `SWAP ${h.swapUsedGb.toFixed(2)}/${h.swapTotalGb.toFixed(1)} GB ${bar(swapPct, 16)}`, fg: severity(swapPct) });
  } else {
    lines.push({ text: "SWAP none", fg: "#6B7280" });
  }
  lines.push({
    text: `LOAD ${h.load1.toFixed(2)} ${h.load5.toFixed(2)} ${h.load15.toFixed(2)} · UP ${fmtDur(h.sysUptimeSec)} · ${h.procs} procs`,
    fg: "#9CA3AF",
  });
  for (const d of h.disks.slice(0, 3)) {
    lines.push({
      text: `DISK ${d.mount.slice(0, 8).padEnd(8)} ${d.usedGb.toFixed(1)}/${d.totalGb.toFixed(1)} GB ${bar(d.pct, 10)} ${Math.round(d.pct)}%`,
      fg: severity(d.pct),
    });
  }
  for (const n of h.nets) {
    lines.push({
      text: `NET  ${n.iface.slice(0, 8).padEnd(8)} ↓ ${fmtBytes(n.rxBps)}/s ↑ ${fmtBytes(n.txBps)}/s`,
      fg: "#9CA3AF",
    });
  }
  if (h.temps.length > 0) {
    const hot = h.temps.some((t) => t > 70);
    lines.push({ text: `TEMP ${h.temps.map((t) => `${Math.round(t)}°C`).join(" ")}`, fg: hot ? "#F87171" : "#9CA3AF" });
  }
  for (const p of h.topProcs) {
    lines.push({
      text: `TOP  ${p.name.slice(0, 16).padEnd(16)} ${p.cpuPct.toFixed(1).padStart(5)}% ${fmtBytes(p.rssMb * 1e6)}`,
      fg: "#9CA3AF",
    });
  }
  return lines;
}

function clearChildren(container: Renderable) {
  for (const child of Array.from(container.getChildren() as unknown as Renderable[])) {
    container.remove(child);
  }
}

function renderLines(container: Renderable, renderer: ReturnType<typeof createCliRenderer>, lines: { text: string; fg: string }[]) {
  clearChildren(container);
  for (const line of lines) {
    container.add(new TextRenderable(renderer, { content: line.text, fg: line.fg, width: "100%" }));
  }
}

function renderContainers(list: ScrollBoxRenderable, renderer: ReturnType<typeof createCliRenderer>, docker: DockerStats) {
  clearChildren(list);
  if (!docker.online) {
    list.add(new TextRenderable(renderer, { content: `docker ${docker.error ?? "unreachable"}`, fg: "#FF6B6B", width: "100%" }));
    return;
  }
  if (docker.containers.length === 0) {
    list.add(new TextRenderable(renderer, { content: "no containers on this host", fg: "#6B7280", width: "100%" }));
    return;
  }
  list.add(new TextRenderable(renderer, { content: `${"NAME".padEnd(22)} ${"STATE".padEnd(9)} ${"CPU".padStart(6)} ${"MEM".padStart(12)}`, fg: "#60A5FA", width: "100%" }));
  for (const c of docker.containers) {
    const running = c.state === "running";
    const fg = running ? "#34D399" : c.state === "exited" ? "#6B7280" : c.state === "paused" ? "#FBBF24" : "#9CA3AF";
    const cpu = running ? `${c.cpuPct.toFixed(1)}%` : "–";
    const mem = running
      ? c.memLimitMb > 0
        ? `${fmtBytes(c.memUsedMb * 1e6)} / ${fmtBytes(c.memLimitMb * 1e6)}`.padStart(12)
        : fmtBytes(c.memUsedMb * 1e6).padStart(12)
      : "–".padStart(12);
    const row = `${c.name.slice(0, 22).padEnd(22)} ${c.state.padEnd(9)} ${cpu.padStart(6)} ${mem}`;
    list.add(new TextRenderable(renderer, { content: row, fg, width: "100%" }));
  }
}

async function main() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: "#0D1117",
  });

  let daemonChild: ChildProcess | null = null;
  let daemonStartedAt: number | null = null;
  let stopRequested = false;
  let shuttingDown = false;
  let extPid: number | null = null;
  let configError = "";

  const daemonEnv = { ...process.env, ...env, version: REPO_VERSION };

function findBun(): string {
  const exe = process.execPath;
  const base = basename(exe).toLowerCase();
  if (base.includes("bun")) return exe;
  return "bun";
}

function startDaemon() {
  if (daemonChild) return;
  if (!KEY || KEY.length < 16) {
    configError = "no daemon key — create daemon/.env with key= (16+ chars)";
    return;
  }
  stopRequested = false;
  configError = "";
  const found = findBin();
  const child = found
    ? spawn(found.bin, found.args, { cwd: found.cwd, env: daemonEnv, stdio: "ignore" })
    : spawn(findBun(), ["src/app.ts"], { cwd: DAEMON_DIR, env: daemonEnv, stdio: "ignore" });
    daemonChild = child;
    daemonStartedAt = Date.now();
    child.on("error", (error) => {
      configError = `failed to start daemon: ${error.message}`;
      daemonChild = null;
    });
    child.on("exit", (code, signal) => {
      daemonChild = null;
      if (shuttingDown || stopRequested) return;
      setTimeout(() => {
        console.error(`Daemon exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""}) — shutting down.`);
        renderer.destroy();
        process.exit(1);
      }, 2500);
    });
  }

  function stopDaemon() {
    const child = daemonChild;
    if (child) {
      stopRequested = true;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => clearTimeout(timer));
      return;
    }
    if (extPid) {
      try {
        process.kill(extPid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  function shutdownDaemon() {
    const child = daemonChild;
    if (!child) return;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1500);
  }

  async function probeDaemon(): Promise<{ online: boolean; pid: number | null }> {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/healthz`);
      if (res.ok) {
        return { online: true, pid: null };
      }
    } catch {
      /* not running */
    }
    return { online: false, pid: null };
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  const brand = Box(
    {
      id: "brand",
      width: BRAND_WIDTH,
      height: "100%",
      flexDirection: "column",
      paddingX: 1,
      paddingY: 1,
      gap: 1,
      borderStyle: "rounded",
      borderColor: "#374151",
      title: "Airlink Daemon",
      titleColor: "#4ADE80",
    },
    Text({ content: ART.join("\n"), fg: "#4ADE80" }),
    Text({ content: `Airlinkd ${VERSION} · by AirlinkLabs · MIT`, fg: "#60A5FA" })
  );

  const host = Box(
    {
      id: "host",
      flexGrow: 1.2,
      flexDirection: "column",
      gap: 0,
      borderStyle: "rounded",
      borderColor: "#374151",
      title: "Host",
      titleColor: "#60A5FA",
      paddingX: 1,
      paddingY: 1,
    },
    Text({ content: "collecting…", fg: "#6B7280" })
  );
  const contList = new ScrollBoxRenderable(renderer, {
    id: "cont-list",
    width: "100%",
    height: "100%",
    viewportCulling: true,
    scrollbarOptions: {
      trackOptions: { foregroundColor: "#4B5563", backgroundColor: "#1F2937" },
    },
  });
  const cont = Box(
    {
      id: "cont",
      flexGrow: 1,
      flexDirection: "column",
      gap: 0,
      borderStyle: "rounded",
      borderColor: "#374151",
      title: "Containers",
      titleColor: "#60A5FA",
      paddingX: 1,
      paddingY: 1,
    },
    contList
  );
  const midRow = Box({ id: "midrow", flexGrow: 1, flexDirection: "row", gap: 1 }, host, cont);

  const logs = new ScrollBoxRenderable(renderer, {
    id: "logs",
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    viewportCulling: true,
    scrollbarOptions: {
      trackOptions: { foregroundColor: "#4B5563", backgroundColor: "#1F2937" },
    },
  });
  const hintBox = Box({ id: "hint-box", flexDirection: "column", gap: 0 }, Text({ content: "", fg: "#4B5563" }));
  const logsWrap = Box({ id: "logs-wrap", flexGrow: 1, flexDirection: "column" }, logs, hintBox);
  const outer = Box(
    { id: "outer", width: "100%", height: "100%", flexDirection: "column", gap: 1 },
    Box(
      { id: "toprow", flexDirection: "row", gap: 1 },
      brand,
      Box({ id: "status-box", flexGrow: 1, flexDirection: "column", gap: 0, justifyContent: "center", paddingLeft: 1 }, Text({ content: "probing…", fg: "#6B7280" }))
    ),
    midRow,
    logsWrap
  );
  renderer.root.add(outer);

  const realOuter = renderer.root.getRenderable("outer")!;
  const realTopRow = realOuter.getRenderable("toprow")!;
  const realBrand = realTopRow.getRenderable("brand")!;
  const statusBox = realTopRow.getRenderable("status-box")!;
  const realMidRow = realOuter.getRenderable("midrow")!;
  const realHost = realMidRow.getRenderable("host")!;
  const realCont = realMidRow.getRenderable("cont")!;
  const realLogs = realOuter.getRenderable("logs-wrap")!.getRenderable("logs")! as ScrollBoxRenderable;
  const realContList = realCont.getRenderable("cont-list")! as ScrollBoxRenderable;

  function applyLayout() {
    const wide = renderer.width >= WIDE_MIN_WIDTH;
    realTopRow.flexDirection = wide ? "row" : "column";
    realBrand.width = wide ? BRAND_WIDTH : "100%";
    realBrand.height = wide ? "100%" : "auto";
    realMidRow.flexDirection = wide ? "row" : "column";
    realHost.width = wide ? "55%" : "100%";
    realCont.width = wide ? "45%" : "100%";
  }

  function renderHint() {
    clearChildren(hintBox);
    hintBox.add(
      new TextRenderable(renderer, {
        content: `[Tab] logs: ${currentFile} · [k] stop daemon · [r] start · [Ctrl+C] quit`,
        fg: "#4B5563",
        width: "100%",
      })
    );
  }

  // ── Logs ─────────────────────────────────────────────────────────────────
  let currentFile = LOG_FILES[0];
  let offsets: Record<string, number> = {};

  function fillFromFile(name: string) {
    clearChildren(realLogs);
    if (!existsSync(logPath(name))) {
      realLogs.add(
        new TextRenderable(renderer, {
          content: `(no ${name} yet — waiting for daemon logs)`,
          fg: "#6B7280",
          width: "100%",
        })
      );
      return;
    }
    offsets[name] = 0;
    const { lines, nextOffset } = readTail(name, 0);
    offsets[name] = nextOffset;
    for (const line of lines.slice(-INITIAL_TAIL_LINES)) {
      realLogs.add(new TextRenderable(renderer, { content: line, fg: colorForLine(line), width: "100%" }));
    }
  }

  function appendNewLines() {
    if (!existsSync(logPath(currentFile))) return;
    const { lines, nextOffset } = readTail(currentFile, offsets[currentFile] ?? 0);
    offsets[currentFile] = nextOffset;
    for (const line of lines) {
      realLogs.add(new TextRenderable(renderer, { content: line, fg: colorForLine(line), width: "100%" }));
    }
  }

  function switchFile() {
    const idx = LOG_FILES.indexOf(currentFile);
    currentFile = LOG_FILES[(idx + 1) % LOG_FILES.length];
    fillFromFile(currentFile);
    renderHint();
  }

  applyLayout();
  renderHint();

  // ── Refresh ──────────────────────────────────────────────────────────────
  const refreshStats = async () => {
    const now = Date.now();
    const ctx: DaemonCtx = {
      port: DAEMON_PORT,
      managedPid: daemonChild?.pid ?? null,
      managedSince: daemonStartedAt,
      daemonDir: DAEMON_DIR,
      runtime: RUNTIME,
      remote: REMOTE,
      version: REPO_VERSION,
      logsDir: LOG_DIR,
    };
    try {
      const [hostStats, docker, daemon] = await Promise.all([collectHost(now), collectDocker(), collectDaemon(ctx)]);
      extPid = daemon.pid ?? extPid;
      if (daemon.mode === "external" && daemon.pid) {
        const dir = resolveExternalDir(daemon.pid);
        if (dir) {
          if (existsSync(`${dir}/logs`)) LOG_DIR = process.env.AIRLINK_LOG_DIR ?? `${dir}/logs`;
          ctx.daemonDir = dir;
          ctx.logsDir = LOG_DIR;
          ctx.version = readVersion(dir) || env.version || VERSION;
          daemon.version = ctx.version;
        }
      }
      renderLines(statusBox, renderer, daemonLines(daemon, docker));
      renderLines(realHost, renderer, hostLines(hostStats));
      renderContainers(realContList, renderer, docker);
    } catch (error) {
      // keep previous stats if a collection fails
    }
  };
  void refreshStats();
  const statsTimer = setInterval(() => void refreshStats(), STATS_INTERVAL_MS);

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "tab") switchFile();
    else if (key.name === "k") stopDaemon();
    else if (key.name === "r") void probeDaemon().then((p) => {
      if (!p.online) startDaemon();
    });
  });

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(LOG_DIR, { persistent: false }, (_evt, filename) => {
      if (filename && String(filename) === currentFile) appendNewLines();
    });
  } catch {
    /* log dir may not exist yet */
  }

  renderer.on("resize", () => applyLayout());
  process.on("SIGTERM", () => renderer.destroy());
  process.on("SIGHUP", () => renderer.destroy());
  process.on("SIGINT", () => renderer.destroy());
  renderer.on("destroy", () => {
    clearInterval(statsTimer);
    watcher?.close();
    shuttingDown = true;
    shutdownDaemon();
    setTimeout(() => process.exit(0), 2000);
  });

  // ── Startup probe: adopt running daemon or start one ────────────────────
  const probe = await probeDaemon();
  if (probe.online) {
    extPid = null;
    const info = await collectDaemon({
      port: DAEMON_PORT,
      managedPid: null,
      managedSince: null,
      daemonDir: DAEMON_DIR,
      runtime: RUNTIME,
      remote: REMOTE,
      version: REPO_VERSION,
      logsDir: LOG_DIR,
    });
    if (info.pid) {
      extPid = info.pid;
      const dir = resolveExternalDir(info.pid);
      if (dir && existsSync(`${dir}/logs`)) LOG_DIR = process.env.AIRLINK_LOG_DIR ?? `${dir}/logs`;
    }
  } else if (KEY.length >= 16) {
    startDaemon();
  } else {
    configError = "no daemon key — create daemon/.env with key= (16+ chars)";
  }
  if (configError) {
    renderLines(
      hintBox,
      renderer,
      [{ text: configError, fg: "#F87171" }, { text: `[Tab] ${currentFile} · [k] stop daemon · [r] start · [Ctrl+C] quit`, fg: "#4B5563" }]
    );
  }
  fillFromFile(currentFile);
  void refreshStats();
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  const { runDaemon } = await import("../../src/app");
  await runDaemon(cliArgs);
  await new Promise<void>(() => {});
}

void main();
