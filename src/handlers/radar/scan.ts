import { resolve, join } from 'node:path';
import { stat, readFile, access } from 'node:fs/promises';
import logger from '../../logger';

interface Pattern {
  type:              'filename' | 'extension' | 'content';
  pattern:           string;
  description:       string;
  content?:          string;
  size_less_than?:   number;
  size_greater_than?: number;
}

interface RadarScript {
  name:        string;
  description: string;
  version:     string;
  patterns:    Pattern[];
}

interface ScanResult {
  pattern: Pattern;
  matches: { path: string; size?: number }[];
}

export async function scanVolume(id: string, script: RadarScript): Promise<ScanResult[]> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);

  try {
    await access(baseDirectory);
  } catch {
    throw new Error(`volume directory for ${id} does not exist`);
  }

  logger.info(`starting radar scan on volume ${id} using script: ${script.name}`);

  const results: ScanResult[] = [];

  for (const pattern of script.patterns) {
    const scanResult: ScanResult = { pattern, matches: [] };

    try {
      if (pattern.type === 'content') {
        // content scanning is intentionally not implemented to avoid reading huge volumes
        logger.warn(`content scanning not implemented for pattern: ${pattern.pattern}`);
        continue;
      }

      // Bun.Glob is built in — no import needed
      const globPattern = pattern.type === 'filename'
        ? `**/*${pattern.pattern}*`
        : `**/*${pattern.pattern}`;

      const matcher = new Bun.Glob(globPattern);
      const files   = await Array.fromAsync(matcher.scan({ cwd: baseDirectory, dot: true }));

      for (const file of files) {
        const filePath = join(baseDirectory, file);
        const fileStats = await stat(filePath).catch(() => null);
        if (!fileStats) continue;

        if (fileStats.isDirectory() && pattern.type === 'extension') continue;
        if (pattern.size_less_than    && fileStats.size >= pattern.size_less_than) continue;
        if (pattern.size_greater_than && fileStats.size <= pattern.size_greater_than) continue;

        if (pattern.content) {
          try {
            if (fileStats.size < 10 * 1024 * 1024) {
              const content = await readFile(filePath, 'utf-8');
              let re: RegExp;
              try {
                re = new RegExp(pattern.content, 'i');
              } catch {
                logger.warn(`invalid regex in pattern content: ${pattern.content}`);
                continue;
              }
              if (!re.test(content)) continue;
            } else {
              logger.debug(`skipping content scan for large file: ${file}`);
              continue;
            }
          } catch {
            logger.debug(`skipping binary or unreadable file: ${file}`);
            continue;
          }
        }

        scanResult.matches.push({ path: file, size: fileStats.size });
      }

      if (scanResult.matches.length > 0) results.push(scanResult);
    } catch (err) {
      logger.error(`error processing pattern ${pattern.pattern}`, err);
    }
  }

  const totalMatches = results.reduce((s, r) => s + r.matches.length, 0);
  logger.info(`radar scan complete on volume ${id}: ${totalMatches} matches across ${results.length} patterns`);

  return results;
}
