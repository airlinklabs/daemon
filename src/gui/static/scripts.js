// all state lives here, nothing is global except this object
const state = {
  activeTab: 'console',
  daemonRunning: false,
  logIdx: 0,
  currentPath: '',
  settingsOriginal: {},
  settingsDirty: {},
  guiStart: Date.now(),
};

const TAB_META = {
  console:    { title: 'Console',    sub: 'Live daemon output and host resource usage.' },
  files:      { title: 'Files',      sub: 'Browse and manage daemon workspace files.' },
  containers: { title: 'Containers', sub: 'Inspect and manage Docker containers.' },
  settings:   { title: 'Settings',   sub: 'Edit daemon .env configuration.' },
};

const SETTINGS_SCHEMA = {
  Connection: ['remote', 'port', 'key'],
  Behavior:   ['DEBUG', 'STATS_INTERVAL'],
  Security:   ['REQUIRE_HMAC', 'ALLOWED_IPS', 'BEHIND_PROXY'],
  TLS:        ['TLS_CERT', 'TLS_KEY'],
};

const BOOL_KEYS = new Set(['DEBUG', 'REQUIRE_HMAC', 'BEHIND_PROXY']);
const THEME_KEY = 'airlink-daemon-theme';

function getSavedTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('theme-light', light);
  localStorage.setItem(THEME_KEY, theme);
  const button = document.getElementById('theme-toggle');
  if (button) button.textContent = light ? 'Dark' : 'Light';
}

function initTheme() {
  applyTheme(getSavedTheme());
}

// ─── tiny helpers ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(2) + ' MB';
}

function fmtUptime() {
  const s = Math.floor((Date.now() - state.guiStart) / 1000);
  const h = String(Math.floor(s/3600)).padStart(2,'0');
  const m = String(Math.floor((s%3600)/60)).padStart(2,'0');
  const sec = String(s%60).padStart(2,'0');
  return `${h}:${m}:${sec}`;
}

function joinPath(base, name) {
  return base ? base + '/' + name : name;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── bridge calls ───────────────────────────────────────────────────────────

async function call(fn, ...args) {
  if (window.DEV_GUI) {
    const response = await fetch(`/api/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    return await response.json();
  } else {
    const raw = await window[fn](...args);
    return JSON.parse(raw);
  }
}

// ─── toast ──────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;

  const iconSvg = {
    success: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"></polyline></svg>',
    error:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    info:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m12 16 0.01 0"></path><path d="m12 8 0.01 0"></path><path d="m12 12-4 0"></path></svg>',
  };

  t.innerHTML = `<span class="toast-icon">${iconSvg[type] || iconSvg.info}</span><span>${esc(msg)}</span>`;
  container.appendChild(t);
  // trigger transition
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 250);
  }, 3500);
}

// ─── modal ──────────────────────────────────────────────────────────────────

function modal({ title, desc, confirmLabel = 'Confirm', danger = true, extraHtml = '', onConfirm }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-desc').textContent  = desc;
  document.getElementById('modal-extra').innerHTML   = extraHtml;

  const btn = document.getElementById('modal-confirm');
  btn.textContent = confirmLabel;
  btn.className = `modal-confirm ${danger ? 'danger' : 'safe'}`;

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('open');

  // swap confirm handler — clone to kill old listeners
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.textContent = confirmLabel;
  fresh.className = `modal-confirm ${danger ? 'danger' : 'safe'}`;
  fresh.addEventListener('click', () => {
    closeModal();
    onConfirm();
  });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-extra').innerHTML = '';
}

document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

// ─── tab switching ──────────────────────────────────────────────────────────

function switchTab(name) {
  if (state.activeTab === name) return;

  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`.nav-item[data-tab="${name}"]`).classList.add('active');

  document.getElementById('page-title').textContent    = TAB_META[name].title;
  document.getElementById('page-subtitle').textContent = TAB_META[name].sub;

  state.activeTab = name;

  // lazy-load on first visit
  if (name === 'files' && !state.filesLoaded) { loadFiles(''); state.filesLoaded = true; }
  if (name === 'containers' && !state.containersLoaded) { loadContainers(); state.containersLoaded = true; }
  if (name === 'settings' && !state.settingsLoaded) { loadSettings(); state.settingsLoaded = true; }
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─── status ─────────────────────────────────────────────────────────────────

function setStatus(running) {
  state.daemonRunning = running;

  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const badge = document.getElementById('header-badge');
  const bdot  = badge ? badge.querySelector('.status-dot') : null;
  const blbl  = document.getElementById('badge-label');

  if (dot) dot.className     = `status-dot ${running ? 'running' : 'stopped'}`;
  if (label) label.textContent = running ? 'Running' : 'Stopped';
  if (badge) badge.className   = `header-badge ${running ? 'running' : 'stopped'}`;
  if (bdot) bdot.className     = `status-dot ${running ? 'running' : 'stopped'}`;
  if (blbl) blbl.textContent   = running ? 'Running' : 'Stopped';
}

async function refreshStatus() {
  try {
    const r = await call('getDaemonStatus');
    setStatus(!!r.running);
  } catch {
    setStatus(true);
  }
}

// ─── stop control ────────────────────────────────────────────────────────────

document.getElementById('theme-toggle').addEventListener('click', () => {
  const next = document.body.classList.contains('theme-light') ? 'dark' : 'light';
  applyTheme(next);
});

document.getElementById('btn-stop').addEventListener('click', () => {
  modal({
    title: 'Stop daemon?',
    desc: 'The daemon process will be stopped and this window will close.',
    confirmLabel: 'Stop',
    danger: true,
    onConfirm: async () => {
      try {
        await call('stopDaemon');
      } catch {
        // process exits, window closes — expected
      }
    },
  });
});

// ─── console log polling ────────────────────────────────────────────────────

function parseLine(raw) {
  const clean = stripAnsi(raw);
  // format: [HH:MM:SS] LEVEL : msg  OR  HH:MM:SS LEVEL msg
  const m = clean.match(/^(?:\[)?(\d{2}:\d{2}:\d{2})(?:\])?\s+(INFO\s*|WARN\s*|ERROR|OK\s*|DEBUG)\s*[:\-]?\s*(.*)$/i);
  if (!m) {
    return `<div class="log-line"><span class="log-msg">${esc(clean)}</span></div>`;
  }
  const ts  = m[1];
  const lvl = m[2].trim().toUpperCase();
  const msg = m[3];
  return `<div class="log-line"><span class="log-ts">${esc(ts)}</span><span class="log-lvl ${lvl.toLowerCase()}">${esc(lvl)}</span><span class="log-msg">${esc(msg)}</span></div>`;
}

async function pollLogs() {
  try {
    const r = await call('pollLogs', String(state.logIdx));
    if (r.lines && r.lines.length > 0) {
      const out = document.getElementById('console-output');
      const frag = document.createDocumentFragment();
      for (const line of r.lines) {
        const div = document.createElement('div');
        div.innerHTML = parseLine(line);
        frag.appendChild(div.firstChild);
      }
      out.appendChild(frag);
      state.logIdx = r.next;
      if (document.getElementById('autoscroll-toggle').checked) {
        out.scrollTop = out.scrollHeight;
      }
    }
  } catch {
    // log file might not exist yet
  }
}

document.getElementById('clear-btn').addEventListener('click', () => {
  document.getElementById('console-output').innerHTML = '';
});

document.getElementById('cmd-send').addEventListener('click', sendCommand);
document.getElementById('cmd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCommand();
});

async function sendCommand() {
  const input = document.getElementById('cmd-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  try {
    const r = await call('sendCommand', cmd);
    if (!r.ok) toast(r.reason || 'Command failed', 'error');
  } catch (err) {
    toast(String(err), 'error');
  }
}

// ─── resource stats ─────────────────────────────────────────────────────────

async function pollStats() {
  try {
    const s = await call('getSystemStats');
    const cpuPct = s.cpuPct ?? 0;
    const used   = s.usedMb ?? 0;
    const total  = s.totalMb ?? 0;
    const cores  = s.cores ?? 0;
    const memPct = total > 0 ? Math.round((used / total) * 100) : 0;

    document.getElementById('cpu-value').textContent = `${cpuPct}%`;
    document.getElementById('cpu-meta').textContent  = `${cores} core${cores !== 1 ? 's' : ''}`;
    const cpuBar = document.getElementById('cpu-bar');
    cpuBar.style.width = `${cpuPct}%`;
    cpuBar.className = `progress-bar${cpuPct > 80 ? ' warn' : ''}`;

    document.getElementById('mem-value').textContent = `${used} / ${total} MB`;
    document.getElementById('mem-meta').textContent  = `${memPct}% used`;
    const memBar = document.getElementById('mem-bar');
    memBar.style.width = `${memPct}%`;
    memBar.className = `progress-bar${memPct > 80 ? ' warn' : ' green'}`;
  } catch {
    // stats not available, probably fine
  }
}

function tickUptime() {
  document.getElementById('uptime-value').textContent = fmtUptime();
}

// ─── file browser ────────────────────────────────────────────────────────────

async function loadFiles(path) {
  state.currentPath = path;
  renderBreadcrumb(path);

  const list = document.getElementById('files-list');
  list.innerHTML = '<div class="empty"><div class="spinner"></div></div>';

  try {
    const entries = await call('listFiles', path);
    renderFiles(entries, path);
  } catch (err) {
    list.innerHTML = `<div class="empty">Failed to load files</div>`;
    toast(String(err), 'error');
  }
}

function renderBreadcrumb(path) {
  const el = document.getElementById('files-breadcrumb');
  const parts = path ? path.split('/').filter(Boolean) : [];
  let html = `<span class="breadcrumb-seg" data-path="">root</span>`;
  let built = '';
  for (const p of parts) {
    built = built ? built + '/' + p : p;
    const snap = built;
    html += `<span class="breadcrumb-sep">/</span><span class="breadcrumb-seg" data-path="${esc(snap)}">${esc(p)}</span>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.breadcrumb-seg').forEach(seg => {
    seg.addEventListener('click', () => loadFiles(seg.dataset.path));
  });
}

function renderFiles(entries, path) {
  const list = document.getElementById('files-list');

  if (!entries.length) {
    list.innerHTML = '<div class="empty"><svg viewBox="0 0 16 16"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z"/></svg><span>Empty directory</span></div>';
    return;
  }

  // dirs first
  const sorted = [...entries].sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  // FLIP: record old positions
  const oldRects = {};
  list.querySelectorAll('.file-row[data-name]').forEach(el => {
    oldRects[el.dataset.name] = el.getBoundingClientRect();
  });

  list.innerHTML = '';
  for (const entry of sorted) {
    const row = document.createElement('div');
    row.className = 'file-row flip-item';
    row.dataset.name = entry.name;

    const iconSvg = entry.isDir
      ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z"/></svg>`
      : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-muted)"><path d="M4 1.5h5l3 3v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/><polyline points="9,1.5 9,4.5 12,4.5"/></svg>`;

    row.innerHTML = `
      ${iconSvg}
      <span class="file-name">${esc(entry.name)}</span>
      <span class="file-size">${entry.isDir ? '' : fmtSize(entry.size)}</span>
      <div class="file-actions">
        ${entry.isDir ? '' : `<button class="file-action-btn edit-btn">Edit</button>`}
        <button class="file-action-btn del file-del-btn">Delete</button>
      </div>`;

    if (entry.isDir) {
      row.addEventListener('click', e => {
        if (e.target.closest('.file-actions')) return;
        loadFiles(joinPath(path, entry.name));
      });
    } else {
      row.querySelector('.edit-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        openFileEditor(joinPath(path, entry.name));
      });
    }

    row.querySelector('.file-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      const fullPath = joinPath(path, entry.name);
      modal({
        title: `Delete ${entry.isDir ? 'directory' : 'file'}?`,
        desc: `"${entry.name}" will be permanently deleted. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: async () => {
          try {
            const r = await call('deleteFile', fullPath);
            if (!r.ok) { toast(r.reason || 'Delete failed', 'error'); return; }
            toast(`Deleted ${entry.name}`, 'success');
            loadFiles(path);
          } catch (err) {
            toast(String(err), 'error');
          }
        },
      });
    });

    list.appendChild(row);
  }

  // FLIP: animate from old positions
  list.querySelectorAll('.file-row[data-name]').forEach(el => {
    const old = oldRects[el.dataset.name];
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dy = old.top - now.top;
    if (Math.abs(dy) < 1) return;
    el.style.transform = `translateY(${dy}px)`;
    el.style.transition = 'none';
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)';
      el.style.transform = '';
    });
  });
}

async function openFileEditor(filePath) {
  const fileName = filePath.split('/').pop();
  let content = '';
  try {
    const r = await call('readFile', filePath);
    if (!r.ok) { toast(r.reason || 'Could not read file', 'error'); return; }
    content = r.content;
  } catch (err) {
    toast(String(err), 'error');
    return;
  }

  modal({
    title: `Edit: ${fileName}`,
    desc: filePath,
    confirmLabel: 'Save',
    danger: false,
    extraHtml: `<textarea id="editor-area" class="editor-textarea" spellcheck="false" style="margin-top:10px;">${esc(content)}</textarea>`,
    onConfirm: async () => {
      const val = document.getElementById('editor-area')?.value ?? content;
      try {
        const r = await call('writeFile', filePath, val);
        if (!r.ok) { toast(r.reason || 'Save failed', 'error'); return; }
        toast(`Saved ${fileName}`, 'success');
      } catch (err) {
        toast(String(err), 'error');
      }
    },
  });
}

document.getElementById('files-refresh').addEventListener('click', () => loadFiles(state.currentPath));

// ─── containers ─────────────────────────────────────────────────────────────

async function loadContainers() {
  const list = document.getElementById('containers-list');
  list.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  try {
    const containers = await call('listContainers');
    if (!Array.isArray(containers)) throw new Error(containers.reason || 'Docker not available');
    renderContainers(containers);
  } catch (err) {
    list.innerHTML = `<div class="empty">Docker unavailable — ${esc(String(err))}</div>`;
  }
}

function renderContainers(containers) {
  const list = document.getElementById('containers-list');

  // FLIP old positions
  const oldRects = {};
  list.querySelectorAll('.container-row[data-id]').forEach(el => {
    oldRects[el.dataset.id] = el.getBoundingClientRect();
  });

  if (!containers.length) {
    list.innerHTML = '<div class="empty"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5.5 3v10M10.5 3v10M2 8h12"/></svg><span>No containers found</span></div>';
    return;
  }

  list.innerHTML = '';
  for (const c of containers) {
    const id    = c.Id.slice(0, 12);
    const name  = (c.Names?.[0] || id).replace(/^\//, '');
    const image = c.Image || '—';
    const state = (c.State || 'unknown').toLowerCase();
    const stateClass = state === 'running' ? 'running' : state === 'paused' ? 'paused' : 'exited';

    const row = document.createElement('div');
    row.className = 'container-row flip-item';
    row.dataset.id = c.Id;
    row.innerHTML = `
      <span class="container-dot ${stateClass}" title="${esc(state)}"></span>
      <span class="container-name" title="${esc(name)}">${esc(name)}</span>
      <span class="container-image" title="${esc(image)}">${esc(image)}</span>
      <div class="container-actions">
        <button class="container-btn exec">Shell</button>
        ${state !== 'running'
          ? `<button class="container-btn start-c">Start</button>`
          : `<button class="container-btn stop-c">Stop</button>`}
        <button class="container-btn rm">Remove</button>
      </div>`;

    row.querySelector('.exec').addEventListener('click', () => openContainerShell(c.Id, name));

    const startBtn = row.querySelector('.start-c');
    if (startBtn) {
      startBtn.addEventListener('click', () => containerAction(c.Id, name, 'start'));
    }
    const stopBtn = row.querySelector('.stop-c');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        modal({
          title: `Stop container?`,
          desc: `"${name}" will be stopped. Data is preserved.`,
          confirmLabel: 'Stop',
          danger: true,
          onConfirm: () => containerAction(c.Id, name, 'stop'),
        });
      });
    }

    row.querySelector('.rm').addEventListener('click', () => {
      modal({
        title: `Remove container?`,
        desc: `"${name}" will be forcefully removed. This cannot be undone.`,
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => containerAction(c.Id, name, 'remove'),
      });
    });

    list.appendChild(row);
  }

  // FLIP animate
  list.querySelectorAll('.container-row[data-id]').forEach(el => {
    const old = oldRects[el.dataset.id];
    if (!old) return;
    const now = el.getBoundingClientRect();
    const dy = old.top - now.top;
    if (Math.abs(dy) < 1) return;
    el.style.transform = `translateY(${dy}px)`;
    el.style.transition = 'none';
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)';
      el.style.transform = '';
    });
  });
}

async function containerAction(id, name, action) {
  try {
    const r = await call('containerAction', id, action);
    if (!r.ok) { toast(r.reason || `${action} failed`, 'error'); return; }
    toast(`${name}: ${action} OK`, 'success');
    await loadContainers();
  } catch (err) {
    toast(String(err), 'error');
  }
}

function openContainerShell(id, name) {
  modal({
    title: `Shell — ${name}`,
    desc: 'Run a command inside the container.',
    confirmLabel: 'Run',
    danger: false,
    extraHtml: `
      <input id="exec-cmd" class="setting-input" placeholder="e.g. ps aux" style="margin-top:10px;width:100%;" value="ps aux">
      <div id="exec-output" class="exec-output" style="margin-top:10px;display:none;"></div>`,
    onConfirm: async () => {
      // keep modal open via re-run trick — just run directly
    },
  });

  // override confirm to keep modal open and show output
  const btn = document.getElementById('modal-confirm');
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.textContent = 'Run';
  fresh.className = 'modal-confirm safe';
  fresh.addEventListener('click', async () => {
    const cmd = document.getElementById('exec-cmd')?.value?.trim();
    if (!cmd) return;
    const outEl = document.getElementById('exec-output');
    if (!outEl) return;
    outEl.style.display = 'block';
    outEl.textContent = 'Running…';
    try {
      const r = await call('containerExec', id, cmd);
      outEl.textContent = r.ok ? r.output || '(no output)' : r.reason || 'exec failed';
    } catch (err) {
      outEl.textContent = String(err);
    }
  });
}

document.getElementById('containers-refresh').addEventListener('click', loadContainers);

// ─── settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const data = await call('readEnvFile');
    state.settingsOriginal = { ...data };
    state.settingsDirty    = { ...data };
    renderSettings(data);
  } catch (err) {
    toast('Failed to load .env: ' + String(err), 'error');
  }
}

function renderSettings(data) {
  const grid = document.getElementById('settings-grid');
  grid.innerHTML = '';

  for (const [group, keys] of Object.entries(SETTINGS_SCHEMA)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="section-head">${esc(group)}</div>`;

    for (const key of keys) {
      const val  = data[key] ?? '';
      const row  = document.createElement('div');
      row.className = 'setting-row';

      if (BOOL_KEYS.has(key)) {
        const isOn = val === 'true' || val === '1';
        row.innerHTML = `
          <span class="setting-key">${esc(key)}</span>
          <div class="setting-toggle ${isOn ? 'on' : ''}" data-key="${esc(key)}" title="Click to toggle"></div>`;
        row.querySelector('.setting-toggle').addEventListener('click', function() {
          const on = this.classList.toggle('on');
          state.settingsDirty[key] = on ? 'true' : 'false';
        });
      } else {
        row.innerHTML = `
          <span class="setting-key">${esc(key)}</span>
          <div class="setting-val">
            <input class="setting-input" data-key="${esc(key)}" value="${esc(val)}" placeholder="${esc(key)}">
          </div>`;
        row.querySelector('input').addEventListener('input', function() {
          state.settingsDirty[this.dataset.key] = this.value;
        });
      }

      card.appendChild(row);
    }

    // unknown keys not in schema
    for (const [k, v] of Object.entries(data)) {
      if (Object.values(SETTINGS_SCHEMA).flat().includes(k)) continue;
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML = `
        <span class="setting-key" style="color:var(--text-muted)">${esc(k)}</span>
        <div class="setting-val">
          <input class="setting-input" data-key="${esc(k)}" value="${esc(v)}" placeholder="${esc(k)}">
        </div>`;
      row.querySelector('input').addEventListener('input', function() {
        state.settingsDirty[this.dataset.key] = this.value;
      });
      // add to last card (TLS)
      grid.lastChild?.appendChild(row);
    }

    grid.appendChild(card);
  }
}

document.getElementById('settings-save').addEventListener('click', async () => {
  try {
    const r = await call('writeEnvFile', JSON.stringify(state.settingsDirty));
    if (!r.ok) { toast(r.reason || 'Save failed', 'error'); return; }
    state.settingsOriginal = { ...state.settingsDirty };
    toast('Settings saved', 'success');
  } catch (err) {
    toast(String(err), 'error');
  }
});

document.getElementById('settings-reset').addEventListener('click', () => {
  state.settingsDirty = { ...state.settingsOriginal };
  renderSettings(state.settingsDirty);
  toast('Reset to saved values', 'info');
});

// ─── boot ────────────────────────────────────────────────────────────────────

async function boot() {
  setStatus(true);
  initTheme();

  // Add startup message
  const out = document.getElementById('console-output');
  const ascii = `Airlink Daemon GUI started

Daemon status: ${window.DEV_GUI ? 'Dev mode (port 3000)' : 'WebView mode'}

`;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-msg">${esc(ascii)}</span>`;
  out.appendChild(div);

  setInterval(pollLogs, 800);
  setInterval(pollStats, 2000);
  setInterval(tickUptime, 1000);

  pollLogs();
  pollStats();
  tickUptime();
}

boot();

// ~ https://github.com/thavanish edited this shitty code
