// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// hostmode.js - Host Mode: this PC keeps a server up (the backend, Ramsgate and the hunts) that friends (Private) or
// everyone using Play online (Public) can join. No game window opens here; the person at this PC can still press Play
// and join their own server. It is the same hosting as "Host with friends" (social.js startHostMode, the package's
// online-host.ps1 -HostMode), plus:
//   - a server name, a welcome line in game chat, a player limit and a ban list (the launcher refuses join requests);
//   - restart by itself when something stops (backend, game servers, Ramsgate, relay), with a growing pause;
//   - options: start when the launcher opens, start with Windows (launcher minimized), keep the PC awake,
//     a daily restart (warning in chat first, characters saved home) and a daily save backup (tools\backup.js).
// Settings live in launcher.json "hostMode". The Host Mode page (renderer/hostmode.js) shows the state and a small
// dashboard: players, hunts running, uptime, relay, PC load, backups.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, ipcMain, powerSaveBlocker } = require('electron');
const settings = require('./settings');
const { IS_WIN } = require('./paths');

const DEFAULTS = {
  version: '', mode: 'public', name: '', welcome: '', limit: 8, bans: [],
  autoStart: false, autoRestart: true, keepAwake: true, startWithWindows: false,
  dailyRestart: false, restartAt: '05:00', dailyBackup: true, backupKeep: 7,
};
const LIMIT_MIN = 1, LIMIT_MAX = 16;
const WELCOME_AFTER_MS = 45000;          // a joining player reaches Ramsgate chat about this long after their launcher says so
const RESTART_PAUSES = [15, 30, 60, 120, 300];   // seconds before each automatic restart in a row
const BACKUP_EVERY_MS = 24 * 3600 * 1000;

let ctx = null, social = null;
let wanted = false;         // Host Mode should be on (Start pressed, or started by itself)
let run = null;             // { version, pub, since }
let phase = 'off';          // off | starting | running | restarting | stopping | failed
let lastError = '';
let restartsInRow = 0, restartTotal = 0, restartTimer = null, restartAt = 0;
let dailyPending = false;   // a daily restart is under way: start again as soon as it has stopped
let lastDailyDay = '';
let backupBusy = false;
let awakeId = null;
const logLines = [];
const seen = new Map();     // guest id -> first seen (for the welcome line)
const welcomed = new Set();
const announceQueue = [];
let cpuPrev = null, cpuPct = null, huntsNow = null, huntsAt = 0;

// ------------------------------------------------------------------ settings
const cfg = () => {
  const s = settings.load().hostMode || {};
  const c = { ...DEFAULTS, ...s, bans: Array.isArray(s.bans) ? s.bans : [] };
  if (!s.modeChosen) c.mode = 'public';   // 0.2.5 and older saved 'private' by default; Public is the default now
  return c;
};
const cleanText = (t, max) => String(t || '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
function setCfg(patch) {
  const c = cfg(), p = patch || {};
  if (typeof p.version === 'string') c.version = p.version;
  if (p.mode === 'public' || p.mode === 'private') { c.mode = p.mode; c.modeChosen = true; }
  if (typeof p.name === 'string') c.name = cleanText(p.name, 32);
  if (typeof p.welcome === 'string') c.welcome = cleanText(p.welcome, 140);
  if (p.limit !== undefined) { const n = Math.round(Number(p.limit)); if (n >= LIMIT_MIN && n <= LIMIT_MAX) c.limit = n; }
  for (const k of ['autoStart', 'autoRestart', 'keepAwake', 'startWithWindows', 'dailyRestart', 'dailyBackup']) if (p[k] !== undefined) c[k] = !!p[k];
  if (typeof p.restartAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.restartAt)) c.restartAt = p.restartAt;
  if (p.backupKeep !== undefined) { const n = Math.round(Number(p.backupKeep)); if (n >= 1 && n <= 30) c.backupKeep = n; }
  settings.update(s => { s.hostMode = c; });
  applyAwake(); applyLogin();
  return c;
}
const serverName = () => cfg().name || `${((social && social.identity()) || {}).name || 'A'}'s server`;

// ------------------------------------------------------------------ log
function log(line, isErr) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  logLines.push({ t: hh, line: String(line).slice(0, 300), err: !!isErr });
  while (logLines.length > 200) logLines.shift();
  ctx.log('hostmode ' + line);
}

// ------------------------------------------------------------------ start / stop
function canHost(v) {
  if (!v) return false;
  try { return fs.readFileSync(path.join(v.dataDir, 'tools', 'online-host.ps1'), 'utf8').includes('HostMode'); } catch { return false; }
}
function versionsThatCan() { return ctx.registry.filter(v => v.package && canHost(v)).map(v => v.id); }
async function start(versionId, how) {
  const c = cfg();
  const id = versionId || c.version || versionsThatCan()[0];
  const v = ctx.byId(id);
  if (!v || !canHost(v)) throw new Error('This version cannot run Host Mode yet. Update its server files (reopen the launcher).');
  if (social.offlineMode()) throw new Error('Offline Forever mode is on (Settings). Host Mode needs the online service.');
  if (!social.onlineOn()) throw new Error(social.onlineOffMessage());
  if (!social.identity()) throw new Error('Still signing you in to the online service. Try again in a moment.');
  const st = await ctx.status(id);
  if (!st || st.game !== 'ok' || st.setup !== 'ready') throw new Error(`Dauntless ${id} is not ready yet: download it and let set-up finish on the Play page first.`);
  const busy = ctx.runner.anyRunning().filter(r => r.kind === 'play' || r.kind === 'host' || r.kind === 'join' || r.kind === 'setup');
  if (busy.length) throw new Error('Close the game (or stop hosting) first: Host Mode runs its own server.');
  if (c.version !== id) setCfg({ version: id });
  wanted = true; restartsInRow = 0; lastError = '';
  log(`Starting Host Mode for ${id} (${c.mode === 'public' ? 'Public: anyone using Play online can join' : 'Private: friends only'})${how ? ' - ' + how : ''}.`);
  launch(id);
}
function launch(id) {
  clearTimeout(restartTimer); restartTimer = null; restartAt = 0;
  // the previous run's STOP may still be closing things: start only once it is done, or it would close the new server
  if (ctx.runner.isRunning(id + ':stop') || ctx.runner.isRunning(id + ':host')) { restartTimer = setTimeout(() => { if (wanted) launch(id); }, 2000); return; }
  const pub = cfg().mode === 'public';
  run = { version: id, pub, since: Date.now() };
  phase = 'starting'; seen.clear(); welcomed.clear();
  applyAwake();
  social.startHostMode(id, pub, (line, isErr) => log(line, isErr))
    .then((code) => ended(id, code))
    .catch((e) => { log('Could not start: ' + e.message, true); ended(id, -1, e.message); });
  push();
}
function ended(id, code, why) {
  const lasted = run ? Date.now() - run.since : 0;
  run = null;
  if (!wanted) { phase = 'off'; log('Host Mode is off.'); applyAwake(); push(); return; }
  if (dailyPending) {
    dailyPending = false; restartsInRow = 0;
    log('Daily restart: starting again.');
    phase = 'restarting'; restartAt = Date.now() + 5000;
    restartTimer = setTimeout(() => { if (wanted) launch(id); }, 5000);
    push(); return;
  }
  const reason = why || (code === 3 ? 'the relay connection was lost' : `it stopped (code ${code})`);
  lastError = reason;
  if (!cfg().autoRestart) { wanted = false; phase = 'failed'; log(`Host Mode stopped: ${reason}.`, true); applyAwake(); push(); return; }
  if (lasted > 10 * 60 * 1000) restartsInRow = 0;   // it ran a good while: start again quickly
  const pause = RESTART_PAUSES[Math.min(restartsInRow, RESTART_PAUSES.length - 1)];
  restartsInRow++; restartTotal++;
  phase = 'restarting'; restartAt = Date.now() + pause * 1000;
  log(`Host Mode stopped (${reason}). Starting again in ${pause} seconds.`, true);
  restartTimer = setTimeout(() => { if (wanted) launch(id); }, pause * 1000);
  push();
}
async function stop(later) {
  wanted = false; dailyPending = false;
  clearTimeout(restartTimer); restartTimer = null; restartAt = 0;
  if (!run) { phase = 'off'; applyAwake(); push(); return; }
  phase = 'stopping'; push();
  if (later && social.guests().length) { log('Stopping in 60 seconds: players were told in chat.'); social.stopHostLater(60, true, serverName()); }
  else await social.stopHostNow(true);
}
// The daily restart: a warning in chat and 60 seconds (characters saved home), then a fresh start
function dailyRestart() {
  if (!run || phase !== 'running') return;
  log('Daily restart.');
  dailyPending = true;
  if (cfg().dailyBackup) backupNow('before the daily restart').catch(() => {});
  if (social.guests().length) social.stopHostLater(60, false, serverName());
  else social.stopHostNow(false).catch(() => {});
}

// ------------------------------------------------------------------ hooks for social.js
const hooks = {
  refuse(fromId, isFriend) {
    if (!run) return '';
    const c = cfg();
    if (c.bans.some(b => b.id === fromId)) return 'You are not allowed on this server.';
    if (social.guests().filter(g => g.id !== fromId).length >= c.limit) return `That server is full (${c.limit} players).`;
    if (phase !== 'running') return 'That server is starting. Try again in a minute.';
    return '';
  },
  heartbeat(versionId) { return run && run.version === versionId ? { hostMode: true, server: serverName(), max: cfg().limit } : {}; },
  brief() { return run || wanted ? { version: (run && run.version) || cfg().version, phase, name: serverName(), mode: cfg().mode } : null; },
  stopped(byUser) { if (byUser && wanted) { wanted = false; dailyPending = false; log('Stopped from the launcher.'); } },
  cancelled() { if (dailyPending) { dailyPending = false; log('Daily restart called off ("Keep playing").'); } },
};

// ------------------------------------------------------------------ the tick: phase, welcome lines, daily jobs, load
function tick() {
  if (run) {
    // starting: ask the friends poll to look now (it sees the server once the relay is connected and the backend answers)
    if (phase === 'starting') { const v = ctx.byId(run.version); if (v && fs.existsSync(path.join(v.dataDir, 'data', 'relay.json'))) social.poll(); }
    const h = social.hostingVersion();
    if (phase === 'starting' && h && h.v.id === run.version) { phase = 'running'; restartsInRow = Math.min(restartsInRow, 1); log(`Host Mode is up: "${serverName()}" on the ${social.regionName(h.relay.ip) || h.relay.ip} relay.`); }
    if (phase === 'running') welcome();
  }
  pumpAnnounce();
  // daily restart at the chosen time (once a day)
  const c = cfg(), now = new Date();
  const day = now.toISOString().slice(0, 10), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (c.dailyRestart && run && phase === 'running' && hm === c.restartAt && lastDailyDay !== day && Date.now() - run.since > 10 * 60 * 1000) { lastDailyDay = day; dailyRestart(); }
  // daily backup: once every 24 hours while Host Mode is up
  if (c.dailyBackup && run && phase === 'running' && !backupBusy) {
    const last = Date.parse(settings.load().hostModeLastBackup || '') || 0;
    if (Date.now() - last > BACKUP_EVERY_MS && Date.now() - run.since > 2 * 60 * 1000) backupNow('daily').catch(() => {});
  }
  measureCpu();
  if (run && Date.now() - huntsAt > 15000) countHunts();
  push();
}
function welcome() {
  const c = cfg(), now = Date.now();
  const guests = social.guests();
  const ids = new Set(guests.map(g => g.id));
  for (const id of [...seen.keys()]) if (!ids.has(id)) { seen.delete(id); welcomed.delete(id); }   // left: welcome again next time
  for (const g of guests) {
    if (!seen.has(g.id)) seen.set(g.id, now);
    if (!welcomed.has(g.id) && now - seen.get(g.id) > WELCOME_AFTER_MS) {
      welcomed.add(g.id);
      announceQueue.push(`Welcome to ${serverName()}, ${cleanText(g.name, 24)}!${c.welcome ? ' ' + c.welcome : ''}`);
    }
  }
}
// data\announce.txt is said in chat by the backend and deleted (every 2 s): one line at a time
function pumpAnnounce() {
  if (!announceQueue.length || !run) { if (!run) announceQueue.length = 0; return; }
  const v = ctx.byId(run.version); if (!v) return;
  const f = path.join(v.dataDir, 'data', 'announce.txt');
  if (fs.existsSync(f)) return;
  social.announce(v, announceQueue.shift());
}

// ------------------------------------------------------------------ backups (tools\backup.js in the package)
async function backupNow(why) {
  const id = (run && run.version) || cfg().version;
  const v = ctx.byId(id);
  if (!v) throw new Error('No version picked yet.');
  const script = path.join(v.dataDir, 'tools', 'backup.js');
  if (!fs.existsSync(script)) throw new Error('This version has no backup tool yet. Update its server files.');
  if (backupBusy) throw new Error('A backup is already running.');
  backupBusy = true; push();
  try {
    const node = await ctx.nodeFor(v);
    if (!node) throw new Error('Node.js was not found. Run Set up first.');
    const r = await new Promise((resolve) => execFile(node, [script, String(cfg().backupKeep)], { cwd: v.dataDir, timeout: 120000, windowsHide: true }, (e, out) => {
      try { resolve(JSON.parse(String(out || '').trim().split(/\r?\n/).pop())); } catch { resolve({ ok: false, error: e ? e.message.split('\n')[0] : 'no answer' }); }
    }));
    if (!r.ok) throw new Error(r.error || 'the backup failed');
    settings.update(s => { s.hostModeLastBackup = new Date().toISOString(); });
    log(`Backup made (${why || 'by hand'}): ${r.files} file(s)${r.removed && r.removed.length ? `, ${r.removed.length} old one(s) removed` : ''}.`);
    return r;
  } catch (e) { log('Backup failed: ' + e.message, true); throw e; }
  finally { backupBusy = false; push(); }
}

// ------------------------------------------------------------------ PC: awake, start with Windows, load
function applyAwake() {
  const on = wanted && cfg().keepAwake;
  if (on && awakeId === null) { try { awakeId = powerSaveBlocker.start('prevent-app-suspension'); } catch {} }
  if (!on && awakeId !== null) { try { powerSaveBlocker.stop(awakeId); } catch {} awakeId = null; }
}
function applyLogin() {
  if (!app.isPackaged || !IS_WIN) return;   // a development copy must never register itself
  try { app.setLoginItemSettings({ openAtLogin: !!cfg().startWithWindows, args: ['--hostmode'] }); } catch {}
}
function measureCpu() {
  const t = os.cpus().reduce((a, c) => { const s = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + s }; }, { idle: 0, total: 0 });
  if (cpuPrev) { const dt = t.total - cpuPrev.total; if (dt > 0) cpuPct = Math.max(0, Math.min(100, Math.round(100 * (1 - (t.idle - cpuPrev.idle) / dt)))); }
  cpuPrev = t;
}
// hunts running here: the hunt servers' game ports (8770-8775; 8776 is the Training Dojo, 8777 Ramsgate)
function countHunts() {
  huntsAt = Date.now();
  if (!IS_WIN) { huntsNow = 0; return; }
  execFile('netstat', ['-ano', '-p', 'UDP'], { windowsHide: true, timeout: 8000 }, (e, out) => {
    if (e) return;
    const ports = new Set();
    for (const m of String(out).matchAll(/:(877[0-5])\s/g)) ports.add(m[1]);
    huntsNow = ports.size;
  });
}

// ------------------------------------------------------------------ state for the page
function publicState() {
  const c = cfg();
  const h = run ? social.hostingVersion() : null;
  const relay = h ? { name: social.regionName(h.relay.ip) || h.relay.ip, address: `${h.relay.ip}:${h.relay.base}` } : null;
  const ping = social.relayPing && social.relayPing();
  const last = settings.load().hostModeLastBackup || '';
  let nextRestart = '';
  if (c.dailyRestart) nextRestart = c.restartAt;
  return {
    settings: { ...c, nameShown: serverName() },
    versions: versionsThatCan(),
    phase, wanted, version: (run && run.version) || c.version || versionsThatCan()[0] || '',
    since: run && phase === 'running' ? run.since : null,
    restartIn: restartAt ? Math.max(0, Math.ceil((restartAt - Date.now()) / 1000)) : 0,
    restarts: restartTotal, lastError,
    players: run ? social.guests().map(g => ({ id: g.id, name: g.name, tag: g.tag || '', banned: c.bans.some(b => b.id === g.id) })) : [],
    friends: social.friendsCount(),
    hunts: run ? huntsNow : null,
    closingIn: social.closingIn(),
    relay, ping: ping ? { name: ping.name, ms: ping.ms } : null,
    pc: { cpu: cpuPct, ramUsedGB: +((os.totalmem() - os.freemem()) / 1073741824).toFixed(1), ramTotalGB: +(os.totalmem() / 1073741824).toFixed(1) },
    awake: awakeId !== null, lastBackup: last, backupBusy, nextRestart,
    canStartWithWindows: app.isPackaged && IS_WIN,
    log: logLines.slice(-60),
  };
}
let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; ctx.send('hostmode:update', publicState()); try { social.push(); } catch {} }, 150);
}

// ------------------------------------------------------------------ IPC
function init(c) {
  ctx = c; social = c.social;
  social.setHostModeHooks(hooks);
  const act = (fn) => async (_e, ...a) => { try { const r = await fn(...a); push(); return { ok: true, result: r, state: publicState() }; } catch (e) { return { ok: false, error: e.message, state: publicState() }; } };
  ipcMain.handle('hostmode:state', () => publicState());
  ipcMain.handle('hostmode:start', act((id) => start(id, 'started by hand')));
  ipcMain.handle('hostmode:stop', act((later) => stop(!!later)));
  ipcMain.handle('hostmode:set', act((patch) => { setCfg(patch); }));
  ipcMain.handle('hostmode:ban', act((id, name) => {
    const c = cfg();
    if (!id || c.bans.some(b => b.id === id)) return;
    settings.update(s => { s.hostMode = { ...cfg(), bans: [...c.bans, { id: String(id).slice(0, 64), name: cleanText(name, 32), at: new Date().toISOString() }].slice(-300) }; });
    log(`Banned ${cleanText(name, 32)}: they cannot join this server again (whoever is in now stays until they leave).`);
  }));
  ipcMain.handle('hostmode:unban', act((id) => {
    const c = cfg(); const b = c.bans.find(x => x.id === id);
    settings.update(s => { s.hostMode = { ...c, bans: c.bans.filter(x => x.id !== id) }; });
    if (b) log(`Unbanned ${b.name}.`);
  }));
  ipcMain.handle('hostmode:backup', act(() => backupNow('by hand')));
  ipcMain.handle('hostmode:openBackups', () => {
    const v = ctx.byId((run && run.version) || cfg().version); if (!v) return false;
    const d = path.join(v.dataDir, 'backup', 'hostmode'); try { fs.mkdirSync(d, { recursive: true }); } catch {}
    require('electron').shell.openPath(d); return true;
  });
  setInterval(tick, 5000);
  applyLogin();
}
// After the launcher has opened and the server-file updates are in: start by itself if asked to
function autoStart(fromWindows) {
  const c = cfg();
  if (!(c.autoStart || fromWindows) || wanted) return;
  if (!c.version) { log('Not started by itself: pick a version on the Host Mode page first.', true); return; }
  let tries = 0;
  const attempt = () => {
    start(c.version, fromWindows ? 'started with Windows' : 'started when the launcher opened').catch((e) => {
      // signing in to the online service can take a little while after the launcher opens
      if (++tries < 6) setTimeout(attempt, 20000);
      else { lastError = e.message; phase = 'failed'; log('Could not start by itself: ' + e.message, true); push(); }
    });
  };
  attempt();
}
const isOn = (id) => !!run && (!id || run.version === id) && (phase === 'running' || phase === 'starting');
const isWanted = () => wanted;
// The launcher is closing: stop the server (it must not keep running without a window to stop it)
async function shutdown() { if (run || wanted) { try { await stop(false); } catch {} } applyAwake(); }

module.exports = { init, autoStart, isOn, isWanted, shutdown };
