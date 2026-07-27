import { mkdir, rm, writeFile } from 'node:fs/promises';

const targets = [
  { target: 'bun-linux-x64', out: 'dist/airlinkd-linux-x64' },
  { target: 'bun-linux-x64-baseline', out: 'dist/airlinkd-linux-x64-baseline' },
  { target: 'bun-linux-arm64', out: 'dist/airlinkd-linux-arm64' },
  { target: 'bun-darwin-x64', out: 'dist/airlinkd-macos-x64' },
  { target: 'bun-darwin-arm64', out: 'dist/airlinkd-macos-arm64' },
  { target: 'bun-windows-x64', out: 'dist/airlinkd-windows-x64.exe' },
  {
    target: 'bun-windows-x64-baseline',
    out: 'dist/airlinkd-windows-x64-baseline.exe',
  },
];

console.log('checking TypeScript...');
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

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

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
import { unlinkSync } from 'node:fs';
import { globSync } from 'node:fs';

const { execSync } = await import('node:child_process');
try {
  execSync('find node_modules -name "*.node" -delete 2>/dev/null', { stdio: 'ignore' });
  console.log('removed .node files');
} catch {}

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
