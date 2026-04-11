// chalk — this is an interactive CLI tool, color output is useful here
import chalk from 'chalk';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function validatePanelUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/`);
    return res.ok;
  } catch {
    return false;
  }
}

// dotenv.parse did: split on newlines, ignore comments, split on first =
// this does the same thing without the dependency
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

async function updateEnvFile(panelUrl: string, key: string): Promise<void> {
  const envPath = join(process.cwd(), '.env');
  let envContent = '';
  try {
    envContent = await readFile(envPath, 'utf-8');
  } catch { /* no existing .env, that's fine */ }

  const envConfig = parseEnvFile(envContent);

  const remoteIp = panelUrl.replace(/https?:\/\//, '').split(':')[0];
  envConfig.remote = remoteIp;
  envConfig.key = key;

  if (!envConfig.version) envConfig.version = '3.0.0';
  if (!envConfig.port)    envConfig.port    = '3002';

  const newContent = Object.entries(envConfig).map(([k, v]) => `${k}=${v}`).join('\n');
  await writeFile(envPath, newContent, 'utf-8');
}

function parseArguments(args: string[]): { panelUrl: string; key: string } {
  let panelUrl = '';
  let key      = '';

  for (let i = 0; i < args.length; i++) {
    const cur  = args[i];
    const next = args[i + 1];
    if ((cur === '--panel' || cur === '-p') && next && !next.startsWith('-')) panelUrl = next;
    if ((cur === '--key'   || cur === '-k') && next && !next.startsWith('-')) key = next;
  }

  return { panelUrl, key };
}

async function main(): Promise<void> {
  const filteredArgs = process.argv.slice(2).filter(a => a !== '--');
  const { panelUrl: rawPanelUrl, key } = parseArguments(filteredArgs);

  if (!rawPanelUrl || !key) {
    console.error(chalk.red('[error] missing required parameters'));
    console.log(chalk.yellow('usage: bun run configure -- --panel <url> --key <key>'));
    console.log(chalk.yellow('   or: bun run configure -- -p <url> -k <key>'));
    process.exit(1);
  }

  const panelUrl = rawPanelUrl.replace(/\/$/, '');

  console.log(chalk.blue('[info] validating panel URL...'));
  const isValid = await validatePanelUrl(panelUrl);

  if (!isValid) {
    console.error(chalk.red('[error] invalid panel URL — is the panel running?'));
    process.exit(1);
  }

  console.log(chalk.green('[ok] panel URL is valid'));
  console.log(chalk.blue('[info] updating .env file...'));

  try {
    await updateEnvFile(panelUrl, key);
    console.log(chalk.green('[ok] daemon configured'));
    console.log(chalk.blue('Panel URL:'), chalk.cyan(panelUrl));
    console.log(chalk.blue('Daemon Key:'), chalk.cyan(key));
  } catch (err) {
    console.error(chalk.red('[error] failed to update .env:'), err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red('[error] unexpected error:'), err);
  process.exit(1);
});
