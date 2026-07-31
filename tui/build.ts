import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const base = import.meta.dir;

const ALL_TARGETS = [
  { platform: "linux", arch: "x64", baseline: false, target: "bun-linux-x64", out: resolve(base, "dist/airlinkd-tui-linux-x64") },
  { platform: "linux", arch: "x64", baseline: true, target: "bun-linux-x64-baseline", out: resolve(base, "dist/airlinkd-tui-linux-x64-baseline") },
  { platform: "linux", arch: "arm64", baseline: false, target: "bun-linux-arm64", out: resolve(base, "dist/airlinkd-tui-linux-arm64") },
  { platform: "macos", arch: "x64", baseline: false, target: "bun-darwin-x64", out: resolve(base, "dist/airlinkd-tui-macos-x64") },
  { platform: "macos", arch: "arm64", baseline: false, target: "bun-darwin-arm64", out: resolve(base, "dist/airlinkd-tui-macos-arm64") },
  { platform: "windows", arch: "x64", baseline: false, target: "bun-windows-x64", out: resolve(base, "dist/airlinkd-tui-windows-x64.exe") },
  { platform: "windows", arch: "x64", baseline: true, target: "bun-windows-x64-baseline", out: resolve(base, "dist/airlinkd-tui-windows-x64-baseline.exe") },
];

const all = process.env.AIRLINK_TUI_ALL === "1";
const nativePlatform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const targets = all
  ? ALL_TARGETS
  : ALL_TARGETS.filter((t) => t.platform === nativePlatform && (t.baseline || t.arch === process.arch));

console.log(`building ${targets.length} target(s) for ${nativePlatform}${process.arch}${all ? " (all)" : " — set AIRLINK_TUI_ALL=1 to attempt every platform"}`);

if (!existsSync(resolve(base, "node_modules/@opentui/core"))) {
  console.error("run `bun install` first (tui deps live in tui/package.json)");
  process.exit(1);
}

await rm(resolve(base, "dist"), { recursive: true, force: true });
await mkdir(resolve(base, "dist"), { recursive: true });

try {
  execSync(`find ${base}/node_modules -name "*.node" -delete 2>/dev/null`, { stdio: "ignore" });
} catch {
  /* nothing to clean */
}

for (const { target, out } of targets) {  console.log(`building ${out}...`);
  const proc = Bun.spawn(["bun", "build", "--compile", "--target", target, "--outfile", out, resolve(base, "src/index.ts")], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) console.error(`build failed for ${target}`);
  else console.log(`built ${out}`);
}
