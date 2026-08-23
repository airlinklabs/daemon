import config from '../config';
import { apiError } from '../errors';
import logger from '../logger';
import { getPaths } from '../paths';
import {
  backupBodyCodes,
  backupBodySchema,
  backupDeleteBodyCodes,
  backupDeleteBodySchema,
  commandBodyCodes,
  commandBodySchema,
  containerIdBodyCodes,
  containerIdBodySchema,
  installBodyCodes,
  installBodySchema,
  installerBodyCodes,
  installerBodySchema,
  killDeleteBodyCodes,
  killDeleteBodySchema,
  logArchiveDownloadBodyCodes,
  logArchiveDownloadBodySchema,
  parseJsonBody,
  reinstallBodyCodes,
  reinstallBodySchema,
  restoreBodyCodes,
  restoreBodySchema,
  startBodyCodes,
  startBodySchema,
} from '../schemas';
import { validateContainerId } from '../validation';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export {
  apiError,
  backupBodyCodes,
  backupBodySchema,
  backupDeleteBodyCodes,
  backupDeleteBodySchema,
  commandBodyCodes,
  commandBodySchema,
  config,
  containerIdBodyCodes,
  containerIdBodySchema,
  getPaths,
  installBodyCodes,
  installBodySchema,
  installerBodyCodes,
  installerBodySchema,
  killDeleteBodyCodes,
  killDeleteBodySchema,
  logArchiveDownloadBodyCodes,
  logArchiveDownloadBodySchema,
  logger,
  parseJsonBody,
  reinstallBodyCodes,
  reinstallBodySchema,
  restoreBodyCodes,
  restoreBodySchema,
  startBodyCodes,
  startBodySchema,
  validateContainerId,
};

export function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  const norm = glob
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/$/, '');
  const segments = norm.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '**') {
      pattern += i === segments.length - 1 ? '(?:(?:^|/)[^/]*)*/?' : '(?:[^/]*/)*';
      continue;
    }
    let out = '';
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j];
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if (
        c === '.' ||
        c === '+' ||
        c === '(' ||
        c === ')' ||
        c === '[' ||
        c === ']' ||
        c === '{' ||
        c === '}' ||
        c === '^' ||
        c === '$' ||
        c === '|'
      )
        out += `\\${c}`;
      else out += c;
    }
    pattern += `${out}/?`;
  }
  return new RegExp(`^(?:${pattern}|(?:.*/)?${pattern})$`);
}

export function buildIgnoreMatchers(patterns: string[]): Array<{ isDir: boolean; re: RegExp; raw: string }> {
  const matchers: { isDir: boolean; re: RegExp; raw: string }[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    const isDir = p.endsWith('/');
    matchers.push({ isDir, re: globToRegExp(p), raw: p });
  }
  return matchers;
}

export function isPathIgnored(normalized: string, matchers: { isDir: boolean; re: RegExp }[]): boolean {
  for (const m of matchers) {
    if (m.re.test(normalized)) return true;
  }
  return false;
}

export async function loadJson(filePath: string): Promise<unknown[]> {
  try {
    const file = Bun.file(filePath);
    if (file.size === 0) return [];
    return JSON.parse(await file.text());
  } catch {
    return [];
  }
}

export async function saveJson(filePath: string, data: unknown): Promise<void> {
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}
