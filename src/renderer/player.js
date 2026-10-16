// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// player.js (window) - the one player name: asked once when the launcher first opens, changed in Settings or on
// the Friends page. Every Dauntless version and the Friends page use it.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.playerGet) return;
  const $ = (id) => document.getElementById(id);
  let current = '';
  let firstTime = false;

  function show(prefill, first) {
    firstTime = !!first;
    $('name-title').textContent = first ? 'Welcome to Dauntless Forever' : 'Your player name';
    $('name-text').textContent = first
      ? 'What should we call you? This is your name in every version of Dauntless and the name your friends see. You can change it later in Settings.'
      : 'Your name in every version of Dauntless and on the Friends page. Each version picks it up the next time you press Play.';
    $('name-cancel').hidden = first;
    $('name-input').value = prefill || '';
    $('name-err').textContent = '';
    const d = $('dlg-name');
    if (!d.open) d.showModal();
    setTimeout(() => { $('name-input').focus(); $('name-input').select(); }, 30);
  }
  async function save() {
    const r = await L.playerSet($('name-input').value.trim());
    if (!r || r.ok === false) { $('name-err').textContent = (r && r.error) || 'That did not work.'; return; }
    current = r.name; render(); $('dlg-name').close();
  }
  function render() { const el = $('set-name'); if (el) el.textContent = current || '(not set)'; }

  async function init() {
    $('name-save').onclick = save;
    $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    $('name-cancel').onclick = () => $('dlg-name').close();
    // the first time, the name is needed: Esc does not close the question
    $('dlg-name').addEventListener('cancel', (e) => { if (firstTime) e.preventDefault(); });
    const btn = $('set-name-change'); if (btn) btn.onclick = () => show(current, false);
    const p = await L.playerGet();
    current = p.name || '';
    render();
    if (!current) show(p.suggestion || '', true);
  }
  window.dfChangeName = () => show(current, false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
