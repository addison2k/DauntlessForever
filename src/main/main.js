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
const AU = require('./appupdate');

let win = null;
let registry = [];
// voice chat: friends' voices play without a click first
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Drawn without the graphics card: on some PCs (drivers, scaling) the GPU path leaves bits of old frames behind buttons
// and draws text soft. The launcher is a few flat panels, so the processor draws it just as fast. DF_GPU=1 turns it back on.
if (process.env.DF_GPU !== '1') app.disableHardwareAcceleration();
// One launcher at a time: opening it again brings the open window forward (two launchers would both poll the
// friends service, both run voice, and fight over the same files)
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// Opened by Windows at login for Host Mode (Host Mode page: "Start with Windows"): start minimized, then start Host Mode
const FROM_WINDOWS = process.argv.includes('--hostmode');
let closeOk = false;   // Host Mode was stopped on the way out: the window may close now
const log = (...a) => { try { fs.appendFileSync(P.launcherLog(), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} };
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

// After a launcher update the bundled server files are copied into the player's folders before the launcher opens.
// That can take a minute (thousands of files, antivirus), so a small window says so instead of showing nothing.
// "Keep my server files" (Settings, for modders): installed server files are never replaced, neither by updates
// nor by the copy that comes with a new launcher. A version that is not installed yet is still copied in.
const keepFiles = () => { try { return !!settings.load().keepServerFiles; } catch { return false; } };
const kept = (v) => keepFiles() && !!v.package && fs.existsSync(path.join(v.dataDir, v.package.play));
async function syncWithPleaseWait() {
  const todo = registry.filter(v => { try { return V.needsSync(v) && !kept(v); } catch { return false; } });
  if (!todo.length) return null;
  let wait = null;
  try {
    wait = new BrowserWindow({ width: 440, height: 150, frame: false, resizable: false, show: false, center: true, skipTaskbar: false,
      title: 'Dauntless Forever', backgroundColor: '#0f1419', icon: path.join(P.bundledRoot(), app.isPackaged ? 'icon.png' : '../build/icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const page = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0f1419;color:#e6edf3;font:14px Segoe UI,sans-serif;display:flex;' +
      'flex-direction:column;justify-content:center;height:100vh;padding:0 26px;box-sizing:border-box;border:1px solid #27333f">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:6px">Dauntless Forever is updating</div>' +
      '<div style="color:#9fb0c2">Copying the new server files. This can take a minute, please wait.</div>' +
      '<div id="n" style="color:#66788c;margin-top:10px;font-size:12px">&nbsp;</div></body>';
    await wait.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
    wait.show();
  } catch { wait = null; }
  let shown = 0;
  for (const v of todo) {
    try {
      await V.syncPackageAsync(v, (n) => {
        if (!wait || wait.isDestroyed() || n - shown < 150) return;
        shown = n;
        wait.webContents.executeJavaScript(`document.getElementById('n').textContent = ${JSON.stringify(`${v.name || v.id}: ${n} files copied`)}`).catch(() => {});
      });
    } catch (e) { log('syncPackage', v.id, e.message); try { V.syncPackage(v); } catch (e2) { log('syncPackage', v.id, e2.message); } }
    shown = 0;
  }
  if (wait && !wait.isDestroyed()) {
    wait.webContents.executeJavaScript(`document.getElementById('n').textContent = 'Done. Opening the launcher...'`).catch(() => {});
    return wait;
  }
  return null;
}
function createWindow() {
  win = new BrowserWindow({
    width: 1340, height: 800, minWidth: 940, minHeight: 620,
    title: 'Dauntless Forever', backgroundColor: '#0f1419', show: false,
    icon: path.join(P.bundledRoot(), app.isPackaged ? 'icon.png' : '../build/icon.png'),
    autoHideMenuBar: true,
    // our own dark title bar (index.html .titlebar); Windows still draws the minimise / maximise / close buttons,
    // so dragging, double-click to maximise and snap layouts work as before
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0b1015', symbolColor: '#9fb0c2', height: 34 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { try { AU.markGood(); } catch {} if (FROM_WINDOWS) { win.showInactive(); win.minimize(); } else win.show(); });
  // never leave a game orphaned without saying so
  win.on('close', (e) => {
    // Host Mode runs without a window of its own: closing the launcher would leave a server nobody can stop
    const HM = require('./hostmode');
    if (!closeOk && HM.isWanted()) {
      e.preventDefault();
      const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep it running', 'Minimize the launcher', 'Stop Host Mode and close'], defaultId: 1, cancelId: 0,
        message: 'Host Mode is running.', detail: 'Players can be in your server right now. Minimize keeps it running; closing the launcher stops the server (players in it get a minute and their characters are saved home).' });
      if (r === 1) win.minimize();
      if (r === 2) { HM.shutdown().finally(() => { closeOk = true; setTimeout(() => { try { win.close(); } catch {} }, 1500); }); }
      return;
    }
    if (!R.anyRunning().some(r => r.kind === 'play')) return;
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep playing', 'Close the launcher anyway'], defaultId: 0, cancelId: 0,
      message: 'The game is still running.', detail: 'The servers it started keep running until the game closes by itself. If something is stuck, use "Stop everything" in the launcher first.' });
    if (r === 0) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(async () => {
  P.ensureDir(P.dataRoot());
  // voice chat: the window may use the microphone (it only ever shows the launcher's own pages)
  require('electron').session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'clipboard-sanitized-write' || perm === 'fullscreen'));
  registry = V.loadRegistry();
  const pleaseWait = await syncWithPleaseWait();   // after an update: copy the new server files in, with a "please wait" window
  createWindow();
  // closed only once the launcher's own window exists (closing the last window would quit the app)
  if (pleaseWait) win.once('ready-to-show', () => { if (!pleaseWait.isDestroyed()) pleaseWait.destroy(); });
  // Friends page: its own IPC handlers and the online-status poll (social.js)
  require('./social').init({ get registry() { return registry; }, byId: (id) => byId(id), runner: R, send, log: (t) => log('social', t) });
  // One player name for every version and the Friends page (player.js)
  require('./player').init({ get registry() { return registry; }, social: require('./social'), log: (t) => log('player', t) });
  // Voice chat with the people in your game (voice.js)
  require('./voice').init({ social: require('./social'), send, log: (t) => log('voice', t) });
  // Host Mode: a server on this PC that stays up (hostmode.js)
  require('./hostmode').init({ get registry() { return registry; }, byId: (id) => byId(id), runner: R, send, log: (t) => log(t), social: require('./social'),
    status: async (id) => { const v = byId(id); return v ? V.status(v) : null; },
    nodeFor: async (v) => {
      let node = null;
      try { node = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).Node; } catch {}
      if (!node || !fs.existsSync(node)) node = (await findNode() || {}).path;
      return node || null;
    } });
  // server-file updates: after the window is up, quietly; the window hears about anything that changed
  win.webContents.once('did-finish-load', () => setTimeout(checkUpdates, 1500));
});
// A newer launcher. Small launcher updates (appupdate.js) download by themselves and are used from the next start:
// the banner offers "Restart now". A launcher too old for them shows the banner with a Download button, as before.
let newerLauncher = null;
async function launcherUpdate(l) {
  try {
    if (!l || !l.version || !/^https:\/\/github\.com\/addison2k\//.test(l.url || '')) return;
    if (V.cmpVersionStr(String(l.version), AU.info().version) <= 0) return;
    const how = await AU.consider(l, (t) => log('launcher', t));
    if (!how) return;
    newerLauncher = { version: String(l.version), url: l.url, notes: String(l.notes || ''), ready: how === 'ready' };
    send('launcher:update', newerLauncher);
  } catch (e) { log('launcher', 'update check: ' + e.message); }
}
// "Restart now": only when nothing of the game is running (closing would otherwise stop or orphan it)
ipcMain.handle('launcher:restart', () => {
  try { if (require('./hostmode').isWanted()) return { ok: false, error: 'Host Mode is running. Stop it first, or just keep going: the update is used the next time the launcher starts.' }; } catch {}
  if (R.anyRunning().length) return { ok: false, error: 'A game or server is still running. Close it first, or just keep going: the update is used the next time the launcher starts.' };
  app.relaunch(); app.quit();
  return { ok: true };
});
ipcMain.handle('launcher:newer', () => newerLauncher);
async function checkUpdates() {
  try {
    const results = await U.checkAndApply(registry, (msg) => { log('updates', msg); send('updates:event', { msg }); },
      (id) => R.isRunning(id) || R.isRunning(id + ':setup') || R.isRunning(id + ':host') || D.isDownloading(id), launcherUpdate,
      (id) => { const v = byId(id); return !!v && kept(v); });
    if (P.MOCK && process.env.DL_MOCK_LAUNCHER) launcherUpdate({ version: process.env.DL_MOCK_LAUNCHER, url: 'https://github.com/addison2k/DauntlessForever/releases', notes: 'Test notes.' });
    if (results.length) send('updates:done', { results });
  } catch (e) { log('updates', e.message); }
  // Host Mode may start by itself once the server files are up to date (Host Mode page options)
  if (!autoStarted) { autoStarted = true; try { require('./hostmode').autoStart(FROM_WINDOWS); } catch (e) { log('hostmode', e.message); } }
}
let autoStarted = false;
ipcMain.handle('updates:check', () => checkUpdates());
ipcMain.handle('settings:keepFiles', () => keepFiles());
// "Light hosting" (Play page): Host with friends uses the old way (the server runs only while your game is open)
// instead of starting this PC's server first (Host Mode, private) and then the game.
ipcMain.handle('settings:lightHost', () => { try { return !!settings.load().lightHost; } catch { return false; } });
ipcMain.handle('settings:setLightHost', (_e, on) => { settings.update(s => { s.lightHost = !!on; }); return !!on; });
// Turning it off fetches what was held back straight away (the window hears about it like any update)
ipcMain.handle('settings:setKeepFiles', async (_e, on) => {
  settings.update(s => { s.keepServerFiles = !!on; });
  log('settings', 'keep server files: ' + (on ? 'on' : 'off'));
  if (!on) {
    for (const v of registry) { try { if (!R.isRunning(v.id) && !R.isRunning(v.id + ':host') && V.needsSync(v)) await V.syncPackageAsync(v, () => {}); } catch (e) { log('syncPackage', v.id, e.message); } }
    checkUpdates();
  }
  return keepFiles();
});

// ---------------------------------------------------------------- credits, community links, supporters
function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
ipcMain.handle('community:info', async () => {
  const credits = readJson(P.appResource('credits.json'), { intro: '', sections: [] });
  const community = readJson(P.appResource('community.json'), {});
  let supporters = readJson(P.appResource('supporters.json'), { supporters: [], anonymous: 0 });
  // the live list from the repo wins when it can be fetched, so a new supporter needs no new build
  try { const live = await U.fetchJson(U.SUPPORTERS_URL); if (live && Array.isArray(live.supporters)) supporters = live; } catch {}
  try { const live = await U.fetchJson(U.COMMUNITY_URL); if (live && typeof live === 'object') Object.assign(community, live); } catch {}
  return { credits, community, supporters };
});
app.on('before-quit', () => { try { require('./hostmode').shutdown(); } catch {} try { require('./voice').shutdown(); } catch {} try { require('./social').shutdown(); } catch {} });
app.on('window-all-closed', () => app.quit());
// ---------------------------------------------------------------- helpers
const byId = (id) => registry.find(v => v.id === id);
function publicVersion(v) {
  const { bundledDir, ...rest } = v;
  // can host friends (Friends panel / "Host with friends"): its server files have the online host script
  let canHost = false;
  try { canHost = !!v.package && fs.existsSync(V.online(v).hostPath); } catch {}
  return { ...rest, hasPackage: !!v.package, canHost };
}
function findNode() {
  const bn = P.bundledNode();
  if (bn) return new Promise((resolve) => execFile(bn, ['--version'], (e, ver) => resolve({ path: bn, version: e ? '?' : ver.trim(), bundled: true })));
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
  // The Revived (1.4.4) import that comes with the server files (More menu): there, and has it been used here?
  s.canImport = fs.existsSync(path.join(v.dataDir, 'tools', 'import-revived.ps1'));
  s.canImportFix = s.canImport && /TutorialOnly/.test((() => { try { return fs.readFileSync(path.join(v.dataDir, 'tools', 'import-revived.ps1'), 'utf8'); } catch { return ''; } })());
  s.imported = fs.existsSync(path.join(v.dataDir, 'data', 'import-revived.json'));
  s.busy = R.isRunning(id) ? 'play' : (D.isDownloading(id) ? 'download' : (R.isRunning(id + ':setup') ? 'setup' : null));
  return s;
});
// Settings -> "What you are running": per version, the server files installed, each file set-up put in the
// game folder (loader dxgi.dll, server DLL, paks) with its short hash and whether it is the expected one,
// and the backend (top-level .js files by hash, node projects by name and version). Read-only. (Oct 17)
ipcMain.handle('versions:files', () => registry.filter(v => v.package).map(v => {
  const short = (h) => (h ? String(h).slice(0, 8).toUpperCase() : '');
  const r = { id: v.id, installed: V.installedPackageVersion(v), latest: v.package.packageVersion, held: kept(v), gameDir: V.knownGameDir(v), files: [], backend: [] };
  for (const f of v.package.installedFiles || []) {
    const name = path.basename(f.rel);
    if (!r.gameDir) { r.files.push({ name, want: short(f.sha256), have: '', state: 'nogame' }); continue; }
    const have = V.sha256(path.join(r.gameDir, f.rel));
    r.files.push({ name, want: short(f.sha256), have: short(have), state: !have ? 'missing' : (have === f.sha256.toUpperCase() ? 'ok' : 'different') });
  }
  const be = path.join(v.dataDir, 'backend');
  try {
    for (const ent of fs.readdirSync(be, { withFileTypes: true })) {
      const p = path.join(be, ent.name);
      if (ent.isFile() && /\.(c?js|mjs)$/i.test(ent.name)) r.backend.push({ name: ent.name, hash: short(V.sha256(p)) });
      else if (ent.isDirectory()) {
        try { const pj = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); r.backend.push({ name: pj.name || ent.name, version: pj.version || '' }); } catch {}
      }
    }
  } catch {}
  return r;
}));
ipcMain.handle('launcher:info', async () => ({
  version: AU.info().version, dataRoot: P.dataRoot(), gamesRoot: defaultGamesRoot(),
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
  // No choice saved: Automatic (holidays by the calendar) when the server files have it, as start.ps1 does.
  let event = (def.events || []).some(e => e.key === 'auto') && !fs.existsSync(path.join(v.dataDir, 'data', 'city_events.txt')) ? 'auto' : 'none', dressing = 'default';
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

// ---------------------------------------------------------------- Main menu background (package file menu.json)
// The choice is written to data/menu_background.txt: a "# keys" line for the launcher, then on=/off= Hunt Pass flags that
// play-162.ps1 / lan-join.ps1 put in the game's private Engine.ini (LocalMapOptions of the menu map). Takes effect at the
// next game start. Versions without menu.json don't show the setting.
// "Your own picture" (menu.json "custom"): menuart.js puts the picture into one season's login texture taken from the
// player's own game files and writes a small mod pak next to the game's paks; the setting then picks that season.
// Any other choice takes the mod pak out again. The pak can't be changed while the game or a server of it is running.
const MenuArt = require('./menuart');
function menuDef(v) {
  try { return JSON.parse(fs.readFileSync(path.join(v.dataDir, 'menu.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
const menuBusy = (v) => R.isRunning(v.id) || R.isRunning(v.id + ':host') || R.isRunning(v.id + ':setup');
const menuPreviewFile = (v) => path.join(v.dataDir, 'data', 'menu_custom.jpg');
function menuGameDir(v) { try { return V.knownGameDir(v) || ''; } catch { return ''; } }
function menuHasPak(v) { const g = menuGameDir(v); return !!g && fs.existsSync(MenuArt.modPakPath(g)); }
function readMenu(v) {
  if (!v || !v.package) return null;
  const def = menuDef(v); if (!def) return null;
  let background = 'default';
  try {
    const m = /#\s*keys:\s*background=([\w-]+)/.exec(fs.readFileSync(path.join(v.dataDir, 'data', 'menu_background.txt'), 'utf8'));
    if (m) background = m[1];
  } catch {}
  const list = (def.backgrounds || []).filter(b => b && b.key && b.title);
  const custom = def.custom && /^[A-Za-z0-9_]+$/.test(def.custom.flag || '') ? def.custom : null;
  const hasPak = custom ? menuHasPak(v) : false;
  if (background === 'custom' ? !(custom && hasPak) : !list.some(b => b.key === background)) background = 'default';
  let preview = '';
  if (custom && hasPak) { try { preview = 'data:image/jpeg;base64,' + fs.readFileSync(menuPreviewFile(v)).toString('base64'); } catch {} }
  return { id: v.id, backgrounds: list, background, custom: !!custom, hasPicture: hasPak, preview, running: menuBusy(v) };
}
function writeMenuChoice(v, def, key, flag) {
  const lines = [`# keys: background=${key}`, '# written by the launcher (Settings, main menu background)'];
  if (flag && /^[A-Za-z0-9_]+$/.test(flag)) {
    lines.push('on=' + flag);
    const off = (def.huntPassFlags || []).filter(f => f !== flag && /^[A-Za-z0-9_]+$/.test(f));
    if (off.length) lines.push('off=' + off.join(','));
  }
  fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(v.dataDir, 'data', 'menu_background.txt'), lines.join('\r\n') + '\r\n');
}
// Game language (Settings): the server files pass it to the game as -CULTURE=<code> (tools\common.ps1
// Add-GameLanguage reads data\game_language.txt). One choice for every version whose server files support it.
const GAME_LANGUAGES = [['', 'Game default'], ['en', 'English'], ['de', 'Deutsch (German)'], ['es', 'Espanol (Spanish)'],
  ['fr', 'Francais (French)'], ['it', 'Italiano (Italian)'], ['pt-BR', 'Portugues do Brasil (Portuguese)'], ['ru', 'Russkiy (Russian)'],
  ['pl', 'Polski (Polish)'], ['tr', 'Turkce (Turkish)'], ['ja', 'Nihongo (Japanese)'], ['ko', 'Hangugeo (Korean)'], ['zh-Hans', 'Zhongwen (Chinese)'],
  ['zh-Hans-mod', 'Zhongwen (Chinese, community translation)']];
const langFile = (v) => path.join(v.dataDir, 'data', 'game_language.txt');
const langSupported = (v) => { try { return /Add-GameLanguage/.test(fs.readFileSync(path.join(v.dataDir, 'tools', 'common.ps1'), 'utf8')); } catch { return false; } };
function readLang(v) {
  try { for (const l of fs.readFileSync(langFile(v), 'utf8').split(/\r?\n/)) { const t = l.trim(); if (t && !t.startsWith('#')) return (GAME_LANGUAGES.find(x => x[0] && x[0].toLowerCase() === t.toLowerCase()) || [''])[0]; } } catch {}
  return '';
}
ipcMain.handle('lang:get', () => {
  const vs = registry.filter(langSupported);
  return { languages: GAME_LANGUAGES, current: vs.length ? readLang(vs[0]) : '', versions: vs.map(v => v.id) };
});
ipcMain.handle('lang:set', (_e, code) => {
  const hit = GAME_LANGUAGES.find(x => x[0] === code); if (!hit) return { ok: false, error: 'Unknown language.' };
  const vs = registry.filter(langSupported);
  if (!vs.length) return { ok: false, error: 'Your server files do not support this yet. They update when the launcher starts.' };
  for (const v of vs) {
    fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
    fs.writeFileSync(langFile(v), ['# game language picked in the launcher (Settings); empty = the game default', code].join('\r\n') + '\r\n');
  }
  const running = vs.some(v => { try { return menuBusy(v); } catch { return false; } });
  return { ok: true, versions: vs.map(v => v.id), running };
});
ipcMain.handle('menu:list', (_e, id) => {
  if (id) return readMenu(byId(id));
  return registry.map(v => readMenu(v)).filter(Boolean);
});
ipcMain.handle('menu:set', (_e, id, key) => {
  const v = byId(id); if (!v) return { ok: false, error: 'Unknown version.' };
  const def = menuDef(v); if (!def) return { ok: false, error: 'This version has no menu backgrounds.' };
  if (key === 'custom') {
    if (!def.custom || !menuHasPak(v)) return { ok: false, needPicture: true, error: 'Choose a picture first.' };
    writeMenuChoice(v, def, 'custom', def.custom.flag);
    return { ok: true, running: menuBusy(v) };
  }
  if (menuHasPak(v)) {
    if (menuBusy(v)) return { ok: false, error: 'Close the game (and Host Mode) first: your own picture is in use.' };
    try { fs.unlinkSync(MenuArt.modPakPath(menuGameDir(v))); } catch (e) { return { ok: false, error: 'Could not take your picture out of the game folder: ' + e.message }; }
  }
  const bg = (def.backgrounds || []).find(b => b.key === key) || { key: 'default', flag: null };
  writeMenuChoice(v, def, bg.key, bg.flag);
  return { ok: true, running: menuBusy(v) };
});
ipcMain.handle('menu:pickCustom', async (_e, id) => {
  const v = byId(id); if (!v) return { ok: false, error: 'Unknown version.' };
  const def = menuDef(v); if (!def || !def.custom) return { ok: false, error: 'This version has no custom background.' };
  if (menuBusy(v)) return { ok: false, error: 'Close the game (and Host Mode) first, then choose the picture.' };
  const gameDir = menuGameDir(v);
  if (!gameDir || !fs.existsSync(path.join(gameDir, 'Archon', 'Content', 'Paks'))) return { ok: false, error: 'The game folder was not found. Download or set up the game first.' };
  const r = await dialog.showOpenDialog(win, { title: 'Choose a picture for the main menu (it is cropped to a wide 2:1 shape)', properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const pic = MenuArt.loadPicture(require('electron').nativeImage, r.filePaths[0]);
    const template = MenuArt.findTemplate(gameDir);
    if (!template) return { ok: false, error: 'The menu texture was not found in the game files.' };
    const pak = MenuArt.buildPak(template, pic.rgba);
    const dst = MenuArt.modPakPath(gameDir), tmp = dst + '.tmp';
    fs.writeFileSync(tmp, pak); fs.renameSync(tmp, dst);
    fs.mkdirSync(path.join(v.dataDir, 'data'), { recursive: true });
    fs.writeFileSync(menuPreviewFile(v), pic.preview);
    writeMenuChoice(v, def, 'custom', def.custom.flag);
    return { ok: true, name: path.basename(r.filePaths[0]) };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
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

// ---------------------------------------------------------------- Inventory (package files items.json + tools/items.js)
// tools/items.js reads/changes the stacked items in data/undaunted.db with the package's own Node.js and SQLite module.
async function runItems(v, args) {
  let node = null;
  try { node = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'config.json'), 'utf8').replace(/^﻿/, '')).Node; } catch {}
  if (!node || !fs.existsSync(node)) node = (await findNode() || {}).path;
  if (!node) return { ok: false, error: 'Node.js was not found. Run Set up first.' };
  return new Promise((resolve) => {
    execFile(node, [path.join(v.dataDir, 'tools', 'items.js'), ...args], { cwd: v.dataDir, timeout: 30000, windowsHide: true }, (e, out) => {
      try { resolve(JSON.parse(String(out || '').trim())); }
      catch { resolve({ ok: false, error: e ? `Could not read the save (${e.message.split('\n')[0]}).` : 'Could not read the save.' }); }
    });
  });
}
// Modded mode (UE4SS) for versions whose server files have tools\ue4ss.cjs (1.6.2 first). The helper does the work;
// the start scripts read data\mods.txt and give the game -dfmods (see tools\ue4ss.cjs).
async function runModsTool(v, args, timeout = 30000) {
  let node = null;
  try { node = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).Node; } catch {}
  if (!node || !fs.existsSync(node)) node = (await findNode() || {}).path;
  if (!node) return { ok: false, error: 'Node.js was not found. Run Set up first.' };
  return new Promise((resolve) => {
    execFile(node, [path.join(v.dataDir, 'tools', 'ue4ss.cjs'), ...args], { cwd: v.dataDir, timeout, windowsHide: true }, (e, out) => {
      try { resolve(JSON.parse(String(out || '').trim())); }
      catch { resolve({ ok: false, error: e ? `Mods helper failed (${e.message.split('\n')[0]}).` : 'Mods helper failed.' }); }
    });
  });
}
ipcMain.handle('mods:status', async (_e, id) => {
  const v = byId(id); if (!v || !v.package || !fs.existsSync(path.join(v.dataDir, 'tools', 'ue4ss.cjs'))) return null;
  const r = await runModsTool(v, ['status']);
  return { ...r, running: R.isRunning(v.id) };
});
ipcMain.handle('mods:act', async (_e, id, action, a, b) => {
  const v = byId(id); if (!v || !v.package || !fs.existsSync(path.join(v.dataDir, 'tools', 'ue4ss.cjs'))) return { ok: false, error: 'Unknown version.' };
  if (action === 'install') return runModsTool(v, ['install'], 300000);
  if (action === 'set' && ['on', 'off', 'servers-on', 'servers-off'].includes(a)) return runModsTool(v, ['set', a]);
  if (action === 'mod' && /^[\w .-]{1,80}$/.test(String(a)) && (b === 'on' || b === 'off')) return runModsTool(v, ['mod', String(a), b]);
  if (action === 'folder') {
    const r = await runModsTool(v, ['status']);
    if (r && r.ok && r.folder && fs.existsSync(r.folder)) { shell.openPath(r.folder); return { ok: true }; }
    return { ok: false, error: (r && r.error) || 'Get UE4SS first: the mods folder comes with it.' };
  }
  return { ok: false, error: 'Unknown action.' };
});
ipcMain.handle('items:list', async (_e, id) => {
  const v = byId(id); if (!v || !v.package) return null;
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'items.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
  if (!fs.existsSync(path.join(v.dataDir, 'tools', 'items.js'))) return null;
  const save = await runItems(v, ['list']);
  return { groups: catalog.groups || [], save, running: R.isRunning(v.id) };
});
// Gear (instanced items): add by catalog id, remove by instance id. Only versions whose helper knows "addgear".
ipcMain.handle('items:gear', async (_e, id, characterId, action, list) => {
  const v = byId(id); if (!v || !v.package) return { ok: false, error: 'Unknown version.' };
  if (R.isRunning(v.id) || R.isRunning(v.id + ':setup')) return { ok: false, error: 'Close the game first (press Stop), then change gear.' };
  if (!/^[\w-]{1,64}$/.test(String(characterId))) return { ok: false, error: 'Unknown character.' };
  if (action === 'unlockall') return runItems(v, ['addcosmetic', String(characterId), 'all']);
  if (action !== 'addgear' && action !== 'removegear') return { ok: false, error: 'Unknown action.' };
  const clean = (Array.isArray(list) ? list : []).map(String).filter(x => /^[\w-]{1,80}$/.test(x)).slice(0, 500);
  if (!clean.length) return { ok: false, error: 'Nothing to change.' };
  return runItems(v, [action, String(characterId), JSON.stringify(clean)]);
});
ipcMain.handle('items:set', async (_e, id, characterId, changes) => {
  const v = byId(id); if (!v || !v.package) return { ok: false, error: 'Unknown version.' };
  if (R.isRunning(v.id) || R.isRunning(v.id + ':setup')) return { ok: false, error: 'Close the game first (press Stop), then change items.' };
  if (!/^[\w-]{1,64}$|^\*$/.test(String(characterId))) return { ok: false, error: 'Unknown character.' };
  const clean = {};
  for (const [k, n] of Object.entries(changes || {})) if (/^[A-Z0-9_]{3,80}$/.test(k) && Number.isFinite(Number(n))) clean[k] = Math.max(0, Math.floor(Number(n)));
  if (!Object.keys(clean).length) return { ok: false, error: 'Nothing to change.' };
  return runItems(v, ['set', String(characterId), JSON.stringify(clean)]);
});

// ---------------------------------------------------------------- patch notes (bundled, the repo's copy wins)
ipcMain.handle('patchnotes:list', async () => {
  let notes = readJson(P.appResource('patchnotes.json'), { notes: [] });
  try { const live = await U.fetchJson(U.PATCHNOTES_URL); if (live && Array.isArray(live.notes)) notes = live; } catch {}
  return notes.notes || [];
});

ipcMain.handle('read:readme', (_e, id) => { const v = byId(id); try { return fs.readFileSync(path.join(v.dataDir, v.package.readme), 'utf8'); } catch { return ''; } });

// ---------------------------------------------------------------- IPC: download
// ---------------------------------------------------------------- download helpers
// Size of a folder in GB (a half-finished download counts towards the space it still needs).
function folderGB(dir) {
  let bytes = 0;
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { bytes += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return bytes / 1e9;
}
// The download tool's message, in words a player can act on.
function downloadError(res) {
  const raw = (res.errorLine || res.lastErrLine || '').replace(/^\s*Error:\s*/i, '');
  if (/not enough space|no space left|disk full|ENOSPC/i.test(raw))
    return 'Your drive is full. Free some space and press Download again (it carries on where it stopped), or pick another drive: Settings, "Downloaded games go to", Change folder. More, "Delete the unfinished download" gives the space back.';
  if (/access is denied|permission denied|EPERM|EACCES/i.test(raw))
    return 'Windows would not let the launcher write to the games folder. Pick another folder in Settings ("Downloaded games go to") and press Download again.';
  return raw ? `The download stopped: ${raw}` : 'The download was stopped.';
}
// Where this version downloads to, and whether an unfinished download is there.
function partialInfo(v) {
  const dir = path.join(defaultGamesRoot(), v.download.folderName);
  const exists = fs.existsSync(dir);
  const hasCache = exists && fs.existsSync(path.join(dir, '.manifest-cache'));
  const exe = path.join(dir, v.exeRel);
  const complete = exists && fs.existsSync(exe) && (!v.exeSha256 || V.sha256(exe) === v.exeSha256.toUpperCase()) && !hasCache;
  return { dir, exists, hasCache, complete, gb: exists ? +folderGB(dir).toFixed(2) : 0 };
}

ipcMain.handle('game:download', async (_e, id, targetRoot) => {
  const v = byId(id); if (!v) return { ok: false, error: 'unknown version' };
  const root = targetRoot || defaultGamesRoot();
  const outDir = path.join(root, v.download.folderName);
  // enough room? It needs about twice the game's size while it runs; what is already there counts.
  if (P.IS_WIN && !P.MOCK) {
    const free = await freeSpaceGB(root);
    const have = fs.existsSync(outDir) ? folderGB(outDir) : 0;
    const need = Math.max(1, v.download.installedGB * 2 - have);
    if (free != null && free < need) {
      const error = `Not enough space: this download needs about ${Math.ceil(need)} GB more on that drive, and it has ${free} GB free. Free some space, or pick another drive in Settings ("Downloaded games go to", Change folder).`;
      send('download:state', { id, state: 'failed', error, outDir });
      return { ok: false, error, outDir };
    }
  }
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
      : downloadError(res);
  }
  send('download:state', { id, state: ok ? 'done' : 'failed', error, outDir });
  return { ok, error, outDir };
});
ipcMain.handle('game:cancelDownload', (_e, id) => D.cancel(id));
ipcMain.handle('game:partialInfo', (_e, id) => { const v = byId(id); return v ? partialInfo(v) : null; });
// Delete an unfinished (or broken) download to get the space back. Never touches a complete, correct game,
// and only ever the launcher's own download folder for this version.
ipcMain.handle('game:deletePartial', async (_e, id) => {
  const v = byId(id); if (!v) return { ok: false, error: 'unknown version' };
  if (D.isDownloading(id) || R.isRunning(id) || R.isRunning(id + ':setup')) return { ok: false, error: 'Stop the download or game first.' };
  const info = partialInfo(v);
  if (!info.exists) return { ok: false, error: 'There is no unfinished download for this version.' };
  if (info.complete) return { ok: false, error: 'That folder holds the complete game, so it was left alone.' };
  if (path.basename(info.dir) !== v.download.folderName) return { ok: false, error: 'Unexpected folder; nothing was deleted.' };
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Delete it', 'Keep it'], defaultId: 1, cancelId: 1,
    message: `Delete the unfinished ${v.name} download?`,
    detail: `${info.dir}\n${info.gb} GB\n\nThis frees the space. You can press Download again later (it starts from the beginning).` });
  if (r.response !== 0) return { ok: false, cancelled: true };
  try { await fs.promises.rm(info.dir, { recursive: true, force: true }); }
  catch (e) { return { ok: false, error: 'Could not delete everything: ' + e.message }; }
  const e = settings.versionEntry(id);
  if (e.gameDir && path.resolve(e.gameDir).toLowerCase().startsWith(path.resolve(info.dir).toLowerCase())) settings.setVersionEntry(id, { gameDir: '' });
  log('deletePartial', id, info.dir, info.gb + ' GB');
  return { ok: true, gb: info.gb, dir: info.dir };
});

// ---------------------------------------------------------------- IPC: set-up / play / stop / uninstall
ipcMain.handle('game:setup', async (_e, id, uninstall, auto) => {
  const v = byId(id); if (!v || !v.package) return { ok: false };
  const key = id + ':setup';
  if (R.isRunning(key)) return { ok: false, error: 'Set-up is already running.' };
  const g = V.knownGameDir(v);
  if (g && !uninstall) V.seedConfig(v, g);
  const script = path.join(v.dataDir, v.package.setup);
  // auto: no window and no questions (setup.ps1 -Auto); the lines go to the log under the button. Packages from
  // before -Auto existed get the normal window.
  let canAuto = false;
  try { canAuto = !uninstall && /\[switch\]\$Auto/.test(fs.readFileSync(script, 'utf8')); } catch {}
  if (auto && canAuto) {
    send('setup:state', { id, state: 'running', auto: true });
    let lastError = '';
    const code = await R.runHidden(key, 'setup', script, ['-Auto'], (line, isErr) => {
      if (/^STOPPED:/.test(line.trim())) lastError = line.trim().replace(/^STOPPED:\s*/, '');
      send('log:line', { id, line, isErr, kind: 'setup' });
    });
    send('setup:state', { id, state: 'done', code, auto: true });
    return { ok: code === 0, code, error: lastError };
  }
  send('setup:state', { id, state: 'running', uninstall: !!uninstall });
  const code = await R.runVisible(key, 'setup', script, uninstall ? v.package.uninstallArgs : [], `${v.name} offline - ${uninstall ? 'uninstall' : 'set-up'}`);
  send('setup:state', { id, state: 'done', code, uninstall: !!uninstall });
  return { ok: true, code };
});

// More > Bring my Dauntless Revived (1.4.4) character: the server files' own import (tools\import-revived.ps1), in a
// window, because it shows what comes over and asks before changing anything. tutorialOnly: the "FIX tutorial" step.
ipcMain.handle('game:importRevived', async (_e, id, tutorialOnly) => {
  const v = byId(id); if (!v || !v.package) return { ok: false, error: 'This version is not installed.' };
  const script = path.join(v.dataDir, 'tools', 'import-revived.ps1');
  if (!fs.existsSync(script)) return { ok: false, error: 'This version has no Revived import yet. Its server files update when the launcher opens.' };
  if (R.anyRunning().some(r => String(r.id).split(':')[0] === id && r.kind !== 'stop'))
    return { ok: false, error: 'Close the game first (and stop hosting): the import changes your save while nothing is using it.' };
  if (R.isRunning(id + ':import')) return { ok: false, error: 'The import window is already open.' };
  const code = await R.runVisible(id + ':import', 'import', script, tutorialOnly ? ['-TutorialOnly'] : [],
    tutorialOnly ? `${v.name} - fix the tutorial after a Revived import` : `${v.name} - bring your Dauntless Revived character`);
  return { ok: code === 0, code };
});

ipcMain.handle('game:play', async (_e, id) => {
  const v = byId(id); if (!v || !v.package) return { ok: false };
  if (R.anyRunning().some(r => r.kind === 'play')) return { ok: false, error: 'A game is already running. Close it first.' };
  settings.update(s => { s.lastVersion = id; });
  // Host Mode is running this version: only the game starts, joining the server that is already up on this PC
  const hp = V.online(v).hostPlayPath;
  const hostPlay = require('./hostmode').isOn(id) && !!hp && fs.existsSync(hp);
  const script = hostPlay ? hp : path.join(v.dataDir, v.package.play);
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
  // Host Mode keeps its server: only the game closes
  if (require('./hostmode').isOn(id)) {
    const k = R.killTree(id);
    send('log:line', { id, line: k ? 'Game closed. Host Mode keeps running.' : 'No game was running. Host Mode keeps running.', isErr: false, kind: 'stop' });
    return { ok: true, code: 0 };
  }
  send('log:line', { id, line: 'Stopping everything this version started...', isErr: false, kind: 'stop' });
  const killed = R.killTree(id);
  const code = await R.runStop(v, (line, isErr) => send('log:line', { id, line, isErr, kind: 'stop' }));
  send('log:line', { id, line: killed ? 'Stopped.' : 'Stopped (nothing from the launcher was running).', isErr: false, kind: 'stop' });
  return { ok: true, code };
});
