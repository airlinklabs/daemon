import { cssStyles } from './parts/styles';
import { layoutHtml } from './parts/layout';
import { consoleTabHtml } from './parts/tab-console';
import { filesTabHtml } from './parts/tab-files';
import { containersTabHtml } from './parts/tab-containers';
import { settingsTabHtml } from './parts/tab-settings';
import { scriptJs } from './parts/script';

export const guiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>Airlink Daemon</title>
<style>${cssStyles}</style>
</head>
${layoutHtml
  .replace('<!-- TAB_CONSOLE -->', consoleTabHtml)
  .replace('<!-- TAB_FILES -->', filesTabHtml)
  .replace('<!-- TAB_CONTAINERS -->', containersTabHtml)
  .replace('<!-- TAB_SETTINGS -->', settingsTabHtml)}
<script>${scriptJs}</script>
</html>`;
