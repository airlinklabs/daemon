import type { Stats } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import logger from '../../logger';

export interface RadarPattern {
  type: 'filename' | 'extension' | 'content';
  pattern: string;
  description: string;
  content?: string;
  size_less_than?: number;
  size_greater_than?: number;
}

export interface RadarScript {
  name: string;
  description: string;
  version: string;
  patterns: RadarPattern[];
}

export interface ScanResult {
  pattern: RadarPattern;
  matches: { path: string; size?: number }[];
}

export interface ScanVolumeOptions {
  // Injectable root so tests can scan a throwaway directory. Real scans use
  // volumes/<id>; tests pass a temporary directory under /tmp.
  baseDirectory?: string;
}

// Content scanning reads whole files into memory, so it must never pull a
// multi-gigabyte file. Files at or above this cap are skipped by content
// matching — a filename or extension pattern may still report them, but their
// bytes are never read.
const MAX_CONTENT_READ_BYTES = 10 * 1024 * 1024;

// A content pattern walks every file in the volume, so an unbounded walk can
// stall a request on a pathological volume. Two independent caps keep it
// finite: a file cap stops the walk at a fixed count, and a time budget stops
// it early when the disk is slow. Content scanning is a best-effort heuristic;
// skipping files past the cap is deliberate, not a bug.
const MAX_CONTENT_SCAN_FILES = 20_000;
const MAX_CONTENT_SCAN_MS = 10_000;

export async function scanVolume(
  id: string,
  script: RadarScript,
  options: ScanVolumeOptions = {},
): Promise<ScanResult[]> {
  const volumePath = resolve(options.baseDirectory ?? `volumes/${id}`);

  let baseDirectory: string;
  try {
    baseDirectory = await realpath(volumePath);
  } catch {
    throw new Error(`volume directory for ${id} does not exist`);
  }

  const baseStat = await stat(baseDirectory);
  if (!baseStat.isDirectory()) {
    throw new Error(`volume directory for ${id} does not exist`);
  }

  const results: ScanResult[] = [];

  for (const pattern of script.patterns) {
    const scanResult: ScanResult = { pattern, matches: [] };

    const matches =
      pattern.type === 'content'
        ? await scanContentMatches(baseDirectory, pattern)
        : await scanNameMatches(baseDirectory, pattern);

    scanResult.matches.push(...matches);
    if (scanResult.matches.length > 0) results.push(scanResult);
  }

  return results;
}

// filename/extension patterns match on the file's name first, then optionally
// on its content. The content check is deliberately limited to files under the
// read cap so a name match never pulls a huge file into memory either.
async function scanNameMatches(
  baseDirectory: string,
  pattern: RadarPattern,
): Promise<{ path: string; size?: number }[]> {
  const matches: { path: string; size?: number }[] = [];

  const contentRe = compileContentRegex(pattern.content);
  // A broken regex cannot match anything; log it once and yield nothing for
  // this pattern (the pre-existing code also produced no matches, silently).
  // The scan continues with the remaining patterns either way.
  if (contentRe === null) return matches;

  const globPattern = pattern.type === 'filename' ? `**/*${pattern.pattern}*` : `**/*${pattern.pattern}`;

  // Bun.Glob is built in — no import needed.
  const matcher = new Bun.Glob(globPattern);
  const files = await Array.fromAsync(matcher.scan({ cwd: baseDirectory, dot: true }));

  for (const file of files) {
    const filePath = join(baseDirectory, file);
    if (!(await isSafeWithinVolume(baseDirectory, filePath))) continue;

    const fileStats = await tryStat(filePath);
    if (!fileStats) continue;

    if (fileStats.isDirectory() && pattern.type === 'extension') continue;
    if (!passesSizeGuards(fileStats.size, pattern)) continue;

    if (contentRe && !(await fileMatchesContent(filePath, fileStats.size, contentRe))) continue;

    matches.push({ path: file, size: fileStats.size });
  }

  return matches;
}

// content patterns ignore file names and read every file in the volume looking
// for a regex match. This is the expensive path, so it is the one bounded by
// the file cap and time budget.
async function scanContentMatches(
  baseDirectory: string,
  pattern: RadarPattern,
): Promise<{ path: string; size?: number }[]> {
  const matches: { path: string; size?: number }[] = [];

  const contentRe = compileContentRegex(pattern.content);
  if (contentRe === undefined || contentRe === null) {
    // A content pattern without a usable regex cannot match anything. Log it so
    // the admin knows the pattern is inert instead of silently reporting zero.
    logger.warn(`content radar pattern has no usable content regex: ${pattern.pattern}`);
    return matches;
  }

  const matcher = new Bun.Glob('**/*');
  const startedAt = performance.now();
  let filesScanned = 0;

  for await (const file of matcher.scan({ cwd: baseDirectory, dot: true, onlyFiles: true })) {
    if (filesScanned >= MAX_CONTENT_SCAN_FILES) {
      logger.warn(
        `radar content scan stopped at file cap (${MAX_CONTENT_SCAN_FILES} files) for pattern ${pattern.pattern}`,
      );
      break;
    }
    if (performance.now() - startedAt >= MAX_CONTENT_SCAN_MS) {
      logger.warn(
        `radar content scan stopped at time budget (${MAX_CONTENT_SCAN_MS}ms) for pattern ${pattern.pattern}`,
      );
      break;
    }
    filesScanned++;

    const filePath = join(baseDirectory, file);
    if (!(await isSafeWithinVolume(baseDirectory, filePath))) continue;

    const fileStats = await tryStat(filePath);
    if (!fileStats?.isFile()) continue;
    if (!passesSizeGuards(fileStats.size, pattern)) continue;

    if (!(await fileMatchesContent(filePath, fileStats.size, contentRe))) continue;

    matches.push({ path: file, size: fileStats.size });
  }

  return matches;
}

// Compile the optional content regex once per pattern. `undefined` means the
// pattern has no content check; `null` means the supplied regex is invalid.
// Regexes are case-insensitive, matching the pre-existing behaviour.
function compileContentRegex(content: string | undefined): RegExp | null | undefined {
  if (content === undefined) return undefined;
  try {
    return new RegExp(content, 'i');
  } catch {
    logger.warn(`invalid content regex in radar pattern: ${content}`);
    return null;
  }
}

async function fileMatchesContent(filePath: string, fileSize: number, re: RegExp): Promise<boolean> {
  if (fileSize >= MAX_CONTENT_READ_BYTES) return false;

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    // Not every file is valid UTF-8 or readable; skip it rather than fail the
    // whole scan over one unreadable candidate.
    logger.debug(`radar content check skipped unreadable file: ${filePath}`);
    return false;
  }

  return re.test(content);
}

function passesSizeGuards(size: number, pattern: RadarPattern): boolean {
  if (pattern.size_less_than !== undefined && size >= pattern.size_less_than) return false;
  if (pattern.size_greater_than !== undefined && size <= pattern.size_greater_than) return false;
  return true;
}

// A file can disappear between the glob and the stat (e.g. a container is
// writing while the scan runs); that is a normal race, not a scan failure, so
// log it and treat the entry as absent.
async function tryStat(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    logger.debug(`radar scan could not stat path: ${filePath}`);
    return null;
  }
}

// Regular paths returned by the glob are already rooted inside the volume; only
// a symlink can point outside it. Resolve links and require the target to stay
// inside, so the scan never reads host files through a link. (Bun.Glob does not
// list symlinks by default, but this guards against a change in that behaviour.)
async function isSafeWithinVolume(baseDirectory: string, filePath: string): Promise<boolean> {
  let fileStat: Stats;
  try {
    fileStat = await lstat(filePath);
  } catch {
    logger.debug(`radar scan could not lstat path: ${filePath}`);
    return false;
  }

  if (!fileStat.isSymbolicLink()) return true;

  let resolved: string;
  try {
    resolved = await realpath(filePath);
  } catch {
    logger.debug(`radar scan skipped broken symlink: ${filePath}`);
    return false;
  }

  return resolved === baseDirectory || resolved.startsWith(baseDirectory + sep);
}
