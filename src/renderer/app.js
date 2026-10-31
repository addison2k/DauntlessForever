// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
const checkNotes = {};   // DF-CHECKFILES: versionId -> { text, err, until }
let avState = null;      // DF-AVGUARD: { products, defender, otherOn, blocked, allowedAt, folders } from main.js
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
  try { avState = await L.avInfo(); L.onAvInfo((a) => { avState = a; renderDetail(); }); } catch {}   // DF-AVGUARD
}
function showPage(name) {
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('selected', b.dataset.page === name);
  for (const pg of document.querySelectorAll('.page')) pg.hidden = pg.id !== 'page-' + name;
  drawPage(name);
  document.querySelector('.content').scrollTop = 0;
  try { document.dispatchEvent(new CustomEvent('page:shown', { detail: name })); } catch {}   // DF-FOREVER: page scripts listen
}
function drawPage(name) {
  if (name === 'settings') fillSettings();
  if (name === 'seasons') renderSeasons();
  if (name === 'events') renderEvents();
  if (name === 'rules') renderRules();
  if (name === 'items') renderItems(true);
  if (name === 'mods') renderMods();
  if (name === 'slayer') renderSlayer();
  if (name === 'patches') renderPatches();
}
// Settings > Launcher language: everything the launcher drew is drawn again in the new language (i18n.js does the
// page's own text); the page being looked at stays where it is
window.addEventListener('df-lang', () => {
  if (!info) return;
  renderShelf(); renderDetail();
  const pg = [...document.querySelectorAll('.page')].find(p => !p.hidden);
  if (pg) { const name = pg.id.replace(/^page-/, ''); if (name === 'items') renderItems(false); else drawPage(name); }
  if (lastCommunity) renderCredits(lastCommunity.credits || {}, lastCommunity.supporters || {});
  fillUiLanguage();
});
const DISCORD_INVITE = 'https://discord.gg/sg9J7KshVc';
let lastCommunity = null;
async function loadCommunity() {
  let c; try { c = await L.communityInfo(); } catch { return; }
  lastCommunity = c;
  const links = c.community || {};
  for (const [id, url] of [['lnk-patreon', links.patreon], ['lnk-patreon-2', links.patreon]]) {
    const el = $(id); if (!el) continue; el.dataset.url = url || ''; el.hidden = !url;
  }
  // "Join the Discord" at the bottom of the sidebar: the server invite (community.json "discord" can change it)
  const ask = $('lnk-ask');
  ask.dataset.url = /^https:\/\/(discord\.gg|discord\.com)\//.test(links.discord || '') ? links.discord : DISCORD_INVITE;
  ask.hidden = false;
  const dc = $('lnk-discord'); dc.dataset.url = ''; dc.hidden = true;   // the older plain button: the card above replaces it
  $('lnk-discord-text').textContent = t('Join the Discord');
  if (links.github) $('lnk-source').dataset.url = links.github;
  renderCredits(c.credits || {}, c.supporters || {});
  // the Supporters section only shows while there is a Patreon link
  $('supporters-section').hidden = !links.patreon;
}
function renderCredits(cr, sup) {
  $('credits-intro').textContent = t(cr.intro || '');
  const host = $('credits-sections'); host.innerHTML = '';
  for (const sec of (cr.sections || [])) {
    const d = document.createElement('div'); d.className = 'credits-section' + (sec.compact ? ' compact' : '');
    d.innerHTML = `<h2>${esc(t(sec.title))}</h2>` + (sec.people || []).map(p => `
      <div class="person"><div class="avatar">${esc((p.name || '?')[0].toUpperCase())}</div><div>
        <div class="person-name">${p.url ? `<a href="#" data-url="${esc(p.url)}">${esc(p.name)}</a>` : esc(p.name)}${p.role ? `<span class="person-role">${esc(t(p.role))}</span>` : ''}</div>
        <div class="person-what">${esc(t(p.what || ''))}</div></div></div>`).join('');
    host.appendChild(d);
  }
  $('supporters-intro').textContent = t(cr.supportersIntro || '');
  const list = $('supporters-list'); list.innerHTML = '';
  const names = sup.supporters || [];
  for (const n of names) { const el = document.createElement('span'); const nm = typeof n === 'string' ? n : n.name; el.className = 'supporter' + (n.top ? ' top' : ''); el.textContent = nm; list.appendChild(el); }
  const anon = sup.anonymous || 0;
  $('supporters-anon').hidden = !anon; $('supporters-anon').textContent = anon === 1 ? t('One supporter chose to stay anonymous. Thank you too.') : t('{n} supporters chose to stay anonymous. Thank you too.', { n: anon });
}
async function fillSettings() {
  info = await L.info();
  $('set-sky').textContent = Sky.enabled() ? t('Turn off') : t('Turn on');
  $('set-games').textContent = info.gamesRoot;
  $('set-data').textContent = info.dataRoot;
  $('set-node').textContent = info.node ? (info.node.bundled ? t('{version}, included with the launcher', { version: info.node.version }) : t('{version} at {path}', { version: info.node.version, path: info.node.path })) : t('Not installed yet. Set-up offers to install it.');
  $('set-tool').textContent = info.toolOk ? t('manifest.exe (meszmate/manifest with the plain-chunk fix), checked') : t('Missing or damaged. Reinstall the launcher.');
  $('set-ver').textContent = `Dauntless Forever ${info.version}`;
  $('set-pkgs').textContent = versions.filter(v => v.hasPackage).map(v => `${v.id}: ${v.package.packageVersion}`).join(', ') + (updateLog.length ? ' ' + t('(last check: {msg})', { msg: updateLog[updateLog.length - 1] }) : '');
  fillUiLanguage();
  fillMenuBackground();
  fillGameLanguage();
  fillKeepFiles();
  fillRunning();
  fillAccount();
  foreverCheckRow();
}
// Settings > Friends account (DF-ACCOUNT, Oct 21): who this launcher is signed in as, a connection report players can
// paste in Discord, and a reset when the server no longer knows the account (replaces the PowerShell steps)
async function fillAccount() {
  let s = null; try { s = await L.socialState(); } catch {}
  const el = $('set-acct');
  if (!s) { el.textContent = t('Could not read the friends account.'); return; }
  if (s.offlineMode) el.textContent = t('Offline Forever mode is on: the launcher does not sign in.');
  else if (s.error) el.textContent = tm(s.error);
  else if (s.signedIn) el.textContent = t('Signed in as {name}. If friends or Play online stop working, Check connection tells you why.', { name: s.name + (s.tag ? '#' + s.tag : '') });
  else el.textContent = t('Not signed in yet. The launcher signs up with your player name by itself.');
}
async function accountCheck() {
  const b = $('set-acct-check'), rep = $('set-acct-report');
  b.disabled = true; b.textContent = t('Checking...');
  rep.hidden = false; rep.textContent = t('Checking the connection, this takes a few seconds...');
  let r = null; try { r = await L.socialDiagnose(); } catch (e) { r = { ok: false, error: e.message }; }
  b.disabled = false; b.textContent = t('Check connection');
  rep.textContent = r && r.ok ? r.report : (tm(r && r.error) || t('The check could not run.'));
  $('set-acct-copy').hidden = !(r && r.ok);
  fillAccount();
}
// Settings > Forever server (DF-FV-CHECKLINE, Oct 26): is the Forever server reachable (secure, then plain address) and is
// the Forever tab open for this launcher. Runs when the Settings page opens and on the button.
async function foreverCheckRow() {
  const b = $('set-fv-check'), rep = $('set-fv-report'), sub = $('set-fv');
  if (!b || !L.foreverServerCheck) return;
  b.disabled = true; b.textContent = t('Checking...'); sub.textContent = t('Checking the Forever server...');
  let r = null; try { r = await L.foreverServerCheck(); } catch (e) { r = { ok: false, error: e.message }; }
  b.disabled = false; b.textContent = t('Check Forever');
  const lines = (r && r.ok && r.lines) || [];
  const bad = lines.some((l) => /^FAIL/.test(l)), note = lines.some((l) => /^NOTE/.test(l));
  sub.textContent = !r || !r.ok ? ((r && r.error) || t('The check could not run (no answer from the launcher; restart it).')) : bad ? t('Problem: see below.') : note ? t('Reachable, see the note below.') : t('Everything looks fine.');
  rep.hidden = !lines.length; rep.textContent = lines.join('\n');
}
async function accountReset() {
  const ok = await confirm(t('Reset your friends account?'),
    t('You get a new friends account with the same player name. Your friends list starts empty: your friends need to add you again. Your Slayers, saves and game files are not touched. Use this when the Friends panel says your account was not recognised. If your PC clock is wrong, fix the clock instead.'));
  if (!ok) return;
  const b = $('set-acct-reset'); b.disabled = true; b.textContent = t('Resetting...');
  let r = null; try { r = await L.socialResetAccount(); } catch (e) { r = { ok: false, error: e.message }; }
  b.disabled = false; b.textContent = t('Reset account');
  const rep = $('set-acct-report'); rep.hidden = false;
  rep.textContent = r && r.ok ? t('Done. You are signed in again as {name}. Ask your friends to add you again.', { name: r.name }) : (tm(r && r.error) || t('The reset did not work.'));
  $('set-acct-copy').hidden = true;
  fillAccount();
}
// "What you are running": server files, the files set-up put in the game folder (short hash, OK or not), backend
async function fillRunning() {
  let list = [];
  try { list = await L.versionFiles(); } catch { $('set-files').textContent = t('Could not read the installed files.'); return; }
  const out = [`Launcher: Dauntless Forever ${info.version}`];
  for (const r of list) {
    if (!r.installed) continue;
    out.push('');
    out.push(`${r.id}: server files ${r.installed}` + (r.installed === r.latest ? ' (latest)' : ` (latest is ${r.latest}${r.held ? ', held by Keep my server files' : ''})`));
    if (!r.gameDir) out.push('  game folder: not set');
    for (const f of r.files) {
      const st = f.state === 'ok' ? 'OK' : f.state === 'missing' ? `MISSING (should be ${f.want})` : f.state === 'nogame' ? `(should be ${f.want})` : `DIFFERENT (should be ${f.want}, run SETUP)`;
      out.push(`  ${f.name}  ${f.have || '--------'}  ${st}`);
    }
    for (const b of r.backend) out.push(`  backend ${b.name}  ${b.hash || b.version || ''}`);
  }
  // the list itself stays in English: it is what players paste when they ask for help
  $('set-files').textContent = out.length > 1 ? out.join('\n') : t('No server files installed yet.');
}
// "Keep my server files" (for modders): no server-file updates while it is on
async function fillKeepFiles() {
  let on = false; try { on = await L.keepFiles(); } catch {}
  $('set-keep').textContent = on ? t('Turn off') : t('Turn on');
  $('set-keep-sub').textContent = on
    ? t('On: the launcher does not update or replace your installed server files. Updates that come out are listed above but not applied. Turn it off to get them.')
    : t('For modders: the launcher stops updating or replacing the installed server files (backend, tools, paks), so your own changes stay. Turn it off to get the latest server files again.');
}
// Game language (-CULTURE= on the game's command line; the server files do it). Hidden until a version supports it.
const LANG_SUB = "The language of the game's text and voices. Windows and the launcher stay as they are. Changes at the next game start.";
async function fillGameLanguage() {
  let g = null; try { g = await L.gameLanguage(); } catch {}
  const row = $('set-lang-row');
  if (!g || !g.versions || !g.versions.length) { row.hidden = true; return; }
  row.hidden = false;
  const sel = $('set-lang');
  if (!sel.options.length) for (const [code, name] of g.languages) { const o = document.createElement('option'); o.value = code; o.textContent = name; o.dataset.en = name; sel.appendChild(o); }
  for (const o of sel.options) if (o.value === '') o.textContent = t(o.dataset.en || 'Game default');   // the languages keep their own names
  sel.value = g.current || '';
  $('set-lang-sub').textContent = t(LANG_SUB);
}
// Launcher language (i18n.js): the launcher's own text; applied at once, kept in launcher.json
function fillUiLanguage() {
  const sel = $('set-ui-lang'); if (!sel || !window.I18N) return;
  if (!sel.options.length) for (const [code, name] of I18N.languages) sel.appendChild(new Option(name, code));
  sel.value = I18N.lang();
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
    o.value = b.key; o.textContent = t(b.title) + (b.season && b.key !== 'default' ? ' ' + t('(season {n})', { n: b.season }) : '') + (b.tested === false ? ' - ' + t('experimental') : '');
    sel.appendChild(o);
  }
  if (m.custom) { const o = document.createElement('option'); o.value = 'custom'; o.textContent = t('Your own picture...'); sel.appendChild(o); }
  sel.value = m.background;
  menuShowCustom(m);
  $('set-menu-sub').textContent = t('The art behind the game\'s start and login screen, from any Hunt Pass season or your own picture. Changes at the next game start.');
}
function menuShowCustom(m) {
  const isCustom = $('set-menu').value === 'custom';
  $('set-menu-pick').hidden = !isCustom;
  $('set-menu-pick').textContent = m && m.hasPicture ? t('Change picture') : t('Choose picture');
  $('set-menu-preview').hidden = !(isCustom && m && m.preview);
  if (m && m.preview) $('set-menu-preview').src = m.preview;
}
async function menuPickPicture() {
  $('set-menu-sub').textContent = t('Choose a picture. It is cropped to a wide 2:1 shape from the middle.');
  $('set-menu-pick').disabled = true;
  let r; try { r = await L.pickMenuPicture(menuVer); } finally { $('set-menu-pick').disabled = false; }
  const m = await L.menuBackgrounds(menuVer);
  if (m) { $('set-menu').value = m.background === 'custom' || !r || !r.ok ? m.background : 'custom'; menuShowCustom(m); }
  if (r && r.ok) $('set-menu-sub').textContent = t('Saved: {name}. You will see it the next time you start the game.', { name: r.name });
  else if (r && r.canceled) $('set-menu-sub').textContent = m && m.hasPicture ? t('Kept your current picture.') : t('No picture chosen.');
  else $('set-menu-sub').textContent = tm(r && r.error) || t('Could not use that picture.');
}
async function refreshAll() { for (const v of versions) statuses[v.id] = await L.status(v.id); }
async function refresh(id) { statuses[id] = await L.status(id); renderShelf(); if (selected === id) renderDetail(); }

// ---------------------------------------------------------------- derived state
function stateOf(v) {
  const s = statuses[v.id] || {};
  const b = busy[v.id] || s.busy;
  if (!v.hasPackage) return { key: 'soon', label: t('Coming soon'), step: 'none' };
  if (b === 'download') return { key: 'busy', busy: b, label: t('Downloading'), step: 'game' };
  if (b === 'setup') return { key: 'busy', busy: b, label: t('Setting up'), step: 'setup' };
  if (b === 'play') return { key: 'busy', busy: b, label: t('Running'), step: 'play' };
  if (s.game === 'missing') return { key: 'attn', label: t('Not downloaded'), step: 'game' };
  if (s.game === 'partial') return { key: 'attn', label: t('Download not finished'), step: 'game' };
  if (s.game === 'wrong') return { key: 'attn', label: t('Wrong game version in folder'), step: 'game' };
  if (s.setup !== 'ready') return { key: 'attn', label: t('Set-up needed'), step: 'setup' };
  return { key: 'ready', label: t('Ready to play'), step: 'play' };
}

// ---------------------------------------------------------------- shelf
// DF-V2-PLAYUI (Addison, Oct 27): tabs for the builds that have a package; the classic cards only for the upcoming ones, under 'Upcoming'
let upcomingOpen = false;
const HERO_ART = { '1.6.2': 'hero-162.jpg', '1.14.7': 'hero-1147.jpg' };
function renderTabs() {
  const row = $('gv-tabs'); if (!row) return; row.innerHTML = '';
  for (const v of versions.filter(x => x.hasPackage)) {
    const st = stateOf(v);
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab');
    b.className = 'gv-tab' + (v.id === selected ? ' selected' : '') + (st.key === 'attn' ? ' attn' : '');
    b.setAttribute('aria-selected', v.id === selected ? 'true' : 'false'); b.title = `${v.released} - ${st.label}`;
    b.innerHTML = `<span class="gv-num">${esc(v.id)}</span>${v.warning ? `<span class="build-flag">${esc(t('Experimental'))}</span>` : ''}`;
    b.addEventListener('click', () => { upcomingOpen = false; select(v.id); });
    row.appendChild(b);
  }
  const up = versions.filter(x => !x.hasPackage);
  if (up.length) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gv-tab more' + (upcomingOpen || up.some(x => x.id === selected) ? ' open' : '');
    b.setAttribute('aria-expanded', upcomingOpen ? 'true' : 'false');
    b.innerHTML = `<span>${esc(t('Upcoming'))}</span><span class="gv-chev" aria-hidden="true"></span>`;
    b.addEventListener('click', () => { upcomingOpen = !upcomingOpen; renderShelf(); });
    row.appendChild(b);
  }
  $('shelf').hidden = !upcomingOpen;
}
function renderShelf() {
  renderTabs();
  const ol = $('shelf'); ol.innerHTML = '';
  for (const v of versions.filter(x => !x.hasPackage)) {   // DF-V2-PLAYUI: only the upcoming ones live on the cards
    const st = stateOf(v);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'build' + (v.id === selected ? ' selected' : '') + (st.key === 'ready' ? ' ready' : '') + (st.key === 'soon' ? ' soon' : '');
    b.setAttribute('aria-current', v.id === selected ? 'true' : 'false');
    b.innerHTML = `<div class="build-ver">${esc(v.id)}${v.warning ? `<span class="build-flag" title="${esc(t('Experimental'))}">${esc(t('Experimental'))}</span>` : ''}</div><div class="build-when">${esc(v.released)}</div><div class="build-state ${st.key}">${esc(st.label)}</div>`;
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
  $('d-meta').textContent = t('Build {build}, released {date}. {era}.', { build: v.build, date: v.released, era: t(v.era) });
  // DF-V2-PLAYUI: the hero card: era and date line, art per version (none = plain dark card)
  { const e = $('d-era'); if (e) e.textContent = [t(v.era), v.released].filter(Boolean).join(' \u00b7 ');
    const hero = $('hero'); if (hero) { const art = HERO_ART[v.id]; hero.style.backgroundImage = art ? `url("${art}")` : ''; hero.classList.toggle('has-art', !!art); } }
  $('d-blurb').textContent = t(v.blurb || ''); $('d-blurb').title = t(v.blurb || '');
  $('d-warn').hidden = !v.warning; $('d-warn').textContent = t(v.warning || '');
  const pill = $('d-pill'); pill.textContent = st.label; pill.className = 'pill ' + st.key;

  // steps
  const gameDone = s.game === 'ok', setupDone = gameDone && s.setup === 'ready';
  setStep('game', gameDone ? 'done' : (st.step === 'game' ? 'current' : ''),
    gameDone ? shortPath(s.gameDir) : (s.game === 'partial' ? t('Partly downloaded; Download carries on') : (s.game === 'wrong' ? t('That folder has a different build') : t('{gb} GB from Epic\'s servers', { gb: v.download.downloadGB }))));
  setStep('setup', setupDone ? 'done' : (st.step === 'setup' ? 'current' : (gameDone ? '' : 'blocked')),
    setupDone ? (s.config && s.config.PlayerName ? t('Player: {name}', { name: s.config.PlayerName }) : t('Done')) : ((s.prereqMissing && s.prereqMissing.length) ? t('Windows parts missing (DirectX / Visual C++)') : t('Automatic after the download, no questions')));
  setStep('play', st.key === 'busy' && st.step === 'play' ? 'current' : (setupDone ? (st.step === 'play' ? 'current' : '') : 'blocked'),
    s.hasSave ? t('Your save is here; progress carries on') : t('Starts as a new Slayer'));

  // the one button
  const p = $('btn-primary'); const note = $('action-note'); note.className = 'action-note';
  $('btn-stop').hidden = true; $('btn-cancel').hidden = true;
  p.disabled = false;
  if (!v.hasPackage) { p.textContent = t('Coming soon'); p.disabled = true; note.textContent = t('The offline package for this version is still being made. It will show up here when it is ready.'); }
  else if (st.busy === 'download') { p.textContent = t('Downloading'); p.disabled = true; $('btn-cancel').hidden = false; note.textContent = t('You can keep using the launcher. Cancelling keeps what is already downloaded.'); }
  else if (st.busy === 'setup') {
    p.textContent = t('Setting up'); p.disabled = true;
    note.textContent = setupAuto[v.id] ? t('Getting the game ready. One time, no questions; it takes a minute or two. If Windows asks for permission, that is for parts the game needs (DirectX, Visual C++).')
      : t('Answer the questions in the black window, then close it when it says it is finished.');
  }
  else if (st.busy === 'play') { p.textContent = t('Running'); p.disabled = true; $('btn-stop').hidden = false; note.textContent = t('Close the game normally and everything else shuts down by itself.'); }
  else if (st.step === 'game') { p.textContent = s.game === 'partial' ? t('Continue download') : t('Download'); note.textContent = t('About {gb} GB to download, {installed} GB installed. Goes to {path} (change it in Settings). Already have {version}? Use "More".', { gb: v.download.downloadGB, installed: v.download.installedGB, path: `${info.gamesRoot}\\${v.download.folderName}`, version: v.id }); }
  else if (st.step === 'setup') {
    p.textContent = t('Set up');   // one click, no window (setup.ps1 -Auto)
    if (s.prereqMissing && s.prereqMissing.length) note.textContent = t('Windows is missing parts the game needs ({list}). Set up downloads them from Microsoft and installs them; Windows asks for permission once.', { list: s.prereqMissing.join(', ') });
    else note.textContent = s.game === 'ok' && s.setup === 'needed' && s.config ? t('The game files or the server files changed. Set up puts things right again; it only fixes what is missing, and your save stays.') : t('One click, no questions. Needs the internet once (a small data pack).');
  }
  else {
    p.textContent = v.canHost ? t('Play solo') : t('Play'); note.textContent = '';
    // hosting or in a friend's game with this version: Play waits until that game closes
    const run = (window.dfSocial && window.dfSocial.running) || [];
    if (run.some(r => r.id === v.id + ':host')) { p.disabled = true; note.textContent = t('You are hosting: friends see you in their Friends panel and press Join. Close your game to stop.'); }
    else if (run.some(r => r.id === v.id + ':join')) {
      p.disabled = true;
      const w = window.dfSocial && window.dfSocial.inGameWith;
      note.textContent = w ? (w.public ? t('You are in {name}\'s game (open to everyone). Your character is saved home every few minutes. Close the game to play here.', { name: w.name })
        : t('You are in {name}\'s game. Your character is saved home every few minutes. Close the game to play here.', { name: w.name })) : t('You are in a friend\'s game. Close it to play here.');
    }
  }
  // DF-PKGVERIFY / DF-AVGUARD: server files that failed their check, or a helper the antivirus removed, outrank the
  // generic notes above: the player should know what to press (More > Allow in the antivirus, then Repair)
  // DF-APPDATA: the game ignores its own settings folder on this PC (sign-in loop / back to the title): say so first
  { const b = document.querySelector('#more-menu [data-act="appdata"]'); if (b) b.hidden = !(s.appdata && !s.appdata.ok && s.appdata.fixable); }
  if (!st.busy && s.appdata && !s.appdata.ok) {
    note.textContent = s.appdata.fixable
      ? t('Windows stores your AppData folder as a fixed path, so the game cannot use its own settings folder: it loops at sign-in or sends you back to the title. Use More > Fix the Windows AppData setting (same folder, nothing moves), then Play.')
      : t('Your Windows AppData folder was moved to another place, so the game cannot use its own settings folder and may loop at sign-in. Send my logs and ask on Discord.');
    note.className = 'action-note err';
  } else
  if (!st.busy && s.pkg && !s.pkg.ok) {
    note.textContent = t('Some server files are missing or wrong ({list}). An antivirus usually removed them: use More > Allow in the antivirus, then More > Repair the launcher files.', { list: s.pkg.bad.slice(0, 3).join(', ') });
    note.className = 'action-note err';
  } else if (!st.busy && avState && avState.blocked && !avState.allowedAt) {
    const name = (avState.otherOn[0] || (avState.products[0] || {}).name || t('your antivirus'));
    note.textContent = t('{name} blocked a helper the game fixes need (the ammo and party fixes, the Forever hunts). Use More > Allow in the antivirus.', { name });
    note.className = 'action-note err';
  }
  // DF-CHECKFILES: the game-file check's progress / result stays shown through refreshes (5 minutes after it ends)
  const cn = checkNotes[v.id];
  if (cn && (!cn.until || Date.now() < cn.until)) { note.textContent = cn.text; note.className = cn.err ? 'action-note err' : 'action-note'; }
  // download notes only while they are still news (not after the player moved on or picked another folder)
  if (!st.busy && st.step === 'game' && d && d.state === 'failed' && d.error) { note.textContent = tm(d.error); note.className = 'action-note err'; }
  if (!st.busy && st.step === 'setup' && d && d.state === 'done' && !(s.prereqMissing && s.prereqMissing.length)) { note.textContent = t('Download finished and checked. Set up runs by itself next.'); }

  renderHostButton();

  // progress
  const pr = $('progress');
  if (d && d.state === 'running') {
    pr.hidden = false; $('p-fill').style.width = (d.pct || 0) + '%';
    $('p-label').textContent = t('Downloading {version}', { version: v.id }); $('p-right').textContent = d.pct != null ? `${d.pct}%` : '';
    $('p-foot').textContent = d.total ? t('{done} of {total}', { done: d.done, total: d.total }) + (d.speed ? ', ' + d.speed : '') + (d.eta ? ', ' + t('about {eta} left', { eta: d.eta }) : '') : t('Reading the manifest...');
    // DF-ASSEMBLE: after 100% the pieces are put together into the game files, then removed (minutes, no tool output)
    const p2 = $('p2'), f2 = $('p2-fill');
    if (d.stage && d.pct >= 100) {
      p2.hidden = false;
      $('p-foot').textContent = t('Download finished. Now putting the game files together; the launcher is not stuck.');
      const mins = d.stageSecs >= 60 ? ' ' + t('({n} min so far)', { n: Math.floor(d.stageSecs / 60) }) : '';
      if (d.stage === 'cleanup') {
        f2.classList.add('busy'); f2.style.width = '100%';
        $('p2-label').textContent = t('Tidying up the download'); $('p2-right').textContent = '';
        $('p2-foot').textContent = t('Removing the downloaded pieces now that the game files are complete. Almost done.') + mins;
      } else {
        const known = d.stagePct != null;
        f2.classList.toggle('busy', !known); f2.style.width = known ? d.stagePct + '%' : '100%';
        $('p2-label').textContent = t('Putting the game files together'); $('p2-right').textContent = known ? d.stagePct + '%' : '';
        $('p2-foot').textContent = (d.stageTotal ? t('{done} of {total} written.', { done: d.stageDone, total: d.stageTotal }) + ' ' : '') + t('This takes a few minutes, up to 20 on a hard drive.') + mins;
      }
    } else { p2.hidden = true; f2.classList.remove('busy'); }
  } else if (st.busy === 'setup' && setupAuto[v.id]) {
    // set-up after the download: a moving bar with the step it is on, so nobody thinks the launcher froze at 100%
    const lg = logs[v.id] || [];
    let last = ''; for (let i = lg.length - 1; i >= 0; i--) { const ln = String(lg[i].line || '').trim(); if (ln && !/^=+/.test(ln)) { last = ln; break; } }
    pr.hidden = false; $('p-fill').style.width = '100%'; $('p-fill').classList.add('busy');
    $('p-label').textContent = t('Setting up {version}', { version: v.id }); $('p-right').textContent = t('a minute or two');
    $('p-foot').textContent = last ? last.slice(0, 120) : t('Installing the server files...');
  } else pr.hidden = true;
  if (!(d && d.state === 'running')) $('p2').hidden = true;   // DF-ASSEMBLE: the second bar only while downloading
  if (!(st.busy === 'setup' && setupAuto[v.id])) $('p-fill').classList.remove('busy');

  // log
  const lg = logs[v.id] || [];
  $('log').hidden = lg.length === 0;
  renderLog(v.id);

  // notes
  fill('d-works', (v.works || []).map(x => t(x))); fill('d-not', (v.notWorking || []).map(x => t(x)));
  $('notes').hidden = !(v.works && v.works.length) && !(v.notWorking && v.notWorking.length);

  // menu availability
  const m = $('more-menu');
  m.querySelector('[data-act="setup"]').disabled = !gameDone || st.key === 'busy';
  m.querySelector('[data-act="uninstall"]').disabled = !gameDone || st.key === 'busy';
  m.querySelector('[data-act="opengame"]').disabled = !s.gameDir;
  m.querySelector('[data-act="check"]').disabled = !s.gameDir || !v.download || st.key === 'busy';   // DF-CHECKFILES
  m.querySelector('[data-act="pick"]').disabled = st.key === 'busy';
  m.querySelector('[data-act="delpartial"]').disabled = st.key === 'busy' || s.game === 'ok';
  // the Revived (1.4.4) import: only for versions whose server files have it, once the game is set up
  const imp = m.querySelector('[data-act="import"]'), fix = m.querySelector('[data-act="importfix"]');
  imp.hidden = !s.canImport; imp.disabled = !setupDone || st.key === 'busy';
  fix.hidden = !(s.canImportFix && s.imported); fix.disabled = !setupDone || st.key === 'busy';
}
// "Host with friends": the selected version, hosted through the Dauntless Forever relay (main/social.js). Friends
// see it in their Friends panel and press Join. Hidden in Offline Forever mode and for versions that cannot host yet.
// Host with friends starts this PC's own server first (Host Mode, private: your friends list; public with Allow
// randoms), then opens your game on it, so friends can join even before you are in. "Light hosting" (or a version
// without Host Mode) keeps the old way: one window that hosts while your game is open.
let hostCan = null, hostCanAt = 0, lightHost = false, pendingPlay = null;
function refreshHostCan() {
  hostCanAt = Date.now();
  Promise.all([L.hostState().catch(() => null), L.lightHost().catch(() => false)]).then(([s, light]) => {
    hostCan = new Set((s && s.versions) || []); lightHost = !!light; renderHostButton();
  });
}
function renderHostButton() {
  const v = versions.find(x => x.id === selected); const hb = $('btn-host'); if (!v || !hb) return;
  if (!hostCanAt || Date.now() - hostCanAt > 30000) refreshHostCan();
  const soc = window.dfSocial || null, st = stateOf(v);
  const run = (soc && soc.running) || [];
  const hostingThis = run.some(r => r.id === v.id + ':host');
  // shown (dim) from the start, lit up once the version is ready to play
  hb.hidden = !v.canHost || !!(soc && soc.offlineMode);
  hb.classList.toggle('on', hostingThis);
  // Host Mode (Host Mode page) runs this version: the server is already up here, so Play only starts the game
  const hm = soc && soc.hostMode && soc.hostMode.version === v.id ? soc.hostMode : null;
  hb.lastChild.textContent = hm ? t('Host Mode on') : hostingThis ? t('Hosting') : t('Host with friends');
  hb.disabled = hostingThis || st.key !== 'ready' || run.length > 0 || !!(soc && soc.onlineOff);
  const ping = soc && soc.relay ? ' ' + t('(online server: {name}, {ms} ms)', { name: soc.relay.name, ms: soc.relay.ms }) : '';
  const randoms = !!(soc && soc.allowRandoms);
  hb.title = st.key !== 'ready' && !hostingThis ? t('Ready once the game is downloaded and set up') : soc && soc.onlineOff ? tm(soc.onlineOff) : (hostingThis ? (soc && soc.hostPublic ? t('Your game is open to everyone') : t('Your game is open to your friends'))
    : (randoms ? t('Play {version} and let your friends (and players using Play online) join you', { version: v.id }) : t('Play {version} and let your friends join you', { version: v.id })) + ping);
  renderOnline(v, soc, st, run, hostingThis);
  // Light hosting: under the Host button, only where Host Mode can run this version
  const lo = $('host-light-opt'), lbox = $('opt-light');
  const canHM = !!(hostCan && hostCan.has(v.id));
  lo.hidden = hb.hidden || !canHM;
  lbox.checked = lightHost; lbox.disabled = hostingThis || !!hm;
  lo.classList.toggle('off', hostingThis || !!hm);
  lo.title = t('Off (recommended): your server starts first and stays up until you press Stop hosting, so friends can always get in. On: the old way, lighter on your PC; the server stops when you close the game.');
  if (hm) {
    // the server is up (or starting): the yellow button stops it
    hb.lastChild.textContent = hm.phase === 'stopping' ? t('Stopping') : t('Stop hosting');
    hb.disabled = hm.phase === 'stopping';
    hb.classList.toggle('on', true);
    hb.title = hm.phase === 'running'
      ? (hm.mode === 'public' ? t('Your server "{name}" is up (open to everyone). Click to stop it.', { name: hm.name }) : t('Your server "{name}" is up (friends only). Click to stop it.', { name: hm.name }))
      : (hm.mode === 'public' ? t('Your server "{name}" is starting (open to everyone). Click to stop it.', { name: hm.name }) : t('Your server "{name}" is starting (friends only). Click to stop it.', { name: hm.name }));
    const p = $('btn-primary'), n = $('action-note');
    // started with the Host button: open the game as soon as the server is up
    if (pendingPlay === v.id && hm.phase === 'running' && st.key === 'ready' && st.busy !== 'play') { pendingPlay = null; play(v); }
    if (st.busy === 'play') { n.textContent = t('Your server stays up for your friends when you close the game. Press Stop hosting when you are done.'); n.className = 'action-note'; }
    else if (st.key === 'ready') {
      p.textContent = t('Play on your server'); p.disabled = hm.phase !== 'running';
      n.className = 'action-note';
      n.textContent = hm.phase === 'running' ? t('Host Mode is running "{name}". Play starts only the game and joins it; closing the game keeps the server up.', { name: hm.name })
        : t('Host Mode is starting. Play works as soon as the server is up.');
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
  lbl.textContent = !mine ? t('Play online') : search.phase === 'asking' ? t('Joining') : search.phase === 'hosting' ? t('Starting') : t('Searching {n}', { n: search.left });
  ob.disabled = !mine && (st.key !== 'ready' || run.length > 0 || !!search || !!(soc && soc.onlineOff) || !(soc && soc.signedIn));
  ob.title = st.key !== 'ready' && !mine ? t('Ready once the game is downloaded and set up') : soc && soc.onlineOff ? tm(soc.onlineOff) : mine ? t('Click to stop looking')
    : !(soc && soc.signedIn) ? t('Signing you in to the online service...') : t('Play {version} with anyone online: joins a game that is open to everyone, or hosts one', { version: v.id });
  // the note under the buttons says what the search is doing, and goes away when it is over
  if (mine) {
    onlineNote = search.phase === 'asking' ? t('Found {name}\'s game. Asking to join...', { name: search.host })
      : search.phase === 'hosting' ? t('No open game right now, so you host one: a window opens, keep it open. Players using Play online join you.')
      : t('Looking for a {version} game that is open to everyone. If none turns up in {n} seconds, you host one and others join you. Click the button to stop.', { version: v.id, n: search.left });
    n.textContent = onlineNote; n.className = 'action-note';
  } else if (onlineNote) { if (n.textContent === onlineNote) n.textContent = ''; onlineNote = ''; }
  // Allow randoms: shown with the Host button; fixed while hosting (it applies when hosting starts)
  opt.hidden = off;
  const box = $('opt-randoms');
  box.checked = !!(soc && soc.allowRandoms);
  box.disabled = hostingThis;
  opt.classList.toggle('off', hostingThis);
  opt.title = hostingThis ? t('Change this before you host: it applies when hosting starts.') : t('Your hosted games show up for players who press Play online. Friends can always join.');
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
        <div><div class="season-name">${esc(t(x.title))}</div><div class="season-kind">${esc(t(x.blurb || ''))}</div></div>
        <div class="season-lvl">${x.tested ? `<span class="tag ok">${esc(t('Tested'))}</span>` : `<span class="tag exp">${esc(t('Experimental'))}</span>`}</div>
        <div class="season-acts">${x.key === chosen ? `<span class="season-on">${esc(t('On'))}</span>` : `<button class="ghost pick">${esc(t('Use this'))}</button>`}</div>`;
      const b = row.querySelector('.pick');
      if (b) b.addEventListener('click', () => pick(x));
      host.appendChild(row);
    }
  };
  const apply = async (ev, dr, title) => {
    const r = await L.setEvents(eventVer, ev, dr);
    eventNote = !r || !r.ok ? (tm(r && r.error) || t('Could not change it.'))
      : r.running ? t('{title}: close the game and press Play again to see it.', { title: t(title) }) : t('{title}: you will see it the next time you press Play.', { title: t(title) });
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
    b.innerHTML = `${esc(v.id)}${ok ? '' : ` <span class="soon-tag">${esc(t('soon'))}</span>`}`;
    b.addEventListener('click', () => { if (v.id !== curId) onPick(v.id); });
    tabs.appendChild(b);
  }
  tabs.hidden = all.length < 2;
  const v = all.find(x => x.id === curId), ban = $(bannerId);
  ban.hidden = !v;
  if (!v) return;
  ban.classList.toggle('off', !supported.has(v.id));
  ban.innerHTML = `<div class="vb-num">${esc(v.id)}</div>
    <div class="vb-text"><div class="vb-title">Dauntless ${esc(v.id)}${v.era ? ` <span class="vb-era">${esc(t(v.era))}</span>` : ''}</div>
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
    cur ? t('These rules change <b>Dauntless {version} only</b>. Every version keeps its own Game Rules.', { version: esc(ruleVer) })
        : t('Game Rules are not available for Dauntless {version} yet.', { version: esc(ruleVer || '') }));
  $('rule-none').hidden = !!cur; $('rule-body').hidden = !cur;
  $('rule-none-title').textContent = ruleVer ? t('No Game Rules for {version} yet', { version: ruleVer }) : t('No Game Rules for this version yet');
  if (!cur) return;
  const { d } = cur;
  $('rule-note').textContent = ruleNote || '';
  const apply = async (changes, what) => {
    const r = await L.setRules(ruleVer, changes);
    ruleNote = !r || !r.ok ? (tm(r && r.error) || t('Could not change it.'))
      : r.running ? t('{version} {what}: close the game and press Play again for it to apply.', { version: ruleVer, what }) : t('{version} {what}: applies the next time you play {version}.', { version: ruleVer, what });
    renderRules();
  };
  const list = $('rule-list'); list.innerHTML = '';
  for (const x of d.rules) {
    const row = document.createElement('div'); row.className = 'season-row rule-row' + (x.value !== x.default ? ' active' : '');
    row.innerHTML = `
      <div><div class="season-name">${esc(t(x.title))} ${x.tested ? '' : `<span class="tag exp">${esc(t('Experimental'))}</span>`}</div><div class="season-kind">${esc(t(x.blurb))} <b>${esc(t('Default: {value}.', { value: t((x.choices.find(c => String(c[0]) === x.default) || [, x.default])[1]) }))}</b></div></div>
      <div class="rule-choices" role="group" aria-label="${esc(t(x.title))}"></div>`;
    const host = row.querySelector('.rule-choices');
    for (const [val, label] of x.choices) {
      const b = document.createElement('button'); b.className = 'season-filter rule-choice';
      b.setAttribute('aria-pressed', String(String(val) === x.value));
      b.textContent = t(label);
      if (String(val) !== x.value) b.addEventListener('click', () => apply({ [x.key]: String(val) }, `${t(x.title)} ${t(label)}`));
      host.appendChild(b);
    }
    list.appendChild(row);
  }
  $('rule-reset').onclick = () => apply(Object.fromEntries(d.rules.map(x => [x.key, x.default])), t('Back to the defaults'));
}

// ---------------------------------------------------------------- Mods (UE4SS modded mode; tools\ue4ss.cjs)
let modsVer = null, modsNote = null, modsErr = false, modsBusy = false;
async function renderMods() {
  const all = versions.filter(x => x.hasPackage);
  const found = [];
  for (const v of all) { let d = null; try { d = await L.modsStatus(v.id); } catch {} if (d) found.push({ v, d }); }
  const supported = new Set(found.map(x => x.v.id));
  modsVer = pickVersion(all, modsVer, supported);
  const cur = found.find(x => x.v.id === modsVer);
  versionPicker('mods-vtabs', 'mods-vbanner', all, modsVer, supported, (id) => { modsVer = id; modsNote = null; modsErr = false; renderMods(); },
    cur ? t('Mods for <b>Dauntless {version}</b>. Every version keeps its own mods.', { version: esc(modsVer) }) : t('Mods are not available for Dauntless {version} yet.', { version: esc(modsVer || '') }));
  const d = cur && cur.d, ok = d && d.ok;
  $('mods-none').hidden = !!ok; $('mods-body').hidden = !ok;
  if (!ok) {
    $('mods-none-title').textContent = d ? t('Mods are not ready yet') : (modsVer ? t('No mods for {version} yet', { version: modsVer }) : t('No mods for this version yet'));
    $('mods-none-text').textContent = d ? (tm(d.error) || t('Run Set up first.')) : t('Modded mode is ready for 1.6.2 first. Other versions get it through a server-file update.');
    return;
  }
  const note = $('mods-note');
  note.textContent = modsNote || (d.running && d.on ? t('The game is running: mod changes apply the next time you press Play.') : '');
  note.classList.toggle('err', modsErr);
  const act = async (what, a, b, done) => {
    if (modsBusy) return; modsBusy = true;
    if (what === 'install') { modsNote = t('Downloading UE4SS...'); modsErr = false; note.textContent = modsNote; note.classList.remove('err'); }
    let r; try { r = await L.modsAct(modsVer, what, a, b); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    modsBusy = false;
    if (!r || !r.ok) { modsNote = tm(r && r.error) || t('Could not change it.'); modsErr = true; }
    else { modsNote = done; modsErr = false; }
    renderMods();
  };
  $('mods-get-row').hidden = !!d.installed;
  $('mods-get').onclick = () => act('install', null, null, t('UE4SS is ready. Turn on Modded mode to use it.'));
  const pick = (onId, offId, isOn, enabled, onClick) => {
    for (const [id, val] of [[onId, true], [offId, false]]) {
      const el = $(id); el.setAttribute('aria-pressed', String(isOn === val)); el.disabled = !enabled;
      el.onclick = isOn === val ? null : () => onClick(val);
    }
  };
  pick('mods-on-btn', 'mods-off-btn', !!d.on, !!d.installed, (v) => act('set', v ? 'on' : 'off', null,
    v ? t('Modded mode on: your next {version} game loads your mods.', { version: modsVer }) : t('Modded mode off: your next {version} game is the normal game.', { version: modsVer })));
  $('mods-srv-row').hidden = !d.on;
  pick('mods-srv-on', 'mods-srv-off', !!d.servers, !!d.on, (v) => act('set', v ? 'servers-on' : 'servers-off', null,
    v ? t('Your servers will run your mods too (next start).') : t('Your servers run without mods (next start).')));
  $('mods-folder').disabled = !d.installed;
  $('mods-folder').onclick = () => act('folder', null, null, modsNote || '');
  const list = $('mods-list'); list.innerHTML = '';
  const mods = d.mods || [];
  // built-in Dauntless Forever mods that need no UE4SS (noUe4ss) are listed even before UE4SS is installed
  const shown = d.installed ? mods : mods.filter(m => m.noUe4ss);
  if (!d.installed) list.innerHTML = `<div class="season-row"><div class="season-kind">${esc(t('Get UE4SS first. Your mods are listed here after that.'))}</div></div>`;
  else if (!mods.some(m => !m.builtin)) list.insertAdjacentHTML('beforeend', `<div class="season-row"><div class="season-kind">${esc(t('No mods of your own yet. Press "Open the mods folder" and put a mod\'s folder in it, then come back here.'))}</div></div>`);
  let toolsHead = false;
  for (const m of shown) {
    if (m.builtin && !toolsHead) { toolsHead = true; list.insertAdjacentHTML('beforeend', `<div class="season-row"><div class="season-kind"><b>${esc(t('Comes with UE4SS'))}</b> ${esc(t('(tools for mod makers; leave them as they are if you are not sure)'))}</div></div>`); }
    const row = document.createElement('div'); row.className = 'season-row rule-row' + (m.on ? ' active' : '');
    row.innerHTML = `<div><div class="season-name">${esc(m.title || m.name)}</div><div class="season-kind">${esc(m.about ? m.about : m.scripts ? (m.builtin ? t('UE4SS tool') : t('Mod')) : t('This folder has no Scripts or dlls folder, so UE4SS may not load it.'))}</div>${Array.isArray(m.keys) && m.keys.length ? `<div class="season-kind mod-keys">${esc(t('Keys'))}: ${m.keys.map((k) => `<b>${esc(k[0])}</b> ${esc(k[1])}`).join(' &middot; ')}</div>` : ''}</div>
      <div class="rule-choices" role="group" aria-label="${esc(m.name)}"></div>`;
    const host = row.querySelector('.rule-choices');
    for (const [val, label] of [[false, 'Off'], [true, 'On']]) {
      const b = document.createElement('button'); b.className = 'season-filter rule-choice'; b.textContent = t(label);
      b.setAttribute('aria-pressed', String(!!m.on === val));
      if (!!m.on !== val) b.onclick = () => act('mod', m.name, val ? 'on' : 'off', val ? t('{name} on: applies the next time you press Play.', { name: m.title || m.name }) : t('{name} off: applies the next time you press Play.', { name: m.title || m.name }));
      host.appendChild(b);
    }
    list.appendChild(row);
  }
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
      if (Object.keys(itemPending).length && !confirm(t('You have unsaved changes for {from}. Switch to {to} and drop them?', { from: itemVer, to: id }))) return;
      itemVer = id; itemPending = {}; itemNote = null; itemErr = false; renderItems(true);
    },
    cur ? (chName ? t('You are editing your <b>Dauntless {version} save</b> (character <b>{name}</b>). Every version has its own save and its own items.', { version: esc(itemVer), name: esc(chName) })
          : t('You are editing your <b>Dauntless {version} save</b>. Every version has its own save and its own items.', { version: esc(itemVer) }))
        : t('Inventory editing is not available for Dauntless {version} yet.', { version: esc(itemVer || '') }));
  $('item-none').hidden = !!usable; $('item-body').hidden = !usable;
  if (!usable) {
    const why = !cur ? null : (save && !save.ok ? tm(save.error) : t('No character yet. Press Play once and make a character first.'));
    $('item-none-title').textContent = why ? t('Nothing to edit yet') : (itemVer ? t('No inventory editing for {version} yet', { version: itemVer }) : t('No inventory editing for this version yet'));
    $('item-none-pill').hidden = !!why;
    $('item-none-text').textContent = why || t('The Inventory page is ready for 1.6.2 first. Other versions get it through a server-file update.');
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
  note.textContent = itemNote || (cur.d.running ? t('The game is running: close it before saving.') : (n ? (n > 1 ? t('{n} unsaved changes.', { n }) : t('{n} unsaved change.', { n })) : ''));
  note.classList.toggle('err', itemErr);
  $('item-save').disabled = !n; $('item-undo').disabled = !n;
  $('item-save').textContent = n ? (n > 1 ? t('Save {n} changes to {version}', { n, version: itemVer }) : t('Save {n} change to {version}', { n, version: itemVer })) : t('Save to {version}', { version: itemVer });
  const known = new Set();
  const row = (id, name, blurb) => {
    const have = ch.items[id] || 0;
    const val = id in itemPending ? itemPending[id] : have;
    const r = document.createElement('div'); r.className = 'season-row item-row' + (id in itemPending ? ' active' : '');
    r.innerHTML = `
      <div><div class="season-name">${esc(t(name))}</div><div class="season-kind">${blurb ? esc(t(blurb)) + ' ' : ''}<code>${esc(id)}</code></div></div>
      <div class="item-have">${id in itemPending ? `<s>${fmtN(have)}</s> &gt; ` : ''}<b>${fmtN(val)}</b></div>
      <div class="item-edit">
        <button class="ghost step" data-d="-10" title="${esc(t('10 less'))}">-10</button>
        <input type="number" min="0" max="99999999" value="${val}" aria-label="${esc(t(name))}">
        <button class="ghost step" data-d="10" title="${esc(t('10 more'))}">+10</button>
        <button class="ghost step" data-d="100" title="${esc(t('100 more'))}">+100</button>
        <button class="ghost step zero" data-z="1" title="${esc(t('Set to 0 (removes it)'))}">${esc(t('Clear'))}</button>
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
    const h = document.createElement('h2'); h.className = 'list-head'; h.textContent = t(g.title); host.appendChild(h);
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
    $('item-save').disabled = true; itemNote = t('Saving...'); itemErr = false; note.textContent = itemNote;
    const r = await L.setItems(itemVer, itemChar, itemPending);
    if (r && r.ok) { itemPending = {}; itemNote = t('Saved to your {version} save. You will see it the next time you play {version}. (Backup kept in {folder}.)', { version: itemVer, folder: 'backup\\inventory' }); itemErr = false; }
    else { itemNote = tm(r && r.error) || t('Could not save.'); itemErr = true; }
    renderItems(!!(r && r.ok));
  };
  $('item-add-btn').onclick = () => {
    const id = $('item-add-id').value.trim().toUpperCase(), q = Math.max(0, Math.floor(Number($('item-add-n').value) || 0));
    if (!/^[A-Z0-9_]{3,80}$/.test(id)) { itemNote = t('That is not an item ID (capital letters, digits and _ only).'); itemErr = true; renderItems(false); return; }
    const have = ch.items[id] || 0;
    if (q === have) delete itemPending[id]; else itemPending[id] = q;
    $('item-add-id').value = ''; itemNote = null; itemErr = false;
    if (!known.has(id)) $('item-more').open = true;
    renderItems(false);
  };
}

// Gear part of the Inventory page (versions whose helper returns gear + a gear catalog: 1.6.2, and 1.14.7 since DF-INV-1147,
// whose helper also sends gearTypes, the order of its kinds).
let gearConfirm = null, gearFilter = '', gearFilterVer = null;
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
    itemNote = t('Saving...'); itemErr = false; note.textContent = itemNote;
    const r = await L.gearItems(itemVer, itemChar, action, ids);
    if (!r || !r.ok) { itemNote = tm(r && r.error) || t('Could not change gear.'); itemErr = true; }
    else {
      const nm = (id) => (names.get(id) || [id, id])[1];
      const parts = [];
      if (r.added && r.added.length) parts.push(t('Added {list}', { list: r.added.map(nm).join(', ') }));
      if (r.removed && r.removed.length) parts.push(t('Removed {list}', { list: r.removed.map(nm).join(', ') }));
      if (r.already && r.already.length) parts.push(t('Already yours: {list}', { list: r.already.map(nm).join(', ') }));
      if (r.equipped && r.equipped.length) parts.push(t('Equipped, so kept: {list} (unequip it in game first)', { list: r.equipped.map(nm).join(', ') }));
      if (r.unknown && r.unknown.length) parts.push(itemVer === '1.6.2' ? t('Not a 1.6.2 gear item: {list}', { list: r.unknown.join(', ') }) : t('Not in the {version} item list: {list}', { version: itemVer, list: r.unknown.join(', ') }));
      itemNote = (parts.join('. ') || what) + '. ' + t('You will see it the next time you play {version}.', { version: itemVer });
      itemErr = !(r.added && r.added.length) && !(r.removed && r.removed.length);
    }
    gearConfirm = null; renderItems(true);
  };
  $('gear-add-btn').onclick = () => {
    const raw = $('gear-add').value.trim();
    const m = /\(([A-Za-z0-9_]{3,80})\)\s*$/.exec(raw);
    let id = m ? m[1] : raw.toUpperCase();
    if (!names.has(id)) { const hit = cat.find(g => g[1].toLowerCase() === raw.toLowerCase()); if (hit) id = hit[0]; }
    if (!names.has(id)) { itemNote = t('Pick gear from the list as you type (a name or an ID like WP_IH_ROCK).'); itemErr = true; renderItems(false); return; }
    $('gear-add').value = '';
    act('addgear', [id], t('Added'));
  };
  $('gear-add').onkeydown = (e) => { if (e.key === 'Enter') $('gear-add-btn').click(); };
  // Unlock all cosmetics (server files .10 and newer say they can with unlockAll)
  $('gear-all-row').hidden = !cur.d.save.unlockAll;
  const allBtn = $('gear-all-btn');
  allBtn.textContent = gearConfirm === '*all' ? t('Unlock all of them?') : t('Unlock all cosmetics');
  allBtn.onclick = async () => {
    if (gearConfirm !== '*all') { gearConfirm = '*all'; renderItems(false); return; }
    allBtn.disabled = true; itemNote = t('Unlocking every cosmetic. This takes a few seconds...'); itemErr = false; note.textContent = itemNote;
    const r = await L.gearItems(itemVer, itemChar, 'unlockall', ['all']);
    if (!r || !r.ok) { itemNote = tm(r && r.error) || t('Could not unlock cosmetics.'); itemErr = true; }
    else { itemNote = t('Unlocked {n} cosmetics ({had} you already had). You will see them the next time you play {version}. (Backup kept in {folder}.)', { n: r.addedCount, had: r.alreadyCount, version: itemVer, folder: 'backup\\inventory' }); itemErr = false; }
    allBtn.disabled = false; gearConfirm = null; renderItems(true);
  };
  const host = $('gear-list'); host.innerHTML = '';
  const order = Array.isArray(cur.d.save.gearTypes) ? cur.d.save.gearTypes : ['Weapons', 'Armour', 'Lanterns', 'Weapon parts', 'Accessories', 'Banners', 'Flares'];
  const owned = ch.gear.map(g => ({ ...g, name: (names.get(g.id) || [g.id, g.id, 'Other'])[1], type: (names.get(g.id) || [g.id, g.id, 'Other'])[2] }))
    .sort((a, b) => (order.indexOf(a.type) - order.indexOf(b.type)) || a.name.localeCompare(b.name));
  if (!owned.length) host.innerHTML = `<div class="season-row"><div class="season-kind">${esc(t('No gear yet.'))}</div></div>`;
  // Show: one kind at a time
  if (gearFilterVer !== itemVer) { gearFilter = ''; gearFilterVer = itemVer; }
  const kinds = [...new Set(owned.map(g => g.type))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (gearFilter && !kinds.includes(gearFilter)) gearFilter = '';
  const fsel = $('gear-filter');
  fsel.innerHTML = `<option value="">${esc(t('All'))} (${fmtN(owned.length)})</option>` + kinds.map(k => `<option value="${esc(k)}"${k === gearFilter ? ' selected' : ''}>${esc(t(k))} (${fmtN(owned.filter(g => g.type === k).length)})</option>`).join('');
  fsel.onchange = () => { gearFilter = fsel.value; gearConfirm = null; renderItems(false); };
  $('gear-filter-row').hidden = kinds.length < 2;
  for (const g of (gearFilter ? owned.filter(x => x.type === gearFilter) : owned)) {
    const r = document.createElement('div'); r.className = 'season-row gear-row';
    r.innerHTML = `<div><div class="season-name">${esc(g.name)}</div><div class="season-kind">${esc(t(g.type))} <code>${esc(g.id)}</code></div></div>
      <div class="item-have">${g.level ? esc(t('Level {n}', { n: g.level })) : ''}${g.equipped ? ` <span class="tag ok">${esc(t('Equipped'))}</span>` : ''}</div>
      <div class="item-edit"></div>`;
    if (!g.equipped) {
      const b = document.createElement('button'); b.className = 'ghost gear-rm';
      b.textContent = gearConfirm === g.instanceId ? t('Remove it?') : t('Remove');
      b.onclick = () => { if (gearConfirm === g.instanceId) act('removegear', [g.instanceId], t('Removed')); else { gearConfirm = g.instanceId; renderItems(false); } };
      r.querySelector('.item-edit').appendChild(b);
    }
    host.appendChild(r);
  }
}

// ---------------------------------------------------------------- patch notes
async function renderPatches() {
  const host = $('patch-list');
  let notes = []; try { notes = await L.patchNotes(); } catch {}
  host.innerHTML = notes.length ? '' : `<p class="small">${esc(t('No patch notes yet.'))}</p>`;
  for (const n of notes) {
    // a note is shown as written (English); one that carries "i18n": { "es": { "title": ..., "items": [...] } } shows that
    const loc = (n.i18n && window.I18N && n.i18n[I18N.lang()]) || {};
    const d = document.createElement('article'); d.className = 'patch';
    d.innerHTML = `<div class="patch-date">${esc(n.date || '')}</div><h2>${esc(loc.title || n.title || '')}</h2><ul>${(Array.isArray(loc.items) ? loc.items : (n.items || [])).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
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
  $('season-doc-title').textContent = t('{title}: rewards', { title: t(x.title) });
  $('season-doc-body').innerHTML = html || `<p>${esc(t('No reward list for this season.'))}</p>`;
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
  $('season-now-title').textContent = t(on.title);
  $('season-now-sub').textContent = (on.started ? t('Level {level} of {levels}', { level: on.level, levels: on.levels }) : t('Not started, {levels} levels', { levels: on.levels })) + ', ' + t(KIND_LABEL[on.kind] || on.kind);
  $('season-now-fill').style.width = (on.levels ? Math.round(100 * on.level / on.levels) : 0) + '%';
  const note = $('season-note'); note.className = 'action-note'; note.textContent = seasonNote || '';

  const filters = $('season-filters'); filters.innerHTML = '';
  for (const [k, label] of SEASON_KINDS) {
    const n = k === 'all' ? d.seasons.length : d.seasons.filter(x => x.kind === k).length;
    if (!n) continue;
    const b = document.createElement('button'); b.className = 'season-filter'; b.setAttribute('aria-pressed', String(k === seasonFilter));
    b.innerHTML = `${esc(t(label))}<span class="n">${n}</span>`;
    b.addEventListener('click', () => { seasonFilter = k; renderSeasons(); });
    filters.appendChild(b);
  }
  const list = $('season-list'); list.innerHTML = '';
  for (const x of d.seasons.filter(x => seasonFilter === 'all' || x.kind === seasonFilter)) {
    const row = document.createElement('div'); row.className = 'season-row' + (x.key === on.key ? ' active' : '');
    const pct = x.levels ? Math.round(100 * x.level / x.levels) : 0;
    row.innerHTML = `
      <div><div class="season-name">${esc(t(x.title))}</div><div class="season-kind"><b>${esc(t(KIND_LABEL[x.kind] || x.kind))}</b>, ${esc(t('{n} levels', { n: x.levels }))}</div></div>
      <div class="season-lvl${x.started ? '' : ' none'}">${x.started ? `${esc(t('Level {level} / {levels}', { level: x.level, levels: x.levels }))}<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` : esc(t('Not started'))}</div>
      <div class="season-acts"><button class="ghost" data-doc>${esc(t('Rewards'))}</button>${x.key === on.key ? `<span class="season-on">${esc(t('Playing'))}</span>` : `<button class="ghost pick" data-pick>${esc(t('Play this'))}</button>`}</div>`;
    row.querySelector('[data-doc]').addEventListener('click', () => showSeasonDoc(x));
    const pick = row.querySelector('[data-pick]');
    if (pick) pick.addEventListener('click', async () => {
      const r = await L.setSeason(seasonVer, x.key);
      if (!r || !r.ok) { seasonNote = tm(r && r.error) || t('Could not change the season.'); }
      else seasonNote = r.running
        ? t('Switched to {title}. Close the game and press Play again: the season loads when the servers start.', { title: t(x.title) })
        : t('Switched to {title}. It starts the next time you press Play.', { title: t(x.title) });
      renderSeasons();
    });
    list.appendChild(row);
  }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function addLog(id, line, isErr) {
  (logs[id] = logs[id] || []).push({ line, isErr });
  if (logs[id].length > 400) logs[id].splice(0, logs[id].length - 400);
  if (busy[id] === 'play') noteHuntFailure(id, line);
  if (id === selected) { $('log').hidden = false; renderLog(id); if (busy[id] === 'setup' && setupAuto[id] && kindOf(line)) $('p-foot').textContent = kindOf(line); }
}
// DF-FIX4: a hunt server that could not start (ports, antivirus, timeout) is explained under the Play button
const huntFailed = {};   // id -> reason
function noteHuntFailure(id, line) {
  const m = /^HUNT SERVER FAILED:\s*(.+)$/.exec(String(line || '').trim());
  if (!m) return;
  huntFailed[id] = m[1];
  if (id === selected) { const n = $('action-note'); n.textContent = t('A hunt could not start: {reason}', { reason: m[1] }); n.className = 'action-note err'; }
}
function kindOf(line) { const ln = String(line || '').trim(); return ln && !/^=+/.test(ln) ? ln.slice(0, 120) : ''; }
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
  const ok = await confirm(t('Download Dauntless {version}?', { version: v.id }),
    t('{gb} GB from Epic\'s servers into\n{path}\n\nWhile it runs it needs about {need} GB free{free}; afterwards the folder is {installed} GB. Stop any time; it carries on later.', {
      gb: v.download.downloadGB, path: `${info.gamesRoot}\\${v.download.folderName}`, need, installed: v.download.installedGB,
      free: free != null ? ' ' + t('(you have {gb} GB)', { gb: free }) : '' }));
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
    const ok = await confirm(t('Put the game folder back?'), t('This takes this version\'s files out of the game folder again (they are kept in the launcher\'s backup folder, nothing is deleted). Your offline save stays. You can run Set up again later.'));
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
    n.textContent = auto ? (r && r.error ? t('Set-up did not finish: {error} More > "Run set-up again" shows every step in a window.', { error: tm(r.error) }) : t('Set-up did not finish. More > "Run set-up again" shows every step in a window.'))
      : t('Set-up did not finish. The window that opened said why; fix that and press Set up again.');
    n.className = 'action-note err';
  }
}
async function play(v) {
  busy[v.id] = 'play'; logs[v.id] = []; renderShelf(); renderDetail();
  delete huntFailed[v.id];
  const r = await L.play(v.id);
  busy[v.id] = null;
  await refresh(v.id);
  if (!r.ok && r.error) { const n = $('action-note'); n.textContent = tm(r.error); n.className = 'action-note err'; }
  else if (huntFailed[v.id]) { const n = $('action-note'); n.textContent = t('A hunt could not start: {reason}', { reason: huntFailed[v.id] }); n.className = 'action-note err'; }
}
// ---------------------------------------------------------------- Slayer copy (1.14.7 tools\slayer-copy.js)
let scBusy = false;
async function renderSlayer() {
  let s = {}; try { s = await L.slayerStatus(); } catch {}
  $('sc-162').textContent = s.v162 ? t('Installed, character found') : t('Install and play 1.6.2 once');
  $('sc-1147').textContent = !s.v1147 ? t('Install 1.14.7 first') : s.c1147 ? t('Installed, character found')
    : s.tool ? t('Installed, no Slayer yet: copying 1.6.2 makes one') : t('Server files update when the launcher opens');
  const fromOk = !!(s.v162 && s.v1147 && (s.tool || s.c1147)), toOk = !!(s.v162 && s.v1147 && s.c1147);
  $('sc-162').dataset.ok = s.v162 ? '1' : '0'; $('sc-1147').dataset.ok = (s.v1147 && (s.c1147 || s.tool)) ? '1' : '0';
  if (!scBusy) fillSlayerSummary();
  $('sc-from').disabled = !fromOk || scBusy; $('sc-to').disabled = !toOk || scBusy;
  const n = $('sc-note');
  if (!scBusy) { n.className = 'action-note'; n.textContent = !s.v162 ? t('Play 1.6.2 once before copying.') : !s.v1147 ? t('Install 1.14.7 (Download and Set up) before copying.')
    : s.running ? t('Close the game and stop hosting before copying.') : !s.c1147 && s.tool ? t('Copying into 1.14.7 makes your 1.14.7 Slayer: level 1, tutorial done, then everything from 1.6.2.') : ''; }
}
// The same facts for both Slayers, side by side; the better value in each row is lit (tools\slayer-summary.js).
async function fillSlayerSummary() {
  let r = null; try { r = await L.slayerSummary(); } catch {}
  const a = r && r.v162, b = r && r.v1147;
  $('sc-name-162').textContent = (a && a.name) || ''; $('sc-name-1147').textContent = (b && b.name) || '';
  const day = (ts) => { if (!ts) return '-'; const d = new Date(ts); return d.toDateString() === new Date().toDateString() ? t('Today') : d.toLocaleDateString(window.I18N && I18N.lang() !== 'en' ? I18N.lang() : undefined, { month: 'short', day: 'numeric' }); };
  const num = (n) => Number(n || 0).toLocaleString();
  const rows = [
    // (the labels go through t() where they are shown)
    ['Last played', (x) => day(x.lastPlayed), (x) => Date.parse(x.lastPlayed) || 0],
    ['Weapons and armour', (x) => num(x.gear), (x) => x.gear],
    ['Cosmetics', (x) => num(x.cosmetics), (x) => x.cosmetics],
    ['Rams', (x) => num(x.rams), (x) => x.rams],
    ['Weapons at level 20', (x) => `${x.maxed} / 7`, (x) => x.maxed],
    ['Reforges', (x) => num(x.reforges), (x) => x.reforges],
    ["Slayer's Path", (x) => `${x.path} / ${x.pathOf}`, (x) => x.path],
  ];
  for (const [id, me, other] of [['sc-stats-162', a, b], ['sc-stats-1147', b, a]]) {
    const dl = $(id); dl.textContent = ''; dl.hidden = !me; if (!me) continue;
    for (const [label, show, val] of rows) {
      const dt = document.createElement('dt'); dt.textContent = t(label);
      const dd = document.createElement('dd'); dd.textContent = show(me);
      if (other && val(me) > val(other)) dd.className = 'sc-win';
      dl.append(dt, dd);
    }
  }
}
async function slayerCopy(dir) {
  if (scBusy) return; scBusy = true; renderSlayer();
  const n = $('sc-note'), out = $('sc-out');
  const from = dir === 'from-162' ? '1.6.2' : '1.14.7', to = dir === 'from-162' ? '1.14.7' : '1.6.2';
  try {
    n.className = 'action-note'; n.textContent = t('Reading both saves...');
    const pre = await L.slayerCopy(dir, true);
    out.hidden = false; out.textContent = pre.text || '';   // the tool's own report: as it wrote it
    if (!pre.ok) { n.className = 'action-note err'; n.textContent = tm((pre.text || 'Could not read the saves.').split('\n')[0].replace(/^STOPPED: /, '')); return; }
    const ok = await confirm(t('Copy your Slayer from {from} into {to}?', { from, to }), t('The preview below shows what changes. Your {from} save is only read. A backup of your {to} save is made first.', { from, to }));
    if (!ok) { n.textContent = t('Nothing was changed.'); return; }
    n.textContent = t('Copying...');
    const r = await L.slayerCopy(dir, false);
    out.textContent = r.text || '';
    n.className = r.ok ? 'action-note' : 'action-note err';
    n.textContent = r.ok ? t('Done. Your Slayer in {to} has it the next time you play.', { to }) : tm((r.text || 'The copy failed.').split('\n')[0].replace(/^STOPPED: /, ''));
  } finally { scBusy = false; renderSlayer(); }
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
  $('sc-from').addEventListener('click', () => slayerCopy('from-162'));
  $('sc-to').addEventListener('click', () => slayerCopy('to-162'));
  $('btn-host').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const hb = $('btn-host'), n = $('action-note');
    const soc = window.dfSocial || {};
    const hm = soc.hostMode && soc.hostMode.version === v.id ? soc.hostMode : null;
    if (hm) {
      // Stop hosting: friends still in get 60 seconds and their characters are saved home
      let players = 0; try { players = ((await L.hostState()).players || []).length; } catch {}
      const ok = await confirm(t('Stop hosting?'), players ? (players > 1 ? t('{n} friends are in your game. They get 60 seconds and their characters are saved home. Your game closes too.', { n: players }) : t('{n} friend is in your game. They get 60 seconds and their characters are saved home. Your game closes too.', { n: players })) : t('This closes your server. If your game is open, it closes too.'));
      if (!ok) return;
      pendingPlay = null; hb.disabled = true;
      const r = await L.hostStop(players > 0);
      if (r && r.ok === false) { n.textContent = tm(r.error) || t('Could not stop hosting.'); n.className = 'action-note err'; hb.disabled = false; }
      return;
    }
    if (!lightHost && hostCan && hostCan.has(v.id)) {
      hb.disabled = true; n.className = 'action-note';
      let friends = 0; try { friends = (await L.hostState()).friends || 0; } catch {}
      n.textContent = soc.allowRandoms ? t('Starting your server (open to everyone: your friends and Play online players). Your game opens by itself in a moment.')
        : friends ? (friends === 1 ? t('Starting your server. Only the {n} person on your Friends list can join (tick Allow randoms to open it to everyone). Your game opens by itself in a moment.', { n: friends })
          : t('Starting your server. Only the {n} people on your Friends list can join (tick Allow randoms to open it to everyone). Your game opens by itself in a moment.', { n: friends }))
        : t('Starting your server, but your Friends list is empty, so nobody can join yet. Add friends on the Friends page, or tick Allow randoms. Your game opens by itself in a moment.');
      try { await L.hostSet({ version: v.id, mode: soc.allowRandoms ? 'public' : 'private' }); } catch {}
      const r = await L.hostStart(v.id);
      if (r && r.ok === false) { n.textContent = tm(r.error) || t('Could not start your server.'); n.className = 'action-note err'; hb.disabled = false; return; }
      pendingPlay = v.id;
      return;
    }
    hb.disabled = true; n.className = 'action-note';
    n.textContent = t('Starting your game as a host. A window opens: keep it open while you play. Friends can join once you reach the main menu.');
    const r = await L.socialHost(v.id);
    if (r && r.ok === false) { n.textContent = tm(r.error) || t('Could not start hosting.'); n.className = 'action-note err'; hb.disabled = false; }
  });
  $('btn-online').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const soc = window.dfSocial || {};
    if (soc.search) { await L.socialCancelOnline(); return; }
    const ob = $('btn-online'), n = $('action-note');
    ob.disabled = true;
    const r = await L.socialPlayOnline(v.id);
    if (r && r.ok === false) { n.textContent = tm(r.error) || t('Could not go online.'); n.className = 'action-note err'; ob.disabled = false; }
  });
  $('opt-light').addEventListener('change', async (e) => {
    try { lightHost = await L.setLightHost(!!e.target.checked); } catch {}
    renderHostButton();
  });
  $('opt-randoms').addEventListener('change', async (e) => {
    const s = await L.socialSetAllowRandoms(!!e.target.checked);
    if (s) { window.dfSocial = Object.assign(window.dfSocial || {}, { allowRandoms: s.allowRandoms }); renderHostButton(); }
  });
  $('btn-stop').addEventListener('click', async () => {
    const v = versions.find(x => x.id === selected); if (!v) return;
    const hmOn = window.dfSocial && window.dfSocial.hostMode && window.dfSocial.hostMode.version === v.id;
    const ok = hmOn ? await confirm(t('Close the game?'), t('This closes your game. Host Mode keeps the server running (stop it on the Host Mode page).'))
      : await confirm(t('Stop everything?'), t('This closes the local backend and the hidden game servers. If the game itself is still open, it is closed too (your progress is saved as you play).'));
    if (!ok) return;
    $('btn-stop').disabled = true; await L.stop(v.id); $('btn-stop').disabled = false;
  });
  $('btn-cancel').addEventListener('click', () => { if (selected) L.cancelDownload(selected); });
  $('btn-more').addEventListener('click', () => {
    const m = $('more-menu'); m.hidden = !m.hidden;
    // DF-MORE-SCROLL (Oct 31): the menu opens below the fold on most screens; bring all of it into view (no scroll if it already is)
    if (!m.hidden) requestAnimationFrame(() => { try { m.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {} });
  });
  $('more-menu').addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    $('more-menu').hidden = true;
    const v = versions.find(x => x.id === selected); if (!v) return;
    if (act === 'pick') {
      const r = await L.pickFolder(v.id);
      if (r.picked) delete dl[v.id];
      if (r.picked && !r.ok) { const n = $('action-note'); n.textContent = tm(r.reason); n.className = 'action-note err'; }
      await refresh(v.id);
      if (r.picked && r.ok && statuses[v.id].game === 'wrong') { const n = $('action-note'); n.textContent = t('That folder has a Dauntless game, but not build {build}. This version only works with that exact build.', { build: v.build }); n.className = 'action-note err'; }
    }
    if (act === 'setup') runSetup(v, false);
    if (act === 'uninstall') runSetup(v, true);
    if (act === 'import' || act === 'importfix') {
      const n = $('action-note');
      if (act === 'import') {
        const ok = await confirm(t('Bring your Dauntless Revived character?'), t('A window opens and asks where your Dauntless Revived (1.4.4) character is: on a Revived server (it reads your own account through the Revived launcher while the game runs) or in a Revived save on this PC. It shows what will come over (gear, Rams, cells, materials, quests, weapon levels) and asks before changing anything. Nothing on the Revived side is changed; your 1.6.2 save is backed up first. Make your 1.6.2 character in game first.'));
        if (!ok) return;
      }
      n.className = 'action-note';
      n.textContent = act === 'import' ? t('The import window is open: answer it there, then close it. Your character has the items the next time you play.') : t('The fix window is open: it only marks the tutorial and the first mission as done. Close it when it says it is finished.');
      const r = await L.importRevived(v.id, act === 'importfix');
      await refresh(v.id);
      if (r && r.ok === false && r.error) { n.textContent = tm(r.error); n.className = 'action-note err'; }
      else { n.className = 'action-note'; n.textContent = act === 'import' ? t('Import window closed. If it said it imported, your character has the items the next time you play.') : t('Fix window closed. It said there whether anything was changed.'); }
    }
    if (act === 'check') {   // DF-CHECKFILES
      const show = (text, err, done) => { checkNotes[v.id] = { text, err: !!err, until: done ? Date.now() + 5 * 60 * 1000 : 0 }; if (v.id === selected) renderDetail(); };
      show(t('Checking the game files. This reads the whole game, so it takes a few minutes...'));
      const off = L.onCheckProgress((p) => {
        if (p.id !== v.id) return;
        show(p.phase === 'repair' ? t('Repairing: downloading the damaged files again, {pct}% ({text})', { pct: p.pct, text: p.text })
          : t('Checking the game files: {pct}% ({text})', { pct: p.pct, text: p.text }));
      });
      const r = await L.checkGame(v.id);
      off();
      const bad = (r && r.bad) || [];
      if (r && r.ok && !bad.length) show(t('All {count} game files are fine. Nothing needed repairing.', { count: r.checked }), false, true);
      else if (r && r.ok) show(t('Repaired {count} file(s) that were missing or damaged. If set-up is asked for, run it, then press Play.', { count: r.repaired }), false, true);
      else show(bad.length ? t('Found {count} missing or damaged file(s), but the repair did not finish: {error}', { count: bad.length, error: tm(r && r.error) }) : t('Could not check the game files: {error}', { error: tm(r && r.error) }), true, true);
      await refresh(v.id);
    }
    if (act === 'opengame') L.openGameFolder(v.id);
    if (act === 'openver') L.openVersionFolder(v.id);
    if (act === 'firewall') {
      const n = $('action-note'); n.textContent = t('Adding Windows Firewall rules (Windows asks for permission once)...'); n.className = 'action-note';
      const r = await L.fixFirewall();
      n.textContent = r && r.ok ? t('Windows Firewall now allows the launcher, Node and the game ({count} programs). If you use another firewall or antivirus, allow "Dauntless Forever" and node.exe there too.', { count: r.count })
        : t('Could not add the firewall rules: {error}', { error: tm(r && r.error) });
      n.className = r && r.ok ? 'action-note' : 'action-note err';
    }
    // DF-AVGUARD / DF-PKGVERIFY: these two take a while and the page redraws every few seconds, so their text goes
    // through checkNotes (kept through redraws, 5 minutes after the end) like the Check the game files text
    const keep = (text, err, done) => { checkNotes[v.id] = { text, err: !!err, until: done ? Date.now() + 5 * 60 * 1000 : 0 }; if (v.id === selected) renderDetail(); };
    if (act === 'avallow') {   // DF-AVGUARD
      keep(t('Checking which antivirus this PC uses...'));
      let r = null; try { r = await L.avAllow(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (r && r.ok) {
        keep(r.probe && r.probe.ok ? t('Windows Defender now leaves the launcher folder and the game folder alone ({count} folders). The helper test passed. If something was removed before, use More > Repair the launcher files.', { count: r.count })
          : t('Windows Defender exclusions were added ({count} folders), but the helper test still failed: {error}. Another protection program may be running; allow the launcher folder there too.', { count: r.count, error: tm(r.probe && r.probe.error) }), !(r.probe && r.probe.ok), true);
      } else if (r && r.manual) {
        const prods = (r.products || []).join(', ') || t('your antivirus');
        const lines = [t('The launcher can only add exclusions to Windows Defender by itself. For {prods}, add these folders yourself:', { prods }), '', ...r.folders.map(f => '    ' + f), '',
          t('Where the setting lives:'),
          '  Avast / AVG: Menu > Settings > General > Exceptions > Add exception (then restore the files from Protection > Virus Chest)',
          '  Bitdefender: Protection > Antivirus > Settings > Manage exceptions > Add an exception (folder)',
          '  ESET: Setup > Advanced setup (F5) > Scans > Detection exclusions > Edit > Add: Detection name MSIL/Riskware.BadInterop.AC, Path left empty (one rule covers the helper on every path; thanks Enryaku). Folders: Advanced setup > Scans > Performance exclusions. Restore from Tools > Quarantine',
          '  Kaspersky: Settings > Threats and exclusions > Manage exclusions > Add (folder); restore from Quarantine',
          '  Malwarebytes: Settings > Allow list > Add (folder)',
          '', t('Afterwards use More > Repair the launcher files, then Set up.')];
        $('readme-title').textContent = t('Allow Dauntless Forever in {prods}', { prods }); $('readme-body').textContent = lines.join('\n'); $('dlg-readme').showModal();
        keep(t('The folders to allow are in the window (More > Allow in the antivirus opens it again). After adding them: More > Repair the launcher files.'), false, true);
      } else keep(t('Could not add the exclusions: {error}', { error: tm(r && r.error) }), true, true);
    }
    if (act === 'appdata') {   // DF-APPDATA
      const ok = await confirm(t('Fix the Windows AppData setting?'), t('Windows on this PC stores your AppData location as a fixed path instead of its normal default. The folder stays exactly where it is; only the way Windows writes it down changes back to the default, so Dauntless can use its own settings folder again. No admin rights needed.'));
      if (!ok) return;
      let r = null; try { r = await L.fixAppData(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      await refresh(v.id);
      keep(r && r.ok ? t('Done: Windows now uses its default AppData setting. Press Play.') : (tm(r && r.error) || t('The setting could not be changed.')), !(r && r.ok), true);
    }
    if (act === 'pkgrepair') {   // DF-PKGVERIFY
      keep(t('Putting the server files back (a download when the newest are not on this PC). This takes up to a minute...'));
      let r = null; try { r = await L.repairPackage(v.id); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      await refresh(v.id);
      if (r && r.ok) keep(t('Server files are in place again ({version}). If Set up is asked for, press it.', { version: r.version }), false, true);
      else keep(tm(r && r.error) || t('The repair did not finish.'), true, true);
    }
    if (act === 'logs') { L.openLogs(v.id); const n = $('action-note'); n.textContent = t('Send the two zips in the upload folder (client_logs.zip, server_logs.zip). Your PC name and user name are blanked out in them.'); n.className = 'action-note'; }
    if (act === 'report') openReport(v);   // DF-REPORTS
    if (act === 'delpartial') {
      const n = $('action-note');
      const r = await L.deletePartial(v.id);
      if (r && r.ok) { delete dl[v.id]; logs[v.id] = []; n.textContent = t('Deleted the unfinished download ({gb} GB freed).', { gb: r.gb }); n.className = 'action-note'; }
      else if (r && !r.cancelled) { n.textContent = tm(r.error) || t('Nothing was deleted.'); n.className = 'action-note err'; }
      await refresh(v.id);
    }
    if (act === 'readme') { $('readme-title').textContent = `${v.name} README`; $('readme-body').textContent = (await L.readme(v.id)) || t('(no README in this package)'); $('dlg-readme').showModal(); }
  });
  // DF-REPORTS (Oct 21): More > "Send my logs": the player's name and what happened, sent with this version's logs
  let reportFor = null;
  async function openReport(v) {
    reportFor = v;
    $('report-title').textContent = t('Send my {version} logs', { version: v.name });
    const msg = $('report-msg'); msg.textContent = ''; msg.className = 'action-note';
    $('report-send').disabled = false; $('report-send').hidden = false; $('report-cancel').textContent = t('Cancel');
    $('report-reason').disabled = false; $('report-name').disabled = false;
    if (!$('report-name').value) { try { const p = await L.playerGet(); $('report-name').value = (p && p.name) || ''; } catch {} }
    if (!$('dlg-report').open) $('dlg-report').showModal();
    setTimeout(() => $('report-reason').focus(), 30);
  }
  $('report-cancel').addEventListener('click', () => $('dlg-report').close());
  $('report-send').addEventListener('click', async () => {
    const v = reportFor; if (!v) return;
    const reason = $('report-reason').value.trim(), msg = $('report-msg');
    if (reason.length < 3) { msg.textContent = t('Say what happened (a few words is fine).'); msg.className = 'action-note err'; $('report-reason').focus(); return; }
    $('report-send').disabled = true; $('report-reason').disabled = true; $('report-name').disabled = true;
    msg.className = 'action-note'; msg.textContent = t('Packing and sending your logs...');
    const r = await L.sendReport(v.id, $('report-name').value.trim(), reason);
    if (r && r.ok) {
      msg.textContent = t('Sent. Your report number is #{n}. Mention it on Discord so we can find it.', { n: r.report });
      $('report-reason').value = ''; $('report-send').hidden = true; $('report-cancel').textContent = t('Close');
    } else {
      msg.textContent = t('Could not send the logs: {error}', { error: tm(r && r.error) || '?' }); msg.className = 'action-note err';
      $('report-send').disabled = false; $('report-reason').disabled = false; $('report-name').disabled = false;
    }
  });
  $('btn-log-clear').addEventListener('click', () => { if (selected) { logs[selected] = []; renderDetail(); } });
  $('set-sky').addEventListener('click', () => { const on = Sky.toggle(); $('set-sky').textContent = on ? t('Turn off') : t('Turn on'); });
  $('set-ui-lang').addEventListener('change', () => { if (window.I18N) I18N.set($('set-ui-lang').value); });
  $('set-lang').addEventListener('change', async () => {
    const r = await L.setGameLanguage($('set-lang').value);
    $('set-lang-sub').textContent = !r || !r.ok ? (tm(r && r.error) || t('Could not save that.')) :
      (r.running ? t('Saved. The game is running: it changes the next time you start the game.') : t('Saved. It changes the next time you start the game.'));
    if (!r || !r.ok) fillGameLanguage();
  });
  $('set-menu').addEventListener('change', async () => {
    if (!menuVer) return;
    const r = await L.setMenuBackground(menuVer, $('set-menu').value);
    if (r && r.needPicture) { await menuPickPicture(); return; }
    const m = await L.menuBackgrounds(menuVer);
    if (m) { if (!r || !r.ok) $('set-menu').value = m.background; menuShowCustom(m); }
    $('set-menu-sub').textContent = !r || !r.ok ? (tm(r && r.error) || t('Could not save that.')) :
      (r.running ? t('Saved. The game is running: you will see it the next time you start the game.') : t('Saved. You will see it the next time you start the game.'));
  });
  $('set-menu-pick').addEventListener('click', () => { if (menuVer) menuPickPicture(); });
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) showPage(b.dataset.page); });
  $('set-games-pick').addEventListener('click', async () => { const p = await L.pickGamesRoot(); if (p) { info.gamesRoot = p; $('set-games').textContent = p; renderDetail(); } });
  $('set-data-open').addEventListener('click', () => L.openPath(info.dataRoot));
  $('set-acct-check').addEventListener('click', accountCheck);
  $('set-fv-check').addEventListener('click', foreverCheckRow);
  $('set-acct-reset').addEventListener('click', accountReset);
  $('set-acct-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('set-acct-report').textContent); $('set-acct-copy').textContent = t('Copied'); setTimeout(() => { $('set-acct-copy').textContent = t('Copy report'); }, 1500); } catch {}
  });
  $('set-files-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('set-files').textContent); $('set-files-copy').textContent = t('Copied'); setTimeout(() => { $('set-files-copy').textContent = t('Copy'); }, 1500); } catch {}
  });
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
      text += t('Server files updated for {list}.', { list: ok.map(r => `${r.id} (${r.to})`).join(', ') });
      text += ' ' + (need.length ? t('Press Set up on {list} to finish; it runs by itself.', { list: need.join(', ') }) : t('Nothing to do, just play.'));
    }
    if (bad.length) text += (text ? ' ' : '') + t('Update failed for {list}: {error}.', { list: bad.map(r => r.id).join(', '), error: tm(bad[0].error) });
    if (text) { $('banner-text').textContent = text; $('banner').hidden = false; }
  });
  $('banner-close').addEventListener('click', () => { $('banner').hidden = true; });
  // a newer launcher: a banner with a Download button (opens the release page; the player unzips it over this one)
  let upUrl = '';
  let upReady = false;
  let lastLauncherUpdate = null;
  const showLauncherUpdate = (u) => {
    if (!u) return; upUrl = u.url; upReady = !!u.ready;
    lastLauncherUpdate = u;
    $('banner-up-text').textContent = upReady
      ? (u.notes ? t('Dauntless Forever {version} is ready: {notes}', { version: u.version, notes: u.notes }) : t('Dauntless Forever {version} is ready.', { version: u.version })) + ' ' + t('Restart the launcher to use it (or it starts next time).')
      : (u.notes ? t('Dauntless Forever {version} is out: {notes}', { version: u.version, notes: u.notes }) : t('Dauntless Forever {version} is out.', { version: u.version })) + ' ' + t('Your games and saves stay where they are.');
    $('banner-up-get').textContent = upReady ? t('Restart now') : t('Download');
    $('banner-up').hidden = false; $('set-launcher').textContent = upReady ? t('({version} is ready: restart the launcher)', { version: u.version }) : t('({version} is available)', { version: u.version });
  };
  L.onLauncherUpdate(showLauncherUpdate);
  // a new language: the launcher-update banner says it again in that language
  window.addEventListener('df-lang', () => { if (lastLauncherUpdate) showLauncherUpdate(lastLauncherUpdate); });
  L.newerLauncher().then(showLauncherUpdate).catch(() => {});
  $('banner-up-get').addEventListener('click', async () => {
    if (!upReady) { if (upUrl) L.openUrl(upUrl); return; }
    const r = await L.restartLauncher().catch(() => null);
    if (r && !r.ok) $('banner-up-text').textContent = tm(r.error);
  });
  $('banner-up-close').addEventListener('click', () => { $('banner-up').hidden = true; });
  $('set-keep').addEventListener('click', async () => {
    const b = $('set-keep'); b.disabled = true;
    try { const on = await L.keepFiles(); if (on) $('set-pkgs').textContent = t('Getting the latest server files...'); await L.setKeepFiles(!on); } catch {}
    b.disabled = false; await fillSettings();
  });
  $('set-pkgs-check').addEventListener('click', async () => { $('set-pkgs').textContent = t('Checking...'); await L.checkUpdates(); await fillSettings(); if (!updateLog.length) $('set-pkgs').textContent += ' ' + t('(up to date)'); });

  // while set-up runs in its own window, re-check every few seconds so the steps tick over as it goes
  refreshTimer = setInterval(() => { for (const id of Object.keys(busy)) if (busy[id] === 'setup') refresh(id); }, 4000);
  window.addEventListener('focus', () => { if (selected) refresh(selected); });
}
boot();
