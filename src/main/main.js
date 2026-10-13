// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// main.js - the launcher's main process: one window, and the bridge between the window and the
// version packages (status, download, set-up, play, stop, uninstall).
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const P = require('./paths');
const settings = require('./settings');
const V = require('./versions');
const R = require('./runner');
const D = require('./downloader');
const U = require('./updates');

let win = null;
let registry = [];

const log = (...a) => { try { fs.appendFileSync(P.launcherLog(), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 940, minHeight: 620,
    title: 'Dauntless Forever', backgroundColor: '#0f1419', show: false,
    icon: path.join(P.bundledRoot(), app.isPackaged ? 'icon.png' : '../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // never leave a game orphaned without saying so
  win.on('close', (e) => {
    if (!R.anyRunning().some(r => r.kind === 'play')) return;
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep playing', 'Close the launcher anyway'], defaultId: 0, cancelId: 0,
      message: 'The game is still running.', detail: 'The servers it started keep running until the game closes by itself. If something is stuck, use "Stop everything" in the launcher first.' });
    if (r === 0) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  P.ensureDir(P.dataRoot());
  registry = V.loadRegistry();
  for (const v of registry) { try { V.syncPackage(v); } catch (e) { log('syncPackage', v.id, e.message); } }
  createWindow();
  // server-file updates: after the window is up, quietly; the window hears about anything that changed
  win.webContents.once('did-finish-load', () => setTimeout(checkUpdates, 1500));
});
// A newer launcher: tell the window (it shows a banner with a Download button). Never downloads by itself.
let newerLauncher = null;
function launcherUpdate(l) {
  if (!l || !l.version || !/^https:\/\/github\.com\/addison2k\//.test(l.url || '')) return;
  if (V.cmpVersionStr(String(l.version), app.getVersion()) <= 0) return;
  newerLauncher = { version: String(l.version), url: l.url, notes: String(l.notes || '') };
  send('launcher:update', newerLauncher);
}
ipcMain.handle('launcher:newer', () => newerLauncher);
async function checkUpdates() {
  try {
    const results = await U.checkAndApply(registry, (msg) => { log('updates', msg); send('updates:event', { msg }); },
      (id) => R.isRunning(id) || R.isRunning(id + ':setup') || D.isDownloading(id), launcherUpdate);
    if (P.MOCK && process.env.DL_MOCK_LAUNCHER) launcherUpdate({ version: process.env.DL_MOCK_LAUNCHER, url: 'https://github.com/addison2k/DauntlessForever/releases', notes: 'Test notes.' });
    if (results.length) send('updates:done', { results });
  } catch (e) { log('updates', e.message); }
}
ipcMain.handle('updates:check', () => checkUpdates());

// ---------------------------------------------------------------- credits, community links, supporters
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
ipcMain.handle('community:info', async () => {
  const root = P.bundledRoot();
  const credits = readJson(path.join(root, 'credits.json'), { intro: '', sections: [] });
  const community = readJson(path.join(root, 'community.json'), {});
  let supporters = readJson(path.join(root, 'supporters.json'), { supporters: [], anonymous: 0 });
  // the live list from the repo wins when it can be fetched, so a new supporter needs no new build
  try { const live = await U.fetchJson(U.SUPPORTERS_URL); if (live && Array.isArray(live.supporters)) supporters = live; } catch {}
  try { const live = await U.fetchJson(U.COMMUNITY_URL); if (live && typeof live === 'object') Object.assign(community, live); } catch {}
  return { credits, community, supporters };
});
app.on('window-all-closed', () => app.quit());
// ---------------------------------------------------------------- helpers
const byId = (id) => registry.find(v => v.id === id);
function publicVersion(v) {
  const { bundledDir, ...rest } = v;
  return { ...rest, hasPackage: !!v.package };
}
function findNode() {
  return new Promise((resolve) => {
    if (!P.IS_WIN) return resolve(P.MOCK ? { path: 'C:\\Program Files\\nodejs\\node.exe', version: 'v22.12.0' } : null);
    const cands = [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe')].filter(Boolean);
    execFile('where.exe', ['node.exe'], (e, out) => {
      const first = (!e && out.split(/\r?\n/).map(s => s.trim()).find(Boolean)) || cands.find(c => fs.existsSync(c));
      if (!first) return resolve(null);
      execFile(first, ['--version'], (e2, ver) => resolve({ path: first, version: e2 ? '?' : ver.trim() }));
    });
  });
}
function defaultGamesRoot() {
  const s = settings.load();
  if (s.gamesRoot) return s.gamesRoot;
  if (P.IS_WIN) {
    // the biggest drive with the most free space would need a WMI call; keep it predictable: the drive the launcher data is on
    const drive = (P.dataRoot().match(/^[A-Za-z]:/) || ['C:'])[0];
    return drive + '\\Games';
  }
  return path.join(app.getPath('home'), 'Games');
}
function freeSpaceGB(dir) {
  return new Promise((resolve) => {
    try {
      let d = dir; while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
      fs.promises.statfs(d).then(st => resolve(+(st.bavail * st.bsize / 1e9).toFixed(1))).catch(() => resolve(null));
    } catch { resolve(null); }
  });
}

// ---------------------------------------------------------------- IPC: read
ipcMain.handle('versions:list', () => registry.map(publicVersion));
ipcMain.handle('versions:status', (_e, id) => {
  const v = byId(id); if (!v) return null;
  const s = V.status(v);
  s.busy = R.isRunning(id) ? 'play' : (D.isDownloading(id) ? 'download' : (R.isRunning(id + ':setup') ? 'setup' : null));
  return s;
});
ipcMain.handle('launcher:info', async () => ({
  version: app.getVersion(), dataRoot: P.dataRoot(), gamesRoot: defaultGamesRoot(),
  node: await findNode(), toolOk: D.toolOk(), platform: process.platform, mock: P.MOCK,
  lastVersion: settings.load().lastVersion,
}));
ipcMain.handle('launcher:freeSpace', (_e, dir) => freeSpaceGB(dir));

// ---------------------------------------------------------------- IPC: folders
ipcMain.handle('game:pickFolder', async (_e, id) => {
  const v = byId(id);
  const r = await dialog.showOpenDialog(win, { title: `Pick the ${v.name} game folder (the one with "Archon" inside it)`, properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { picked: false };
  const g = V.resolveGameDir(r.filePaths[0], v.exeRel);
  if (!g) return { picked: true, ok: false, reason: `No Dauntless game (Archon\\Binaries\\Win64\\Dauntless-Win64-Shipping.exe) found in ${r.filePaths[0]}.` };
  settings.setVersionEntry(id, { gameDir: g });
  V.seedConfig(v, g);
  return { picked: true, ok: true, gameDir: g };
});
ipcMain.handle('game:forget', (_e, id) => { settings.setVersionEntry(id, { gameDir: '' }); return true; });
ipcMain.handle('launcher:pickGamesRoot', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should downloaded games go?', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.update(s => { s.gamesRoot = r.filePaths[0]; });
  return r.filePaths[0];
});
ipcMain.handle('launcher:setLast', (_e, id) => { settings.update(s => { s.lastVersion = id; }); return true; });
ipcMain.handle('open:path', (_e, p) => { if (p && fs.existsSync(p)) shell.openPath(p); return true; });
ipcMain.handle('open:url', (_e, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); return true; });
ipcMain.handle('open:versionFolder', (_e, id) => { const v = byId(id); if (v) shell.openPath(v.dataDir); return true; });
ipcMain.handle('open:gameFolder', (_e, id) => { const v = byId(id); const g = v && V.knownGameDir(v); if (g && fs.existsSync(g)) shell.openPath(g); return true; });
ipcMain.handle('open:logs', (_e, id) => { const v = byId(id); const u = v && path.join(v.dataDir, 'upload'); if (u && fs.existsSync(u)) shell.openPath(u); else if (v) shell.openPath(v.dataDir); return true; });
// ---------------------------------------------------------------- Hunt Pass seasons (package folder "seasons")
// index.json lists them; the choice goes to data/season.txt (start.ps1 hands it to the metagame);
// progress per season is in data/progression/<UID>.huntpass.json -> passes[save_key].xp
function readSeasons(v) {
  if (!v || !v.package) return null;
  let idx;
  try { idx = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'seasons', 'index.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  const list = Array.isArray(idx.seasons) ? idx.seasons : [];
  let active = '';
  try { active = fs.readFileSync(path.join(v.dataDir, 'data', 'season.txt'), 'utf8').trim(); } catch {}
  if (!list.some(x => x.key === active)) active = idx.default || 'mega';
  // the newest save file is this PC's player (one player per package)
  let passes = {};
  try {
    const dir = path.join(v.dataDir, 'data', 'progression');
    const f = fs.readdirSync(dir).filter(n => n.endsWith('.huntpass.json'))
      .map(n => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (f) passes = (JSON.parse(fs.readFileSync(path.join(dir, f.n), 'utf8').replace(/^﻿/, '')).passes) || {};
  } catch {}
  return {
    active,
    running: R.isRunning(v.id),
    seasons: list.map(x => {
      const p = passes[x.save_key || x.key];
      const xp = p ? Number(p.xp) || 0 : null;
      const per = Number(x.xp_per_level) || 100;
      return { key: x.key, title: x.title, kind: x.kind, levels: x.levels, started: xp !== null,
               level: xp === null ? 0 : Math.min(x.levels, Math.floor(xp / per)), xp };
    }),
  };
}
ipcMain.handle('seasons:list', (_e, id) => readSeasons(byId(id)));
ipcMain.handle('seasons:set', (_e, id, key) => {
  const v = byId(id); const s = readSeasons(v);
  if (!s || !s.seasons.some(x => x.key === key)) return { ok: false, error: 'Unknown season.' };
  fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(v.dataDir, 'data', 'season.txt'), key);
  return { ok: true, running: R.isRunning(v.id) };
});
ipcMain.handle('seasons:openDoc', (_e, id, key) => {
  const v = byId(id); if (!v) return '';
  let doc = '';
  try { doc = (JSON.parse(fs.readFileSync(path.join(v.dataDir, 'seasons', 'index.json'), 'utf8').replace(/^\uFEFF/, '')).seasons.find(x => x.key === key) || {}).doc || ''; } catch {}
  if (!/^docs\/[\w.-]+\.md$/.test(doc)) return '';
  const f = path.join(v.dataDir, 'seasons', doc);
  try { return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
});
// ---------------------------------------------------------------- Ramsgate events (package file events.json)
// The choice is written to data/city_events.txt: a "# keys" line for the launcher, then on=/off= feature flags that
// start.ps1 hands to the deploy server (Ramsgate map URL ?OverridenFeaturesOn=/Off=).
function readEvents(v) {
  if (!v || !v.package) return null;
  let def;
  try { def = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'events.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  let event = 'none', dressing = 'default';
  try {
    const m = /#\s*keys:\s*event=([\w-]+);\s*dressing=([\w-]+)/.exec(fs.readFileSync(path.join(v.dataDir, 'data', 'city_events.txt'), 'utf8'));
    if (m) { event = m[1]; dressing = m[2]; }
  } catch {}
  if (!(def.events || []).some(e => e.key === event)) event = 'none';
  if (!(def.dressings || []).some(d => d.key === dressing)) dressing = 'default';
  return { events: def.events || [], dressings: def.dressings || [], event, dressing, running: R.isRunning(v.id) };
}
ipcMain.handle('events:list', (_e, id) => readEvents(byId(id)));
ipcMain.handle('events:set', (_e, id, eventKey, dressingKey) => {
  const v = byId(id); if (!v) return { ok: false, error: 'Unknown version.' };
  let def; try { def = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'events.json'), 'utf8').replace(/^﻿/, '')); } catch { return { ok: false, error: 'This version has no events.' }; }
  const ev = (def.events || []).find(e => e.key === eventKey) || { key: 'none', on: [] };
  const dr = (def.dressings || []).find(d => d.key === dressingKey) || { key: 'default', flag: null };
  const on = [...(ev.on || [])], off = [];
  if (dr.flag) { on.push(dr.flag); for (const f of def.huntPassFlags || []) if (f !== dr.flag) off.push(f); }
  const lines = [`# keys: event=${ev.key}; dressing=${dr.key}`, '# written by the launcher (Events page)'];
  if (on.length) lines.push('on=' + on.join(','));
  if (off.length) lines.push('off=' + off.join(','));
  fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(v.dataDir, 'data', 'city_events.txt'), lines.join('\r\n') + '\r\n');
  return { ok: true, running: R.isRunning(v.id) };
});

// ---------------------------------------------------------------- Game Rules (package file rules.json)
// The picks are written to data/rules.txt as key=value lines; start.ps1 reads them (defaults come from rules.json).
function readRuleDefs(v) {
  try { return JSON.parse(fs.readFileSync(path.join(v.dataDir, 'rules.json'), 'utf8').replace(/^﻿/, '')).rules || []; } catch { return null; }
}
function readRulePicks(v) {
  const picks = {};
  try {
    for (const line of fs.readFileSync(path.join(v.dataDir, 'data', 'rules.txt'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([a-z_]+)\s*=\s*([0-9.]+)\s*$/.exec(line); if (m) picks[m[1]] = m[2];
    }
  } catch {}
  return picks;
}
ipcMain.handle('rules:list', (_e, id) => {
  const v = byId(id); if (!v || !v.package) return null;
  const defs = readRuleDefs(v); if (!defs) return null;
  const picks = readRulePicks(v);
  const rules = defs.map(r => {
    const ok = (r.choices || []).map(c => String(c[0]));
    const value = ok.includes(picks[r.key]) ? picks[r.key] : String(r.default);
    return { key: r.key, title: r.title, blurb: r.blurb || '', tested: !!r.tested, default: String(r.default), choices: r.choices || [], value };
  });
  return { rules, running: R.isRunning(v.id) };
});
ipcMain.handle('rules:set', (_e, id, changes) => {
  const v = byId(id); if (!v) return { ok: false, error: 'Unknown version.' };
  const defs = readRuleDefs(v); if (!defs) return { ok: false, error: 'This version has no Game Rules.' };
  const picks = readRulePicks(v);
  for (const [k, val] of Object.entries(changes || {})) {
    const r = defs.find(x => x.key === k);
    if (r && (r.choices || []).some(c => String(c[0]) === String(val))) picks[k] = String(val);
  }
  const lines = ['# Game Rules, written by the launcher (Game Rules page). Takes effect the next time you press Play.'];
  for (const r of defs) if (picks[r.key] != null) lines.push(`${r.key}=${picks[r.key]}`);
  fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(v.dataDir, 'data', 'rules.txt'), lines.join('\r\n') + '\r\n');
  return { ok: true, running: R.isRunning(v.id) };
});

// ---------------------------------------------------------------- patch notes (bundled, the repo's copy wins)
ipcMain.handle('patchnotes:list', async () => {
  let notes = readJson(path.join(P.bundledRoot(), 'patchnotes.json'), { notes: [] });
  try { const live = await U.fetchJson(U.PATCHNOTES_URL); if (live && Array.isArray(live.notes)) notes = live; } catch {}
  return notes.notes || [];
});

ipcMain.handle('read:readme', (_e, id) => { const v = byId(id); try { return fs.readFileSync(path.join(v.dataDir, v.package.readme), 'utf8'); } catch { return ''; } });

// ---------------------------------------------------------------- IPC: download
ipcMain.handle('game:download', async (_e, id, targetRoot) => {
  const v = byId(id); if (!v) return { ok: false, error: 'unknown version' };
  const root = targetRoot || defaultGamesRoot();
  const outDir = path.join(root, v.download.folderName);
  settings.update(s => { s.gamesRoot = root; });
  log('download', id, '->', outDir);
  send('download:state', { id, state: 'running', outDir });
  const res = await D.download(v, outDir,
    (p) => send('download:progress', { id, ...p }),
    (line, isErr) => send('log:line', { id, line, isErr, kind: 'download' }));
  let ok = res.code === 0 && (res.failed === 0 || res.failed === null);
  let error = res.error || '';
  if (ok) {
    const g = V.resolveGameDir(outDir, v.exeRel);
    if (!g) { ok = false; error = 'The download finished but the game exe is not where it should be. Open the folder and check it.'; }
    else {
      settings.setVersionEntry(id, { gameDir: g });
      V.seedConfig(v, g);
      const h = V.sha256(path.join(g, v.exeRel));
      if (v.exeSha256 && h !== v.exeSha256.toUpperCase()) { ok = false; error = 'The downloaded game is not the expected build (the exe hash is different). Run the download again; already-complete files are skipped.'; }
    }
  } else if (!error) {
    error = res.failed ? `${res.failed} chunks failed. Check your connection and press Download again; it carries on where it stopped.`
      : (res.lastErrLine ? `The download stopped: ${res.lastErrLine}` : 'The download was stopped.');
  }
  send('download:state', { id, state: ok ? 'done' : 'failed', error, outDir });
  return { ok, error, outDir };
});
ipcMain.handle('game:cancelDownload', (_e, id) => D.cancel(id));

// ---------------------------------------------------------------- IPC: set-up / play / stop / uninstall
ipcMain.handle('game:setup', async (_e, id, uninstall) => {
  const v = byId(id); if (!v || !v.package) return { ok: false };
  const key = id + ':setup';
  if (R.isRunning(key)) return { ok: false, error: 'Set-up is already running.' };
  const g = V.knownGameDir(v);
  if (g && !uninstall) V.seedConfig(v, g);
  const script = path.join(v.dataDir, v.package.setup);
  send('setup:state', { id, state: 'running', uninstall: !!uninstall });
  const code = await R.runVisible(key, 'setup', script, uninstall ? v.package.uninstallArgs : [], `${v.name} offline - ${uninstall ? 'uninstall' : 'set-up'}`);
  send('setup:state', { id, state: 'done', code, uninstall: !!uninstall });
  return { ok: true, code };
});

ipcMain.handle('game:play', async (_e, id) => {
  const v = byId(id); if (!v || !v.package) return { ok: false };
  if (R.anyRunning().some(r => r.kind === 'play')) return { ok: false, error: 'A game is already running. Close it first.' };
  settings.update(s => { s.lastVersion = id; });
  const script = path.join(v.dataDir, v.package.play);
  send('play:state', { id, state: 'running' });
  let lastError = '';
  const code = await R.runHidden(id, 'play', script, [], (line, isErr) => {
    if (isErr && /^STOPPED:/.test(line.trim())) lastError = line.trim().replace(/^STOPPED:\s*/, '');
    send('log:line', { id, line, isErr, kind: 'play' });
  });
  send('play:state', { id, state: 'done', code, error: lastError });
  return { ok: code === 0, code, error: lastError };
});

ipcMain.handle('game:stop', async (_e, id) => {
  const v = byId(id); if (!v || !v.package) return { ok: false };
  send('log:line', { id, line: 'Stopping everything this version started...', isErr: false, kind: 'stop' });
  const killed = R.killTree(id);
  const code = await R.runStop(v, (line, isErr) => send('log:line', { id, line, isErr, kind: 'stop' }));
  send('log:line', { id, line: killed ? 'Stopped.' : 'Stopped (nothing from the launcher was running).', isErr: false, kind: 'stop' });
  return { ok: true, code };
});
