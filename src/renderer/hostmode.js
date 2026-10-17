// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// hostmode.js - the Host Mode page: start / stop, who can join, the server's name, welcome line, player limit and ban
// list, the options for a PC that hosts all day, and a small dashboard (players, hunts, uptime, relay, PC load,
// backups, log). The work is done in main/hostmode.js.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.hostState) return;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let S = null;
  let noteTimer = null;

  function note(text, isErr) {
    const n = $('hm-note'); if (!n) return;
    n.textContent = text || ''; n.className = 'action-note' + (isErr ? ' err' : '');
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => { n.textContent = ''; }, isErr ? 20000 : 7000);
  }
  function dur(ms) {
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d) return `${d} d ${h % 24} h`;
    if (h) return `${h} h ${m % 60} min`;
    return `${m} min`;
  }
  function ago(iso) {
    const t = Date.parse(iso || ''); if (!t) return 'never';
    const ms = Date.now() - t; if (ms < 90000) return 'just now';
    return dur(ms) + ' ago';
  }
  const PHASE = {
    off: ['Off', ''], starting: ['Starting', 'starting'], running: ['Running', 'running'],
    restarting: ['Restarting', 'restarting'], stopping: ['Stopping', 'stopping'], failed: ['Stopped', 'failed'],
  };

  function render() {
    if (!S) return;
    const page = $('page-host');
    // the dot next to "Host Mode" in the side menu: on while it runs (brass while starting / restarting)
    const dot = $('nav-host-dot');
    if (dot) { dot.hidden = !S.wanted && S.phase !== 'running'; dot.classList.toggle('warn', S.phase !== 'running'); }
    if (!page || page.hidden) return;
    const c = S.settings;
    $('hm-none').hidden = S.versions.length > 0 || S.wanted;
    $('hm-body').hidden = !(S.versions.length > 0 || S.wanted);
    if ($('hm-body').hidden) return;
    const on = S.wanted || S.phase === 'running' || S.phase === 'starting' || S.phase === 'stopping';

    // status line
    const [label, cls] = PHASE[S.phase] || PHASE.off;
    $('hm-state').textContent = label + (S.phase === 'running' ? `: ${c.nameShown}` : '');
    $('hm-dot').className = 'hm-dot ' + cls;
    let sub = '';
    if (S.phase === 'off') sub = `Dauntless ${S.version || ''}, ${c.mode === 'public' ? 'Public (anyone using Play online)' : 'Private (your friends)'}. Press Start: no game window opens.`;
    else if (S.phase === 'starting') sub = 'Starting the backend and Ramsgate. This takes a minute or two.';
    else if (S.phase === 'running') sub = `Dauntless ${S.version}, ${c.mode === 'public' ? 'open to everyone using Play online' : 'friends only'}${S.closingIn ? `, closing in ${S.closingIn} s` : ''}. Press Play on the Play page to join it from this PC.`;
    else if (S.phase === 'restarting') sub = `${S.lastError ? 'It stopped: ' + S.lastError + '. ' : ''}Starting again${S.restartIn ? ` in ${S.restartIn} s` : ''}...`;
    else if (S.phase === 'stopping') sub = S.closingIn ? `Players have ${S.closingIn} seconds; their characters are being saved home.` : 'Closing the server...';
    else if (S.phase === 'failed') sub = `It stopped: ${S.lastError || 'see the log below'}. "Restart by itself" is off.`;
    $('hm-sub').textContent = sub; $('hm-sub').title = sub;

    // version picker: always shown, so it is clear which game this server runs (1.6.2, 1.14.7...)
    const vs = $('hm-version');
    $('hm-ver-wrap').hidden = S.versions.length < 1;
    if (vs.dataset.list !== S.versions.join(',')) { vs.innerHTML = ''; for (const id of S.versions) vs.appendChild(new Option(id, id)); vs.dataset.list = S.versions.join(','); }
    vs.value = S.version || S.versions[0] || ''; vs.disabled = on;

    // buttons
    $('hm-start').hidden = on; $('hm-start').disabled = !S.versions.length;
    $('hm-stop').hidden = !on;
    $('hm-stop-later').hidden = !(S.phase === 'running' && S.players.length > 0 && !S.closingIn);

    // dashboard tiles
    const running = S.phase === 'running';
    const tile = (k, v, s, title) => { $('hm-t-' + k).textContent = v; $('hm-t-' + k + '-s').textContent = s || ''; $('hm-t-' + k).parentNode.title = title || ''; };
    tile('players', running ? `${S.players.length} / ${c.limit}` : '-', running ? (c.mode === 'public' ? 'public' : 'friends only') : '');
    tile('hunts', running && S.hunts !== null && S.hunts !== undefined ? String(S.hunts) : '-', running ? 'up to 6 at a time' : '');
    tile('up', running && S.since ? dur(Date.now() - S.since) : '-', S.restarts ? `${S.restarts} restart${S.restarts > 1 ? 's' : ''}` : '');
    tile('relay', S.relay ? S.relay.name : (S.ping ? S.ping.name : '-'), S.ping ? `${S.ping.ms} ms from here` : '',
      S.relay ? `Players reach this PC at ${S.relay.address}` : (S.ping ? 'The relay this PC reaches fastest' : ''));
    tile('pc', `CPU ${S.pc.cpu === null || S.pc.cpu === undefined ? '-' : S.pc.cpu + '%'}`, `RAM ${S.pc.ramUsedGB} / ${S.pc.ramTotalGB} GB`);
    tile('backup', S.backupBusy ? 'Backing up' : ago(S.lastBackup), c.dailyBackup ? 'daily, ' + c.backupKeep + ' kept' : 'daily backup off');

    // players and bans
    const pl = $('hm-players'); pl.innerHTML = '';
    if (!S.players.length) pl.appendChild(el('div', 'empty', running ? 'Nobody in your server right now.' : 'Players show up here while Host Mode runs.'));
    for (const p of S.players) {
      const r = el('div', 'season-row');
      const n = el('div', 'season-name', p.name); if (p.tag) n.appendChild(el('span', 'hm-tag', '#' + p.tag));
      const a = el('div', 'hm-row-acts');
      if (p.banned) a.appendChild(el('span', 'tag', 'Banned'));
      else { const b = el('button', 'ghost danger', 'Ban'); b.title = 'They cannot join again (they stay until they leave)'; b.onclick = () => ban(p); a.appendChild(b); }
      r.append(n, a); pl.appendChild(r);
    }
    const bl = $('hm-bans'); bl.innerHTML = '';
    if (!c.bans.length) bl.appendChild(el('div', 'empty', 'Nobody is banned.'));
    for (const b of c.bans.slice().reverse()) {
      const r = el('div', 'season-row');
      const n = el('div'); n.appendChild(el('div', 'season-name', b.name || b.id)); n.appendChild(el('div', 'season-kind', 'Banned ' + ago(b.at)));
      const a = el('div', 'hm-row-acts'); const u = el('button', 'ghost', 'Unban'); u.onclick = () => act(L.hostUnban(b.id), `${b.name} can join again.`); a.appendChild(u);
      r.append(n, a); bl.appendChild(r);
    }

    // server settings (inputs are left alone while the player is typing in them)
    $('hm-mode-private').classList.toggle('on', c.mode !== 'public'); $('hm-mode-private').setAttribute('aria-checked', String(c.mode !== 'public'));
    $('hm-mode-public').classList.toggle('on', c.mode === 'public'); $('hm-mode-public').setAttribute('aria-checked', String(c.mode === 'public'));
    $('hm-mode-private').disabled = on; $('hm-mode-public').disabled = on;
    $('hm-mode-sub').textContent = c.mode === 'public'
      ? 'Public: anyone using Play online can join, and your friends too. Banned players cannot.'
      : `Private: only people on your Friends list (${S.friends}). Accepting a friend request lets them in; removing a friend takes them off.`;
    if (on) $('hm-mode-sub').textContent += ' Stop Host Mode to change this.';
    if (document.activeElement !== $('hm-name')) { $('hm-name').value = c.name; $('hm-name').placeholder = c.nameShown; }
    if (document.activeElement !== $('hm-welcome')) $('hm-welcome').value = c.welcome;
    const lim = $('hm-limit');
    if (!lim.options.length) for (let i = 1; i <= 16; i++) lim.appendChild(new Option(String(i), String(i)));
    lim.value = String(c.limit);
    const keep = $('hm-keep');
    if (!keep.options.length) for (const k of [3, 5, 7, 14, 30]) keep.appendChild(new Option(String(k), String(k)));
    keep.value = String(c.backupKeep);

    // this PC
    $('hm-autostart').checked = c.autoStart;
    $('hm-windows').checked = c.startWithWindows; $('hm-windows').disabled = !S.canStartWithWindows;
    $('hm-windows-sub').textContent = S.canStartWithWindows ? 'The launcher opens minimized when you sign in to Windows and starts Host Mode' : 'Only in the installed launcher on Windows';
    $('hm-autorestart').checked = c.autoRestart;
    $('hm-awake').checked = c.keepAwake;
    $('hm-daily').checked = c.dailyRestart;
    if (document.activeElement !== $('hm-daily-at')) $('hm-daily-at').value = c.restartAt;
    $('hm-backup').checked = c.dailyBackup;
    $('hm-backup-now').disabled = S.backupBusy;

    // log
    const lg = $('hm-log'), atEnd = lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 4;
    lg.innerHTML = '';
    for (const l of S.log) { const s = el('span', l.err ? 'err' : '', `${l.t}  ${l.line}\n`); lg.appendChild(s); }
    if (atEnd) lg.scrollTop = lg.scrollHeight;
  }

  async function act(p, okText) {
    const r = await p;
    if (r && r.state) S = r.state;
    if (r && r.ok === false) note(r.error || 'That did not work.', true);
    else if (okText) note(okText);
    render();
    return r;
  }
  const set = (patch, okText) => act(L.hostSet(patch), okText);
  function ban(p) { act(L.hostBan(p.id, p.name), `${p.name} is banned: they cannot join again.`); }

  function wire() {
    $('hm-start').onclick = async () => {
      $('hm-start').disabled = true;
      const pub = ((S && S.settings) || {}).mode === 'public', n = (S && S.friends) || 0;
      note(pub ? 'Starting Host Mode (Public: anyone using Play online can join, plus your friends). No game window opens; this page shows when it is up.'
        : n ? `Starting Host Mode (Private: only the ${n} ${n === 1 ? 'person' : 'people'} on your Friends list can join). Switch to Public to let anyone join. No game window opens.`
        : 'Starting Host Mode (Private), but your Friends list is empty, so nobody can join yet. Add friends on the Friends page, or switch to Public.', !pub && !n);
      await act(L.hostStart($('hm-version').value || undefined));
    };
    $('hm-stop').onclick = () => act(L.hostStop(false), 'Host Mode stopped.');
    $('hm-stop-later').onclick = () => act(L.hostStop(true), 'Players were told in chat. Host Mode stops in 60 seconds.');
    $('hm-version').onchange = (e) => set({ version: e.target.value });
    $('hm-mode-private').onclick = () => set({ mode: 'private' });
    $('hm-mode-public').onclick = () => set({ mode: 'public' });
    $('hm-name').onchange = (e) => set({ name: e.target.value }, 'Server name saved.');
    $('hm-welcome').onchange = (e) => set({ welcome: e.target.value }, 'Welcome line saved.');
    $('hm-limit').onchange = (e) => set({ limit: Number(e.target.value) }, 'Player limit saved.');
    $('hm-keep').onchange = (e) => set({ backupKeep: Number(e.target.value) });
    $('hm-autostart').onchange = (e) => set({ autoStart: e.target.checked });
    $('hm-windows').onchange = (e) => set({ startWithWindows: e.target.checked }, e.target.checked ? 'The launcher now starts with Windows and starts Host Mode.' : 'The launcher no longer starts with Windows.');
    $('hm-autorestart').onchange = (e) => set({ autoRestart: e.target.checked });
    $('hm-awake').onchange = (e) => set({ keepAwake: e.target.checked });
    $('hm-daily').onchange = (e) => set({ dailyRestart: e.target.checked });
    $('hm-daily-at').onchange = (e) => set({ restartAt: e.target.value }, 'Restart time saved.');
    $('hm-backup').onchange = (e) => set({ dailyBackup: e.target.checked });
    $('hm-backup-now').onclick = () => { note('Making a backup...'); act(L.hostBackup(), 'Backup made.'); };
    $('hm-backup-open').onclick = () => L.hostOpenBackups();
    // the page is drawn when it is opened (app.js showPage) and on every update
    document.querySelector('.nav-item[data-page="host"]').addEventListener('click', () => setTimeout(render, 0));
    L.onHostUpdate((s) => { S = s; render(); });
    setInterval(() => { if (S && S.phase === 'running' && !$('page-host').hidden) render(); }, 30000);   // "Up for" moves on
  }
  async function init() {
    wire();
    S = await L.hostState();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
