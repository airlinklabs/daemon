export const guiHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  height: 100%; width: 100%; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  background: #0f0f0f; color: #a3a3a3; font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
* { scrollbar-width: none; -ms-overflow-style: none; }
::-webkit-scrollbar { display: none; }

.layout { display: flex; height: 100vh; }

/* ── sidebar ── */
.sidebar {
  width: 210px; flex-shrink: 0;
  background: #111111;
  border-right: 1px solid #1e1e1e;
  display: flex; flex-direction: column;
}
.sidebar-top { padding: 18px 16px 10px; }
.sidebar-name { font-size: 13.5px; font-weight: 600; color: #f0f0f0; letter-spacing: -0.02em; }
.sidebar-sub  { font-size: 11px; color: #444; margin-top: 2px; }

.nav { flex: 1; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: 9px;
  padding: 7px 9px; border-radius: 6px; cursor: default;
  color: #555; font-size: 12.5px; font-weight: 500;
  transition: background 120ms, color 120ms;
  user-select: none; -webkit-user-select: none;
}
.nav-item:hover { background: #191919; color: #888; }
.nav-item.active { background: rgba(99,102,241,0.1); color: #818cf8; }
.nav-item svg { width: 15px; height: 15px; flex-shrink: 0; }

.sidebar-bottom {
  padding: 10px 8px 14px;
  border-top: 1px solid #1a1a1a;
  display: flex; flex-direction: column; gap: 8px;
}
.status-line { display: flex; align-items: center; gap: 8px; padding: 0 4px; }
.dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  transition: background 300ms, box-shadow 300ms;
}
.dot.running { background: #22c55e; box-shadow: 0 0 5px rgba(34,197,94,0.5); }
.dot.stopped { background: #ef4444; box-shadow: none; }
.dot.starting { background: #f59e0b; box-shadow: 0 0 5px rgba(245,158,11,0.4); }
.status-label { font-size: 11.5px; color: #555; }
.status-label b { font-weight: 500; }
.status-label b.running { color: #4ade80; }
.status-label b.stopped { color: #f87171; }
.status-label b.starting { color: #fbbf24; }

.action-btn {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; padding: 7px; border-radius: 6px;
  font-size: 12px; font-weight: 500; cursor: default;
  border: none; transition: background 120ms;
}
.action-btn svg { width: 12px; height: 12px; }
.action-btn.stop  { background: rgba(239,68,68,0.1);  color: #f87171; }
.action-btn.stop:hover  { background: rgba(239,68,68,0.17); }
.action-btn.start { background: rgba(34,197,94,0.1);  color: #4ade80; }
.action-btn.start:hover { background: rgba(34,197,94,0.17); }
.action-btn:disabled { opacity: 0.4; pointer-events: none; }

/* ── main ── */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }

.panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
.panel.active { display: flex; }

/* panel header */
.ph { padding: 20px 22px 16px; flex-shrink: 0; }
.ph-title { font-size: 14px; font-weight: 600; color: #f0f0f0; letter-spacing: -0.02em; }
.ph-desc  { font-size: 11.5px; color: #444; margin-top: 3px; }

/* ── overview ── */
.ov-grid { padding: 0 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex-shrink: 0; }
.card {
  background: #141414; border: 1px solid #1e1e1e; border-radius: 8px; padding: 14px 15px;
}
.card-label { font-size: 10.5px; color: #444; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
.card-value { font-size: 22px; font-weight: 600; color: #f0f0f0; letter-spacing: -0.03em; line-height: 1; }
.card-sub   { font-size: 11px; color: #444; margin-top: 5px; }

.bar-card { background: #141414; border: 1px solid #1e1e1e; border-radius: 8px; padding: 14px 15px; }
.bar-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.bar-name { font-size: 11.5px; color: #666; }
.bar-pct  { font-size: 12px; font-weight: 500; color: #a3a3a3; font-variant-numeric: tabular-nums; }
.bar-track { height: 3px; background: #222; border-radius: 2px; overflow: hidden; }
.bar-fill  { height: 100%; border-radius: 2px; transition: width 600ms cubic-bezier(0.4,0,0.2,1); }
.bar-fill.cpu { background: #6366f1; }
.bar-fill.ram { background: #22c55e; }

.info-strip {
  display: flex; gap: 0;
  border-top: 1px solid #1a1a1a; margin: 16px 22px 0;
  flex-shrink: 0;
}
.info-cell { flex: 1; padding: 12px 0; }
.info-cell + .info-cell { border-left: 1px solid #1a1a1a; padding-left: 18px; }
.info-cell-l { font-size: 10.5px; color: #444; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
.info-cell-v { font-size: 12.5px; font-weight: 500; color: #d4d4d4; }

/* ── logs ── */
.log-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 0 22px 12px;
  border-bottom: 1px solid #1a1a1a; flex-shrink: 0;
}
.log-bar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.autoscroll { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: #555; cursor: default; user-select: none; -webkit-user-select: none; }
.autoscroll input { accent-color: #6366f1; cursor: default; }
.clear-btn {
  padding: 4px 10px; border-radius: 5px; font-size: 11.5px;
  border: 1px solid #222; background: transparent; color: #555; cursor: default;
  transition: border-color 120ms, color 120ms;
}
.clear-btn:hover { border-color: #333; color: #a3a3a3; }

.log-output {
  flex: 1; overflow-y: auto;
  padding: 10px 22px;
  font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace;
  font-size: 11.5px; line-height: 1.75;
}
.log-line { display: flex; gap: 10px; align-items: baseline; }
.log-ts  { color: #333; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.log-lvl { flex-shrink: 0; font-weight: 600; min-width: 38px; }
.log-lvl.info  { color: #3b82f6; }
.log-lvl.warn  { color: #f59e0b; }
.log-lvl.error { color: #ef4444; }
.log-lvl.ok    { color: #22c55e; }
.log-lvl.debug { color: #a855f7; }
.log-msg { color: #888; word-break: break-all; }

/* ── files ── */
.file-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 0 22px 12px;
  border-bottom: 1px solid #1a1a1a; flex-shrink: 0;
}
.crumb { display: flex; align-items: center; gap: 3px; flex: 1; min-width: 0; flex-wrap: wrap; }
.crumb-seg { font-size: 11.5px; color: #555; cursor: default; transition: color 120ms; }
.crumb-seg:hover { color: #a3a3a3; }
.crumb-sep { font-size: 11px; color: #2a2a2a; }

.file-list { flex: 1; overflow-y: auto; }
.file-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 22px; cursor: default;
  border-bottom: 1px solid #141414;
  transition: background 100ms;
}
.file-row:hover { background: #131313; }
.file-ico { width: 15px; height: 15px; flex-shrink: 0; }
.file-ico.dir { color: #6366f1; }
.file-ico.file { color: #444; }
.file-n { flex: 1; font-size: 12px; }
.file-n.dir  { color: #d4d4d4; }
.file-n.file { color: #888; }
.file-sz { font-size: 11px; color: #333; font-variant-numeric: tabular-nums; }
.file-empty { padding: 48px 22px; text-align: center; color: #333; font-size: 12px; }
</style>
</head>
<body>
<div class="layout">

  <div class="sidebar">
    <div class="sidebar-top">
      <div class="sidebar-name">airlinkd</div>
      <div class="sidebar-sub">daemon controller</div>
    </div>

    <nav class="nav">
      <div class="nav-item active" id="nav-overview" onclick="nav('overview')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5"/>
          <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5"/>
          <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5"/>
          <rect x="9" y="9" width="5.5" height="5.5" rx="1.5"/>
        </svg>
        Overview
      </div>
      <div class="nav-item" id="nav-logs" onclick="nav('logs')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M2 4.5h12M2 8h8M2 11.5h10"/>
        </svg>
        Logs
      </div>
      <div class="nav-item" id="nav-files" onclick="nav('files')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 3.5a1 1 0 011-1h3.672a1 1 0 01.707.293l.828.828A1 1 0 009.414 4H12.5a1 1 0 011 1v7a1 1 0 01-1 1h-9a1 1 0 01-1-1v-7.5z"/>
        </svg>
        Files
      </div>
    </nav>

    <div class="sidebar-bottom">
      <div class="status-line">
        <div class="dot stopped" id="dot"></div>
        <div class="status-label" id="statusLabel"><b class="stopped">Stopped</b></div>
      </div>
      <button class="action-btn start" id="actionBtn" onclick="toggleDaemon()">
        <svg id="actionIcon" viewBox="0 0 12 12" fill="currentColor">
          <polygon points="2,1 11,6 2,11"/>
        </svg>
        <span id="actionLabel">Start daemon</span>
      </button>
    </div>
  </div>

  <div class="main">

    <!-- overview -->
    <div class="panel active" id="panel-overview">
      <div class="ph">
        <div class="ph-title">Overview</div>
        <div class="ph-desc">Daemon status and system resource usage.</div>
      </div>
      <div class="ov-grid">
        <div class="card">
          <div class="card-label">Uptime</div>
          <div class="card-value" id="ov-uptime">—</div>
          <div class="card-sub" id="ov-port">port —</div>
        </div>
        <div class="card">
          <div class="card-label">Memory used</div>
          <div class="card-value" id="ov-ram">—</div>
          <div class="card-sub" id="ov-ram-of">of — MB</div>
        </div>
        <div class="bar-card">
          <div class="bar-head">
            <span class="bar-name">CPU usage</span>
            <span class="bar-pct" id="ov-cpu-pct">—</span>
          </div>
          <div class="bar-track"><div class="bar-fill cpu" id="ov-cpu-bar" style="width:0%"></div></div>
        </div>
        <div class="bar-card">
          <div class="bar-head">
            <span class="bar-name">RAM usage</span>
            <span class="bar-pct" id="ov-ram-pct">—</span>
          </div>
          <div class="bar-track"><div class="bar-fill ram" id="ov-ram-bar" style="width:0%"></div></div>
        </div>
      </div>
      <div class="info-strip">
        <div class="info-cell">
          <div class="info-cell-l">Version</div>
          <div class="info-cell-v" id="ov-version">—</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-l">Remote</div>
          <div class="info-cell-v" id="ov-remote">—</div>
        </div>
        <div class="info-cell">
          <div class="info-cell-l">CPU cores</div>
          <div class="info-cell-v" id="ov-cores">—</div>
        </div>
      </div>
    </div>

    <!-- logs -->
    <div class="panel" id="panel-logs">
      <div class="ph">
        <div class="ph-title">Logs</div>
        <div class="ph-desc">Live output from the daemon process.</div>
      </div>
      <div class="log-bar">
        <div class="log-bar-right">
          <label class="autoscroll">
            <input type="checkbox" id="autoscroll" checked> Auto-scroll
          </label>
          <button class="clear-btn" onclick="clearLogs()">Clear</button>
        </div>
      </div>
      <div class="log-output" id="logOutput"></div>
    </div>

    <!-- files -->
    <div class="panel" id="panel-files">
      <div class="ph">
        <div class="ph-title">Files</div>
        <div class="ph-desc">Daemon working directory.</div>
      </div>
      <div class="file-bar">
        <div class="crumb" id="crumb"></div>
      </div>
      <div class="file-list" id="fileList"></div>
    </div>

  </div>
</div>
<script>
var PORT    = parseInt(location.search.slice(1)) || 3002;
var logIdx  = 0;
var crumbPath = [];

// ── nav ──
function nav(name) {
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'files') loadFiles([]);
}

// ── daemon state ──
var running = false;
var busy    = false;

function setStatus(state) {
  var dot   = document.getElementById('dot');
  var lbl   = document.getElementById('statusLabel');
  var btn   = document.getElementById('actionBtn');
  var icon  = document.getElementById('actionIcon');
  var label = document.getElementById('actionLabel');

  dot.className = 'dot ' + state;

  var labelMap = { running: 'Running', stopped: 'Stopped', starting: 'Starting…' };
  lbl.innerHTML = '<b class="' + state + '">' + (labelMap[state] || state) + '</b>';

  running = (state === 'running');
  btn.className = 'action-btn ' + (running ? 'stop' : 'start');
  btn.disabled  = (state === 'starting') || busy;
  icon.innerHTML = running
    ? '<rect x="1" y="1" width="10" height="10" rx="1.5"/>'
    : '<polygon points="2,1 11,6 2,11"/>';
  label.textContent = running ? 'Stop daemon' : 'Start daemon';
}

async function toggleDaemon() {
  if (busy) return;
  busy = true;
  document.getElementById('actionBtn').disabled = true;

  if (running) {
    await window.stopDaemon();
    setStatus('stopped');
  } else {
    setStatus('starting');
    await window.startDaemon();
    setTimeout(function() { setStatus('running'); }, 1200);
  }

  busy = false;
}

// ── stats polling ──
async function pollStats() {
  try {
    var r1 = await fetch('http://localhost:' + PORT + '/');
    if (!r1.ok) { setStatus('stopped'); return; }
    var root = await r1.json();

    var r2   = await fetch('http://localhost:' + PORT + '/stats');
    var data = await r2.json();

    if (!running) setStatus('running');

    document.getElementById('ov-version').textContent = root.versionRelease || '—';
    document.getElementById('ov-remote').textContent  = root.remote || '—';
    document.getElementById('ov-port').textContent    = 'port ' + PORT;
    document.getElementById('ov-uptime').textContent  = data.uptime || '—';

    var latest = data.totalStats && data.totalStats[data.totalStats.length - 1];
    if (latest) {
      var cpuStr = latest.Cores  || '0%';
      var ramStr = latest.Ram    || '0 MB';
      var maxStr = latest.RamMax || '1 MB';
      var cpuNum = parseFloat(cpuStr);
      var ramNum = parseFloat(ramStr);
      var maxNum = parseFloat(maxStr) || 1;
      var ramPct = Math.round(ramNum / maxNum * 100);

      document.getElementById('ov-cpu-pct').textContent = cpuStr;
      document.getElementById('ov-cpu-bar').style.width = Math.min(cpuNum, 100) + '%';
      document.getElementById('ov-ram').textContent     = Math.round(ramNum) + ' MB';
      document.getElementById('ov-ram-of').textContent  = 'of ' + Math.round(maxNum) + ' MB';
      document.getElementById('ov-ram-pct').textContent = ramPct + '%';
      document.getElementById('ov-ram-bar').style.width = ramPct + '%';
      document.getElementById('ov-cores').textContent   = latest.CoresMax || '—';
    }
  } catch (e) {
    if (running) setStatus('stopped');
  }
}

// ── logs ──
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function parseLogLine(raw) {
  var m = raw.match(/^\\[(\\d+:\\d+:\\d+)\\] (\\w+)\\s*: (.*)/);
  if (!m) return null;
  return { time: m[1], level: m[2].toLowerCase().trim(), msg: m[3] };
}

async function pollLogs() {
  var raw    = await window.pollLogs(String(logIdx));
  var result = JSON.parse(raw);
  logIdx = result.next;
  if (!result.lines.length) return;

  var out  = document.getElementById('logOutput');
  var frag = document.createDocumentFragment();

  result.lines.forEach(function(line) {
    var entry = parseLogLine(line);
    if (!entry) return;
    var div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML =
      '<span class="log-ts">' + esc(entry.time) + '</span>' +
      '<span class="log-lvl ' + esc(entry.level) + '">' + entry.level.toUpperCase() + '</span>' +
      '<span class="log-msg">' + esc(entry.msg) + '</span>';
    frag.appendChild(div);
  });

  out.appendChild(frag);
  if (document.getElementById('autoscroll').checked) {
    out.scrollTop = out.scrollHeight;
  }
}

function clearLogs() {
  document.getElementById('logOutput').innerHTML = '';
}

// ── files ──
async function loadFiles(parts) {
  crumbPath = parts;
  var pathStr = parts.join('/') || '.';
  var raw     = await window.listFiles(pathStr);
  var entries = JSON.parse(raw);
  renderCrumb(parts);
  renderFiles(entries, parts);
}

function renderCrumb(parts) {
  var el   = document.getElementById('crumb');
  var html = '<span class="crumb-seg" onclick="loadFiles([])">root</span>';
  parts.forEach(function(p, i) {
    html += '<span class="crumb-sep">/</span>';
    var slice = parts.slice(0, i + 1);
    html += '<span class="crumb-seg" onclick=\\'loadFiles(' + JSON.stringify(slice) + ')\\'>' + esc(p) + '</span>';
  });
  el.innerHTML = html;
}

function renderFiles(entries, parts) {
  var el = document.getElementById('fileList');
  if (!entries || !entries.length) {
    el.innerHTML = '<div class="file-empty">This directory is empty.</div>';
    return;
  }

  var dirs  = entries.filter(function(e) { return e.isDir; }).sort(function(a,b) { return a.name.localeCompare(b.name); });
  var files = entries.filter(function(e) { return !e.isDir; }).sort(function(a,b) { return a.name.localeCompare(b.name); });
  var sorted = dirs.concat(files);

  el.innerHTML = sorted.map(function(e) {
    var icon = e.isDir
      ? '<svg class="file-ico dir" viewBox="0 0 15 15" fill="currentColor"><path d="M1.5 3a1 1 0 011-1h3.672a1 1 0 01.707.293L7.707 3.121A1 1 0 008.414 3.414H12.5a1 1 0 011 1v7a1 1 0 01-1 1H2.5a1 1 0 01-1-1V3z"/></svg>'
      : '<svg class="file-ico file" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2h5.879a1 1 0 01.707.293l2.121 2.121A1 1 0 0112.5 5.121V12.5a1 1 0 01-1 1h-8a1 1 0 01-1-1V3a1 1 0 011-1z"/></svg>';
    var clickAttr = e.isDir ? 'onclick="loadFiles(' + JSON.stringify(parts.concat([e.name])) + ')"' : '';
    var sizeStr   = e.isDir ? '' : fmtSize(e.size);
    return '<div class="file-row" ' + clickAttr + '>' +
      icon +
      '<span class="file-n ' + (e.isDir ? 'dir' : 'file') + '">' + esc(e.name) + '</span>' +
      '<span class="file-sz">' + sizeStr + '</span>' +
      '</div>';
  }).join('');
}

function fmtSize(b) {
  if (b === null || b === undefined) return '';
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── init ──
(function() {
  pollStats();
  pollLogs();
  setInterval(pollStats, 3000);
  setInterval(pollLogs, 800);
})();
</script>
</body>
</html>`;
