import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import fileSpecifier from "./../utils/fileSpecifier";
import { jailPath, jailRename } from "../security/pathJail";

const requestCache = new Map<string, { value: unknown; expiresAt: number }>();

async function zipFiles(targetZipPath: string, entries: { cleanPath: string; fullPath: string }[]): Promise<void> {
  const staging = mkdtempSync(`${tmpdir()}/airlinkd-zip-`);
  try {
    for (const { cleanPath, fullPath } of entries) {
      const dest = path.join(staging, cleanPath);
      await Bun.spawn(["mkdir", "-p", path.dirname(dest)], { stdout: "pipe", stderr: "pipe" }).exited;
      cpSync(fullPath, dest, { recursive: true });
    }

    const proc = Bun.spawn(["zip", "-r", "-9", targetZipPath, "."], { cwd: staging, stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`zip failed (exit ${code}): ${err}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function unzipFile(zipPath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", destDir], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}

const afs = {
  async list(id: string, relativePath = "/", filter = ""): Promise<any[]> {
    const cacheKey = `${id}:${relativePath}:${filter}`;
    const cached = requestCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as any[];

    const base = path.resolve(`volumes/${id}`);
    const dir = jailPath(base, relativePath);
    const items = await fs.readdir(dir, { withFileTypes: true });
    const result = await Promise.all(items
      .filter((item) => !filter || item.name.toLowerCase().includes(filter.toLowerCase()))
      .map(async (item) => {
        const fullPath = path.join(dir, item.name);
        const stats = await fs.stat(fullPath);
        const extension = path.extname(item.name).slice(1);
        return {
          name: item.name,
          type: item.isDirectory() ? "directory" : "file",
          extension: extension || undefined,
          category: extension ? await fileSpecifier.getCategory(extension).catch(() => null) : null,
          size: stats.size,
        };
      }));
    requestCache.set(cacheKey, { value: result, expiresAt: Date.now() + 3000 });
    return result;
  },

  async getDirectorySizeHandler(id: string, relativePath = "/"): Promise<number> {
    const base = path.resolve(`volumes/${id}`);
    const dir = jailPath(base, relativePath);
    const walk = async (current: string): Promise<number> => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        if (entry.name === "node_modules") continue;
        const fullPath = path.join(current, entry.name);
        const stats = await fs.lstat(fullPath);
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) total += await walk(fullPath);
        else total += stats.size;
      }
      return total;
    };
    return walk(dir);
  },

  async getFileContentHandler(id: string, relativePath: string): Promise<string | null> {
    const fullPath = jailPath(path.resolve(`volumes/${id}`), relativePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) return null;
    return fs.readFile(fullPath, "utf8");
  },

  async writeFileContentHandler(id: string, relativePath: string, content: string): Promise<void> {
    const base = path.resolve(`volumes/${id}`);
    const fullPath = jailPath(base, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  },

  async writeFileRaw(id: string, relativePath: string, content: Buffer): Promise<void> {
    const base = path.resolve(`volumes/${id}`);
    const fullPath = jailPath(base, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, content);
  },

  async getFilePath(id: string, relativePath: string): Promise<string | null> {
    const fullPath = jailPath(path.resolve(`volumes/${id}`), relativePath);
    return existsSync(fullPath) ? fullPath : null;
  },

  async rm(id: string, relativePath: string): Promise<void> {
    const fullPath = jailPath(path.resolve(`volumes/${id}`), relativePath);
    await fs.rm(fullPath, { recursive: true, force: true });
  },

  async zip(id: string, relativePaths: string[], zipname: string): Promise<string> {
    const base = path.resolve(`volumes/${id}`);
    const backupDir = jailPath(base, "/");
    const target = path.join(backupDir, zipname || `archive-${Date.now()}.zip`);
    const entries = relativePaths.map((entry) => ({ cleanPath: entry.replace(/^\/+/, "") || ".", fullPath: jailPath(base, entry) }));
    await zipFiles(target, entries);
    return target;
  },

  async unzip(id: string, relativePath: string, zipname: string): Promise<void> {
    const base = path.resolve(`volumes/${id}`);
    const destDir = jailPath(base, relativePath);
    const zipPath = jailPath(base, zipname);
    await unzipFile(zipPath, destDir);
  },

  async rename(id: string, oldPath: string, newPath: string): Promise<void> {
    await jailRename(path.resolve(`volumes/${id}`), oldPath, newPath);
  },

  async download(id: string, url: string, fileName: string, env?: Record<string, string>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      let fileContent = Buffer.from(await response.arrayBuffer());
      if (env) {
        let text = fileContent.toString();
        for (const [key, value] of Object.entries(env)) {
          text = text.replace(new RegExp(`\\$ALVKT\\(${key}\\)`, "g"), value);
        }
        fileContent = Buffer.from(text);
      }
      const outputPath = jailPath(path.resolve(`volumes/${id}`), fileName);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, fileContent);
    } finally {
      clearTimeout(timer);
    }
  },

  async getDownloadPath(id: string, fileName: string): Promise<string> {
    return jailPath(path.resolve(`volumes/${id}`), fileName);
  },

  async copy(id: string, sourcePath: string, destPath: string, fileName: string): Promise<void> {
    const target = jailPath(path.resolve(`volumes/${id}`), path.join(destPath, fileName));
    await fs.mkdir(path.dirname(target), { recursive: true });
    cpSync(sourcePath, target, { recursive: true });
  },

  async createEmptyFile(id: string, relativePath: string, fileName: string): Promise<string> {
    const target = relativePath === "/" ? fileName : `${relativePath}/${fileName}`;
    const fullPath = jailPath(path.resolve(`volumes/${id}`), target);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "");
    return target;
  },

  async appendFile(id: string, relativePath: string, fileName: string, content: Buffer | string): Promise<string> {
    const target = relativePath === "/" ? fileName : `${relativePath}/${fileName}`;
    const fullPath = jailPath(path.resolve(`volumes/${id}`), target);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    appendFileSync(fullPath, content);
    return target;
  },
};

export default afs;
