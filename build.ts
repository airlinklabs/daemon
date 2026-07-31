import { mkdir, rm, writeFile } from 'node:fs/promises';

const outDir = 'dist/daemon';

const ALL_TARGETS = [
  { platform: 'linux', arch: 'x64', target: 'bun-linux-x64', out: `${outDir}/airlinkd-linux-x64` },
  { platform: 'linux', arch: 'x64', target: 'bun-linux-x64-baseline', out: `${outDir}/airlinkd-linux-x64-baseline` },
  { platform: 'linux', arch: 'arm64', target: 'bun-linux-arm64', out: `${outDir}/airlinkd-linux-arm64` },
  { platform: 'macos', arch: 'x64', target: 'bun-darwin-x64', out: `${outDir}/airlinkd-macos-x64` },
  { platform: 'macos', arch: 'arm64', target: 'bun-darwin-arm64', out: `${outDir}/airlinkd-macos-arm64` },
  { platform: 'windows', arch: 'x64', target: 'bun-windows-x64', out: `${outDir}/airlinkd-windows-x64.exe` },
  {
    platform: 'windows',
    arch: 'x64',
    target: 'bun-windows-x64-baseline',
    out: `${outDir}/airlinkd-windows-x64-baseline.exe`,
  },
];

const nativePlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const all = process.env.AIRLINK_DAEMON_ALL === '1';
const targets = all
  ? ALL_TARGETS
  : ALL_TARGETS.filter((t) => t.platform === nativePlatform && (t.arch === process.arch || t.target.endsWith('baseline')));

console.log(`checking TypeScript for ${nativePlatform}-${process.arch}${all ? ' (all targets)' : ''}...`);
const tscProc = Bun.spawn(['bunx', 'tsc', '--noEmit'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
const tscCode = await tscProc.exited;
if (tscCode !== 0) {
  console.error('TypeScript check failed');
  process.exit(1);
}
console.log('TypeScript check passed');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Stub native .node modules before building.
// Bun standalone binaries crash on dlopen of .node files.
// The daemon only uses local Docker sockets, so SSH transport is never needed.

// 1. Stub cpu-features (required by ssh2)
await writeFile(
  'node_modules/cpu-features/lib/index.js',
  'module.exports = function() { return { flags: [], models: [] }; };\n',
);
console.log('patched cpu-features');

// 2. Stub ssh2 native crypto binding
// ssh2 wraps the require in try/catch, but Bun crashes during the dlopen
// itself. We remove the require entirely so ssh2 falls back to JS crypto.
const sshCryptoPath = 'node_modules/ssh2/lib/protocol/crypto.js';
const orig = await Bun.file(sshCryptoPath).text();
if (orig.includes("require('./crypto/build/Release/sshcrypto.node')")) {
  const patched = orig.replace(
    /binding = require\('\.\/crypto\/build\/Release\/sshcrypto\.node'\);/,
    'binding = null; // stubbed: native .node crashes Bun standalone',
  );
  await writeFile(sshCryptoPath, patched);
  console.log('patched ssh2 crypto binding');
}

// 3. Remove .node files so bun build --compile can't try to embed them
try {
  const { execSync } = await import('node:child_process');
  execSync('find node_modules -name "*.node" -delete 2>/dev/null', { stdio: 'ignore' });
  console.log('removed .node files');
} catch {
  /* ignore */
}

for (const { target, out } of targets) {
  console.log(`building ${out}...`);
  const proc = Bun.spawn(['bun', 'build', '--compile', '--target', target, '--outfile', out, 'src/app.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) console.error(`build failed for ${target}`);
  else console.log(`built ${out}`);
}
