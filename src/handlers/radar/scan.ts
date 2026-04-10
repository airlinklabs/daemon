import path from "node:path";
import fs from "node:fs/promises";
import logger from "../../logger";

type Pattern = {
  type: "filename" | "extension" | "content";
  pattern: string;
  description: string;
  content?: string;
  size_less_than?: number;
  size_greater_than?: number;
};

type RadarScript = {
  name: string;
  description: string;
  version: string;
  patterns: Pattern[];
};

export async function scanVolume(id: string, script: RadarScript): Promise<any[]> {
  const baseDirectory = path.resolve(`volumes/${id}`);
  await fs.access(baseDirectory);
  const results: any[] = [];

  for (const pattern of script.patterns) {
    let files: string[] = [];
    if (pattern.type === "filename") {
      files = [];
      for await (const match of new Bun.Glob(`**/*${pattern.pattern}*`).scan({ cwd: baseDirectory, dot: true })) {
        files.push(match);
      }
    } else if (pattern.type === "extension") {
      files = [];
      for await (const match of new Bun.Glob(`**/*${pattern.pattern}`).scan({ cwd: baseDirectory, dot: true })) {
        files.push(match);
      }
    } else {
      logger.warn(`content scan not fully implemented for ${pattern.pattern}`);
      continue;
    }

    const matches: Array<{ path: string; size?: number }> = [];
    for (const file of files) {
      const filePath = path.join(baseDirectory, file);
      const stats = await fs.stat(filePath).catch(() => null);
      if (!stats) continue;
      if (pattern.type === "extension" && stats.isDirectory()) continue;
      if (pattern.size_less_than && stats.size >= pattern.size_less_than) continue;
      if (pattern.size_greater_than && stats.size <= pattern.size_greater_than) continue;
      matches.push({ path: file, size: stats.size });
    }

    if (matches.length > 0) results.push({ pattern, matches });
  }

  return results;
}
