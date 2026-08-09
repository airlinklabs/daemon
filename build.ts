#!/usr/bin/env bun
// build.ts — Airlinkd release build system
//
// Commands:
//   generate-embedded [--check]  Generate or verify src/embedded.ts
//   package --target <target>     Build binary for a specific target
//   verify                        Verify built binary (version, --help, first-run)
//   smoke                         Run smoke tests on built binaries
//   release-manifest              Generate dist/manifest.json + checksums
//   build                         Full release build (all commands in sequence)
//   build:dev                     Dev build (linux x64 only, no cross-target fetch)
//
// Usage:
//   bun run build.ts generate-embedded --check
//   bun run build.ts package --target bun-linux-x64
//   bun run build.ts verify
//   bun run build.ts smoke
//   bun run build.ts release-manifest
//   bun run build.ts build
//   bun run build.ts build:dev

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ── Constants ────────────────────────────────────────────────────────────────

const ROOT = resolve('.');
const DIST_DIR = join(ROOT, 'dist');
const STORAGE_DIR = join(ROOT, 'storage');
const EMBEDDED_PATH = join(ROOT, 'src', 'embedded.ts');
const MANIFEST_PATH = join(DIST_DIR, 'manifest.json');
const BUN_VERSION = '1.3.12';

// Supported target matrix
const ALL_TARGETS = [
  { platform: 'linux', arch: 'x64', target: 'bun-linux-x64', out: 'airlinkd-linux-x64' },
  { platform: 'linux', arch: 'arm64', target: 'bun-linux-arm64', out: 'airlinkd-linux-arm64' },
  { platform: 'windows', arch: 'x64', target: 'bun-windows-x64', out: 'airlinkd-windows-x64.exe' },
  { platform: 'windows', arch: 'arm64', target: 'bun-windows-arm64', out: 'airlinkd-windows-arm64.exe' },
  { platform: 'macos', arch: 'x64', target: 'bun-darwin-x64', out: 'airlinkd-macos-x64' },
  { platform: 'macos', arch: 'arm64', target: 'bun-darwin-arm64', out: 'airlinkd-macos-arm64' },
] as const;

type Target = { platform: string; arch: string; target: string; out: string };

// Files to embed from storage/ — the allowlist
const EMBEDDED_ALLOWLIST = new Set([
  'storage/config.json',
  'storage/fileSpecifier.json',
]);

// Runtime state — never bundled
const RUNTIME_STORAGE = new Set([
  'sftp_host_ed25519',
  'alc',
  'containerConfigs',
  'install_logs.json',
  'systemStats.json',
]);

// ── Utilities ────────────────────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function fileSha256(filePath: string): string {
  return sha256(readFileSync(filePath));
}

function getGitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitTag(): string | undefined {
  try {
    return execSync('git describe --tags --exact-match 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isDirtyTree(): boolean {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

function getVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function fail(msg: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

// ── Command: generate-embedded ───────────────────────────────────────────────

interface EmbeddedAsset {
  path: string;
  contents: string;
}

function collectStorageFiles(): string[] {
  try {
    const listed = execSync('git ls-files storage/', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (listed.length > 0) return listed;
  } catch {
    // not a git checkout — fall through
  }
  // Fallback: walk the directory, only include allowlisted files
  const walk = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of nodeReaddirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = path.replace(ROOT + '/', '');
      if (RUNTIME_STORAGE.has(entry.name)) continue;
      if (entry.isDirectory()) {
        found.push(...walk(path));
      } else if (EMBEDDED_ALLOWLIST.has(rel)) {
        found.push(path);
      }
    }
    return found;
  };
  return walk(STORAGE_DIR);
}

function generateEmbeddedCode(files: string[]): string {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1).replace(/'/g, "\\'");

  const entries = files.map((file) => {
    const contents = readFileSync(file, 'utf8');
    const relPath = file.replace(ROOT + '/', '');
    return `  {\n    path: '${esc(relPath)}',\n    contents: '${esc(contents)}',\n  },`;
  });

  return `// Auto-generated by build.ts — do not edit by hand.
// Contains the contents of the git-tracked storage/ directory so the
// standalone binary can extract its defaults on first run (see
// src/bootstrap.ts). Regenerated on every build.
//
// Generator: build.ts generate-embedded
// Bun version: ${BUN_VERSION}
// Git commit: ${getGitCommit()}

export interface EmbeddedAsset {
  path: string;
  contents: string;
}

export const EMBEDDED_STORAGE: EmbeddedAsset[] = [
${entries.join('\n')}
];
`;
}

function generateEmbedded(checkOnly: boolean): void {
  console.log('generate-embedded: collecting storage files...');
  const files = collectStorageFiles();

  // Validate against allowlist
  for (const file of files) {
    const rel = file.replace(ROOT + '/', '');
    if (!EMBEDDED_ALLOWLIST.has(rel)) {
      fail(`storage file '${rel}' is not in the embedded allowlist. Add it to EMBEDDED_ALLOWLIST or exclude it.`);
    }
  }

  const code = generateEmbeddedCode(files);

  if (checkOnly) {
    if (!existsSync(EMBEDDED_PATH)) {
      fail('src/embedded.ts does not exist. Run generate-embedded without --check to create it.');
    }
    const existing = readFileSync(EMBEDDED_PATH, 'utf8');
    if (existing !== code) {
      fail('src/embedded.ts is stale. Run: bun run build.ts generate-embedded');
    }
    ok(`embedded assets are current (${files.length} files)`);
    return;
  }

  mkdirSync(join(ROOT, 'src'), { recursive: true });
  writeFileSync(EMBEDDED_PATH, code);
  ok(`embedded ${files.length} storage file(s) into src/embedded.ts`);
}

// ── Command: package ─────────────────────────────────────────────────────────

async function ensurePlatformPackages(): Promise<void> {
  const corePkgPath = join(ROOT, 'node_modules', '@opentui', 'core', 'package.json');
  if (!existsSync(corePkgPath)) return;

  const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'));
  const optional = (corePkg.optionalDependencies ?? {}) as Record<string, string>;

  for (const [name, version] of Object.entries(optional)) {
    const targetDir = join(ROOT, 'node_modules', name);
    if (existsSync(join(targetDir, 'package.json'))) continue;

    const bare = name.startsWith('@') ? name.split('/')[1] : name;
    const url = `https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`;
    console.log(`fetching ${name}@${version} from registry...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);

    const tarball = join(tmpdir(), `${bare}-${version}.tgz`);
    await Bun.write(tarball, await res.arrayBuffer());

    const extractDir = join(ROOT, 'node_modules', '.opentui-staging');
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });

    const { x: tarExtract } = await import('tar');
    await tarExtract({ file: tarball, cwd: extractDir });
    rmSync(tarball, { force: true });
    rename(join(extractDir, 'package'), targetDir);
    rmSync(extractDir, { recursive: true, force: true });
    console.log(`installed ${name}@${version}`);
  }
}

function stubNativeModules(): void {
  // Stub cpu-features (required by ssh2, never actually called)
  writeFileSync(
    join(ROOT, 'node_modules/cpu-features/lib/index.js'),
    'module.exports = function() { return { flags: [], models: [] }; };\n',
  );
  console.log('patched cpu-features');

  // Stub ssh2 native crypto binding — ssh2 wraps in try/catch but Bun crashes
  // on dlopen. Remove the require so ssh2 falls back to JS crypto.
  const sshCryptoPath = join(ROOT, 'node_modules/ssh2/lib/protocol/crypto.js');
  if (existsSync(sshCryptoPath)) {
    const orig = readFileSync(sshCryptoPath, 'utf8');
    if (orig.includes("require('./crypto/build/Release/sshcrypto.node')")) {
      const patched = orig.replace(
        /binding = require\('\.\/crypto\/build\/Release\/sshcrypto\.node'\);/,
        'binding = null; // stubbed: native .node crashes Bun standalone',
      );
      writeFileSync(sshCryptoPath, patched);
      console.log('patched ssh2 crypto binding');
    }
  }

  // Remove .node files so bun build --compile can't try to embed them
  try {
    execSync('find node_modules -name "*.node" -delete 2>/dev/null', { stdio: 'ignore' });
    console.log('removed .node files');
  } catch {
    // ignore
  }
}

async function packageBinary(target: Target): Promise<void> {
  const outPath = join(DIST_DIR, target.out);

  // Stage in temp dir, then atomic move
  const stagingDir = join(tmpdir(), `airlinkd-build-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });
  const stagingOut = join(stagingDir, target.out);

  console.log(`packaging ${target.out}...`);
  const proc = Bun.spawn(
    ['bun', 'build', '--compile', '--target', target.target, '--outfile', stagingOut, 'src/app.ts'],
    { stdout: 'inherit', stderr: 'inherit', cwd: ROOT },
  );
  const code = await proc.exited;
  if (code !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    fail(`build failed for ${target.target}`);
  }

  // Verify the staged binary exists and has non-zero size
  const stat = statSync(stagingOut);
  if (stat.size === 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    fail(`built binary is empty: ${target.out}`);
  }

  // Atomic move to dist/
  mkdirSync(DIST_DIR, { recursive: true });
  rename(stagingOut, outPath);
  rmSync(stagingDir, { recursive: true, force: true });
  ok(`built ${target.out} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

// ── Command: verify ──────────────────────────────────────────────────────────

async function verifyBinary(binaryPath: string): Promise<void> {
  console.log(`verifying ${binaryPath}...`);

  // Check file exists and is executable
  if (!existsSync(binaryPath)) {
    fail(`binary not found: ${binaryPath}`);
  }

  // Version check
  try {
    const version = execSync(`${binaryPath} version`, { encoding: 'utf8', timeout: 10000 }).trim();
    const pkgVersion = getVersion();
    if (!version.includes(pkgVersion)) {
      fail(`version mismatch: expected ${pkgVersion}, got ${version}`);
    }
    ok(`version: ${version}`);
  } catch (e) {
    fail(`version check failed: ${e}`);
  }

  // --help check
  try {
    const help = execSync(`${binaryPath} --help`, { encoding: 'utf8', timeout: 10000 });
    if (!help.includes('airlinkd')) {
      fail('--help output missing "airlinkd"');
    }
    ok('--help works');
  } catch (e) {
    fail(`--help check failed: ${e}`);
  }

  // First-run isolation test: run in a clean temp directory
  const testDir = join(tmpdir(), `airlinkd-verify-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  try {
    // The binary should create default dirs and .env on first run
    const proc = Bun.spawn([binaryPath, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, DAEMON_DATA_ROOT: testDir },
      cwd: testDir,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      fail(`first-run test failed (exit ${exitCode}): ${stderr}`);
    }
    ok('first-run: exits cleanly');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ── Command: smoke ───────────────────────────────────────────────────────────

async function smokeTest(): Promise<void> {
  console.log('running smoke tests...');

  // Find the native binary (airlinkd without platform suffix)
  const nativeBin = join(DIST_DIR, 'airlinkd');
  if (!existsSync(nativeBin)) {
    // Fall back to the host-platform binary
    const hostTarget = ALL_TARGETS.find(
      (t) =>
        t.platform ===
          (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux') &&
        t.arch === process.arch,
    );
    if (!hostTarget) {
      fail('no native binary found for smoke test');
    }
    await verifyBinary(join(DIST_DIR, hostTarget.out));
  } else {
    await verifyBinary(nativeBin);
  }

  ok('smoke tests passed');
}

// ── Command: release-manifest ────────────────────────────────────────────────

function generateManifest(): void {
  console.log('generating release manifest...');

  mkdirSync(DIST_DIR, { recursive: true });

  const version = getVersion();
  const commit = getGitCommit();
  const tag = getGitTag();
  const dirty = isDirtyTree();
  const artifacts: Record<string, { sha256: string; size: number }> = {};

  for (const entry of nodeReaddirSync(DIST_DIR)) {
    const fullPath = join(DIST_DIR, entry);
    if (entry === 'manifest.json' || entry.endsWith('.sha256')) continue;
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;

    const hash = fileSha256(fullPath);
    artifacts[entry] = { sha256: hash, size: stat.size };

    // Write detached checksum
    writeFileSync(join(DIST_DIR, `${entry}.sha256`), `${hash}  ${entry}\n`);
    console.log(`  ${entry}: ${hash.slice(0, 12)}... (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  // Compute embedded assets hash
  let embeddedHash = 'none';
  if (existsSync(EMBEDDED_PATH)) {
    embeddedHash = fileSha256(EMBEDDED_PATH);
  }

  const manifest = {
    version,
    gitCommit: commit,
    gitTag: tag ?? null,
    dirtyTree: dirty,
    buildTimestamp: new Date().toISOString(),
    bunVersion: BUN_VERSION,
    generatorVersion: '1.0',
    embeddedAssetsHash: embeddedHash,
    license: 'See LICENSE in repository root',
    artifacts,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  ok(`manifest written: ${MANIFEST_PATH}`);

  // Verify manifest checksums match
  for (const [name, info] of Object.entries(artifacts)) {
    const actual = fileSha256(join(DIST_DIR, name));
    if (actual !== info.sha256) {
      fail(`checksum mismatch for ${name}: manifest says ${info.sha256}, computed ${actual}`);
    }
  }
  ok('all checksums verified');
}

// ── Command: build ───────────────────────────────────────────────────────────

async function fullBuild(dev: boolean): Promise<void> {
  const startTime = Date.now();
  const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  // 1. Verify Bun version
  const bunVersion = execSync('bun --version', { encoding: 'utf8' }).trim();
  if (bunVersion !== BUN_VERSION) {
    fail(`Bun version mismatch: expected ${BUN_VERSION}, got ${bunVersion}`);
  }
  ok(`bun version: ${bunVersion}`);

  // 2. TypeScript check
  console.log('running TypeScript check...');
  const tscProc = Bun.spawn(['bunx', 'tsc', '--noEmit'], { stdout: 'inherit', stderr: 'inherit', cwd: ROOT });
  if ((await tscProc.exited) !== 0) {
    fail('TypeScript check failed');
  }
  ok('TypeScript check passed');

  // 3. Generate embedded assets
  generateEmbedded(false);

  // 4. Ensure cross-target platform packages (skip for dev builds)
  if (!dev) {
    await ensurePlatformPackages();
  }

  // 5. Stub native modules
  stubNativeModules();

  // 6. Clean dist/
  mkdirSync(DIST_DIR, { recursive: true });
  try {
  for (const entry of nodeReaddirSync(DIST_DIR)) {
    if (entry === 'manifest.json') continue;
    rmSync(join(DIST_DIR, entry), { force: true });
    }
  } catch {
    // dist/ may not exist yet
  }

  // 7. Build targets
  const targets = dev
    ? [{ platform: 'linux' as const, arch: 'x64' as const, target: 'bun-linux-x64' as const, out: 'airlinkd' as const }]
    : ALL_TARGETS;

  let built = 0;
  for (const t of targets) {
    try {
      await packageBinary(t);
      built++;
    } catch (e) {
      console.error(`target ${t.target} failed: ${e}`);
      fail(`build failed — ${built}/${targets.length} targets succeeded`);
    }
  }

  // 8. Copy native target as `airlinkd` (full builds only)
  if (!dev) {
    const nativeTarget = ALL_TARGETS.find(
      (t) =>
        t.platform ===
          (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux') &&
        t.arch === process.arch,
    );
    if (nativeTarget) {
      const src = join(DIST_DIR, nativeTarget.out);
      const dst = join(DIST_DIR, 'airlinkd');
      await copyFile(src, dst);
      console.log(`copied ${nativeTarget.out} -> airlinkd`);
    }
  }

  // 9. Verify native binary
  const nativeBin = join(DIST_DIR, 'airlinkd');
  if (existsSync(nativeBin)) {
    await verifyBinary(nativeBin);
  }

  // 10. Generate manifest + checksums (full builds only)
  if (!dev) {
    generateManifest();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nbuild complete in ${elapsed}s (${built} targets)`);
}

// ── CLI Router ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] ?? 'build';
const isDev = args.includes('--dev') || command === 'build:dev';

switch (command) {
  case 'generate-embedded': {
    const checkOnly = args.includes('--check');
    generateEmbedded(checkOnly);
    break;
  }
  case 'package': {
    const targetArg = args.find((a) => a.startsWith('--target='));
    if (!targetArg) fail('usage: build.ts package --target <target>');
    const targetName = targetArg.split('=')[1];
    const target = ALL_TARGETS.find((t) => t.target === targetName);
    if (!target) fail(`unknown target: ${targetName}. Available: ${ALL_TARGETS.map((t) => t.target).join(', ')}`);
    packageBinary(target).catch((e) => fail(String(e)));
    break;
  }
  case 'verify': {
    const binArg = args.find((a) => a.startsWith('--binary='));
    const binPath = binArg ? binArg.split('=')[1] : join(DIST_DIR, 'airlinkd');
    verifyBinary(binPath).catch((e) => fail(String(e)));
    break;
  }
  case 'smoke':
    smokeTest().catch((e) => fail(String(e)));
    break;
  case 'release-manifest':
    generateManifest();
    break;
  case 'build':
    fullBuild(false).catch((e) => fail(String(e)));
    break;
  case 'build:dev':
    fullBuild(true).catch((e) => fail(String(e)));
    break;
  default:
    fail(`unknown command: ${command}\nAvailable: generate-embedded, package, verify, smoke, release-manifest, build, build:dev`);
}
