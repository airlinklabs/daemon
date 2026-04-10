import path from "node:path";
import fs from "node:fs/promises";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import logger from "../../logger";

type ZipOptions = {
  include?: string[];
  exclude?: string[];
  maxFileSizeMb?: number;
};

export async function zipScanVolume(id: string, options: ZipOptions): Promise<Buffer> {
  const baseDirectory = path.resolve(`volumes/${id}`);
  await fs.access(baseDirectory);
  const include = options.include?.length ? options.include : ["."];
  const exclude = new Set(options.exclude ?? []);
  const maxBytes = (options.maxFileSizeMb ?? 32) * 1024 * 1024;
  const staging = mkdtempSync(`${tmpdir()}/airlinkd-radar-`);
  const out = path.join(staging, `scan-${id}.zip`);

  try {
    for (const folder of include) {
      const matcher = new Bun.Glob(folder === "." ? "**/*" : `${folder}/**/*`);
      const files: string[] = [];
      for await (const match of matcher.scan({ cwd: baseDirectory, dot: true })) {
        files.push(match);
      }
      for (const file of files) {
        const top = file.split("/")[0] ?? "";
        if (exclude.has(top)) continue;
        const src = path.join(baseDirectory, file);
        const stat = await fs.stat(src).catch(() => null);
        if (!stat || stat.isDirectory() || stat.size > maxBytes) continue;
        const dest = path.join(staging, file);
        await Bun.spawn(["mkdir", "-p", path.dirname(dest)], { stdout: "pipe", stderr: "pipe" }).exited;
        cpSync(src, dest);
      }
    }

    const proc = Bun.spawn(["zip", "-r", "-9", out, "."], {
      cwd: staging,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`zip failed (exit ${code}): ${err}`);
    }

    return Buffer.from(await Bun.file(out).arrayBuffer());
  } catch (error) {
    logger.error(`radar zip failed for ${id}`, error);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
