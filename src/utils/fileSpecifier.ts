// loads the file spec map from storage — used by the install handler to find installer scripts
// this file is part of the daemon config, not generated at runtime

import { resolve } from 'node:path';

const specPath = resolve(process.cwd(), 'storage/fileSpecifier.json');

// shape: { "code": ["js", "ts", ...], "image": ["png", ...], ... }
type FileSpecifierData = Record<string, string[]>;

let cached: FileSpecifierData | null = null;

async function load(): Promise<FileSpecifierData> {
  if (cached) return cached;
  try {
    cached = await Bun.file(specPath).json() as FileSpecifierData;
    return cached;
  } catch {
    throw new Error('failed to load storage/fileSpecifier.json — is the file missing?');
  }
}

async function getCategory(extension: string): Promise<string | null> {
  const data = await load();
  for (const [category, extensions] of Object.entries(data)) {
    if (Array.isArray(extensions) && extensions.includes(extension)) {
      return category;
    }
  }
  return null;
}

export default { getCategory };
