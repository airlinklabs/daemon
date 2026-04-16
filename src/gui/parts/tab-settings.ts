export const settingsTabHtml = `<section id="tab-settings" class="tab-page">
  <div class="content-pad" style="display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overflow:auto;">
    <div class="settings-grid">
      <div class="card">
        <div class="section-head">Connection</div>
        <div id="settings-connection" class="section-body" style="padding:0;"></div>
      </div>
      <div class="card">
        <div class="section-head">Behavior</div>
        <div id="settings-behavior" class="section-body" style="padding:0;"></div>
      </div>
      <div class="card">
        <div class="section-head">Security</div>
        <div id="settings-security" class="section-body" style="padding:0;"></div>
      </div>
      <div class="card">
        <div class="section-head">TLS</div>
        <div id="settings-tls" class="section-body" style="padding:0;"></div>
      </div>
    </div>
    <div class="settings-actions">
      <button id="settings-reset-btn" class="ghost-btn">Reset</button>
      <button id="settings-save-btn" class="primary-btn">Save</button>
    </div>
  </div>
</section>`;
