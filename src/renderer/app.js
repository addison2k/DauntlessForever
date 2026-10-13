// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
const L = window.launcher;
const $ = (id) => document.getElementById(id);

let versions = [];
let statuses = {};          // id -> status from main
let info = null;
let selected = null;
const logs = {};            // id -> [{line,isErr}]
const dl = {};              // id -> { pct, done, total, speed, eta, outDir, state }
const busy = {};            // id -> 'download' | 'setup' | 'play' | null
let refreshTimer = null;
const updateLog = [];

// ---------------------------------------------------------------- boot
async function boot() {
  info = await L.info();
  versions = await L.listVersions();
  await refreshAll();
  renderShelf();
  const pick = versions.find(v => v.id === info.lastVersion) || versions.find(v => v.hasPackage) || versions[0];
  if (pick) select(pick.id);
  wire();
  $('side-ver').textContent = `Dauntless Forever ${info.version}`;
  loadCommunity();
}
function showPage(name) {
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('selected', b.dataset.page === name);
  for (const pg of document.querySelectorAll('.page')) pg.hidden = pg.id !== 'page-' + name;
  if (name === 'settings') fillSettings();
  if (name === 'seasons') renderSeasons();
  if (name === 'events') renderEvents();
  if (name === 'rules') renderRules();
  if (name === 'items') renderItems(true);
  if (name === 'patches') renderPatches();
  document.querySelector('.content').scrollTop = 0;
}
async function loadCommunity() {
  let c; try { c = await L.communityInfo(); } catch { return; }
  const links = c.community || {};
  for (const [id, url] of [['lnk-patreon', links.patreon], ['lnk-patreon-2', links.patreon]]) {
    const el = $(id); if (!el) continue; el.dataset.url = url || ''; el.hidden = !url;
  }
  // the Discord button only shows once there is an invite link in community.json
  // "Questions?" opens the author's Discord profile once its user id is in community.json
  const ask = $('lnk-ask'); const uid = String(links.discordUserId || '').trim();
  ask.hidden = !/^\d{15,22}$/.test(uid); ask.dataset.url = ask.hidden ? '' : `https://discord.com/users/${uid}`;
  if (links.contactLabel) $('lnk-ask-title').textContent = links.contactLabel;
  const dc = $('lnk-discord'); dc.dataset.url = links.discord || ''; dc.hidden = !links.discord;
  $('lnk-discord-text').textContent = 'Join the Discord';
  if (links.github) $('lnk-source').dataset.url = links.github;
  renderCredits(c.credits || {}, c.supporters || {});
  // the Supporters section only shows while there is a Patreon link
  $('supporters-section').hidden = !links.patreon;
}
function renderCredits(cr, sup) {
  $('credits-intro').textContent = cr.intro || '';
  const host = $('credits-sections'); host.innerHTML = '';
  for (const sec of (cr.sections || [])) {
    const d = document.createElement('div'); d.className = 'credits-section';
    d.innerHTML = `<h2>${esc(sec.title)}</h2>` + (sec.people || []).map(p => `
      <div class="person"><div class="avatar">${esc((p.name || '?')[0].toUpperCase())}</div><div>
        <div class="person-name">${p.url ? `<a href="#" data-url="${esc(p.url)}">${esc(p.name)}</a>` : esc(p.name)}${p.role ? `<span class="person-role">${esc(p.role)}</span>` : ''}</div>
        <div class="person-what">${esc(p.what || '')}</div></div></div>`).join('');
    host.appendChild(d);
  }
  $('supporters-intro').textContent = cr.supportersIntro || '';
  const list = $('supporters-list'); list.innerHTML = '';
  const names = sup.supporters || [];
  for (const n of names) { const el = document.createElement('span'); const nm = typeof n === 'string' ? n : n.name; el.className = 'supporter' + (n.top ? ' top' : ''); el.textContent = nm; list.appendChild(el); }
  const anon = sup.anonymous || 0;
  $('supporters-anon').hidden = !anon; $('supporters-anon').textContent = anon === 1 ? 'One supporter chose to stay anonymous. Thank you too.' : `${anon} supporters chose to stay anonymous. Thank you too.`;
}
async function fillSettings() {
  info = await L.info();
  $('set-sky').textContent = Sky.enabled() ? 'Turn off' : 'Turn on';
  $('set-games').textContent = info.gamesRoot;
  $('set-data').textContent = info.dataRoot;
  $('set-node').textContent = info.node ? `${info.node.version} at ${info.node.path}` : 'Not installed yet. Set-up offers to install it.';
  $('set-tool').textContent = info.toolOk ? 'manifest.exe (meszmate/manifest with the plain-chunk fix), checked' : 'Missing or damaged. Reinstall the launcher.';
  $('set-ver').textContent = `Dauntless Forever ${info.version}`;
  $('set-pkgs').textContent = versions.filter(v => v.hasPackage).map(v => `${v.id}: ${v.package.packageVersion}`).join(', ') + (updateLog.length ? ` (last check: ${updateLog[updateLog.length - 1]})` : '');
}
async function refreshAll() { for (const v of versions) statuses[v.id] = await L.status(v.id); }
async function refresh(id) { statuses[id] = await L.status(id); renderShelf(); if (selected === id) renderDetail(); }

// ---------------------------------------------------------------- derived state
function stateOf(v) {
  const s = statuses[v.id] || {};
  const b = busy[v.id] || s.busy;
  if (!v.hasPackage) return { key: 'soon', label: 'Offline package coming soon', step: 'none' };
  if (b === 'download') return { key: 'busy', busy: b, label: 'Downloading', step: 'game' };
  if (b === 'setup') return { key: 'busy', busy: b, label: 'Set-up running', step: 'setup' };
  if (b === 'play') return { key: 'busy', busy: b, label: 'Running', step: 'play' };
  if (s.game === 'missing') return { key: 'attn', label: 'Not downloaded', step: 'game' };
  if (s.game === 'partial') return { key: 'attn', label: 'Download not finished', step: 'game' };
  if (s.game === 'wrong') return { key: 'attn', label: 'Wrong game version in folder', step: 'game' };
  if (s.setup !== 'ready') return { key: 'attn', label: 'Set-up needed', step: 'setup' };
  return { key: 'ready', label: 'Ready to play', step: 'play' };
}

// ---------------------------------------------------------------- shelf
function renderShelf() {
  const ol = $('shelf'); ol.innerHTML = '';
  for (const v of versions) {
    const st = stateOf(v);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'build' + (v.id === selected ? ' selected' : '') + (st.key === 'ready' ? ' ready' : '') + (st.key === 'soon' ? ' soon' : '');
    b.setAttribute('aria-current', v.id === selected ? 'true' : 'false');
    b.innerHTML = `<div class="build-ver">${esc(v.id)}${v.warning ? '<span class="build-flag" title="Experimental">Experimental</span>' : ''}</div><div class="build-when">${esc(v.released)}</div><div class="build-state ${st.key}">${esc(st.label)}</div>`;
    b.addEventListener('click', () => select(v.id));
    li.appendChild(b); ol.appendChild(li);
  }
}
function select(id) {
  selected = id; L.setLast(id);
  $('more-menu').hidden = true;
  renderShelf(); renderDetail();
}

// ---------------------------------------------------------------- detail
function renderDetail() {
  const v = versions.find(x => x.id === selected); if (!v) return;
  const s = statuses[v.id] || {}; const st = stateOf(v); const d = dl[v.id];
  $('detail-empty').hidden = true; $('detail-body').hidden = false;
  $('d-ver').textContent = v.id;
  $('d-meta').textContent = `Build ${v.build}, released ${v.released}. ${v.era}.`;
  $('d-blurb').textContent = v.blurb || '';
  $('d-warn').hidden = !v.warning; $('d-warn').textContent = v.warning || '';
  const pill = $('d-pill'); pill.textContent = st.label; pill.className = 'pill ' + st.key;

  // steps
  const gameDone = s.game === 'ok', setupDone = gameDone && s.setup === 'ready';
  setStep('game', gameDone ? 'done' : (st.step === 'game' ? 'current' : ''),
    gameDone ? shortPath(s.gameDir) : (s.game === 'partial' ? 'Partly downloaded; Download carries on' : (s.game === 'wrong' ? 'That folder has a different build' : `${v.download.downloadGB} GB from Epic's servers`)));
  setStep('setup', setupDone ? 'done' : (st.step === 'setup' ? 'current' : (gameDone ? '' : 'blocked')),
    setupDone ? (s.config && s.config.PlayerName ? `Player: ${s.config.PlayerName}` : 'Done') : ((s.prereqMissing && s.prereqMissing.length) ? 'Windows parts missing (DirectX / Visual C++)' : 'A window asks one or two questions'));
  setStep('play', st.key === 'busy' && st.step === 'play' ? 'current' : (setupDone ? (st.step === 'play' ? 'current' : '') : 'blocked'),
    s.hasSave ? 'Your save is here; progress carries on' : 'Starts as a new Slayer');

  // the one button
  const p = $('btn-primary'); const note = $('action-note'); note.className = 'action-note';
  $('btn-stop').hidden = true; $('btn-cancel').hidden = true;
  p.disabled = false;
  if (!v.hasPackage) { p.textContent = 'Coming soon'; p.disabled = true; note.textContent = 'The offline package for this version is still being made. It will show up here when it is ready.'; }
  else if (st.busy === 'download') { p.textContent = 'Downloading'; p.disabled = true; $('btn-cancel').hidden = false; note.textContent = 'You can keep using the launcher. Cancelling keeps what is already downloaded.'; }
  else if (st.busy === 'setup') { p.textContent = 'Set-up running'; p.disabled = true; note.textContent = 'Answer the questions in the black window, then close it when it says it is finished.'; }
  else if (st.busy === 'play') { p.textContent = 'Running'; p.disabled = true; $('btn-stop').hidden = false; note.textContent = 'Close the game normally and everything else shuts down by itself.'; }
  else if (st.step === 'game') { p.textContent = s.game === 'partial' ? 'Continue download' : 'Download'; note.textContent = `About ${v.download.downloadGB} GB to download, ${v.download.installedGB} GB installed. Goes to ${info.gamesRoot}\\${v.download.folderName} (change it in Settings). Already have ${v.id}? Use "More".`; }
  else if (st.step === 'setup') {
    p.textContent = 'Set up';
    if (s.prereqMissing && s.prereqMissing.length) note.textContent = `Windows is missing parts the game needs (${s.prereqMissing.join(', ')}). Set up downloads them from Microsoft and installs them; Windows asks for permission once.`;
    else note.textContent = s.game === 'ok' && s.setup === 'needed' && s.config ? 'Something the set-up put in place is missing (the game may have been repaired). Run it again; it only fixes what is missing.' : 'One-time. Needs the internet once (Node.js and a small data pack).';
  }
  else { p.textContent = 'Play'; note.textContent = ''; }
  // download notes only while they are still news (not after the player moved on or picked another folder)
  if (!st.busy && st.step === 'game' && d && d.state === 'failed' && d.error) { note.textContent = d.error; note.className = 'action-note err'; }
  if (!st.busy && st.step === 'setup' && d && d.state === 'done' && !(s.prereqMissing && s.prereqMissing.length)) { note.textContent = 'Download finished and checked. Next: Set up.'; }

  // progress
  const pr = $('progress');
  if (d && d.state === 'running') {
    pr.hidden = false; $('p-fill').style.width = (d.pct || 0) + '%';
    $('p-label').textContent = `Downloading ${v.id}`; $('p-right').textContent = d.pct != null ? `${d.pct}%` : '';
    $('p-foot').textContent = d.total ? `${d.done} of ${d.total}${d.speed ? ', ' + d.speed : ''}${d.eta ? ', about ' + d.eta + ' left' : ''}` : 'Reading the manifest...';
  } else pr.hidden = true;

  // log
  const lg = logs[v.id] || [];
  $('log').hidden = lg.length === 0;
  renderLog(v.id);

  // notes
  fill('d-works', v.works); fill('d-not', v.notWorking);
  $('notes').hidden = !(v.works && v.works.length) && !(v.notWorking && v.notWorking.length);

  // menu availability
  const m = $('more-menu');
  m.querySelector('[data-act="setup"]').disabled = !gameDone || st.key === 'busy';
  m.querySelector('[data-act="uninstall"]').disabled = !gameDone || st.key === 'busy';
  m.querySelector('[data-act="opengame"]').disabled = !s.gameDir;
  m.querySelector('[data-act="pick"]').disabled = st.key === 'busy';
}
function setStep(name, cls, sub) { const el = document.querySelector(`.step[data-step="${name}"]`); el.className = 'step ' + cls; $('s-' + name).textContent = sub; }
function fill(id, items) { const ul = $(id); ul.innerHTML = ''; for (const t of (items || [])) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); } }
function shortPath(p) { if (!p) return ''; return p.length > 48 ? '…' + p.slice(-46) : p; }
// ---------------------------------------------------------------- events (Ramsgate decorations)
let eventVer = null, eventNote = null;
async function renderEvents() {
  const withEvents = [];
  for (const v of versions.filter(x => x.hasPackage)) {
    let d = null; try { d = await L.events(v.id); } catch {}
    if (d && d.events.length) withEvents.push({ v, d });
  }
  if (!withEvents.some(x => x.v.id === eventVer)) eventVer = (withEvents.find(x => x.v.id === selected) || withEvents[0] || {}).v?.id || null;
  const tabs = $('event-vtabs'); tabs.innerHTML = '';
  for (const { v } of withEvents) {
    const b = document.createElement('button'); b.className = 'season-tab'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === eventVer)); b.textContent = v.name || v.id;
    b.addEventListener('click', () => { eventVer = v.id; eventNote = null; renderEvents(); });
    tabs.appendChild(b);
  }
  tabs.hidden = withEvents.length < 2;
  const cur = withEvents.find(x => x.v.id === eventVer);
  $('event-none').hidden = !!cur; $('event-body').hidden = !cur;
  if (!cur) return;
  const { d } = cur;
  $('event-note').textContent = eventNote || '';
  const fill = (host, items, chosen, pick) => {
    host.innerHTML = '';
    for (const x of items) {
      const row = document.createElement('div'); row.className = 'season-row event-row' + (x.key === chosen ? ' active' : '');
      row.innerHTML = `
        <div><div class="season-name">${esc(x.title)}</div><div class="season-kind">${esc(x.blurb || '')}</div></div>
        <div class="season-lvl">${x.tested ? '<span class="tag ok">Tested</span>' : '<span class="tag exp">Experimental</span>'}</div>
        <div class="season-acts">${x.key === chosen ? '<span class="season-on">On</span>' : '<button class="ghost pick">Use this</button>'}</div>`;
      const b = row.querySelector('.pick');
      if (b) b.addEventListener('click', () => pick(x));
      host.appendChild(row);
    }
  };
  const apply = async (ev, dr, title) => {
    const r = await L.setEvents(eventVer, ev, dr);
    eventNote = !r || !r.ok ? ((r && r.error) || 'Could not change it.')
      : r.running ? `${title}: close the game and press Play again to see it.` : `${title}: you will see it the next time you press Play.`;
    renderEvents();
  };
  fill($('event-list'), d.events, d.event, (x) => apply(x.key, d.dressing, x.title));
  fill($('dressing-list'), d.dressings, d.dressing, (x) => apply(d.event, x.key, x.title));
}

// ---------------------------------------------------------------- Game Rules
let ruleVer = null, ruleNote = null;
async function renderRules() {
  const withRules = [];
  for (const v of versions.filter(x => x.hasPackage)) {
    let d = null; try { d = await L.rules(v.id); } catch {}
    if (d && d.rules.length) withRules.push({ v, d });
  }
  if (!withRules.some(x => x.v.id === ruleVer)) ruleVer = (withRules.find(x => x.v.id === selected) || withRules[0] || {}).v?.id || null;
  const tabs = $('rule-vtabs'); tabs.innerHTML = '';
  for (const { v } of withRules) {
    const b = document.createElement('button'); b.className = 'season-tab'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === ruleVer)); b.textContent = v.name || v.id;
    b.addEventListener('click', () => { ruleVer = v.id; ruleNote = null; renderRules(); });
    tabs.appendChild(b);
  }
  tabs.hidden = withRules.length < 2;
  const cur = withRules.find(x => x.v.id === ruleVer);
  $('rule-none').hidden = !!cur; $('rule-body').hidden = !cur;
  if (!cur) return;
  const { d } = cur;
  $('rule-note').textContent = ruleNote || '';
  const apply = async (changes, what) => {
    const r = await L.setRules(ruleVer, changes);
    ruleNote = !r || !r.ok ? ((r && r.error) || 'Could not change it.')
      : r.running ? `${what}: close the game and press Play again for it to apply.` : `${what}: applies the next time you press Play.`;
    renderRules();
  };
  const list = $('rule-list'); list.innerHTML = '';
  for (const x of d.rules) {
    const row = document.createElement('div'); row.className = 'season-row rule-row' + (x.value !== x.default ? ' active' : '');
    row.innerHTML = `
      <div><div class="season-name">${esc(x.title)} ${x.tested ? '' : '<span class="tag exp">Experimental</span>'}</div><div class="season-kind">${esc(x.blurb)} <b>Default: ${esc((x.choices.find(c => String(c[0]) === x.default) || [, x.default])[1])}.</b></div></div>
      <div class="rule-choices" role="group" aria-label="${esc(x.title)}"></div>`;
    const host = row.querySelector('.rule-choices');
    for (const [val, label] of x.choices) {
      const b = document.createElement('button'); b.className = 'season-filter rule-choice';
      b.setAttribute('aria-pressed', String(String(val) === x.value));
      b.textContent = label;
      if (String(val) !== x.value) b.addEventListener('click', () => apply({ [x.key]: String(val) }, `${x.title} ${label}`));
      host.appendChild(b);
    }
    list.appendChild(row);
  }
  $('rule-reset').onclick = () => apply(Object.fromEntries(d.rules.map(x => [x.key, x.default])), 'Back to the defaults');
}

// ---------------------------------------------------------------- Inventory (add / remove items in the save)
let itemVer = null, itemChar = null, itemNote = null, itemData = null, itemPending = {}, itemErr = false;
const fmtN = n => Number(n || 0).toLocaleString('en-US');
async function renderItems(reload) {
  const vs = versions.filter(x => x.hasPackage);
  if (reload || !itemData) {
    const found = [];
    for (const v of vs) { let d = null; try { d = await L.items(v.id); } catch {} if (d) found.push({ v, d }); }
    if (!found.some(x => x.v.id === itemVer)) itemVer = (found.find(x => x.v.id === selected) || found[0] || {}).v?.id || null;
    itemData = { found };
  }
  const { found } = itemData;
  const tabs = $('item-vtabs'); tabs.innerHTML = '';
  for (const { v } of found) {
    const b = document.createElement('button'); b.className = 'season-tab'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === itemVer)); b.textContent = v.name || v.id;
    b.addEventListener('click', () => { itemVer = v.id; itemPending = {}; itemNote = null; renderItems(true); });
    tabs.appendChild(b);
  }
  tabs.hidden = found.length < 2;
  const cur = found.find(x => x.v.id === itemVer);
  const save = cur && cur.d.save;
  const chars = (save && save.ok && save.characters) || [];
  const usable = cur && chars.length;
  $('item-none').hidden = !!usable; $('item-body').hidden = !usable;
  if (!usable) {
    const why = !cur ? null : (save && !save.ok ? save.error : 'No character yet. Press Play once and make a character first.');
    $('item-none-title').textContent = why ? 'Nothing to edit yet' : 'No inventory editing for this version yet';
    $('item-none-pill').hidden = !!why;
    $('item-none-text').textContent = why || 'The Inventory page is ready for 1.6.2 first. Other versions get it through a server-file update.';
    return;
  }
  if (!chars.some(c => c.id === itemChar)) itemChar = chars[0].id;
  const ch = chars.find(c => c.id === itemChar);
  const sel = $('item-char'); sel.innerHTML = '';
  for (const c of chars) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name || c.id.slice(0, 8); o.selected = c.id === itemChar; sel.appendChild(o); }
  $('item-char-wrap').hidden = chars.length < 2;
  sel.onchange = () => { itemChar = sel.value; itemPending = {}; itemNote = null; renderItems(false); };
  const n = Object.keys(itemPending).length;
  const note = $('item-note');
  note.textContent = itemNote || (cur.d.running ? 'The game is running: close it before saving.' : (n ? `${n} unsaved change${n > 1 ? 's' : ''}.` : ''));
  note.classList.toggle('err', itemErr);
  $('item-save').disabled = !n; $('item-undo').disabled = !n;
  $('item-save').textContent = n ? `Save ${n} change${n > 1 ? 's' : ''}` : 'Save changes';
  const known = new Set();
  const row = (id, name, blurb) => {
    const have = ch.items[id] || 0;
    const val = id in itemPending ? itemPending[id] : have;
    const r = document.createElement('div'); r.className = 'season-row item-row' + (id in itemPending ? ' active' : '');
    r.innerHTML = `
      <div><div class="season-name">${esc(name)}</div><div class="season-kind">${blurb ? esc(blurb) + ' ' : ''}<code>${esc(id)}</code></div></div>
      <div class="item-have">${id in itemPending ? `<s>${fmtN(have)}</s> → ` : ''}<b>${fmtN(val)}</b></div>
      <div class="item-edit">
        <button class="ghost step" data-d="-10" title="10 less">−10</button>
        <input type="number" min="0" max="99999999" value="${val}" aria-label="${esc(name)}">
        <button class="ghost step" data-d="10" title="10 more">+10</button>
        <button class="ghost step" data-d="100" title="100 more">+100</button>
        <button class="ghost step zero" data-z="1" title="Set to 0 (removes it)">Clear</button>
      </div>`;
    const inp = r.querySelector('input');
    const setTo = (x) => {
      x = Math.max(0, Math.min(99999999, Math.floor(Number(x) || 0)));
      if (x === have) delete itemPending[id]; else itemPending[id] = x;
      itemNote = null; itemErr = false; renderItems(false);
    };
    inp.addEventListener('change', () => setTo(inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTo(inp.value); });
    for (const b of r.querySelectorAll('.step')) b.addEventListener('click', () => setTo(b.dataset.z ? 0 : val + Number(b.dataset.d)));
    return r;
  };
  const host = $('item-groups'); host.innerHTML = '';
  for (const g of cur.d.groups) {
    const h = document.createElement('h2'); h.className = 'list-head'; h.textContent = g.title; host.appendChild(h);
    const list = document.createElement('div'); list.className = 'season-list';
    for (const it of g.items) { known.add(it.id); list.appendChild(row(it.id, it.name, it.blurb)); }
    host.appendChild(list);
  }
  const other = $('item-other'); other.innerHTML = '';
  const otherIds = [...new Set([...Object.keys(ch.items), ...Object.keys(itemPending)])].filter(id => !known.has(id)).sort();
  for (const id of otherIds) other.appendChild(row(id, id.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), ''));
  $('item-more-n').textContent = otherIds.length;
  $('item-undo').onclick = () => { itemPending = {}; itemNote = null; itemErr = false; renderItems(false); };
  $('item-save').onclick = async () => {
    $('item-save').disabled = true; itemNote = 'Saving...'; itemErr = false; note.textContent = itemNote;
    const r = await L.setItems(itemVer, itemChar, itemPending);
    if (r && r.ok) { itemPending = {}; itemNote = 'Saved. You will see it the next time you press Play. (Backup kept in backup\\inventory.)'; itemErr = false; }
    else { itemNote = (r && r.error) || 'Could not save.'; itemErr = true; }
    renderItems(!!(r && r.ok));
  };
  $('item-add-btn').onclick = () => {
    const id = $('item-add-id').value.trim().toUpperCase(), q = Math.max(0, Math.floor(Number($('item-add-n').value) || 0));
    if (!/^[A-Z0-9_]{3,80}$/.test(id)) { itemNote = 'That is not an item ID (capital letters, digits and _ only).'; itemErr = true; renderItems(false); return; }
    const have = ch.items[id] || 0;
    if (q === have) delete itemPending[id]; else itemPending[id] = q;
    $('item-add-id').value = ''; itemNote = null; itemErr = false;
    if (!known.has(id)) $('item-more').open = true;
    renderItems(false);
  };
}

// ---------------------------------------------------------------- patch notes
async function renderPatches() {
  const host = $('patch-list');
  let notes = []; try { notes = await L.patchNotes(); } catch {}
  host.innerHTML = notes.length ? '' : '<p class="small">No patch notes yet.</p>';
  for (const n of notes) {
    const d = document.createElement('article'); d.className = 'patch';
    d.innerHTML = `<div class="patch-date">${esc(n.date || '')}</div><h2>${esc(n.title || '')}</h2><ul>${(n.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    host.appendChild(d);
  }
}

// ---------------------------------------------------------------- seasons
const SEASON_KINDS = [
  ['all', 'All'], ['original', 'Original'], ['reimagined', 'Reimagined'], ['vault', 'Vault'], ['event', 'Event passes'], ['mega', 'Mega'],
];
const KIND_LABEL = { mega: 'Mega pass, every season in one', original: 'Original, as shipped', reimagined: 'Reimagined', vault: 'Vault re-release, as shipped', event: 'Event pass, as shipped' };
let seasonVer = null, seasonFilter = 'all', seasonNote = null;
// the season's reward list (a small Markdown file: a heading, a few lines, one table) shown in a dialog
async function showSeasonDoc(x) {
  const md = (await L.openSeasonDoc(seasonVer, x.key)) || '';
  const inl = t => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  let html = '', rows = [];
  const flush = () => {
    if (!rows.length) return;
    const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    html += '<table><thead><tr>' + head.map(h => `<th>${inl(h)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.slice(1).filter(r => !/^\|[\s|:-]+\|$/.test(r)).map(r => '<tr>' + cells(r).map(c => `<td>${inl(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
    rows = [];
  };
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('|')) { rows.push(line.trim()); continue; }
    flush();
    if (/^#\s/.test(line)) continue;                       // the title is the dialog heading
    if (/^#{2,}\s/.test(line)) html += `<h3>${inl(line.replace(/^#+\s/, ''))}</h3>`;
    else if (/^[-*]\s/.test(line)) html += `<p class="li">${inl(line.slice(2))}</p>`;
    else if (line.trim()) html += `<p>${inl(line)}</p>`;
  }
  flush();
  $('season-doc-title').textContent = `${x.title}: rewards`;
  $('season-doc-body').innerHTML = html || '<p>No reward list for this season.</p>';
  $('dlg-season').showModal(); $('season-doc-body').scrollTop = 0;
}
async function renderSeasons() {
  const withSeasons = [];
  for (const v of versions.filter(x => x.hasPackage)) {
    let d = null; try { d = await L.seasons(v.id); } catch {}
    if (d && d.seasons.length) withSeasons.push({ v, d });
  }
  if (!withSeasons.some(x => x.v.id === seasonVer)) seasonVer = (withSeasons.find(x => x.v.id === selected) || withSeasons[0] || {}).v?.id || null;
  const tabs = $('season-vtabs'); tabs.innerHTML = '';
  for (const { v } of withSeasons) {
    const b = document.createElement('button'); b.className = 'season-tab'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === seasonVer)); b.textContent = v.name || v.id;
    b.addEventListener('click', () => { seasonVer = v.id; seasonNote = null; renderSeasons(); });
    tabs.appendChild(b);
  }
  tabs.hidden = withSeasons.length < 2;
  const cur = withSeasons.find(x => x.v.id === seasonVer);
  $('season-none').hidden = !!cur; $('season-body').hidden = !cur;
  if (!cur) return;
  const { d } = cur;
  const on = d.seasons.find(x => x.key === d.active) || d.seasons[0];
  $('season-now-title').textContent = on.title;
  $('season-now-sub').textContent = (on.started ? `Level ${on.level} of ${on.levels}` : `Not started, ${on.levels} levels`) + ` · ${KIND_LABEL[on.kind] || on.kind}`;
  $('season-now-fill').style.width = (on.levels ? Math.round(100 * on.level / on.levels) : 0) + '%';
  const note = $('season-note'); note.className = 'action-note'; note.textContent = seasonNote || '';

  const filters = $('season-filters'); filters.innerHTML = '';
  for (const [k, label] of SEASON_KINDS) {
    const n = k === 'all' ? d.seasons.length : d.seasons.filter(x => x.kind === k).length;
    if (!n) continue;
    const b = document.createElement('button'); b.className = 'season-filter'; b.setAttribute('aria-pressed', String(k === seasonFilter));
    b.innerHTML = `${esc(label)}<span class="n">${n}</span>`;
    b.addEventListener('click', () => { seasonFilter = k; renderSeasons(); });
    filters.appendChild(b);
  }
  const list = $('season-list'); list.innerHTML = '';
  for (const x of d.seasons.filter(x => seasonFilter === 'all' || x.kind === seasonFilter)) {
    const row = document.createElement('div'); row.className = 'season-row' + (x.key === on.key ? ' active' : '');
    const pct = x.levels ? Math.round(100 * x.level / x.levels) : 0;
    row.innerHTML = `
      <div><div class="season-name">${esc(x.title)}</div><div class="season-kind"><b>${esc(KIND_LABEL[x.kind] || x.kind)}</b> · ${x.levels} levels</div></div>
      <div class="season-lvl${x.started ? '' : ' none'}">${x.started ? `Level ${x.level} / ${x.levels}<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` : 'Not started'}</div>
      <div class="season-acts"><button class="ghost" data-doc>Rewards</button>${x.key === on.key ? '<span class="season-on">Playing</span>' : '<button class="ghost pick" data-pick>Play this</button>'}</div>`;
    row.querySelector('[data-doc]').addEventListener('click', () => showSeasonDoc(x));
    const pick = row.querySelector('[data-pick]');
    if (pick) pick.addEventListener('click', async () => {
      const r = await L.setSeason(seasonVer, x.key);
      if (!r || !r.ok) { seasonNote = (r && r.error) || 'Could not change the season.'; }
      else seasonNote = r.running
        ? `Switched to ${x.title}. Close the game and press Play again: the season loads when the servers start.`
        : `Switched to ${x.title}. It starts the next time you press Play.`;
      renderSeasons();
    });
    list.appendChild(row);
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function addLog(id, line, isErr) {
  (logs[id] = logs[id] || []).push({ line, isErr });
  if (logs[id].length > 400) logs[id].splice(0, logs[id].length - 400);
  if (id === selected) { $('log').hidden = false; renderLog(id); }
}
function renderLog(id) {
  const body = $('log-body'); const lg = logs[id] || [];
  body.innerHTML = lg.map(l => `<span class="${l.isErr ? 'err' : (/ready|running|DONE|All closed|complete/i.test(l.line) ? 'ok' : '')}">${esc(l.line)}</span>`).join('\n');
  body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- actions
async function primary() {
  const v = versions.find(x => x.id === selected); if (!v || !v.hasPackage) return;
  const st = stateOf(v);
  if (st.key === 'busy') return;
  if (st.step === 'game') return startDownload(v);
  if (st.step === 'setup') return runSetup(v, false);
  if (st.step === 'play') return play(v);
}
async function startDownload(v) {
  const free = await L.freeSpace(info.gamesRoot);
  const need = Math.ceil(v.download.installedGB * 2);
  const ok = await confirm(`Download Dauntless ${v.id}?`,
    `${v.download.downloadGB} GB from Epic's servers into\n${info.gamesRoot}\\${v.download.folderName}\n\nWhile it runs it needs about ${need} GB free${free != null ? ` (you have ${free} GB)` : ''}; afterwards the folder is ${v.download.installedGB} GB. Stop any time; it carries on later.`);
  if (!ok) return;
  busy[v.id] = 'download'; dl[v.id] = { state: 'running', pct: 0 }; logs[v.id] = [];
  renderShelf(); renderDetail();
  const r = await L.download(v.id, info.gamesRoot);
  busy[v.id] = null;
  dl[v.id] = { ...(dl[v.id] || {}), state: r.ok ? 'done' : 'failed', error: r.error };
  await refresh(v.id);
}
async function runSetup(v, uninstall) {
  if (uninstall) {
    const ok = await confirm('Put the game folder back?', `This takes this version's files out of the game folder again (they are kept in the launcher's backup folder, nothing is deleted). Your offline save stays. You can run Set up again later.`);
    if (!ok) return;
  }
  busy[v.id] = 'setup'; delete dl[v.id]; renderShelf(); renderDetail();
  const r = await L.setup(v.id, uninstall);
  busy[v.id] = null;
  await refresh(v.id);
  const s = statuses[v.id];
  if (!uninstall && s.setup !== 'ready') { const n = $('action-note'); n.textContent = 'Set-up did not finish. The window that opened said why; fix that and press Set up again.'; n.className = 'action-note err'; }
}
async function play(v) {
  busy[v.id] = 'play'; logs[v.id] = []; renderShelf(); renderDetail();
  const r = await L.play(v.id);
  busy[v.id] = null;
  await refresh(v.id);
  if (!r.ok && r.error) { const n = $('action-note'); n.textContent = r.error; n.className = 'action-note err'; }
}
function confirm(title, text) {
  return new Promise((res) => {
    const d = $('dlg-confirm'); $('confirm-title').textContent = title; $('confirm-text').textContent = text;
    const yes = $('confirm-yes'), no = $('confirm-no');
    const done = (val) => { d.close(); yes.onclick = no.onclick = null; res(val); };
    yes.onclick = () => done(true); no.onclick = () => done(false); d.oncancel = () => done(false);
    d.showModal();
  });
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('btn-primary').addEventListener('click', primary);
  $('btn-stop').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const ok = await confirm('Stop everything?', 'This closes the local backend and the hidden game servers. If the game itself is still open, it is closed too (your progress is saved as you play).');
    if (!ok) return;
    $('btn-stop').disabled = true; await L.stop(v.id); $('btn-stop').disabled = false;
  });
  $('btn-cancel').addEventListener('click', () => { if (selected) L.cancelDownload(selected); });
  $('btn-more').addEventListener('click', () => { $('more-menu').hidden = !$('more-menu').hidden; });
  $('more-menu').addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    $('more-menu').hidden = true;
    const v = versions.find(x => x.id === selected); if (!v) return;
    if (act === 'pick') {
      const r = await L.pickFolder(v.id);
      if (r.picked) delete dl[v.id];
      if (r.picked && !r.ok) { const n = $('action-note'); n.textContent = r.reason; n.className = 'action-note err'; }
      await refresh(v.id);
      if (r.picked && r.ok && statuses[v.id].game === 'wrong') { const n = $('action-note'); n.textContent = `That folder has a Dauntless game, but not build ${v.build}. This version only works with that exact build.`; n.className = 'action-note err'; }
    }
    if (act === 'setup') runSetup(v, false);
    if (act === 'uninstall') runSetup(v, true);
    if (act === 'opengame') L.openGameFolder(v.id);
    if (act === 'openver') L.openVersionFolder(v.id);
    if (act === 'logs') { L.openLogs(v.id); const n = $('action-note'); n.textContent = 'Send the two zips in the upload folder (client_logs.zip, server_logs.zip). Your PC name and user name are blanked out in them.'; n.className = 'action-note'; }
    if (act === 'readme') { $('readme-title').textContent = `${v.name} README`; $('readme-body').textContent = (await L.readme(v.id)) || '(no README in this package)'; $('dlg-readme').showModal(); }
  });
  $('btn-log-clear').addEventListener('click', () => { if (selected) { logs[selected] = []; renderDetail(); } });
  $('set-sky').addEventListener('click', () => { const on = Sky.toggle(); $('set-sky').textContent = on ? 'Turn off' : 'Turn on'; });
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) showPage(b.dataset.page); });
  $('set-games-pick').addEventListener('click', async () => { const p = await L.pickGamesRoot(); if (p) { info.gamesRoot = p; $('set-games').textContent = p; renderDetail(); } });
  $('set-data-open').addEventListener('click', () => L.openPath(info.dataRoot));
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) { e.preventDefault(); L.openUrl(a.dataset.url); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) $('more-menu').hidden = true; });

  L.onLog(({ id, line, isErr }) => addLog(id, line, isErr));
  L.onDownloadProgress((p) => { dl[p.id] = { ...(dl[p.id] || {}), ...p, state: 'running' }; if (p.id === selected) renderDetail(); });
  L.onDownloadState(({ id, state, error, outDir }) => { dl[id] = { ...(dl[id] || {}), state, error, outDir }; if (state !== 'running') busy[id] = null; refresh(id); });
  L.onSetupState(({ id, state }) => { busy[id] = state === 'running' ? 'setup' : null; refresh(id); });
  L.onPlayState(({ id, state }) => { busy[id] = state === 'running' ? 'play' : null; Sky.pause(state === 'running'); refresh(id); if (!$('page-seasons').hidden) renderSeasons(); });
  L.onUpdatesEvent(({ msg }) => { updateLog.push(msg); });
  L.onUpdatesDone(async ({ results }) => {
    versions = await L.listVersions(); await refreshAll(); renderShelf(); renderDetail();
    const ok = results.filter(r => r.applied), bad = results.filter(r => !r.applied);
    let text = '';
    if (ok.length) text += `Server files updated for ${ok.map(r => `${r.id} (${r.to})`).join(', ')}. Run Set up again on ${ok.length > 1 ? 'those versions' : 'that version'} to put the new files into the game folder.`;
    if (bad.length) text += (text ? ' ' : '') + `Update failed for ${bad.map(r => r.id).join(', ')}: ${bad[0].error}.`;
    if (text) { $('banner-text').textContent = text; $('banner').hidden = false; }
  });
  $('banner-close').addEventListener('click', () => { $('banner').hidden = true; });
  // a newer launcher: a banner with a Download button (opens the release page; the player unzips it over this one)
  let upUrl = '';
  const showLauncherUpdate = (u) => {
    if (!u) return; upUrl = u.url;
    $('banner-up-text').textContent = `Dauntless Forever ${u.version} is out` + (u.notes ? `: ${u.notes}` : '.') + ' Your games and saves stay where they are.';
    $('banner-up').hidden = false; $('set-launcher').textContent = `· ${u.version} is available`;
  };
  L.onLauncherUpdate(showLauncherUpdate);
  L.newerLauncher().then(showLauncherUpdate).catch(() => {});
  $('banner-up-get').addEventListener('click', () => { if (upUrl) L.openUrl(upUrl); });
  $('banner-up-close').addEventListener('click', () => { $('banner-up').hidden = true; });
  $('set-pkgs-check').addEventListener('click', async () => { $('set-pkgs').textContent = 'Checking...'; await L.checkUpdates(); await fillSettings(); if (!updateLog.length) $('set-pkgs').textContent += ' (up to date)'; });

  // while set-up runs in its own window, re-check every few seconds so the steps tick over as it goes
  refreshTimer = setInterval(() => { for (const id of Object.keys(busy)) if (busy[id] === 'setup') refresh(id); }, 4000);
  window.addEventListener('focus', () => { if (selected) refresh(selected); });
}
boot();
