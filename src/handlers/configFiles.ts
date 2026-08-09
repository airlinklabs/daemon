import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../config';
import { getPaths } from '../paths';
import logger from '../logger';

// Applies Wings/PTDL-v2 style egg config files before a container starts.
// Format (stored in the image's config_files column):
//   {
//     "server.properties": { "parser": "properties", "find": { "server-port": "{{server.build.default.port}}" } },
//     "config.yml":        { "parser": "yaml",      "find": { "database.host": "0.0.0.0" } },
//     "config.json":       { "parser": "json",      "find": { "settings.port": "{{server.build.default.port}}" } }
//   }
// Keys in "find" name the setting to change; values are the replacement,
// with {{...}} tokens resolved from the start environment.

export type ConfigFileEntry = {
  parser?: string;
  find?: Record<string, string>;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveToken(value: string, env: Record<string, string>): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_, token: string) => {
    const normalized = token.trim();
    if (normalized === 'server.build.default.port') return env.SERVER_PORT ?? '';
    if (normalized === 'server.build.default.ip') return env.SERVER_IP ?? env.SERVER_ADDRESS ?? '';
    if (normalized === 'server.build.default.memory') return env.SERVER_MEMORY ?? '';
    if (normalized === 'server.build.default.cpu') return env.SERVER_CPU ?? '';
    const envKey = normalized.startsWith('env.') ? normalized.slice(4).toUpperCase() : '';
    if (envKey && env[envKey] !== undefined) return String(env[envKey]);
    return '';
  });
}

function applyProperties(content: string, find: Record<string, string>, env: Record<string, string>): string {
  const lines = content.split('\n');
  for (const [key, rawValue] of Object.entries(find)) {
    const value = resolveToken(rawValue, env);
    const regex = new RegExp(`^\\s*${escapeRegExp(key)}\\s*[=:]`, 'm');
    const idx = lines.findIndex((line) => regex.test(line));
    if (idx !== -1) lines[idx] = `${key}=${value}`;
  }
  return lines.join('\n');
}

function yamlChainDepth(lines: string[], idx: number, _key: string): number {
  // count leading spaces to infer nesting depth
  const match = lines[idx].match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function applyYaml(content: string, find: Record<string, string>, env: Record<string, string>): string {
  const lines = content.split('\n');
  for (const [key, rawValue] of Object.entries(find)) {
    const value = resolveToken(rawValue, env);
    const segments = key.split('.');
    const leaf = segments[segments.length - 1];

    // find candidate lines whose trailing key matches the leaf
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/^\s*/, '').replace(/#.*$/, '');
      if (!stripped) continue;
      const match = stripped.match(/^([^:]+):\s*(.*)$/);
      if (!match) continue;
      const lineKey = match[1].trim().replace(/^["']|["']$/g, '');
      if (lineKey !== leaf) continue;

      // walk upward to confirm the dotted chain matches; siblings at the
      // same depth are skipped, only a shallower line is a parent
      let depth = yamlChainDepth(lines, i, key);
      const chain = [leaf];
      let cursor = i - 1;
      while (cursor >= 0 && chain.length < segments.length) {
        const up = lines[cursor].replace(/^\s*/, '').replace(/#.*$/, '');
        const upMatch = up.match(/^([^:]+):\s*(.*)$/);
        if (!upMatch) {
          cursor--;
          continue;
        }
        const upDepth = yamlChainDepth(lines, cursor, upMatch[1]);
        if (upDepth >= depth) {
          cursor--;
          continue;
        } // sibling or deeper
        chain.unshift(upMatch[1].trim().replace(/^["']|["']$/g, ''));
        depth = upDepth;
        cursor--;
      }

      if (chain.join('.') === key) {
        // `^\s*` always matches (even an empty line), so the captured indent is
        // never undefined in practice; the ?. keeps the linter and types honest
        const indent = lines[i].match(/^\s*/)?.[0] ?? '';
        lines[i] = `${indent}${leaf}: ${value}`;
        break;
      }
    }
  }
  return lines.join('\n');
}

function applyJson(content: string, find: Record<string, string>, env: Record<string, string>): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    logger.warn('config file is not valid JSON, skipping');
    return content;
  }

  for (const [key, rawValue] of Object.entries(find)) {
    const segments = key.split('.');
    let cursor: unknown = data;
    let ok = true;
    for (const segment of segments.slice(0, -1)) {
      if (cursor && typeof cursor === 'object' && segment in cursor) {
        cursor = (cursor as Record<string, unknown>)[segment];
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || !cursor || typeof cursor !== 'object') continue;
    (cursor as Record<string, unknown>)[segments[segments.length - 1]] = resolveToken(rawValue, env);
  }

  return JSON.stringify(data, null, 2);
}

function applyPlain(content: string, find: Record<string, string>, env: Record<string, string>): string {
  let result = content;
  for (const [key, rawValue] of Object.entries(find)) {
    result = result.split(key).join(resolveToken(rawValue, env));
  }
  return result;
}

export async function applyConfigFiles(
  containerId: string,
  files: Record<string, ConfigFileEntry>,
  env: Record<string, string>,
): Promise<void> {
  const volumeRoot = resolve(getPaths(config.paths).volumesRoot, containerId);

  for (const [filePath, entry] of Object.entries(files)) {
    const cleanPath = filePath.replace(/^[/\\]+/, '');
    if (!cleanPath || cleanPath.includes('..')) {
      logger.warn(`skipping config file with unsafe path: ${filePath}`);
      continue;
    }

    const target = resolve(volumeRoot, cleanPath);
    if (!target.startsWith(`${volumeRoot}/`)) {
      logger.warn(`skipping config file outside volume root: ${filePath}`);
      continue;
    }

    if (!existsSync(target)) {
      logger.warn(`config file missing, skipping: ${filePath}`);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(target, 'utf8');
    } catch (err) {
      logger.error(`failed to read config file ${filePath}:`, err);
      continue;
    }

    const find = entry?.find;
    if (!find || Object.keys(find).length === 0) continue;

    const parser = entry?.parser ?? 'plain';
    try {
      switch (parser) {
        case 'properties':
          content = applyProperties(content, find, env);
          break;
        case 'yaml':
        case 'yml':
          content = applyYaml(content, find, env);
          break;
        case 'json':
          content = applyJson(content, find, env);
          break;
        default:
          content = applyPlain(content, find, env);
      }
      writeFileSync(target, content);
      logger.info(`applied config file ${filePath} for container ${containerId}`);
    } catch (err) {
      logger.error(`failed to apply config file ${filePath}:`, err);
    }
  }
}
