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
const DISCORD_INVITE = 'https://discord.gg/sg9J7KshVc';
async function loadCommunity() {
  let c; try { c = await L.communityInfo(); } catch { return; }
  const links = c.community || {};
  for (const [id, url] of [['lnk-patreon', links.patreon], ['lnk-patreon-2', links.patreon]]) {
    const el = $(id); if (!el) continue; el.dataset.url = url || ''; el.hidden = !url;
  }
  // "Join the Discord" at the bottom of the sidebar: the server invite (community.json "discord" can change it)
  const ask = $('lnk-ask');
  ask.dataset.url = /^https:\/\/(discord\.gg|discord\.com)\//.test(links.discord || '') ? links.discord : DISCORD_INVITE;
  ask.hidden = false;
  const dc = $('lnk-discord'); dc.dataset.url = ''; dc.hidden = true;   // the older plain button: the card above replaces it
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
  $('set-node').textContent = info.node ? (info.node.bundled ? `${info.node.version}, included with the launcher` : `${info.node.version} at ${info.node.path}`) : 'Not installed yet. Set-up offers to install it.';
  $('set-tool').textContent = info.toolOk ? 'manifest.exe (meszmate/manifest with the plain-chunk fix), checked' : 'Missing or damaged. Reinstall the launcher.';
  $('set-ver').textContent = `Dauntless Forever ${info.version}`;
  $('set-pkgs').textContent = versions.filter(v => v.hasPackage).map(v => `${v.id}: ${v.package.packageVersion}`).join(', ') + (updateLog.length ? ` (last check: ${updateLog[updateLog.length - 1]})` : '');
  fillMenuBackground();
  fillGameLanguage();
}
// Game language (-CULTURE= on the game's command line; the server files do it). Hidden until a version supports it.
const LANG_SUB = "The language of the game's text and voices. Windows and the launcher stay as they are. Changes at the next game start.";
async function fillGameLanguage() {
  let g = null; try { g = await L.gameLanguage(); } catch {}
  const row = $('set-lang-row');
  if (!g || !g.versions || !g.versions.length) { row.hidden = true; return; }
  row.hidden = false;
  const sel = $('set-lang');
  if (!sel.options.length) for (const [code, name] of g.languages) { const o = document.createElement('option'); o.value = code; o.textContent = name; sel.appendChild(o); }
  sel.value = g.current || '';
  $('set-lang-sub').textContent = LANG_SUB;
}
// Main menu background (menu.json in the server files; 1.6.2 for now). Hidden when no version has it.
let menuVer = null;
async function fillMenuBackground() {
  let all = [];
  try { all = (await L.menuBackgrounds()) || []; } catch {}
  const m = all.find(x => x.id === '1.6.2') || all[0];
  $('set-menu-row').hidden = !m;
  if (!m) { menuVer = null; return; }
  menuVer = m.id;
  $('set-menu-ver').textContent = m.id;
  const sel = $('set-menu'); sel.innerHTML = '';
  for (const b of m.backgrounds) {
    const o = document.createElement('option');
    o.value = b.key; o.textContent = b.title + (b.season && b.key !== 'default' ? ` (season ${b.season})` : '') + (b.tested === false ? ' - experimental' : '');
    sel.appendChild(o);
  }
  if (m.custom) { const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Your own picture...'; sel.appendChild(o); }
  sel.value = m.background;
  menuShowCustom(m);
  $('set-menu-sub').textContent = 'The art behind the game\'s start and login screen, from any Hunt Pass season or your own picture. Changes at the next game start.';
}
function menuShowCustom(m) {
  const isCustom = $('set-menu').value === 'custom';
  $('set-menu-pick').hidden = !isCustom;
  $('set-menu-pick').textContent = m && m.hasPicture ? 'Change picture' : 'Choose picture';
  $('set-menu-preview').hidden = !(isCustom && m && m.preview);
  if (m && m.preview) $('set-menu-preview').src = m.preview;
}
async function menuPickPicture() {
  $('set-menu-sub').textContent = 'Choose a picture. It is cropped to a wide 2:1 shape from the middle.';
  $('set-menu-pick').disabled = true;
  let r; try { r = await L.pickMenuPicture(menuVer); } finally { $('set-menu-pick').disabled = false; }
  const m = await L.menuBackgrounds(menuVer);
  if (m) { $('set-menu').value = m.background === 'custom' || !r || !r.ok ? m.background : 'custom'; menuShowCustom(m); }
  if (r && r.ok) $('set-menu-sub').textContent = `Saved: ${r.name}. You will see it the next time you start the game.`;
  else if (r && r.canceled) $('set-menu-sub').textContent = m && m.hasPicture ? 'Kept your current picture.' : 'No picture chosen.';
  else $('set-menu-sub').textContent = (r && r.error) || 'Could not use that picture.';
}
async function refreshAll() { for (const v of versions) statuses[v.id] = await L.status(v.id); }
async function refresh(id) { statuses[id] = await L.status(id); renderShelf(); if (selected === id) renderDetail(); }

// ---------------------------------------------------------------- derived state
function stateOf(v) {
  const s = statuses[v.id] || {};
  const b = busy[v.id] || s.busy;
  if (!v.hasPackage) return { key: 'soon', label: 'Coming soon', step: 'none' };
  if (b === 'download') return { key: 'busy', busy: b, label: 'Downloading', step: 'game' };
  if (b === 'setup') return { key: 'busy', busy: b, label: 'Setting up', step: 'setup' };
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
  $('d-blurb').textContent = v.blurb || ''; $('d-blurb').title = v.blurb || '';
  $('d-warn').hidden = !v.warning; $('d-warn').textContent = v.warning || '';
  const pill = $('d-pill'); pill.textContent = st.label; pill.className = 'pill ' + st.key;

  // steps
  const gameDone = s.game === 'ok', setupDone = gameDone && s.setup === 'ready';
  setStep('game', gameDone ? 'done' : (st.step === 'game' ? 'current' : ''),
    gameDone ? shortPath(s.gameDir) : (s.game === 'partial' ? 'Partly downloaded; Download carries on' : (s.game === 'wrong' ? 'That folder has a different build' : `${v.download.downloadGB} GB from Epic's servers`)));
  setStep('setup', setupDone ? 'done' : (st.step === 'setup' ? 'current' : (gameDone ? '' : 'blocked')),
    setupDone ? (s.config && s.config.PlayerName ? `Player: ${s.config.PlayerName}` : 'Done') : ((s.prereqMissing && s.prereqMissing.length) ? 'Windows parts missing (DirectX / Visual C++)' : 'Automatic after the download, no questions'));
  setStep('play', st.key === 'busy' && st.step === 'play' ? 'current' : (setupDone ? (st.step === 'play' ? 'current' : '') : 'blocked'),
    s.hasSave ? 'Your save is here; progress carries on' : 'Starts as a new Slayer');

  // the one button
  const p = $('btn-primary'); const note = $('action-note'); note.className = 'action-note';
  $('btn-stop').hidden = true; $('btn-cancel').hidden = true;
  p.disabled = false;
  if (!v.hasPackage) { p.textContent = 'Coming soon'; p.disabled = true; note.textContent = 'The offline package for this version is still being made. It will show up here when it is ready.'; }
  else if (st.busy === 'download') { p.textContent = 'Downloading'; p.disabled = true; $('btn-cancel').hidden = false; note.textContent = 'You can keep using the launcher. Cancelling keeps what is already downloaded.'; }
  else if (st.busy === 'setup') {
    p.textContent = 'Setting up'; p.disabled = true;
    note.textContent = setupAuto[v.id] ? 'Getting the game ready. One time, no questions; it takes a minute or two. If Windows asks for permission, that is for parts the game needs (DirectX, Visual C++).'
      : 'Answer the questions in the black window, then close it when it says it is finished.';
  }
  else if (st.busy === 'play') { p.textContent = 'Running'; p.disabled = true; $('btn-stop').hidden = false; note.textContent = 'Close the game normally and everything else shuts down by itself.'; }
  else if (st.step === 'game') { p.textContent = s.game === 'partial' ? 'Continue download' : 'Download'; note.textContent = `About ${v.download.downloadGB} GB to download, ${v.download.installedGB} GB installed. Goes to ${info.gamesRoot}\\${v.download.folderName} (change it in Settings). Already have ${v.id}? Use "More".`; }
  else if (st.step === 'setup') {
    p.textContent = 'Set up';   // one click, no window (setup.ps1 -Auto)
    if (s.prereqMissing && s.prereqMissing.length) note.textContent = `Windows is missing parts the game needs (${s.prereqMissing.join(', ')}). Set up downloads them from Microsoft and installs them; Windows asks for permission once.`;
    else note.textContent = s.game === 'ok' && s.setup === 'needed' && s.config ? 'The game files or the server files changed. Set up puts things right again; it only fixes what is missing, and your save stays.' : 'One click, no questions. Needs the internet once (a small data pack).';
  }
  else {
    p.textContent = v.canHost ? 'Play solo' : 'Play'; note.textContent = '';
    // hosting or in a friend's game with this version: Play waits until that game closes
    const run = (window.dfSocial && window.dfSocial.running) || [];
    if (run.some(r => r.id === v.id + ':host')) { p.disabled = true; note.textContent = 'You are hosting: friends see you in their Friends panel and press Join. Close your game to stop.'; }
    else if (run.some(r => r.id === v.id + ':join')) {
      p.disabled = true;
      const w = window.dfSocial && window.dfSocial.inGameWith;
      note.textContent = w ? `You are in ${w.name}'s game${w.public ? ' (open to everyone)' : ''}. Your character is saved home every few minutes. Close the game to play here.` : 'You are in a friend\'s game. Close it to play here.';
    }
  }
  // download notes only while they are still news (not after the player moved on or picked another folder)
  if (!st.busy && st.step === 'game' && d && d.state === 'failed' && d.error) { note.textContent = d.error; note.className = 'action-note err'; }
  if (!st.busy && st.step === 'setup' && d && d.state === 'done' && !(s.prereqMissing && s.prereqMissing.length)) { note.textContent = 'Download finished and checked. Set up runs by itself next.'; }

  renderHostButton();

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
  m.querySelector('[data-act="delpartial"]').disabled = st.key === 'busy' || s.game === 'ok';
  // the Revived (1.4.4) import: only for versions whose server files have it, once the game is set up
  const imp = m.querySelector('[data-act="import"]'), fix = m.querySelector('[data-act="importfix"]');
  imp.hidden = !s.canImport; imp.disabled = !setupDone || st.key === 'busy';
  fix.hidden = !(s.canImportFix && s.imported); fix.disabled = !setupDone || st.key === 'busy';
}
// "Host with friends": the selected version, hosted through the Dauntless Forever relay (main/social.js). Friends
// see it in their Friends panel and press Join. Hidden in Offline Forever mode and for versions that cannot host yet.
function renderHostButton() {
  const v = versions.find(x => x.id === selected); const hb = $('btn-host'); if (!v || !hb) return;
  const soc = window.dfSocial || null, st = stateOf(v);
  const run = (soc && soc.running) || [];
  const hostingThis = run.some(r => r.id === v.id + ':host');
  // shown (dim) from the start, lit up once the version is ready to play
  hb.hidden = !v.canHost || !!(soc && soc.offlineMode);
  hb.classList.toggle('on', hostingThis);
  // Host Mode (Host Mode page) runs this version: the server is already up here, so Play only starts the game
  const hm = soc && soc.hostMode && soc.hostMode.version === v.id ? soc.hostMode : null;
  hb.lastChild.textContent = hm ? 'Host Mode on' : hostingThis ? 'Hosting' : 'Host with friends';
  hb.disabled = hostingThis || st.key !== 'ready' || run.length > 0 || !!(soc && soc.onlineOff);
  const ping = soc && soc.relay ? ` (online server: ${soc.relay.name}, ${soc.relay.ms} ms)` : '';
  const randoms = !!(soc && soc.allowRandoms);
  hb.title = st.key !== 'ready' && !hostingThis ? 'Ready once the game is downloaded and set up' : soc && soc.onlineOff ? soc.onlineOff : (hostingThis ? (soc && soc.hostPublic ? 'Your game is open to everyone' : 'Your game is open to your friends')
    : `Play ${v.id} and let your friends${randoms ? ' (and players using Play online)' : ''} join you${ping}`);
  renderOnline(v, soc, st, run, hostingThis);
  if (hm) {
    hb.title = 'Host Mode is running this version (see the Host Mode page)';
    const p = $('btn-primary'), n = $('action-note');
    if (st.busy === 'play') { n.textContent = 'Close the game when you like: Host Mode keeps the server running.'; n.className = 'action-note'; }
    else if (st.key === 'ready') {
      p.textContent = 'Play on your server'; p.disabled = hm.phase !== 'running';
      n.className = 'action-note';
      n.textContent = hm.phase === 'running' ? `Host Mode is running "${hm.name}". Play starts only the game and joins it; closing the game keeps the server up.`
        : 'Host Mode is starting. Play works as soon as the server is up.';
    }
  }
}
window.renderHostButton = renderHostButton;
// "Play online": join a game on this version that is open to everyone, or host one if none turns up in 40 seconds.
// "Allow randoms" (under the buttons): a hosted game is open to Play online players too. main/social.js does the work.
let onlineNote = '';
function renderOnline(v, soc, st, run, hostingThis) {
  const ob = $('btn-online'), opt = $('host-opt'), n = $('action-note'); if (!ob || !opt) return;
  const search = soc && soc.search;
  const mine = !!(search && search.version === v.id);
  const off = !v.canHost || !!(soc && soc.offlineMode);
  ob.hidden = off;   // dim until the version is ready, like Host with friends
  ob.classList.toggle('on', mine);
  const lbl = ob.querySelector('.lbl');
  lbl.textContent = !mine ? 'Play online' : search.phase === 'asking' ? 'Joining' : search.phase === 'hosting' ? 'Starting' : `Searching ${search.left}`;
  ob.disabled = !mine && (st.key !== 'ready' || run.length > 0 || !!search || !!(soc && soc.onlineOff) || !(soc && soc.signedIn));
  ob.title = st.key !== 'ready' && !mine ? 'Ready once the game is downloaded and set up' : soc && soc.onlineOff ? soc.onlineOff : mine ? 'Click to stop looking'
    : !(soc && soc.signedIn) ? 'Signing you in to the online service...' : `Play ${v.id} with anyone online: joins a game that is open to everyone, or hosts one`;
  // the note under the buttons says what the search is doing, and goes away when it is over
  if (mine) {
    onlineNote = search.phase === 'asking' ? `Found ${search.host}'s game. Asking to join...`
      : search.phase === 'hosting' ? 'No open game right now, so you host one: a window opens, keep it open. Players using Play online join you.'
      : `Looking for a ${v.id} game that is open to everyone. If none turns up in ${search.left} seconds, you host one and others join you. Click the button to stop.`;
    n.textContent = onlineNote; n.className = 'action-note';
  } else if (onlineNote) { if (n.textContent === onlineNote) n.textContent = ''; onlineNote = ''; }
  // Allow randoms: shown with the Host button; fixed while hosting (it applies when hosting starts)
  opt.hidden = off;
  const box = $('opt-randoms');
  box.checked = !!(soc && soc.allowRandoms);
  box.disabled = hostingThis;
  opt.classList.toggle('off', hostingThis);
  opt.title = hostingThis ? 'Change this before you host: it applies when hosting starts.' : 'Your hosted games show up for players who press Play online. Friends can always join.';
}
function setStep(name, cls, sub) { const el = document.querySelector(`.step[data-step="${name}"]`); el.className = 'step ' + cls; $('s-' + name).textContent = sub; }
function fill(id, items) { const ul = $(id); ul.innerHTML = ''; for (const t of (items || [])) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); } }
function shortPath(p) { if (!p) return ''; return p.length > 48 ? '...' + p.slice(-46) : p; }
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

// ---------------------------------------------------------------- version picker + banner (Game Rules, Inventory)
// Every version with server files gets a tab; ones without this page yet are marked "soon". The banner says loudly which
// version's save / server the page is changing, because each version keeps its own.
function versionPicker(tabsId, bannerId, all, curId, supported, onPick, bannerSub) {
  const tabs = $(tabsId); tabs.innerHTML = '';
  for (const v of all) {
    const ok = supported.has(v.id);
    const b = document.createElement('button'); b.className = 'season-tab ver-tab' + (ok ? '' : ' soon'); b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v.id === curId));
    b.innerHTML = `${esc(v.id)}${ok ? '' : ' <span class="soon-tag">soon</span>'}`;
    b.addEventListener('click', () => { if (v.id !== curId) onPick(v.id); });
    tabs.appendChild(b);
  }
  tabs.hidden = all.length < 2;
  const v = all.find(x => x.id === curId), ban = $(bannerId);
  ban.hidden = !v;
  if (!v) return;
  ban.classList.toggle('off', !supported.has(v.id));
  ban.innerHTML = `<div class="vb-num">${esc(v.id)}</div>
    <div class="vb-text"><div class="vb-title">Dauntless ${esc(v.id)}${v.era ? ` <span class="vb-era">${esc(v.era)}</span>` : ''}</div>
    <div class="vb-sub">${bannerSub}</div></div>`;
}
function pickVersion(all, cur, supported) {
  if (all.some(v => v.id === cur)) return cur;
  return (all.find(v => v.id === selected && supported.has(v.id)) || all.find(v => supported.has(v.id)) || all.find(v => v.id === selected) || all[0] || {}).id || null;
}

// ---------------------------------------------------------------- Game Rules
let ruleVer = null, ruleNote = null;
async function renderRules() {
  const all = versions.filter(x => x.hasPackage);
  const withRules = [];
  for (const v of all) {
    let d = null; try { d = await L.rules(v.id); } catch {}
    if (d && d.rules.length) withRules.push({ v, d });
  }
  const supported = new Set(withRules.map(x => x.v.id));
  ruleVer = pickVersion(all, ruleVer, supported);
  const cur = withRules.find(x => x.v.id === ruleVer);
  versionPicker('rule-vtabs', 'rule-vbanner', all, ruleVer, supported, (id) => { ruleVer = id; ruleNote = null; renderRules(); },
    cur ? `These rules change <b>Dauntless ${esc(ruleVer)} only</b>. Every version keeps its own Game Rules.`
        : `Game Rules are not available for Dauntless ${esc(ruleVer || '')} yet.`);
  $('rule-none').hidden = !!cur; $('rule-body').hidden = !cur;
  $('rule-none-title').textContent = `No Game Rules for ${ruleVer || 'this version'} yet`;
  if (!cur) return;
  const { d } = cur;
  $('rule-note').textContent = ruleNote || '';
  const apply = async (changes, what) => {
    const r = await L.setRules(ruleVer, changes);
    ruleNote = !r || !r.ok ? ((r && r.error) || 'Could not change it.')
      : r.running ? `${ruleVer} ${what}: close the game and press Play again for it to apply.` : `${ruleVer} ${what}: applies the next time you play ${ruleVer}.`;
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
  const all = versions.filter(x => x.hasPackage);
  if (reload || !itemData) {
    const found = [];
    for (const v of all) { let d = null; try { d = await L.items(v.id); } catch {} if (d) found.push({ v, d }); }
    itemData = { found };
  }
  const { found } = itemData;
  const supported = new Set(found.map(x => x.v.id));
  itemVer = pickVersion(all, itemVer, supported);
  const cur = found.find(x => x.v.id === itemVer);
  const save = cur && cur.d.save;
  const chars = (save && save.ok && save.characters) || [];
  const usable = cur && chars.length;
  const chName = usable ? ((chars.find(c => c.id === itemChar) || chars[0]).name || '') : '';
  versionPicker('item-vtabs', 'item-vbanner', all, itemVer, supported,
    (id) => {
      if (Object.keys(itemPending).length && !confirm(`You have unsaved changes for ${itemVer}. Switch to ${id} and drop them?`)) return;
      itemVer = id; itemPending = {}; itemNote = null; itemErr = false; renderItems(true);
    },
    cur ? `You are editing your <b>Dauntless ${esc(itemVer)} save</b>${chName ? ` (character <b>${esc(chName)}</b>)` : ''}. Every version has its own save and its own items.`
        : `Inventory editing is not available for Dauntless ${esc(itemVer || '')} yet.`);
  $('item-none').hidden = !!usable; $('item-body').hidden = !usable;
  if (!usable) {
    const why = !cur ? null : (save && !save.ok ? save.error : 'No character yet. Press Play once and make a character first.');
    $('item-none-title').textContent = why ? 'Nothing to edit yet' : `No inventory editing for ${itemVer || 'this version'} yet`;
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
  $('item-save').textContent = n ? `Save ${n} change${n > 1 ? 's' : ''} to ${itemVer}` : `Save to ${itemVer}`;
  const known = new Set();
  const row = (id, name, blurb) => {
    const have = ch.items[id] || 0;
    const val = id in itemPending ? itemPending[id] : have;
    const r = document.createElement('div'); r.className = 'season-row item-row' + (id in itemPending ? ' active' : '');
    r.innerHTML = `
      <div><div class="season-name">${esc(name)}</div><div class="season-kind">${blurb ? esc(blurb) + ' ' : ''}<code>${esc(id)}</code></div></div>
      <div class="item-have">${id in itemPending ? `<s>${fmtN(have)}</s> &gt; ` : ''}<b>${fmtN(val)}</b></div>
      <div class="item-edit">
        <button class="ghost step" data-d="-10" title="10 less">-10</button>
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
  renderGear(cur, ch, note);
  const other = $('item-other'); other.innerHTML = '';
  const otherIds = [...new Set([...Object.keys(ch.items), ...Object.keys(itemPending)])].filter(id => !known.has(id)).sort();
  for (const id of otherIds) other.appendChild(row(id, id.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), ''));
  $('item-more-n').textContent = otherIds.length;
  $('item-undo').onclick = () => { itemPending = {}; itemNote = null; itemErr = false; renderItems(false); };
  $('item-save').onclick = async () => {
    $('item-save').disabled = true; itemNote = 'Saving...'; itemErr = false; note.textContent = itemNote;
    const r = await L.setItems(itemVer, itemChar, itemPending);
    if (r && r.ok) { itemPending = {}; itemNote = `Saved to your ${itemVer} save. You will see it the next time you play ${itemVer}. (Backup kept in backup\\inventory.)`; itemErr = false; }
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

// Gear part of the Inventory page (versions whose helper returns gear + a gear catalog, 1.6.2 first).
let gearConfirm = null;
function renderGear(cur, ch, note) {
  const cat = cur.d.save && cur.d.save.gearCatalog;
  $('item-gear').hidden = !(cat && Array.isArray(ch.gear));
  if ($('item-gear').hidden) return;
  const names = new Map(cat.map(g => [g[0], g]));
  const dl = $('gear-options');
  if (dl.dataset.ver !== itemVer) {
    dl.innerHTML = cat.map(g => `<option value="${esc(g[1])} (${esc(g[0])})">${esc(g[2])}</option>`).join('');
    dl.dataset.ver = itemVer;
  }
  const act = async (action, ids, what) => {
    itemNote = 'Saving...'; itemErr = false; note.textContent = itemNote;
    const r = await L.gearItems(itemVer, itemChar, action, ids);
    if (!r || !r.ok) { itemNote = (r && r.error) || 'Could not change gear.'; itemErr = true; }
    else {
      const nm = (id) => (names.get(id) || [id, id])[1];
      const parts = [];
      if (r.added && r.added.length) parts.push('Added ' + r.added.map(nm).join(', '));
      if (r.removed && r.removed.length) parts.push('Removed ' + r.removed.map(nm).join(', '));
      if (r.already && r.already.length) parts.push('Already yours: ' + r.already.map(nm).join(', '));
      if (r.equipped && r.equipped.length) parts.push('Equipped, so kept: ' + r.equipped.map(nm).join(', ') + ' (unequip it in game first)');
      if (r.unknown && r.unknown.length) parts.push('Not a 1.6.2 gear item: ' + r.unknown.join(', '));
      itemNote = (parts.join('. ') || what) + `. You will see it the next time you play ${itemVer}.`;
      itemErr = !(r.added && r.added.length) && !(r.removed && r.removed.length);
    }
    gearConfirm = null; renderItems(true);
  };
  $('gear-add-btn').onclick = () => {
    const raw = $('gear-add').value.trim();
    const m = /\(([A-Za-z0-9_]{3,80})\)\s*$/.exec(raw);
    let id = m ? m[1] : raw.toUpperCase();
    if (!names.has(id)) { const hit = cat.find(g => g[1].toLowerCase() === raw.toLowerCase()); if (hit) id = hit[0]; }
    if (!names.has(id)) { itemNote = 'Pick gear from the list as you type (a name or an ID like WP_IH_ROCK).'; itemErr = true; renderItems(false); return; }
    $('gear-add').value = '';
    act('addgear', [id], 'Added');
  };
  $('gear-add').onkeydown = (e) => { if (e.key === 'Enter') $('gear-add-btn').click(); };
  const host = $('gear-list'); host.innerHTML = '';
  const order = ['Weapons', 'Armour', 'Lanterns', 'Weapon parts', 'Accessories', 'Banners', 'Flares'];
  const owned = ch.gear.map(g => ({ ...g, name: (names.get(g.id) || [g.id, g.id, 'Other'])[1], type: (names.get(g.id) || [g.id, g.id, 'Other'])[2] }))
    .sort((a, b) => (order.indexOf(a.type) - order.indexOf(b.type)) || a.name.localeCompare(b.name));
  if (!owned.length) host.innerHTML = '<div class="season-row"><div class="season-kind">No gear yet.</div></div>';
  for (const g of owned) {
    const r = document.createElement('div'); r.className = 'season-row gear-row';
    r.innerHTML = `<div><div class="season-name">${esc(g.name)}</div><div class="season-kind">${esc(g.type)} <code>${esc(g.id)}</code></div></div>
      <div class="item-have">${g.level ? 'Level ' + g.level : ''}${g.equipped ? ' <span class="tag ok">Equipped</span>' : ''}</div>
      <div class="item-edit"></div>`;
    if (!g.equipped) {
      const b = document.createElement('button'); b.className = 'ghost gear-rm';
      b.textContent = gearConfirm === g.instanceId ? 'Remove it?' : 'Remove';
      b.onclick = () => { if (gearConfirm === g.instanceId) act('removegear', [g.instanceId], 'Removed'); else { gearConfirm = g.instanceId; renderItems(false); } };
      r.querySelector('.item-edit').appendChild(b);
    }
    host.appendChild(r);
  }
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
  $('season-now-sub').textContent = (on.started ? `Level ${on.level} of ${on.levels}` : `Not started, ${on.levels} levels`) + `, ${KIND_LABEL[on.kind] || on.kind}`;
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
      <div><div class="season-name">${esc(x.title)}</div><div class="season-kind"><b>${esc(KIND_LABEL[x.kind] || x.kind)}</b>, ${x.levels} levels</div></div>
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
  if (st.step === 'setup') return runSetup(v, false, true);
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
  // straight on to set-up (no window, no questions): the Download button turns into Play by itself
  const s = statuses[v.id];
  if (r.ok && s && s.game === 'ok' && s.setup !== 'ready' && !busy[v.id]) await runSetup(v, false, true);
}
const setupAuto = {};   // id -> true while set-up runs by itself (no window)
async function runSetup(v, uninstall, auto) {
  if (uninstall) {
    const ok = await confirm('Put the game folder back?', `This takes this version's files out of the game folder again (they are kept in the launcher's backup folder, nothing is deleted). Your offline save stays. You can run Set up again later.`);
    if (!ok) return;
  }
  setupAuto[v.id] = !!auto && !uninstall;
  if (setupAuto[v.id]) logs[v.id] = [];
  busy[v.id] = 'setup'; delete dl[v.id]; renderShelf(); renderDetail();
  const r = await L.setup(v.id, uninstall, !!auto && !uninstall);
  busy[v.id] = null; setupAuto[v.id] = false;
  await refresh(v.id);
  const s = statuses[v.id];
  if (!uninstall && s.setup !== 'ready') {
    const n = $('action-note');
    n.textContent = auto ? `Set-up did not finish${r && r.error ? ': ' + r.error : '.'} More > "Run set-up again" shows every step in a window.`
      : 'Set-up did not finish. The window that opened said why; fix that and press Set up again.';
    n.className = 'action-note err';
  }
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
  $('btn-host').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const hb = $('btn-host'), n = $('action-note');
    hb.disabled = true; n.className = 'action-note';
    n.textContent = 'Starting your game as a host. A window opens: keep it open while you play. Friends can join once you reach the main menu.';
    const r = await L.socialHost(v.id);
    if (r && r.ok === false) { n.textContent = r.error || 'Could not start hosting.'; n.className = 'action-note err'; hb.disabled = false; }
  });
  $('btn-online').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const soc = window.dfSocial || {};
    if (soc.search) { await L.socialCancelOnline(); return; }
    const ob = $('btn-online'), n = $('action-note');
    ob.disabled = true;
    const r = await L.socialPlayOnline(v.id);
    if (r && r.ok === false) { n.textContent = r.error || 'Could not go online.'; n.className = 'action-note err'; ob.disabled = false; }
  });
  $('opt-randoms').addEventListener('change', async (e) => {
    const s = await L.socialSetAllowRandoms(!!e.target.checked);
    if (s) { window.dfSocial = Object.assign(window.dfSocial || {}, { allowRandoms: s.allowRandoms }); renderHostButton(); }
  });
  $('btn-stop').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const hmOn = window.dfSocial && window.dfSocial.hostMode && window.dfSocial.hostMode.version === v.id;
    const ok = hmOn ? await confirm('Close the game?', 'This closes your game. Host Mode keeps the server running (stop it on the Host Mode page).')
      : await confirm('Stop everything?', 'This closes the local backend and the hidden game servers. If the game itself is still open, it is closed too (your progress is saved as you play).');
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
    if (act === 'import' || act === 'importfix') {
      const n = $('action-note');
      if (act === 'import') {
        const ok = await confirm('Bring your Dauntless Revived character?', 'A window opens and asks where your Dauntless Revived (1.4.4) character is: on a Revived server (it reads your own account through the Revived launcher while the game runs) or in a Revived save on this PC. It shows what will come over (gear, Rams, cells, materials, quests, weapon levels) and asks before changing anything. Nothing on the Revived side is changed; your 1.6.2 save is backed up first. Make your 1.6.2 character in game first.');
        if (!ok) return;
      }
      n.className = 'action-note';
      n.textContent = act === 'import' ? 'The import window is open: answer it there, then close it. Your character has the items the next time you play.' : 'The fix window is open: it only marks the tutorial and the first mission as done. Close it when it says it is finished.';
      const r = await L.importRevived(v.id, act === 'importfix');
      await refresh(v.id);
      if (r && r.ok === false && r.error) { n.textContent = r.error; n.className = 'action-note err'; }
      else { n.className = 'action-note'; n.textContent = act === 'import' ? 'Import window closed. If it said it imported, your character has the items the next time you play.' : 'Fix window closed. It said there whether anything was changed.'; }
    }
    if (act === 'opengame') L.openGameFolder(v.id);
    if (act === 'openver') L.openVersionFolder(v.id);
    if (act === 'logs') { L.openLogs(v.id); const n = $('action-note'); n.textContent = 'Send the two zips in the upload folder (client_logs.zip, server_logs.zip). Your PC name and user name are blanked out in them.'; n.className = 'action-note'; }
    if (act === 'delpartial') {
      const n = $('action-note');
      const r = await L.deletePartial(v.id);
      if (r && r.ok) { delete dl[v.id]; logs[v.id] = []; n.textContent = `Deleted the unfinished download (${r.gb} GB freed).`; n.className = 'action-note'; }
      else if (r && !r.cancelled) { n.textContent = r.error || 'Nothing was deleted.'; n.className = 'action-note err'; }
      await refresh(v.id);
    }
    if (act === 'readme') { $('readme-title').textContent = `${v.name} README`; $('readme-body').textContent = (await L.readme(v.id)) || '(no README in this package)'; $('dlg-readme').showModal(); }
  });
  $('btn-log-clear').addEventListener('click', () => { if (selected) { logs[selected] = []; renderDetail(); } });
  $('set-sky').addEventListener('click', () => { const on = Sky.toggle(); $('set-sky').textContent = on ? 'Turn off' : 'Turn on'; });
  $('set-lang').addEventListener('change', async () => {
    const r = await L.setGameLanguage($('set-lang').value);
    $('set-lang-sub').textContent = !r || !r.ok ? ((r && r.error) || 'Could not save that.') :
      (r.running ? 'Saved. The game is running: it changes the next time you start the game.' : 'Saved. It changes the next time you start the game.');
    if (!r || !r.ok) fillGameLanguage();
  });
  $('set-menu').addEventListener('change', async () => {
    if (!menuVer) return;
    const r = await L.setMenuBackground(menuVer, $('set-menu').value);
    if (r && r.needPicture) { await menuPickPicture(); return; }
    const m = await L.menuBackgrounds(menuVer);
    if (m) { if (!r || !r.ok) $('set-menu').value = m.background; menuShowCustom(m); }
    $('set-menu-sub').textContent = !r || !r.ok ? ((r && r.error) || 'Could not save that.') :
      (r.running ? 'Saved. The game is running: you will see it the next time you start the game.' : 'Saved. You will see it the next time you start the game.');
  });
  $('set-menu-pick').addEventListener('click', () => { if (menuVer) menuPickPicture(); });
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
    if (ok.length) {
      // Only versions whose game folder really needs the new files (new DLLs) need set-up; the rest are ready as they are
      const need = ok.filter(r => statuses[r.id] && statuses[r.id].game === 'ok' && statuses[r.id].setup !== 'ready').map(r => r.id);
      text += `Server files updated for ${ok.map(r => `${r.id} (${r.to})`).join(', ')}.`;
      text += need.length ? ` Press Set up on ${need.join(', ')} to finish; it runs by itself.` : ' Nothing to do, just play.';
    }
    if (bad.length) text += (text ? ' ' : '') + `Update failed for ${bad.map(r => r.id).join(', ')}: ${bad[0].error}.`;
    if (text) { $('banner-text').textContent = text; $('banner').hidden = false; }
  });
  $('banner-close').addEventListener('click', () => { $('banner').hidden = true; });
  // a newer launcher: a banner with a Download button (opens the release page; the player unzips it over this one)
  let upUrl = '';
  let upReady = false;
  const showLauncherUpdate = (u) => {
    if (!u) return; upUrl = u.url; upReady = !!u.ready;
    $('banner-up-text').textContent = upReady
      ? `Dauntless Forever ${u.version} is ready` + (u.notes ? `: ${u.notes}` : '.') + ' Restart the launcher to use it (or it starts next time).'
      : `Dauntless Forever ${u.version} is out` + (u.notes ? `: ${u.notes}` : '.') + ' Your games and saves stay where they are.';
    $('banner-up-get').textContent = upReady ? 'Restart now' : 'Download';
    $('banner-up').hidden = false; $('set-launcher').textContent = upReady ? `(${u.version} is ready: restart the launcher)` : `(${u.version} is available)`;
  };
  L.onLauncherUpdate(showLauncherUpdate);
  L.newerLauncher().then(showLauncherUpdate).catch(() => {});
  $('banner-up-get').addEventListener('click', async () => {
    if (!upReady) { if (upUrl) L.openUrl(upUrl); return; }
    const r = await L.restartLauncher().catch(() => null);
    if (r && !r.ok) $('banner-up-text').textContent = r.error;
  });
  $('banner-up-close').addEventListener('click', () => { $('banner-up').hidden = true; });
  $('set-pkgs-check').addEventListener('click', async () => { $('set-pkgs').textContent = 'Checking...'; await L.checkUpdates(); await fillSettings(); if (!updateLog.length) $('set-pkgs').textContent += ' (up to date)'; });

  // while set-up runs in its own window, re-check every few seconds so the steps tick over as it goes
  refreshTimer = setInterval(() => { for (const id of Object.keys(busy)) if (busy[id] === 'setup') refresh(id); }, 4000);
  window.addEventListener('focus', () => { if (selected) refresh(selected); });
}
boot();
