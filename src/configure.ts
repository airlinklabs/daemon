import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnvFile } from './utils/parseEnv';

const ESC = '\x1b';
const RED = `${ESC}[31m`;
const GRN = `${ESC}[32m`;
const BLU = `${ESC}[34m`;
const CYN = `${ESC}[36m`;
const RESET = `${ESC}[0m`;

export function printConfigureHelp(): void {
  const bin = process.argv[1]?.split('/').pop() || 'airlinkd';
  console.log(`Configure this daemon

Usage:
  ${bin} configure --panel <url> --key <key>
  ${bin} configure -p <url> -k <key>

What it does:
  - checks that the panel URL answers
  - writes .env in the current directory
  - stores the panel host as "remote"
  - stores the node key as "key"
  - keeps existing .env values unless they are being configured

Example:
  ${bin} configure --panel http://localhost:3000 --key your-node-key`);
}

async function validatePanelUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/`);
    return res.ok;
  } catch {
    return false;
  }
}

async function updateEnvFile(panelUrl: string, key: string): Promise<void> {
  const envPath = join(process.cwd(), '.env');
  let envContent = '';
  try {
    envContent = await readFile(envPath, 'utf-8');
  } catch {
    /* no existing .env */
  }

  const envConfig = parseEnvFile(envContent);

  const remoteIp = panelUrl
    .replace(/https?:\/\//, '')
    .split(':')[0]
    .split('/')[0];
  // normalize to uppercase keys for consistency
  delete envConfig.remote;
  delete envConfig.key;
  delete envConfig.version;
  delete envConfig.port;
  delete envConfig.require_hmac;
  delete envConfig.debug;
  envConfig.REMOTE = remoteIp;
  envConfig.KEY = key;

  if (!envConfig.VERSION) envConfig.VERSION = '3.0.0';
  if (!envConfig.PORT) envConfig.PORT = '3002';
  if (!envConfig.REQUIRE_HMAC) envConfig.REQUIRE_HMAC = 'true';
  if (!envConfig.DEBUG) envConfig.DEBUG = 'false';

  const newContent = Object.entries(envConfig)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  await writeFile(envPath, `${newContent}\n`, 'utf-8');
}

function parseArguments(args: string[]): { panelUrl: string; key: string } {
  let panelUrl = '';
  let key = '';

  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    const next = args[i + 1];
    if ((cur === '--panel' || cur === '-p') && next && !next.startsWith('-')) panelUrl = next;
    if ((cur === '--key' || cur === '-k') && next && !next.startsWith('-')) key = next;
  }

  return { panelUrl, key };
}

export async function runConfigure(args: string[]): Promise<void> {
  const filteredArgs = args.filter((a) => a !== '--');
  const { panelUrl: rawPanelUrl, key } = parseArguments(filteredArgs);

  if (!rawPanelUrl || !key) {
    console.error(`${RED}missing --panel or --key${RESET}`);
    printConfigureHelp();
    process.exit(1);
  }

  const panelUrl = rawPanelUrl.replace(/\/$/, '');

  console.log(`${BLU}checking the panel...${RESET}`);
  const isValid = await validatePanelUrl(panelUrl);

  if (!isValid) {
    console.error(`${RED}could not reach the panel. is it running?${RESET}`);
    process.exit(1);
  }

  console.log(`${GRN}panel answered${RESET}`);
  console.log(`${BLU}writing .env...${RESET}`);

  try {
    await updateEnvFile(panelUrl, key);
    console.log(`${GRN}daemon configured${RESET}`);
    console.log(`${BLU}Panel URL:${RESET} ${CYN}${panelUrl}${RESET}`);
    console.log(`${BLU}Daemon Key:${RESET} ${CYN}${key}${RESET}`);
  } catch (err) {
    console.error(`${RED}could not write .env:${RESET}`, err);
    process.exit(1);
  }
}

if (import.meta.main) {
  const filteredArgs = process.argv.slice(2).filter((a) => a !== '--');
  if (filteredArgs.includes('--help') || filteredArgs.includes('-h')) {
    printConfigureHelp();
    process.exit(0);
  }
  runConfigure(filteredArgs).catch((err) => {
    console.error(`${RED}configure crashed:${RESET}`, err);
    process.exit(1);
  });
}
