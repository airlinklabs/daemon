const targets = [
  { target: "bun-linux-x64", out: "dist/airlinkd-linux-x64" },
  { target: "bun-linux-x64-baseline", out: "dist/airlinkd-linux-x64-baseline" },
  { target: "bun-linux-arm64", out: "dist/airlinkd-linux-arm64" },
  { target: "bun-darwin-x64", out: "dist/airlinkd-macos-x64" },
  { target: "bun-darwin-arm64", out: "dist/airlinkd-macos-arm64" },
  { target: "bun-windows-x64", out: "dist/airlinkd-windows-x64.exe" },
  { target: "bun-windows-x64-baseline", out: "dist/airlinkd-windows-x64-baseline.exe" },
];

for (const { target, out } of targets) {
  console.log(`building ${out}...`);
  const bunExec = process.execPath || Bun.which?.("bun") || "bun";
  const proc = Bun.spawn([
    bunExec,
    "build",
    "--compile",
    "--target",
    target,
    "--outfile",
    out,
    "src/app.ts",
  ], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) console.error(`build failed for ${target}`);
  else console.log(`built ${out}`);
}

export {};
