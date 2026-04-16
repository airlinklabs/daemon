export const cssStyles = `
:root {
  --bg: #0a0a0a;
  --sidebar: #111111;
  --card: #141414;
  --border: #1e1e1e;
  --divider: #1a1a1a;
  --accent: #6366f1;
  --accent-soft: rgba(99, 102, 241, 0.12);
  --text-primary: #f0f0f0;
  --text-body: #a3a3a3;
  --text-muted: #3a3a3a;
  --danger: #ef4444;
  --warn: #f59e0b;
  --success: #22c55e;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
* { scrollbar-width: none; }
*::-webkit-scrollbar { display: none; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
  background: var(--bg);
  color: var(--text-body);
  font: 13px/1.5 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
button, input, textarea {
  font: inherit;
  color: inherit;
}
button {
  cursor: default;
  border: 0;
  background: none;
}
input, textarea {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-primary);
  outline: none;
}
input:focus, textarea:focus {
  border-color: var(--accent);
}
.shell {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.sidebar {
  width: 220px;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px;
  border-bottom: 1px solid var(--divider);
}
.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}
.brand-title {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.brand-subtitle {
  color: var(--text-muted);
  font-size: 11px;
}
.sidebar-nav {
  flex: 1;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 7px;
  color: var(--text-body);
  transition: background 0.15s ease, color 0.15s ease;
  text-align: left;
}
.nav-item:hover {
  background: rgba(255, 255, 255, 0.03);
}
.nav-item.active {
  background: var(--accent-soft);
  color: #c7c9ff;
}
.nav-item svg {
  width: 15px;
  height: 15px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.sidebar-footer {
  border-top: 1px solid var(--divider);
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sidebar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--text-muted);
}
.status-dot.running { background: var(--success); box-shadow: 0 0 10px rgba(34, 197, 94, 0.4); }
.status-dot.stopped { background: var(--danger); }
.status-dot.paused { background: var(--warn); }
.status-label {
  color: var(--text-body);
  font-size: 12px;
}
.primary-btn, .secondary-btn, .ghost-btn, .danger-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.primary-btn {
  background: var(--accent);
  color: #fff;
}
.primary-btn:hover { background: #7376f4; }
.secondary-btn {
  background: rgba(34, 197, 94, 0.12);
  color: #7ce3a2;
}
.secondary-btn.stop {
  background: rgba(239, 68, 68, 0.12);
  color: #ff8e8e;
}
.ghost-btn {
  background: var(--card);
  color: var(--text-body);
  border: 1px solid var(--border);
}
.ghost-btn:hover, .secondary-btn:hover, .danger-btn:hover {
  border-color: #2b2b2b;
}
.danger-btn {
  background: rgba(239, 68, 68, 0.12);
  color: #ff8e8e;
  border: 1px solid rgba(239, 68, 68, 0.2);
}
button:disabled {
  opacity: 0.5;
  pointer-events: none;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.page-header {
  padding: 22px 24px 16px;
  border-bottom: 1px solid var(--divider);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.page-header h1 {
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.page-header p {
  color: var(--text-body);
  margin-top: 4px;
}
.header-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.header-badge.running {
  background: rgba(34, 197, 94, 0.12);
  color: #7ce3a2;
}
.header-badge.stopped {
  background: rgba(239, 68, 68, 0.12);
  color: #ff8e8e;
}
.header-badge .status-dot {
  width: 6px;
  height: 6px;
}
#main-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.tab-page {
  display: none;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.tab-page.active {
  display: flex;
}
.content-pad {
  padding: 18px 24px 24px;
}
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
}
.section-head {
  background: #181818;
  border-bottom: 1px solid var(--divider);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  padding: 11px 14px;
}
.section-body {
  padding: 14px;
}
.metric-name {
  color: var(--text-body);
  font-size: 12px;
}
.metric-value {
  color: var(--text-primary);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.03em;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.metric-sub {
  color: var(--text-body);
  font-size: 12px;
  margin-top: 8px;
}
.progress {
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: #0d0d0d;
  overflow: hidden;
  margin-top: 12px;
}
.progress > span {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 999px;
  transition: width 0.2s ease, background 0.2s ease;
}
.console-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.console-toolbar, .modal-header, .panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.check-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-body);
  font-size: 12px;
}
.console-output, .exec-output {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #0d0d0d;
  border-top: 1px solid var(--divider);
  border-bottom: 1px solid var(--divider);
  font: 12px/1.7 var(--font-mono);
  padding: 12px 14px;
}
.console-input-row {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
}
.console-input-row input {
  flex: 1;
  min-width: 0;
  background: #0d0d0d;
}
.log-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-body);
  margin-bottom: 4px;
}
.log-ts {
  color: #6b6b6b;
  min-width: 62px;
}
.log-lvl {
  min-width: 52px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  text-align: center;
}
.log-lvl.info { background: rgba(59, 130, 246, 0.12); color: #60a5fa; }
.log-lvl.warn { background: rgba(245, 158, 11, 0.12); color: #fbbf24; }
.log-lvl.error { background: rgba(239, 68, 68, 0.12); color: #f87171; }
.log-lvl.ok { background: rgba(34, 197, 94, 0.12); color: #4ade80; }
.log-lvl.debug { background: rgba(168, 85, 247, 0.12); color: #c084fc; }
.log-msg {
  color: #c6c6c6;
  word-break: break-word;
  white-space: pre-wrap;
}
.mono {
  font-family: var(--font-mono);
}
.breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 34px;
}
.crumb {
  color: var(--text-body);
  font-size: 12px;
}
.crumb.clickable {
  color: var(--text-primary);
}
.crumb-sep {
  color: var(--text-muted);
}
.list-card {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.list-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--divider);
}
.list-row:hover {
  background: rgba(255, 255, 255, 0.02);
}
.list-row:last-child {
  border-bottom: 0;
}
.row-main {
  flex: 1;
  min-width: 0;
}
.row-title {
  color: var(--text-primary);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-meta {
  color: var(--text-body);
  font-size: 12px;
  margin-top: 2px;
}
.row-size {
  color: var(--text-body);
  font-size: 12px;
  min-width: 90px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.row-menu-btn {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--text-body);
  opacity: 0;
}
.list-row:hover .row-menu-btn {
  opacity: 1;
}
.row-menu-btn:hover {
  background: rgba(255, 255, 255, 0.03);
}
.icon {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.empty-state, .error-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  color: var(--text-body);
  text-align: center;
  padding: 24px;
}
.container-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.small-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.small-btn:hover {
  background: rgba(255, 255, 255, 0.04);
}
.small-btn.danger {
  color: #ff8e8e;
  border-color: rgba(239, 68, 68, 0.22);
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-body);
  font-size: 12px;
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.setting-row {
  display: grid;
  grid-template-columns: 1fr minmax(180px, 240px);
  gap: 16px;
  padding: 14px;
  border-bottom: 1px solid var(--divider);
  align-items: center;
}
.setting-row:last-child {
  border-bottom: 0;
}
.setting-key {
  color: var(--text-primary);
  font-size: 12px;
}
.setting-hint {
  color: var(--text-body);
  font-size: 11px;
  margin-top: 4px;
}
.toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.toggle-track {
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: #2a2a2a;
  border: 1px solid #303030;
  position: relative;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  transition: transform 0.15s ease;
}
.toggle input:checked + .toggle-track {
  background: var(--accent);
  border-color: var(--accent);
}
.toggle input:checked + .toggle-track::after {
  transform: translateX(18px);
}
.text-input {
  width: 100%;
  height: 34px;
  padding: 0 12px;
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
#modal-overlay {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.68);
  z-index: 1000;
}
.modal {
  width: min(920px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.modal.large {
  height: min(86vh, 720px);
}
.modal.compact {
  width: min(720px, 100%);
  height: min(80vh, 620px);
}
.modal-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--divider);
}
.modal-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}
.modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.editor-area {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  border-radius: 0;
  padding: 12px;
  background: #0d0d0d;
  color: var(--text-body);
  font: 12px/1.6 var(--font-mono);
  resize: none;
}
.exec-input {
  width: 100%;
  padding: 0 12px;
  height: 36px;
}
.exec-output {
  white-space: pre-wrap;
  color: #d0d0d0;
}
#ctx-menu {
  position: fixed;
  display: none;
  min-width: 140px;
  background: #181818;
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
  z-index: 1100;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.35);
}
.ctx-item {
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  color: var(--text-primary);
  font-size: 12px;
}
.ctx-item:hover {
  background: rgba(99, 102, 241, 0.12);
}
#toast-container {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 1200;
}
.toast {
  min-width: 220px;
  max-width: 320px;
  background: #171717;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 11px 14px;
  color: var(--text-primary);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28);
}
.toast-error {
  border-color: rgba(239, 68, 68, 0.25);
  color: #ffb0b0;
}
@media (max-width: 960px) {
  .grid-3, .settings-grid { grid-template-columns: 1fr; }
  .setting-row { grid-template-columns: 1fr; }
}
`;
