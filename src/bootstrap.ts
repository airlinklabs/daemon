// this module runs its logic immediately when imported.
// it must be the first import in app.ts so it runs before config.ts reads Bun.env.
//
// when bun starts, it loads .env automatically — but only if the file exists.
// if .env is missing (first run), bun skips it. this module creates it from
// the embedded template and manually injects the values into process.env
// so config.ts sees them as if bun had loaded the file normally.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// bun --compile bundles these into the binary as static assets
import envTemplate          from '../example.env'          with { type: 'text' };
import defaultConfig        from '../storage/config.json';
import defaultFileSpecifier from '../storage/fileSpecifier.json';

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val   = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

const envPath = join(process.cwd(), '.env');

if (!existsSync(envPath)) {
  writeFileSync(envPath, envTemplate, 'utf-8');
  const defaults = parseEnv(envTemplate);
  for (const [key, val] of Object.entries(defaults)) {
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  process.stdout.write('[bootstrap] no .env found — created with defaults. edit it and restart.\n');
}

for (const dir of ['logs', 'storage', 'storage/alc', 'storage/alc/files', 'volumes', 'backups']) {
  mkdirSync(dir, { recursive: true });
}

if (!existsSync('storage/config.json')) {
  writeFileSync('storage/config.json', JSON.stringify(defaultConfig, null, 2), 'utf-8');
}

if (!existsSync('storage/fileSpecifier.json')) {
  writeFileSync('storage/fileSpecifier.json', JSON.stringify(defaultFileSpecifier, null, 2), 'utf-8');
}
