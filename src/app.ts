// This code was written by thavanish(https://github.com/thavanish) for airlinklabs
const firstArg = process.argv[2];

if (firstArg === 'configure') {
  const { runConfigure } = await import('./configure');
  await runConfigure(process.argv.slice(3));
  process.exit(0);
}

import './bootstrap';

import { createInterface } from 'node:readline';

function hasDisplay(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') {
    return !process.env.SSH_CLIENT && !process.env.SSH_TTY;
  }
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      setImmediate(() => resolve(answer.trim()));
    });
  });
}

const args = process.argv.slice(2);
const forceGui = args.includes('--gui');
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
    await import('./server');
  }
} else {
  await import('./server');
}
