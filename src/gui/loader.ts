// assets are bundled as static text via bun --compile, same pattern as bootstrap.ts.
// this avoids any file system path resolution which breaks in a compiled binary.

import indexHtml        from './static/index.html'               with { type: 'text' };
import css              from './static/styles.css'               with { type: 'text' };
import js               from './static/scripts.js'               with { type: 'text' };
import tabConsole       from './static/components/tab-console.html'    with { type: 'text' };
import tabFiles         from './static/components/tab-files.html'      with { type: 'text' };
import tabContainers    from './static/components/tab-containers.html' with { type: 'text' };
import tabSettings      from './static/components/tab-settings.html'   with { type: 'text' };

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveAssetPath(...parts: string[]): string {
  const candidatePaths = [
    resolve(process.cwd(), ...parts),
  ];

  try {
    candidatePaths.push(resolve(resolve(process.execPath, '..'), ...parts));
  } catch {}

  try {
    candidatePaths.push(resolve(new URL('.', import.meta.url).pathname, ...parts));
  } catch {}

  for (const p of candidatePaths) {
    if (existsSync(p)) return p;
  }

  return resolve(process.cwd(), ...parts);
}

function logoDataUrl(): string {
  const logoPath = resolveAssetPath('assets', 'airlink_logo.png');
  if (existsSync(logoPath)) {
    const data = readFileSync(logoPath).toString('base64');
    return `data:image/png;base64,${data}`;
  }

  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

export function buildGuiHtml(dev = false): string {
  const tabs = [tabConsole, tabFiles, tabContainers, tabSettings].join('\n');
  const logo = logoDataUrl();

  const devScript = dev ? '<script>window.DEV_GUI = true;</script>' : '';

  return (indexHtml as unknown as string)
    .replace('<link rel="stylesheet" href="__STYLES__">', `<style>${css}</style>`)
    .replace('<script src="__SCRIPTS__"></script>', `<script>${js}</script>`)
    .replace('__TABS__',    tabs)
    .replace('__LOGO__',    logo)
    .replace('</head>', `${devScript}</head>`);
}
