export const scriptJs = `
const tabMeta = {
  console: { title: 'Console', subtitle: 'Live daemon output and host resource usage.' },
  files: { title: 'Files', subtitle: 'Browse and edit daemon workspace files.' },
  containers: { title: 'Containers', subtitle: 'Inspect Docker containers and run actions.' },
  settings: { title: 'Settings', subtitle: 'Review daemon environment configuration.' }
};

const settingsSchema = {
  connection: ['remote', 'port', 'key'],
  behavior: ['DEBUG', 'STATS_INTERVAL'],
  security: ['REQUIRE_HMAC', 'ALLOWED_IPS', 'BEHIND_PROXY'],
  tls: ['TLS_CERT', 'TLS_KEY']
};

const settingHints = {
  remote: 'IP or hostname of the panel',
  port: 'Port the daemon listens on',
  key: 'Shared secret with the panel',
  ALLOWED_IPS: 'Comma-separated IPs. Leave empty to allow all.'
};

const booleanKeys = new Set(['DEBUG', 'REQUIRE_HMAC', 'BEHIND_PROXY']);
const state = {
  activeTab: 'console',
  loadedTabs: { console: true, files: false, containers: false, settings: false },
  daemonRunning: false,
  logIdx: 0,
  currentPath: '',
  fileEntries: [],
  settingsData: {},
  extraSettings: {},
  containers: [],
  guiStartedAt: new Date(),
  contextMenu: null
};

let execIsRunning = false;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function call(name, ...args) {
  const result = await window[name](...args);
  return JSON.parse(result);
}

function showToast(message, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' toast-error' : '');
  t.textContent = message;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function openModal(contentHtml) {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = contentHtml;
  overlay.style.display = 'flex';
}

function closeModal() {
  if (execIsRunning) return;
  const overlay = document.getElementById('modal-overlay');
  overlay.style.display = 'none';
  overlay.innerHTML = '';
}

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget && !execIsRunning) closeModal();
});

function stripAnsi(str) {
  return str.replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, '');
}

function parseLine(raw) {
  const clean = stripAnsi(raw);
  const m = clean.match(/^(\\d{2}:\\d{2}:\\d{2})\\s+(INFO|WARN|ERROR|OK|DEBUG)\\s+(.*)$/);
  if (!m) return '<div class="log-line"><span class="log-msg">' + escapeHtml(clean) + '</span></div>';
  const ts = m[1];
  const lvl = m[2];
  const msg = m[3];
  return '<div class="log-line"><span class="log-ts">' + escapeHtml(ts) + '</span><span class="log-lvl ' + lvl.toLowerCase() + '">' + escapeHtml(lvl) + '</span><span class="log-msg">' + escapeHtml(msg) + '</span></div>';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function joinPath(base, name) {
  return base ? base + '/' + name : name;
}

function formatUptime() {
  const secs = Math.floor((Date.now() - state.guiStartedAt.getTime()) / 1000);
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  document.getElementById('uptime-value').textContent = h + ':' + m + ':' + s;
}

function setHeader(tab) {
  document.getElementById('page-title').textContent = tabMeta[tab].title;
  document.getElementById('page-subtitle').textContent = tabMeta[tab].subtitle;
}

function setStatus(running) {
  state.daemonRunning = running;
  const dot = document.getElementById('sidebar-status-dot');
  dot.className = 'status-dot ' + (running ? 'running' : 'stopped');
  document.getElementById('sidebar-status-label').textContent = running ? 'Running' : 'Stopped';
  const badge = document.getElementById('header-badge');
  badge.className = 'header-badge ' + (running ? 'running' : 'stopped');
  badge.innerHTML = '<span class="status-dot ' + (running ? 'running' : 'stopped') + '"></span><span>' + (running ? 'Running' : 'Stopped') + '</span>';
  const btn = document.getElementById('daemon-toggle-btn');
  btn.className = running ? 'secondary-btn stop' : 'secondary-btn';
  btn.textContent = running ? 'Stop' : 'Start';
}

async function refreshDaemonStatus() {
  try {
    const status = await call('getDaemonStatus');
    setStatus(!!status.running);
  } catch (err) {
    showToast(String(err), true);
  }
}

async function toggleDaemon() {
  try {
    const res = await call(state.daemonRunning ? 'stopDaemon' : 'startDaemon');
    if (!res.ok) {
      showToast(res.reason || 'Daemon action failed.', true);
      return;
    }
    await refreshDaemonStatus();
  } catch (err) {
    showToast(String(err), true);
  }
}

async function pollLogs() {
  try {
    const res = await call('pollLogs', String(state.logIdx));
    if (!res.lines || !res.lines.length) {
      state.logIdx = typeof res.next === 'number' ? res.next : state.logIdx;
      return;
    }
    state.logIdx = typeof res.next === 'number' ? res.next : state.logIdx;
    const out = document.getElementById('console-output');
    res.lines.forEach((line) => out.insertAdjacentHTML('beforeend', parseLine(line)));
    if (document.getElementById('auto-scroll-toggle').checked) {
      out.scrollTop = out.scrollHeight;
    }
  } catch (err) {
    showToast(String(err), true);
  }
}

async function refreshStats() {
  try {
    const stats = await call('getSystemStats');
    const cpuBar = document.getElementById('cpu-bar');
    document.getElementById('cpu-value').textContent = stats.cpuPct + '%';
    cpuBar.style.width = Math.max(0, Math.min(100, stats.cpuPct)) + '%';
    cpuBar.style.background = stats.cpuPct > 80 ? '#ef4444' : stats.cpuPct >= 50 ? '#f59e0b' : '#22c55e';
    document.getElementById('cpu-meta').textContent = stats.cores + ' cores';
    document.getElementById('memory-value').textContent = stats.usedMb + ' MB / ' + stats.totalMb + ' MB';
    document.getElementById('memory-bar').style.width = (stats.totalMb > 0 ? Math.round((stats.usedMb / stats.totalMb) * 100) : 0) + '%';
    document.getElementById('memory-meta').textContent = 'Host memory usage';
  } catch (err) {
    showToast(String(err), true);
  }
}

async function sendConsoleCommand() {
  const input = document.getElementById('console-command-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  try {
    const res = await call('sendCommand', cmd);
    if (!res.ok) {
      showToast(res.reason || 'Command failed.', true);
      return;
    }
    input.value = '';
  } catch (err) {
    showToast(String(err), true);
  }
}

function renderBreadcrumb() {
  const root = '<span class="crumb ' + (state.currentPath ? 'clickable' : '') + '" data-path="">/</span>';
  if (!state.currentPath) {
    document.getElementById('files-breadcrumb').innerHTML = '<span class="crumb">/</span>';
    return;
  }
  const parts = state.currentPath.split('/').filter(Boolean);
  let html = root;
  parts.forEach((part, index) => {
    const full = parts.slice(0, index + 1).join('/');
    html += '<span class="crumb-sep">/</span>';
    if (index === parts.length - 1) {
      html += '<span class="crumb">' + escapeHtml(part) + '</span>';
    } else {
      html += '<span class="crumb clickable" data-path="' + escapeHtml(full) + '">' + escapeHtml(part) + '</span>';
    }
  });
  document.getElementById('files-breadcrumb').innerHTML = html;
}

function closeContextMenu() {
  const menu = document.getElementById('ctx-menu');
  menu.style.display = 'none';
  menu.innerHTML = '';
  state.contextMenu = null;
}

function fileIcon(isDir) {
  return isDir
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>';
}

function renderFiles(entries) {
  const list = document.getElementById('files-list');
  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">This directory is empty.</div>';
    return;
  }
  const sorted = entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  state.fileEntries = sorted;
  list.innerHTML = sorted.map((entry, index) => {
    const fullPath = joinPath(state.currentPath, entry.name);
    return '<div class="list-row" data-file-index="' + index + '" data-path="' + escapeHtml(fullPath) + '" data-dir="' + (entry.isDir ? '1' : '0') + '">' +
      fileIcon(entry.isDir) +
      '<div class="row-main"><div class="row-title">' + escapeHtml(entry.name) + '</div></div>' +
      '<div class="row-size">' + (entry.isDir ? '' : formatSize(entry.size || 0)) + '</div>' +
      '<button class="row-menu-btn" data-menu-index="' + index + '">⋯</button>' +
      '</div>';
  }).join('');
}

async function loadFiles(path = state.currentPath) {
  state.currentPath = path || '';
  renderBreadcrumb();
  closeContextMenu();
  const list = document.getElementById('files-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const result = await call('listFiles', state.currentPath || '.');
    if (!Array.isArray(result)) {
      list.innerHTML = '<div class="error-state">Failed to load directory.</div>';
      return;
    }
    renderFiles(result);
  } catch (err) {
    list.innerHTML = '<div class="error-state">Failed to load directory.</div>';
    showToast(String(err), true);
  }
}

async function openFileEditor(path) {
  try {
    const res = await call('readFile', path);
    if (!res.ok) {
      showToast(res.reason || 'Failed to read file.', true);
      return;
    }
    openModal(
      '<div class="modal large">' +
        '<div class="modal-header"><div class="modal-title">' + escapeHtml(path.split('/').pop() || path) + '</div>' +
        '<div class="modal-actions"><button id="editor-save-btn" class="primary-btn">Save</button><button id="editor-close-btn" class="ghost-btn">Close</button></div></div>' +
        '<div class="modal-body"><textarea id="editor-textarea" class="editor-area">' + escapeHtml(res.content) + '</textarea></div>' +
      '</div>'
    );
    document.getElementById('editor-close-btn').addEventListener('click', () => closeModal());
    document.getElementById('editor-save-btn').addEventListener('click', async () => {
      try {
        const out = await call('writeFile', path, document.getElementById('editor-textarea').value);
        if (!out.ok) {
          showToast(out.reason || 'Failed to save file.', true);
          return;
        }
        showToast('Saved.');
      } catch (err) {
        showToast(String(err), true);
      }
    });
  } catch (err) {
    showToast(String(err), true);
  }
}

async function deletePath(path, name) {
  if (!window.confirm('Delete ' + name + '?')) return;
  try {
    const res = await call('deleteFile', path);
    if (!res.ok) {
      showToast(res.reason || 'Delete failed.', true);
      return;
    }
    await loadFiles(state.currentPath);
  } catch (err) {
    showToast(String(err), true);
  }
}

function openFileContextMenu(entry, x, y) {
  const path = joinPath(state.currentPath, entry.name);
  const menu = document.getElementById('ctx-menu');
  const buttons = entry.isDir
    ? [
        { label: 'Open', action: () => loadFiles(path) },
        { label: 'Delete', action: () => deletePath(path, entry.name) }
      ]
    : [
        { label: 'Open', action: () => openFileEditor(path) },
        { label: 'Edit', action: () => openFileEditor(path) },
        { label: 'Delete', action: () => deletePath(path, entry.name) }
      ];
  menu.innerHTML = buttons.map((item, index) => '<button class="ctx-item" data-ctx-index="' + index + '">' + item.label + '</button>').join('');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.display = 'block';
  state.contextMenu = buttons;
}

async function loadContainers() {
  const root = document.getElementById('containers-list');
  root.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const result = await call('listContainers');
    if (!Array.isArray(result)) {
      root.innerHTML = '<div class="error-state">Could not connect to Docker.</div>';
      return;
    }
    state.containers = result;
    if (!result.length) {
      root.innerHTML = '<div class="empty-state">No containers found. Docker may not be running.</div>';
      return;
    }
    root.innerHTML = result.map((container, index) => {
      const stateName = container.State || 'unknown';
      const dotClass = stateName === 'running' ? 'running' : stateName === 'paused' ? 'paused' : 'stopped';
      const name = ((container.Names && container.Names[0]) || '').replace(/^\\//, '');
      const actionButtons = stateName === 'running'
        ? '<button class="small-btn" data-container-action="stop" data-container-index="' + index + '">Stop</button><button class="small-btn" data-container-action="exec" data-container-index="' + index + '">Exec</button>'
        : '<button class="small-btn" data-container-action="start" data-container-index="' + index + '">Start</button><button class="small-btn danger" data-container-action="remove" data-container-index="' + index + '">Delete</button>';
      return '<div class="list-row">' +
        '<span class="status-dot ' + dotClass + '"></span>' +
        '<div class="row-main"><div class="row-title">' + escapeHtml(name || container.Id.slice(0, 12)) + '</div><div class="row-meta">' + escapeHtml(container.Image || '') + ' · ' + escapeHtml(container.Id.slice(0, 12)) + '</div></div>' +
        '<div class="container-actions">' + actionButtons + '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    root.innerHTML = '<div class="error-state">Could not connect to Docker.</div>';
    showToast(String(err), true);
  }
}

async function runContainerAction(container, action) {
  const name = ((container.Names && container.Names[0]) || '').replace(/^\\//, '') || container.Id.slice(0, 12);
  if (action === 'remove' && !window.confirm('Delete container ' + name + '?')) return;
  if (action === 'exec') {
    openExecModal(container);
    return;
  }
  try {
    const res = await call('containerAction', container.Id, action);
    if (!res.ok) {
      showToast(res.reason || 'Container action failed.', true);
      return;
    }
    await loadContainers();
  } catch (err) {
    showToast(String(err), true);
  }
}

function openExecModal(container) {
  const name = ((container.Names && container.Names[0]) || '').replace(/^\\//, '') || container.Id.slice(0, 12);
  openModal(
    '<div class="modal compact">' +
      '<div class="modal-header"><div class="modal-title">Exec — ' + escapeHtml(name) + '</div>' +
      '<div class="modal-actions"><button id="exec-close-btn" class="ghost-btn">X</button></div></div>' +
      '<div class="modal-body" style="padding:14px;gap:12px;">' +
        '<input id="exec-command-input" class="exec-input mono" type="text" value="/bin/bash -l">' +
        '<div class="toolbar-actions" style="justify-content:flex-start;"><button id="exec-run-btn" class="primary-btn">Run</button><button id="exec-clear-btn" class="ghost-btn">Clear</button></div>' +
        '<pre id="exec-output" class="exec-output"></pre>' +
      '</div>' +
    '</div>'
  );
  const closeBtn = document.getElementById('exec-close-btn');
  const runBtn = document.getElementById('exec-run-btn');
  const output = document.getElementById('exec-output');
  closeBtn.addEventListener('click', () => {
    if (!execIsRunning) closeModal();
  });
  document.getElementById('exec-clear-btn').addEventListener('click', () => {
    output.textContent = '';
  });
  runBtn.addEventListener('click', async () => {
    const cmd = document.getElementById('exec-command-input').value;
    execIsRunning = true;
    runBtn.disabled = true;
    closeBtn.disabled = true;
    output.textContent = 'Running…';
    try {
      const res = await call('containerExec', container.Id, cmd);
      if (!res.ok) {
        output.textContent = res.reason || 'Command failed.';
        showToast(res.reason || 'Command failed.', true);
      } else {
        output.textContent = res.output || '';
      }
    } catch (err) {
      output.textContent = String(err);
      showToast(String(err), true);
    } finally {
      execIsRunning = false;
      runBtn.disabled = false;
      closeBtn.disabled = false;
    }
  });
}

function renderSettings() {
  Object.keys(settingsSchema).forEach((section) => {
    const mount = document.getElementById('settings-' + section);
    mount.innerHTML = settingsSchema[section].map((key) => {
      const value = state.settingsData[key] || '';
      const control = booleanKeys.has(key)
        ? '<label class="toggle"><input type="checkbox" data-setting-key="' + key + '"' + ((value || '').toLowerCase() === 'true' ? ' checked' : '') + '><span class="toggle-track"></span></label>'
        : '<input class="text-input" type="text" data-setting-key="' + key + '" value="' + escapeHtml(value) + '">';
      const hint = settingHints[key] ? '<div class="setting-hint">' + escapeHtml(settingHints[key]) + '</div>' : '';
      return '<div class="setting-row"><div><div class="setting-key mono">' + escapeHtml(key) + '</div>' + hint + '</div><div>' + control + '</div></div>';
    }).join('');
  });
}

async function loadSettings() {
  try {
    const env = await call('readEnvFile');
    state.settingsData = {};
    state.extraSettings = {};
    Object.keys(env || {}).forEach((key) => {
      if (Object.values(settingsSchema).flat().includes(key)) state.settingsData[key] = env[key];
      else state.extraSettings[key] = env[key];
    });
    renderSettings();
  } catch (err) {
    showToast(String(err), true);
  }
}

function collectSettings() {
  const data = Object.assign({}, state.extraSettings);
  document.querySelectorAll('[data-setting-key]').forEach((el) => {
    const key = el.getAttribute('data-setting-key');
    if (el.type === 'checkbox') data[key] = el.checked ? 'true' : 'false';
    else data[key] = el.value;
  });
  return data;
}

async function saveSettings() {
  try {
    const res = await call('writeEnvFile', JSON.stringify(collectSettings()));
    if (!res.ok) {
      showToast(res.reason || 'Failed to save settings.', true);
      return;
    }
    showToast('Saved. Restart the daemon for changes to take effect.');
  } catch (err) {
    showToast(String(err), true);
  }
}

async function activateTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-tab') === tab);
  });
  document.querySelectorAll('.tab-page').forEach((page) => {
    page.classList.toggle('active', page.id === 'tab-' + tab);
  });
  setHeader(tab);
  if (!state.loadedTabs[tab]) {
    state.loadedTabs[tab] = true;
    if (tab === 'files') await loadFiles('');
    if (tab === 'containers') await loadContainers();
    if (tab === 'settings') await loadSettings();
  } else {
    if (tab === 'files') await loadFiles(state.currentPath);
    if (tab === 'containers') await loadContainers();
    if (tab === 'settings') await loadSettings();
  }
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) {
    activateTab(nav.getAttribute('data-tab'));
    return;
  }

  const crumb = e.target.closest('.crumb.clickable');
  if (crumb) {
    loadFiles(crumb.getAttribute('data-path'));
    return;
  }

  const fileRow = e.target.closest('.list-row[data-file-index]');
  const menuBtn = e.target.closest('.row-menu-btn');
  if (menuBtn) {
    const entry = state.fileEntries[Number(menuBtn.getAttribute('data-menu-index'))];
    const rect = menuBtn.getBoundingClientRect();
    openFileContextMenu(entry, rect.left, rect.bottom + 6);
    e.stopPropagation();
    return;
  }
  if (fileRow && !menuBtn) {
    const isDir = fileRow.getAttribute('data-dir') === '1';
    const path = fileRow.getAttribute('data-path');
    if (isDir) loadFiles(path);
    else openFileEditor(path);
    return;
  }

  const ctx = e.target.closest('[data-ctx-index]');
  if (ctx && state.contextMenu) {
    const action = state.contextMenu[Number(ctx.getAttribute('data-ctx-index'))];
    closeContextMenu();
    action.action();
    return;
  }

  const containerBtn = e.target.closest('[data-container-action]');
  if (containerBtn) {
    const action = containerBtn.getAttribute('data-container-action');
    const container = state.containers[Number(containerBtn.getAttribute('data-container-index'))];
    runContainerAction(container, action);
    return;
  }

  if (!e.target.closest('#ctx-menu')) closeContextMenu();
});

document.getElementById('daemon-toggle-btn').addEventListener('click', toggleDaemon);
document.getElementById('clear-console-btn').addEventListener('click', () => {
  document.getElementById('console-output').innerHTML = '';
});
document.getElementById('console-send-btn').addEventListener('click', sendConsoleCommand);
document.getElementById('console-command-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendConsoleCommand();
});
document.getElementById('files-refresh-btn').addEventListener('click', () => loadFiles(state.currentPath));
document.getElementById('containers-refresh-btn').addEventListener('click', () => loadContainers());
document.getElementById('settings-reset-btn').addEventListener('click', () => loadSettings());
document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

setHeader('console');
setStatus(false);
formatUptime();
refreshDaemonStatus();
refreshStats();
pollLogs();
setInterval(pollLogs, 2000);
setInterval(refreshStats, 3000);
setInterval(refreshDaemonStatus, 4000);
setInterval(() => {
  formatUptime();
  if (state.activeTab === 'containers') loadContainers();
}, 5000);
setInterval(formatUptime, 1000);
`;
