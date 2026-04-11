import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function parseEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(path)) return result;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function loadFileEnv(): Record<string, string> {
  const cwd = process.cwd();
  const cwdEnv = parseEnvFile(join(cwd, '.env'));

  // When launched from /dist, prefer the project-root .env over a stale
  // copied dist/.env so panel node keys keep matching daemon auth.
  if (basename(cwd) === 'dist') {
    const parentEnv = parseEnvFile(join(dirname(cwd), '.env'));
    return { ...cwdEnv, ...parentEnv };
  }

  return cwdEnv;
}

const fileEnv = loadFileEnv();

const required = (key: string, fallback?: string): string => {
  const val = fileEnv[key] ?? Bun.env[key] ?? fallback;
  if (val === undefined) {
    console.error(`[config] required env var ${key} is missing`);
    process.exit(1);
  }
  return val;
};

const config = {
  remote:        required('remote', 'localhost'),
  key:           required('key', '00000000000000000000000000000000'),
  port:          parseInt(required('port', '3002'), 10),
  debug:         (fileEnv['DEBUG'] ?? Bun.env['DEBUG']) === 'true',
  version:       required('version', '3.0.0'),
  statsInterval: parseInt(fileEnv['STATS_INTERVAL'] ?? Bun.env['STATS_INTERVAL'] ?? '10000', 10),
  allowedIps:    (fileEnv['ALLOWED_IPS'] ?? Bun.env['ALLOWED_IPS'])?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
  tlsCertPath:   fileEnv['TLS_CERT'] ?? Bun.env['TLS_CERT'] ?? null,
  tlsKeyPath:    fileEnv['TLS_KEY'] ?? Bun.env['TLS_KEY'] ?? null,
} as const;

export default config;
