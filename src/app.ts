const firstArg = process.argv[2];

if (firstArg === 'configure') {
  const { runConfigure } = await import('./configure');
  await runConfigure(process.argv.slice(3));
  process.exit(0);
}

import './bootstrap';

function hasDisplay(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') {
    return !process.env.SSH_CLIENT && !process.env.SSH_TTY;
  }
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

const args = process.argv.slice(2);
const forceGui = args.includes('--gui');
const forceHeadless = args.includes('--no-gui');
const devGui = args.includes('--dev-gui');

if (devGui) {
  const { runDevGui } = await import('./gui/dev-server');
  await runDevGui();
} else if (forceGui || (!forceHeadless && hasDisplay())) {
  const { runGui } = await import('./gui/window');
  const launched = await runGui();
  if (!launched) {
    await import('./server');
  }
} else {
  await import('./server');
}
