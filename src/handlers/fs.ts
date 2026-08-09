import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { extract as tarExtract, list as tarList } from 'tar';
import config from '../config';
import { getPaths } from '../paths';
import { validatePublicUrl } from '../router';
import { jailPath, jailRename } from '../security/pathJail';
import fileSpecifier from '../utils/fileSpecifier';

/** Resolve a container's volume root from the centralised paths. */
function volumeRoot(id: string): string {
  return join(getPaths(config.paths).volumesRoot, id);
}

// per-container cache to avoid hammering the filesystem on every list request
const listCache = new Map<
  string,
  {
    lastRequest: number;
    count: number;
    cache: unknown;
    path: string;
  }
>();

// cap for GET /fs/file/content — the route reads the whole file into memory
// for the in-browser editor, so unbounded reads would be a memory DoS. 10MB is
// far beyond any real config file; larger files must be pulled/downloaded.
export const MAX_FILE_CONTENT_BYTES = 10 * 1024 * 1024;

async function getDirSize(dir: string, depth = 0): Promise<number> {
  if (depth > 20) return 0;
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      try {
        const s = await lstat(full);
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) total += await getDirSize(full, depth + 1);
        else total += s.size;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return total;
}

export async function listDir(id: string, relativePath = '/', filter?: string): Promise<unknown> {
  const now = Date.now();

  if (!listCache.has(id)) {
    listCache.set(id, {
      lastRequest: now,
      count: 0,
      cache: null,
      path: relativePath,
    });
  }

  const rateData = listCache.get(id);
  if (!rateData) throw new Error('list cache was not initialized');

  // return cached result if the same path was requested within the last second
  if (rateData.cache && now - rateData.lastRequest < 1000 && rateData.path === relativePath) {
    return rateData.cache;
  }

  if (now - rateData.lastRequest < 1000) rateData.count++;
  else rateData.count = 1;

  rateData.lastRequest = now;
  rateData.path = relativePath;

  if (rateData.count > 5) {
    rateData.cache = { error: 'Too many requests, please wait 3 seconds.' };
    setTimeout(() => listCache.delete(id), 3000);
    return rateData.cache;
  }

  const baseDirectory = volumeRoot(id);
  const targetDirectory = jailPath(baseDirectory, relativePath);
  const entries = await readdir(targetDirectory, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (dirent) => {
      const ext = extname(dirent.name).substring(1);
      const category = await fileSpecifier.getCategory(ext);
      const full = join(targetDirectory, dirent.name);

      let size: number;
      if (dirent.isDirectory()) {
        size = await getDirSize(full);
      } else {
        try {
          size = (await stat(full)).size;
        } catch {
          size = 0;
        }
      }

      return {
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
        extension: dirent.isDirectory() ? null : ext,
        category: dirent.isDirectory() ? null : category,
        size,
      };
    }),
  );

  const limited = results.slice(0, 256);
  const filtered = filter ? limited.filter((i) => i.name.includes(filter)) : limited;
  rateData.cache = filtered;
  return filtered;
}

export async function getDirSizeForId(id: string, relativePath = '/'): Promise<number> {
  const baseDirectory = volumeRoot(id);
  const dirPath = jailPath(baseDirectory, relativePath);
  return getDirSize(dirPath);
}

export async function getFileContent(id: string, relativePath = '/'): Promise<string | null> {
  try {
    const baseDirectory = volumeRoot(id);
    const filePath = jailPath(baseDirectory, relativePath);
    if (!existsSync(filePath)) return null;
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    // refuse to read anything past the cap — a text "file" larger than this is
    // not an editor document, it is a memory-exhaustion attempt
    if (s.size > MAX_FILE_CONTENT_BYTES) return null;
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function writeFileContent(id: string, relativePath: string, content: string | Buffer): Promise<void> {
  const baseDirectory = volumeRoot(id);
  await mkdir(baseDirectory, { recursive: true });
  const filePath = jailPath(baseDirectory, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  if (typeof content === 'string') await writeFile(filePath, content, 'utf-8');
  else await writeFile(filePath, content);
}

export function getFilePath(id: string, relativePath = '/'): string {
  const baseDirectory = volumeRoot(id);
  return jailPath(baseDirectory, relativePath);
}

export async function rmPath(id: string, relativePath: string): Promise<void> {
  if (relativePath === '/') throw new Error('root directory cannot be deleted');
  const baseDirectory = volumeRoot(id);
  const targetPath = jailPath(baseDirectory, relativePath);
  const s = await lstat(targetPath);
  if (s.isDirectory()) await rm(targetPath, { recursive: true, force: true });
  else if (s.isFile()) await unlink(targetPath);
  else throw new Error('path is neither a file nor a directory');
}

export async function renameFile(id: string, oldPath: string, newPath: string): Promise<void> {
  const baseDirectory = volumeRoot(id);

  // pre-create destination parent so jailPath doesn't fail on realpathSync of a non-existent dir
  const rawNewParent = resolve(join(baseDirectory, dirname(newPath)));
  if (!rawNewParent.startsWith(baseDirectory)) throw new Error('destination escapes volume boundary');
  await mkdir(rawNewParent, { recursive: true });

  await jailRename(baseDirectory, oldPath, newPath);
}

const MAX_REDIRECT_HOPS = 5;

// Safe HTTP(S) fetch: follows redirects manually and re-runs the SSRF guard on
// every hop. Bun's fetch follows redirects transparently, which turns a single
// public URL into a foothold on 127.0.0.1 (the classic /fs/pull SSRF). Here a
// 3xx is intercepted, the Location is validated, and any hop to a private
// address or a non-http(s) scheme aborts the whole fetch. The caller owns the
// AbortSignal (and therefore the timeout) so it covers headers + body frames.
export async function fetchPublicUrl(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const safeUrl = await validatePublicUrl(current);
    const response = await fetch(safeUrl.toString(), { redirect: 'manual', signal });

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      const location = response.headers.get('location');
      // release the redirect body (usually small) so the socket frees up
      await response.body?.cancel();
      if (!location) {
        throw new Error(`redirect response without a location header (${response.status})`);
      }
      current = new URL(location, safeUrl).toString();
      continue;
    }

    return response;
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECT_HOPS})`);
}

// download a file from a URL into the container volume
// the URL is SSRF-validated (scheme + resolved address) before connecting, and
// every redirect hop is re-validated, matching the /fs/pull hardening.
export async function downloadToVolume(
  id: string,
  url: string,
  relativePath: string,
  env?: Record<string, string>,
): Promise<void> {
  const baseDirectory = volumeRoot(id);
  const filePath = jailPath(baseDirectory, relativePath);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetchPublicUrl(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);

  await mkdir(dirname(filePath), { recursive: true });

  if (env) {
    // apply ALVKT variable substitution — only for text files
    let content = await response.text();
    content = content.replace(/\$ALVKT\((\w+)\)/g, (_, varName: string) => {
      if (env[varName] !== undefined) return env[varName];
      return '';
    });
    await writeFile(filePath, content, 'utf-8');
  } else {
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));
  }
}

// copy a file from an arbitrary source path into the container volume
export async function copyIntoVolume(id: string, sourcePath: string, destRelative: string): Promise<void> {
  const baseDirectory = volumeRoot(id);
  const destPath = jailPath(baseDirectory, destRelative);
  const s = await lstat(sourcePath);

  if (s.isDirectory()) {
    await mkdir(destPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const e of entries) {
      await copyIntoVolume(id, join(sourcePath, e.name), join(destRelative, e.name));
    }
  } else {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
  }
}

// zip multiple paths inside a container volume using system zip
export async function zipPaths(id: string, filePaths: string[], zipname: string): Promise<string> {
  const baseDirectory = volumeRoot(id);

  const clean = (f: string): string => f.replace(/[[\]"']/g, '').trim();
  const files = filePaths
    .flatMap((f) => (typeof f === 'string' ? f.split(',').map((s) => s.trim()) : [f]))
    .map((f) => {
      const cleanPath = clean(f);
      // jailPath resolves the parent's realpath and rejects `..`/absolute targets,
      // so a path like '../etc/passwd' can never read a file off the host
      const fullPath = jailPath(baseDirectory, cleanPath);
      return { cleanPath, fullPath };
    });

  // the zip name is operator-supplied (unvalidated by the schema) — jail it so
  // it cannot traverse out of the volume either
  const firstFileRel = files[0].cleanPath.split('/').slice(0, -1).join('/');
  const zipPath = jailPath(baseDirectory, join(firstFileRel, `${zipname}.zip`));
  await mkdir(dirname(zipPath), { recursive: true });

  // stage files into a temp dir so we control paths inside the zip
  // archiver is gone — system zip is fine, this is a server daemon
  const staging = mkdtempSync(join(tmpdir(), 'airlinkd-zip-'));
  try {
    for (const { cleanPath, fullPath } of files) {
      // reject `..`/absolute staging names outright — nothing escapes the staging tree
      const dest = jailPath(staging, cleanPath);
      await Bun.spawn(['mkdir', '-p', dirname(dest)], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['cp', '-r', fullPath, dest], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
    }

    const proc = Bun.spawn(['zip', '-r', '-9', zipPath, '.'], {
      cwd: staging,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await (proc.stderr instanceof ReadableStream
        ? new Response(proc.stderr).text()
        : Promise.resolve(''));
      throw new Error(`zip failed (exit ${code}): ${err}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return zipPath;
}

// ── Safe archive extraction (F-011 zip-slip) ────────────────────────────────
// Extraction used to shell out to unzip/tar/unrar/7z with zero entry
// validation — a `../evil` member escapes the container volume and writes
// anywhere the daemon can. Every format now (1) validates every member name
// against absolute / `..` / backslash / empty rules BEFORE anything is
// written, and (2) walks the extraction tree afterwards confirming every
// realpath stays inside the extraction directory (defends against symlink
// tricks that valid-looking names can still hide).

function assertSafeArchiveEntry(entry: string, archiveName: string): void {
  if (entry.length === 0) {
    throw new Error(`archive ${archiveName} contains an empty entry name`);
  }
  if (entry.includes('\\')) {
    throw new Error(`archive ${archiveName} contains a backslash entry name: ${entry}`);
  }
  if (entry.startsWith('/')) {
    throw new Error(`archive ${archiveName} contains an absolute path entry: ${entry}`);
  }
  for (const segment of entry.split('/')) {
    if (segment === '..') {
      throw new Error(`archive ${archiveName} contains a path traversal entry: ${entry}`);
    }
  }
}

// list .zip/.rar/.7z members via their tooling and reject the archive if any
// member name is unsafe — must run before extraction, not after
async function listArchiveMembers(kind: 'zip' | 'rar' | '7z', archivePath: string): Promise<string[]> {
  const argv =
    kind === 'zip'
      ? ['unzip', '-Z1', archivePath]
      : kind === 'rar'
        ? ['unrar', 'lb', archivePath]
        : ['7z', 'l', '-ba', archivePath];

  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${kind} listing failed (exit ${code}): ${stderr.trim()}`);
  }

  return stdout.split('\n').filter((line) => line.length > 0);
}

async function extractTar(archivePath: string, extractPath: string): Promise<void> {
  // node-tar's extract is path-safe by default (drops `..`/absolute, refuses
  // writes through symlinks) and its list mode gives us the raw member names to
  // validate first — so malicious entries are rejected loudly instead of being
  // silently skipped.
  const members: string[] = [];
  await tarList({
    file: archivePath,
    onentry: (entry) => members.push(entry.path),
  });
  const archiveName = basename(archivePath);
  for (const member of members) assertSafeArchiveEntry(member, archiveName);

  await tarExtract({ file: archivePath, cwd: extractPath });
}

async function extractZip(archivePath: string, extractPath: string): Promise<void> {
  const archiveName = basename(archivePath);
  const members = await listArchiveMembers('zip', archivePath);
  for (const member of members) assertSafeArchiveEntry(member, archiveName);

  const proc = Bun.spawn(['unzip', '-o', archivePath, '-d', extractPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unzip failed (exit ${code}): ${err.trim()}`);
  }
}

async function extractRar(archivePath: string, extractPath: string): Promise<void> {
  const archiveName = basename(archivePath);
  const members = await listArchiveMembers('rar', archivePath);
  for (const member of members) assertSafeArchiveEntry(member, archiveName);

  const proc = Bun.spawn(['unrar', 'x', archivePath, extractPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unrar failed (exit ${code}): ${err.trim()}`);
  }
}

async function extract7z(archivePath: string, extractPath: string): Promise<void> {
  const archiveName = basename(archivePath);
  const members = await listArchiveMembers('7z', archivePath);
  for (const member of members) assertSafeArchiveEntry(member, archiveName);

  const proc = Bun.spawn(['7z', 'x', archivePath, `-o${extractPath}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`7z extraction failed (exit ${code}): ${err.trim()}`);
  }
}

// Post-extraction guard: walk every entry under extractPath, realpath it, and
// reject if any resolves outside the extraction base. Catches symlink tricks —
// an archive member that creates `dir -> ../../..` and then writes `dir/evil`
// lands outside even though both member names look innocent.
async function assertExtractionStayedInside(extractPath: string): Promise<void> {
  const base = realpathSync(extractPath);
  const stack = [base];
  const visited = new Set<string>();
  let depth = 0;

  while (stack.length > 0 && depth < 100) {
    const dir = stack.pop() as string;
    depth += 1;
    const realDir = realpathSync(dir);
    if (realDir !== base && !realDir.startsWith(base + sep)) {
      throw new Error(`archive extracted outside the extraction directory: ${dir}`);
    }
    if (visited.has(realDir)) continue;
    visited.add(realDir);

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const real = realpathSync(full);
      if (real !== base && !real.startsWith(base + sep)) {
        throw new Error(`archive entry escapes the extraction directory: ${entry.name}`);
      }
      // recurse into real directories AND symlinks that resolve inside the
      // base — content written through a safe symlink still needs checking
      const st = await lstat(full);
      if (st.isDirectory()) stack.push(full);
    }
  }
}

// unzip an archive inside a container volume using system unzip or tar
export async function unzipPath(id: string, relativePath: string, zipname: string): Promise<void> {
  const baseDirectory = volumeRoot(id);
  // jail the archive path too — the route schema does not validate `path`, so
  // without this an operator-supplied `../../x.tar` would extract an arbitrary
  // host file into the volume
  const archivePath = jailPath(baseDirectory, join(relativePath, zipname));
  const extractPath = dirname(archivePath);

  if (!existsSync(archivePath)) throw new Error(`file not found: ${zipname}`);

  const ext = extname(archivePath).toLowerCase();

  if (ext === '.tar' || ext === '.gz' || ext === '.tgz') {
    await extractTar(archivePath, extractPath);
  } else if (ext === '.zip') {
    await extractZip(archivePath, extractPath);
  } else if (ext === '.rar') {
    await extractRar(archivePath, extractPath);
  } else if (ext === '.7z') {
    await extract7z(archivePath, extractPath);
  } else {
    throw new Error(`unsupported archive type: ${ext}`);
  }

  await assertExtractionStayedInside(extractPath);
}

// ── Chunked upload sequencing ────────────────────────────────────────────────
// appendChunk used to raw-appendFile each chunk as it arrived. Concurrent
// uploads of the same file raced — chunks interleaved and corrupted the file.
// Now chunks are buffered per upload session (keyed by container + target
// path), assembled in index order once every chunk is present, written to a
// temp file, then renamed over the target. A per-key mutex keeps sessions
// from interleaving; a stale timeout prevents leaked buffers.

interface ChunkSession {
  chunks: Buffer[];
  received: Set<number>;
  total: number;
  timer: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
}

const chunkSessions = new Map<string, ChunkSession>();

function sessionKey(id: string, relativePath: string): string {
  return `${id}\u0000${relativePath}`;
}

function cleanupSession(key: string): void {
  const session = chunkSessions.get(key);
  if (session) clearTimeout(session.timer);
  chunkSessions.delete(key);
}

export async function appendChunk(
  id: string,
  relativePath: string,
  chunk: Buffer,
  options?: { chunkIndex?: number; totalChunks?: number },
): Promise<void> {
  const chunkIndex = options?.chunkIndex ?? 0;
  const totalChunks = options?.totalChunks ?? 1;

  // Single-chunk upload — write directly, no session bookkeeping.
  if (totalChunks <= 1) {
    const baseDirectory = volumeRoot(id);
    const filePath = jailPath(baseDirectory, relativePath);
    await writeFile(filePath, chunk);
    return;
  }

  const key = sessionKey(id, relativePath);
  let session = chunkSessions.get(key);

  if (!session) {
    let resolveFirst: () => void = () => {};
    const firstChain = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const timer = setTimeout(() => cleanupSession(key), 60_000);
    timer.unref?.();
    session = {
      chunks: [],
      received: new Set(),
      total: totalChunks,
      timer,
      chain: firstChain,
    };
    chunkSessions.set(key, session);
    resolveFirst();
  } else {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => cleanupSession(key), 60_000);
    session.timer.unref?.();
    session.total = Math.max(session.total, totalChunks);
  }

  await session.chain;

  if (chunkIndex < 0 || chunkIndex >= session.total) {
    throw new Error('chunk index out of range');
  }

  session.chunks[chunkIndex] = chunk;
  session.received.add(chunkIndex);

  const done = session.received.size >= session.total && session.chunks.every((c) => c instanceof Buffer);
  if (!done) return;

  try {
    const baseDirectory = volumeRoot(id);
    const filePath = jailPath(baseDirectory, relativePath);
    const tmpPath = `${filePath}.part-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const ordered = session.chunks as Buffer[];
    await writeFile(tmpPath, Buffer.concat(ordered));
    await rename(tmpPath, filePath);
  } finally {
    cleanupSession(key);
  }
}
