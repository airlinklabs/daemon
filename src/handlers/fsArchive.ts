import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { extract as tarExtract, list as tarList } from 'tar';
import config from '../config';
import { getPaths } from '../paths';
import { jailPath, secureWriteFile } from '../security/pathJail';

function volumeRoot(id: string): string {
  return join(getPaths(config.paths).volumesRoot, id);
}

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
      const st = lstatSync(full);
      if (st.isDirectory()) stack.push(full);
    }
  }
}

export async function unzipPath(id: string, relativePath: string, zipname: string): Promise<void> {
  const baseDirectory = volumeRoot(id);
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

  if (totalChunks <= 1) {
    const baseDirectory = volumeRoot(id);
    const filePath = jailPath(baseDirectory, relativePath);
    // Use secure write to prevent TOCTOU symlink races
    secureWriteFile(baseDirectory, relativePath, chunk);
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
    // Use secure write for the temp file, then atomic rename
    await writeFile(tmpPath, Buffer.concat(ordered));
    await rename(tmpPath, filePath);
  } finally {
    cleanupSession(key);
  }
}
