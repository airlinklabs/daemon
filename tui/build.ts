import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const targets = [
  { target: "bun-linux-x64", out: "dist/airlinkd-tui-linux-x64" },
  { target: "bun-linux-x64-baseline", out: "dist/airlinkd-tui-linux-x64-baseline" },
  { target: "bun-linux-arm64", out: "dist/airlinkd-tui-linux-arm64" },
  { target: "bun-darwin-x64", out: "dist/airlinkd-tui-macos-x64" },
  { target: "bun-darwin-arm64", out: "dist/airlinkd-tui-macos-arm64" },
  { target: "bun-windows-x64", out: "dist/airlinkd-tui-windows-x64.exe" },
  { target: "bun-windows-x64-baseline", out: "dist/airlinkd-tui-windows-x64-baseline.exe" },
];

if (!existsSync("node_modules/@opentui/core")) {
  console.error("run `bun install` first (tui deps live in tui/package.json)");
  process.exit(1);
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

// Stub native .node modules before building — standalone binaries crash on
// dlopen of .node files. The TUI only uses dockerode's HTTP modem (unix
// socket), so ssh2's native crypto is never invoked.
await writeFile(
  "node_modules/cpu-features/lib/index.js",
  "module.exports = function() { return { flags: [], models: [] }; };\n",
);
const sshCryptoPath = "node_modules/ssh2/lib/protocol/crypto.js";
try {
  const orig = await Bun.file(sshCryptoPath).text();
  if (orig.includes("require('./crypto/build/Release/sshcrypto.node')")) {
    await writeFile(
      sshCryptoPath,
      orig.replace(
        /binding = require\('\.\/crypto\/build\/Release\/sshcrypto\.node'\);/,
        "binding = null; // stubbed: native .node crashes Bun standalone",
      ),
    );
  }
} catch {
  /* ssh2 not present */
}
try {
  execSync('find node_modules -name "*.node" -delete 2>/dev/null', { stdio: "ignore" });
} catch {
  /* nothing to clean */
}

for (const { target, out } of targets) {
  console.log(`building ${out}...`);
  const proc = Bun.spawn(["bun", "build", "--compile", "--target", target, "--outfile", out, "tui/src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) console.error(`build failed for ${target}`);
  else console.log(`built ${out}`);
}
