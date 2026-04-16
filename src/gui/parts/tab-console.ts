export const consoleTabHtml = `<section id="tab-console" class="tab-page active">
  <div class="content-pad" style="display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;">
    <div class="grid-3">
      <div class="card">
        <div class="section-head">CPU</div>
        <div class="section-body">
          <div id="cpu-value" class="metric-value">0%</div>
          <div class="progress"><span id="cpu-bar"></span></div>
          <div id="cpu-meta" class="metric-sub">0 cores</div>
        </div>
      </div>
      <div class="card">
        <div class="section-head">Memory</div>
        <div class="section-body">
          <div id="memory-value" class="metric-value">0 MB / 0 MB</div>
          <div class="progress"><span id="memory-bar" style="background:#22c55e;"></span></div>
          <div id="memory-meta" class="metric-sub">Host memory usage</div>
        </div>
      </div>
      <div class="card">
        <div class="section-head">Uptime</div>
        <div class="section-body">
          <div id="uptime-value" class="metric-value">00:00:00</div>
          <div class="progress"><span id="uptime-bar" style="width:100%;background:#6366f1;"></span></div>
          <div class="metric-sub">GUI session uptime</div>
        </div>
      </div>
    </div>
    <div class="card console-card">
      <div class="section-head">
        <div class="console-toolbar">
          <span>Console</span>
          <div class="toolbar-actions">
            <button id="clear-console-btn" class="ghost-btn">Clear</button>
            <label class="check-wrap">
              <input id="auto-scroll-toggle" type="checkbox" checked>
              <span>Auto-scroll</span>
            </label>
          </div>
        </div>
      </div>
      <div id="console-output" class="console-output"></div>
      <div class="console-input-row">
        <input id="console-command-input" type="text" autocomplete="off" placeholder="Type command">
        <button id="console-send-btn" class="primary-btn">Send</button>
      </div>
    </div>
  </div>
</section>`;
