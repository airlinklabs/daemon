// loads the file spec map from storage — used by the install handler to find installer scripts
// this file is part of the daemon config, not generated at runtime

import { join } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';

const specPath = join(getPaths(config.paths).storageRoot, 'fileSpecifier.json');

// shape: { "code": ["js", "ts", ...], "image": ["png", ...], ... }
type FileSpecifierData = Record<string, string[]>;

let cached: FileSpecifierData | null = null;

const DEFAULT_SPEC: FileSpecifierData = {
  code: [
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'c',
    'cpp',
    'h',
    'hpp',
    'cs',
    'php',
    'sh',
    'bash',
    'zsh',
    'fish',
    'ps1',
    'bat',
    'cmd',
  ],
  config: ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'properties'],
  data: ['sql', 'csv', 'tsv', 'db', 'sqlite', 'sqlite3'],
  document: ['txt', 'md', 'rst', 'doc', 'docx', 'pdf', 'rtf', 'odt'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp', 'tiff', 'psd', 'ai', 'eps'],
  video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4'],
  binary: ['exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'lock', 'pid', 'sock'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
  web: ['html', 'htm', 'css', 'scss', 'less', 'sass'],
};

async function load(): Promise<FileSpecifierData> {
  if (cached) return cached;
  try {
    cached = (await Bun.file(specPath).json()) as FileSpecifierData;
    return cached;
  } catch {
    // fallback to hardcoded defaults so the daemon never crashes over a missing config
    cached = DEFAULT_SPEC;
    return cached;
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
