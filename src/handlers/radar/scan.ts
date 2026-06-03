import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

interface ScanResult {
  pattern: RadarPattern;
  matches: { path: string; size?: number }[];
}

export async function scanVolume(id: string, script: RadarScript): Promise<ScanResult[]> {
  const baseDirectory = resolve(process.cwd(), `volumes/${id}`);

  try {
    await access(baseDirectory);
  } catch {
    throw new Error(`volume directory for ${id} does not exist`);
  }

  const results: ScanResult[] = [];

  for (const pattern of script.patterns) {
    const scanResult: ScanResult = { pattern, matches: [] };

    try {
      if (pattern.type === 'content') {
        // content scanning is intentionally not implemented to avoid reading huge volumes
        continue;
      }

      // Bun.Glob is built in — no import needed
      const globPattern = pattern.type === 'filename' ? `**/*${pattern.pattern}*` : `**/*${pattern.pattern}`;

      const matcher = new Bun.Glob(globPattern);
      const files = await Array.fromAsync(matcher.scan({ cwd: baseDirectory, dot: true }));

      for (const file of files) {
        const filePath = join(baseDirectory, file);
        const fileStats = await stat(filePath).catch(() => null);
        if (!fileStats) continue;

        if (fileStats.isDirectory() && pattern.type === 'extension') continue;
        if (pattern.size_less_than && fileStats.size >= pattern.size_less_than) continue;
        if (pattern.size_greater_than && fileStats.size <= pattern.size_greater_than) continue;

        if (pattern.content) {
          try {
            if (fileStats.size < 10 * 1024 * 1024) {
              const content = await readFile(filePath, 'utf-8');
              let re: RegExp;
              try {
                re = new RegExp(pattern.content, 'i');
              } catch {
                continue;
              }
              if (!re.test(content)) continue;
            } else {
              continue;
            }
          } catch {
            continue;
          }
        }

        scanResult.matches.push({ path: file, size: fileStats.size });
      }

      if (scanResult.matches.length > 0) results.push(scanResult);
    } catch {}
  }

  return results;
}
