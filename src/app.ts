// bootstrap runs as a module-level side effect and must be the first import.
// it creates .env and storage files from embedded defaults if they don't exist,
// and injects env vars into process.env before config.ts reads them.
import './bootstrap';

import { createInterface } from 'node:readline';

function hasDisplay(): boolean {
  if (process.platform === 'win32') return true;
  // macOS: skip GUI prompt when connecting over SSH
  if (process.platform === 'darwin') {
    return !process.env.SSH_CLIENT && !process.env.SSH_TTY;
  }
  // Linux: X11 or Wayland
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

const args          = process.argv.slice(2);
const forceGui      = args.includes('--gui');
const forceHeadless = args.includes('--no-gui');

let launchGui = false;

if (!forceHeadless && hasDisplay()) {
  if (forceGui) {
    launchGui = true;
  } else {
    const answer = await ask('Launch GUI? [y/N] ');
    launchGui = answer.toLowerCase() === 'y';
  }
}

if (launchGui) {
  const { runGui } = await import('./gui/window');
  const ok = await runGui();
  if (!ok) {
    // webview unavailable — fall back to headless
    await import('./server');
  }
} else {
  await import('./server');
}
