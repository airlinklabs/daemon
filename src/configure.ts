import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';

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
  } catch {
    /* no existing .env */
  }

  const envConfig = parseEnvFile(envContent);

  const remoteIp = panelUrl
    .replace(/https?:\/\//, '')
    .split(':')[0]
    .split('/')[0];
  envConfig.remote = remoteIp;
  envConfig.key = key;

  if (!envConfig.version) envConfig.version = '3.0.0';
  if (!envConfig.port) envConfig.port = '3002';

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
    console.error(chalk.red('missing --panel or --key'));
    printConfigureHelp();
    process.exit(1);
  }

  const panelUrl = rawPanelUrl.replace(/\/$/, '');

  console.log(chalk.blue('checking the panel...'));
  const isValid = await validatePanelUrl(panelUrl);

  if (!isValid) {
    console.error(chalk.red('could not reach the panel. is it running?'));
    process.exit(1);
  }

  console.log(chalk.green('panel answered'));
  console.log(chalk.blue('writing .env...'));

  try {
    await updateEnvFile(panelUrl, key);
    console.log(chalk.green('daemon configured'));
    console.log(chalk.blue('Panel URL:'), chalk.cyan(panelUrl));
    console.log(chalk.blue('Daemon Key:'), chalk.cyan(key));
  } catch (err) {
    console.error(chalk.red('could not write .env:'), err);
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
    console.error(chalk.red('configure crashed:'), err);
    process.exit(1);
  });
}
