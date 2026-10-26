// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// forever.js - Forever mode (main side). One button: Play Forever. The director on the VPS (df-director.js, mounted in
// the social service) says whether this PC joins a world, hosts one, or waits; keeps the board; elects a standby PC in
// every world and tells everyone where to go when a host leaves; and holds the Forever characters (fresh characters
// that only play Forever).
//
// Forever is its own install: versions\forever (own backend, own save, same game folder as 1.14.7), built by this
// launcher from the 1.14.7 package plus two packs the Forever service hands to allowed launchers. What is in the
// second pack, and what its parts are called, is described by the pack itself (core\core.json) - not by this file.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const P = require('./paths');

const FV = 'forever';
const BEAT_MS = 5000, HOST_BEAT_MS = 10000;
const UDP_BASE = 8780;
// Everything the private pack is called lives in the pack itself (core\core.json), never in this file:
// this source is published, the pack is not.
let M = null;
function manifest() {
  if (M) return M;
  try { M = JSON.parse(fs.readFileSync(path.join(coreDir(), 'core.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { M = null; }
  return M;
}

let ctx = null;        // { runner, send, log, social, nodeFor }
let S = null;          // the public state (see publicState)
let timer = null;      // the beat loop
let hostTimer = null;
let standby = null;    // { relayIp, relayBase, code, prewarmed, ready, huntPort, adopted, proc }
let gameSince = 0;
let character = null;  // { season, lease, record } when checked out
let lastGoAt = 0;
let pushTimer = null;
const logLines = [];

const dir = () => path.join(P.versionsDataDir(), FV);
const dataDir = () => path.join(dir(), 'data');
const toolsDir = () => path.join(dir(), 'tools');
const coreDir = () => path.join(dir(), 'core');
const coreTool = (name) => path.join(coreDir(), 'tools', (manifest() && manifest().tools && manifest().tools[name]) || (name + '.ps1'));
const coreBin = (which) => path.join(coreDir(), 'bin', (manifest() && manifest()[which]) || '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const ENV = () => ({ DF_VER: FV });

function log(t, isErr) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${t}`;
  logLines.push(line); if (logLines.length > 400) logLines.shift();
  try { ctx.log('forever: ' + t); } catch {}
  if (isErr) S.error = t;
  push();
}
function push() { if (pushTimer) return; pushTimer = setTimeout(() => { pushTimer = null; ctx.send('forever:update', publicState()); }, 150); }

// ------------------------------------------------------------------ the director: its own address and its own account
// Forever does NOT use the Friends account: the director can live on another VPS (network.json "director": {"url": ...}),
// and nothing Forever does can disturb the Friends service or a player's friends list. The account is a name only,
// made once per PC, kept in the launcher's data folder.
const accountFile = () => path.join(P.dataRoot(), 'forever-account.json');
let account = null;
function directorBase() {
  // 1. a local override, for testing against another box: data folder \ forever-director.txt with just the address.
  //    network.json is re-downloaded from GitHub every 10 minutes, so an edit there would not survive; this file does.
  try {
    const u = fs.readFileSync(path.join(P.dataRoot(), 'forever-director.txt'), 'utf8').trim();
    if (/^https?:\/\//.test(u)) return u.replace(/\/+$/, '');
  } catch {}
  const n = ctx.social.getNetwork() || {};
  // DF-FV-HTTPS (Oct 25): network.json "director": { "url": "http://ip:7080", "secure": "https://name" }. Launchers from
  // 0.3.6 use "secure" and fall back to "url" for 30 min when "secure" cannot be reached at all (a network that blocks
  // the name or HTTPS); older launchers only know "url". Same director, same accounts either way.
  const fb = fallbackBase();
  const sec = n.director && typeof n.director.secure === 'string' && /^https:\/\//.test(n.director.secure) ? n.director.secure.replace(/\/+$/, '') : '';
  if (sec && !(fb && Date.now() < useFallbackUntil)) return sec;
  if (n.director && typeof n.director.url === 'string' && /^https?:\/\//.test(n.director.url)) return n.director.url.replace(/\/+$/, '');
  return String((n.social && n.social.url) || '').replace(/\/+$/, '');
}
let useFallbackUntil = 0;
function fallbackBase() {
  try { if (fs.existsSync(path.join(P.dataRoot(), 'forever-director.txt'))) return ''; } catch {}
  const d = (ctx.social.getNetwork() || {}).director || {};
  return typeof d.secure === 'string' && typeof d.url === 'string' && /^https?:\/\//.test(d.url) ? d.url.replace(/\/+$/, '') : '';
}
// every address the same director has had (the account made on one is valid on all of them)
function directorAliases() {
  const d = (ctx.social.getNetwork() || {}).director || {};
  const all = [d.url, d.secure, ...(Array.isArray(d.aliases) ? d.aliases : [])].filter(x => typeof x === 'string').map(x => x.replace(/\/+$/, ''));
  return all;
}
const NET_ERR = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|CERT|SSL|TLS|self.signed|did not answer/i;
async function dcall(method, apiPath, body, timeoutMs) {
  try { return await dcallOnce(method, apiPath, body, timeoutMs); }
  catch (e0) {
    let e = e0;
    // DF-FV-RESETRETRY: a kept-alive connection the server already closed answers ECONNRESET / socket hang up once;
    // try again on a fresh connection before calling the address down (it was moving everyone to plain http for 30 min)
    if (!e.status && /ECONNRESET|socket hang up|EPIPE/i.test(String(e.code || '') + ' ' + e.message)) {
      try { return await dcallOnce(method, apiPath, body, timeoutMs, true); } catch (e2) { e = e2; }
    }
    const fb = fallbackBase();
    if (e.status || !fb || directorBase() === fb || !NET_ERR.test(String(e.code || '') + ' ' + e.message)) throw e;
    log(`the Forever service did not answer at ${directorBase()} (${e.code || e.message}); using ${fb} for 30 minutes`, true);
    useFallbackUntil = Date.now() + 30 * 60 * 1000;
    return dcallOnce(method, apiPath, body, timeoutMs);
  }
}
function dcallOnce(method, apiPath, body, timeoutMs, fresh) {
  return new Promise((resolve, reject) => {
    const base = directorBase();
    if (!base) return reject(new Error('no director address (network.json)'));
    const url = new URL(apiPath, base + '/');
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (account) {
      const time = Date.now();
      headers['X-DF-Id'] = account.id; headers['X-DF-Time'] = String(time);
      headers['X-DF-Sig'] = crypto.createHmac('sha256', account.secret).update(`${time}\n${method}\n${url.pathname}\n${data}`).digest('hex');
    }
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, Object.assign({ method, headers, timeout: timeoutMs || 15000 }, fresh ? { agent: false } : {}), (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d);
      res.on('end', () => {
        let j = {}; try { j = b ? JSON.parse(b) : {}; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else { const e = new Error(j.error || ('HTTP ' + res.statusCode)); e.status = res.statusCode; reject(e); }
      });
    });
    req.on('timeout', () => { const e = new Error('the Forever service did not answer'); req.destroy(e); });
    req.on('error', reject);
    req.end(data);
  });
}
async function ensureAccount() {
  if (account) return account;
  const same = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
  try { account = JSON.parse(fs.readFileSync(accountFile(), 'utf8')); if (account && account.id && account.secret && (same(account.base, directorBase()) || directorAliases().some(a => same(a, account.base)))) return account; account = null; } catch { account = null; }   // DF-FV-HTTPS: the same director under another address keeps the account
  let name = 'Slayer';
  try { name = (require('./player').get() || '').trim() || name; } catch {}
  try { const me = ctx.social.identity(); if (me && me.name) name = me.name; } catch {}
  name = name.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 20) || 'Slayer';
  if (name.length < 3) name = name + '123';
  const r = await dcall('POST', '/v1/register', { name });
  if (!r || !r.id || !r.secret) throw new Error('the Forever service did not give this PC an account');
  account = { id: r.id, secret: r.secret, name, base: directorBase() };
  P.ensureDir(path.dirname(accountFile()));
  fs.writeFileSync(accountFile(), JSON.stringify(account, null, 2));
  log(`this PC signed in to Forever as ${name} (${r.id.slice(0, 11)}...)`);
  return account;
}
async function api(method, apiPath, body) {
  await ensureAccount();
  try { return await dcall(method, apiPath, body); }
  catch (e) {
    // DF-FV-REREGISTER (Oct 26, Chabog): the Forever server no longer knows this PC's account ("not signed in"): every call
    // failed and the Forever tab stayed hidden. Make a new account once and try again (a new account starts a new Forever character).
    if (e && e.status === 401 && /unknown account/.test(e.message || '') && account && !apiPath.startsWith('/v1/register')) {
      log(`the Forever server does not know this PC's account (${account.id.slice(0, 11)}...): signing in again`, true);
      try { fs.renameSync(accountFile(), accountFile() + '.unknown-' + Date.now()); } catch {}
      account = null; await ensureAccount();
      return dcall(method, apiPath, body);
    }
    throw e;
  }
}

// ------------------------------------------------------------------ install
function installed() {
  return exists(path.join(dir(), 'version.json')) && exists(path.join(toolsDir(), 'online-host-1147.ps1')) && exists(path.join(toolsDir(), 'lan-join-1147.ps1'));
}
function privateOk() {
  const m = manifest();
  return !!(m && exists(coreBin('server')) && exists(coreBin('client')) && exists(coreTool('standby')) && exists(coreTool('attach')));
}
function missing() {
  if (!installed()) return 'Forever is not set up on this PC yet (versions\\forever).';
  if (!privateOk()) return 'Forever is missing part of its set-up on this PC. Press Set up Forever.';
  return '';
}
// this PC's player keys: the game signs in with the eos_lan id when it JOINS someone (what a host stores this
// player under, what the standby script uses) and with the eos id when this PC HOSTS (its own backend's record).
const DEFAULT_EPIC_ID = 'd211000000000000000000000000e91c';   // the game's offline id when eos\eos_offline.ini names none (the backend's HOST_KEY)
function ownKeys() {
  const out = [];
  const keyOf = (id) => crypto.createHash('sha256').update('epic:' + String(id).toLowerCase()).digest('hex').slice(0, 32);
  for (const ini of [path.join(dir(), 'eos_lan', 'eos_offline.ini'), path.join(dir(), 'eos', 'eos_offline.ini')]) {
    let id = null;
    try { const m = /^\s*EpicAccountId\s*=\s*([0-9a-fA-F]{32})\s*$/m.exec(fs.readFileSync(ini, 'utf8')); if (m) id = m[1]; } catch {}
    if (!id && /[\\/]eos[\\/]/.test(ini + path.sep)) id = DEFAULT_EPIC_ID;   // hosting with no id of its own = the default id
    if (id) { const k = keyOf(id); if (!out.includes(k)) out.push(k); }
  }
  return out;
}
function ownKey() { return ownKeys()[0] || null; }   // the join key (the standby's pull asks the host about this one)
// the account id the backend derives from a sign-in key (the same derivation as recorder-1147.js); a record filed under a key
// carries that key's id, so two keys never share an account id (the feature modules refuse a player with two records)
function accountIdOf(key) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const buf = crypto.createHash('sha256').update('account:' + key).digest().subarray(0, 16);
  let bits = 0, value = 0, out = ''; for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31]; return out;
}
// the key the game signs in under for each role: joining uses eos_lan (this PC's own id), hosting uses eos (the default id when it names none)
function ownKeyFor(role) { const k = ownKeys(); return role === 'host' ? (k[k.length - 1] || null) : (k[0] || null); }
// the backend's feature modules find a player by accountId and refuse when two records share one, so this PC's
// character lives under exactly one of its keys: the one the game is about to sign in with
function placeRecord(role) {
  const key = ownKeyFor(role); if (!key) return;
  const sf = path.join(dataDir(), 'state.json');
  const st = readJson(sf, null); if (!st || !st.players) return;
  const own = ownForeverRecord(st); if (!own) return;
  let changed = false;
  for (const k of ownKeys()) if (k !== key && st.players[k]) { delete st.players[k]; changed = true; }
  if (st.players[key] !== own.record) { st.players[key] = own.record; changed = true; }
  if (st.lastPlayer !== key) { st.lastPlayer = key; changed = true; }
  // nobody's game is signed in now (the backend starts after this), so every record takes its key's own account id
  for (const [k, r] of Object.entries(st.players)) if (r && typeof r === 'object' && r.accountId !== accountIdOf(k)) { r.accountId = accountIdOf(k); changed = true; }
  if (changed) { fs.writeFileSync(sf + '.tmp', JSON.stringify(st)); fs.renameSync(sf + '.tmp', sf); log(`your character is filed under this PC's ${role} key`); }
}
// the record of this PC's own player in the Forever save: whichever of its keys has a character
function ownForeverRecord(st) {
  if (!st || !st.players) return null;
  let best = null, bestKey = null;
  for (const k of ownKeys()) { const r = st.players[k]; if (r && typeof r === 'object' && (!best || (r.characters || []).length > (best.characters || []).length)) { best = r; bestKey = k; } }
  return best ? { key: bestKey, record: best } : null;
}
function writeRules(rules) {
  const f = path.join(dataDir(), 'rules.txt');
  let lines = [];
  try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim() && !/^forever_(hunts|max_hunts)=/.test(l)); } catch {}
  lines.push(`forever_hunts=${rules && rules.forever_hunts ? rules.forever_hunts : 8}`);
  // DF-FOREVER-CAP: hunt servers at once = this PC's share from the host check (its own file: rules.txt only takes Game Rules)
  const mh = Math.min(8, Math.max(1, Number((S.score || {}).maxHunts) || 1));
  try { fs.writeFileSync(path.join(dataDir(), 'forever_max_hunts.txt'), String(mh)); } catch {}
  P.ensureDir(dataDir());
  fs.writeFileSync(f, lines.join('\r\n') + '\r\n');
}

// ------------------------------------------------------------------ the Forever character (fresh mode)
async function checkoutCharacter(season) {
  let r = await api('GET', `/v1/forever/character?season=${encodeURIComponent(season)}`, undefined);
  if (!r.exists) { r = await api('POST', '/v1/forever/character/new', { season }); log(`made your Forever character for ${season}`); }
  const co = await api('POST', '/v1/forever/character/checkout', { season, device: deviceId() });
  character = { season, lease: co.lease, record: co.record };
  // put it under this PC's key in the Forever save; a fresh one (no characters yet) is left to the backend to create
  const keys = ownKeys();
  if (keys.length && Array.isArray(co.record.characters) && co.record.characters.length) {
    const sf = path.join(dataDir(), 'state.json');
    const st = readJson(sf, { players: {} });
    if (!st.players) st.players = {};
    // the game's own save format only: the VPS bookkeeping keys (forever, season) are added back at upload
    const local = Object.assign({}, co.record); delete local.forever; delete local.season; delete local.candidate; delete local.partyId;
    for (const key of keys) if (key !== keys[0]) delete st.players[key];   // one record per account: the feature modules refuse duplicates
    st.players[keys[0]] = Object.assign({}, local, { accountId: accountIdOf(keys[0]) });
    P.ensureDir(dataDir());
    fs.writeFileSync(sf + '.tmp', JSON.stringify(st)); fs.renameSync(sf + '.tmp', sf);
    log('your Forever character is in place');
  }
  S.character = { season, exists: true, fresh: !(co.record.characters || []).length };
  startCheckpoints();
}
// DF-FV-CHECKPOINT (Oct 25): while playing, the character on this PC is also saved on the director every 3 minutes (when
// it changed), so a crash, a lost travel home or a bad world move costs minutes, not the session. The director keeps
// the earlier copies too (DF-FV-HISTORY).
let checkpointTimer = null, lastCheckpoint = '';
function startCheckpoints() { clearInterval(checkpointTimer); lastCheckpoint = ''; checkpointTimer = setInterval(() => { checkpoint().catch(() => {}); }, 3 * 60 * 1000); }
async function checkpoint() {
  if (!character) return;
  // DF-FV-LIVESAVE (Oct 26): the copy on the PC the game plays on right now, through the join proxy (it follows host
  // changes). Before, this read the home copy, which the join window refreshes from the FIRST host only: after a world
  // move, or for a Host Mode host playing in another world, it stopped changing and nothing was saved for half an hour.
  let source = await liveRecord();
  if (!source) { const own = ownForeverRecord(readJson(path.join(dataDir(), 'state.json'), null)); source = own && own.record; }
  if (!source || typeof source !== 'object') return;
  const rec = Object.assign({}, source, { forever: true, season: character.season }); delete rec.candidate; delete rec.partyId;
  if (!Array.isArray(rec.characters) || !rec.characters.length) return;
  const h = crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex');
  if (h === lastCheckpoint) return;
  await api('PUT', '/v1/forever/character', { season: character.season, lease: character.lease, record: rec });
  lastCheckpoint = h;
}
// this player's record on the backend the game is connected to (127.0.0.1:63000 = the join proxy), or null
function liveRecord() {
  const key = ownKey();
  if (!key || !/^[0-9a-f]{32}$/.test(key)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port: 63000, path: '/_travel/' + key, timeout: 10000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(res.statusCode === 200 && j && j.player && Array.isArray(j.player.characters) && j.player.characters.length ? j.player : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
}
async function returnCharacter() {
  if (!character) return;
  clearInterval(checkpointTimer); checkpointTimer = null;
  const c = character; character = null;
  try {
    const st = readJson(path.join(dataDir(), 'state.json'), null);
    const own = ownForeverRecord(st);
    let record = own ? own.record : null;
    if (record && typeof record === 'object') {
      record = Object.assign({}, record, { forever: true, season: c.season });
      delete record.candidate; delete record.partyId;
      await api('POST', '/v1/forever/character/release', { season: c.season, lease: c.lease, record });
      log('your Forever character is saved on the server');
    } else await api('POST', '/v1/forever/character/release', { season: c.season, lease: c.lease });
  } catch (e) { log('could not save your Forever character: ' + e.message, true); }
}
function deviceId() {
  try { return crypto.createHash('sha256').update(require('os').hostname() + '|' + (process.env.USERNAME || '')).digest('hex').slice(0, 16); } catch { return 'pc'; }
}

// a Forever character that has been through character creation (the join guard refuses a fresh one)
function hasCharacter() {
  const own = ownForeverRecord(readJson(path.join(dataDir(), 'state.json'), null));
  return !!(own && Array.isArray(own.record.characters) && own.record.characters.length && own.record.characters.some(c => c && typeof c.data === 'string' && c.data.trim() && c.data.trim() !== 'null'));
}
// solo boot so the player makes their Slayer; when they close the game we carry on into the world
function createCharacter() {
  S.phase = 'creating'; push();
  log('making your Forever character: the game opens on its own for a moment - create your Slayer, then close the game');
  return ctx.runner.runVisible(FV + ':create', 'create', path.join(toolsDir(), 'start.ps1'), [], 'Dauntless Forever - make your Slayer, then close the game', { closeWhenDone: true, env: ENV(), cwd: dir() })
    .then(() => new Promise(r => setTimeout(r, 2500)));   // the backend writes the save as it shuts down
}

// ------------------------------------------------------------------ board data for the host beat
// a server copy's tick rate from its loader log: "HH:MM:SS.mmm alive: tick N" once a minute; 60/s when healthy
function tickRate(port) {
  try {
    const f = path.join(dir(), 'logs', `server_${port}.log`);
    const st = fs.statSync(f); const len = Math.min(st.size, 16384);
    const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    const m = [...b.toString('utf8').matchAll(/^(\d\d):(\d\d):(\d\d)\.(\d{3}) alive: tick (\d+)/gm)].slice(-2);
    if (m.length < 2) return 0;
    const t = (x) => ((Number(x[1]) * 60 + Number(x[2])) * 60 + Number(x[3])) * 1000 + Number(x[4]);
    let dt = t(m[1]) - t(m[0]); if (dt <= 0) dt += 86400000;
    const dn = Number(m[1][5]) - Number(m[0][5]);
    return dt > 20000 && dn > 0 ? Math.round(dn / (dt / 1000)) : 0;
  } catch { return 0; }
}
// is this PC's own game connected to its own town server? (the city server's loader log: "client connections: a -> b")
function ownGameInTown() {
  try {
    const f = path.join(dir(), 'logs', 'server_8780.log');
    const st = fs.statSync(f); const len = Math.min(st.size, 32768);
    const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    const m = [...b.toString('utf8').matchAll(/client connections: \d+ -> (\d+)/g)].pop();
    return !!(m && Number(m[1]) > 0);
  } catch { return false; }
}
function huntsForBeat() {
  const h = readJson(path.join(dataDir(), 'server_hunt.json'), null);
  const list = h ? (Array.isArray(h.list) ? h.list : [h]) : [];
  const w = readJson(path.join(dataDir(), 'wanted.json'), null);
  const wl = w ? (Array.isArray(w.list) ? w.list : [w]) : [];
  return list.filter(e => e && e.id && e.port).map(e => {
    const snap = readJson(path.join(dataDir(), `${(manifest() || {}).snapshot || 'snapshot_'}${e.port}.json`), null);
    const want = wl.find(x => x && x.id === e.id) || {};
    let behemoth = null, players = 0;
    if (snap) {
      const bs = Array.isArray(snap.behemoths) ? snap.behemoths.filter(b => b && !b.isDead) : [];
      if (bs.length) { const fr = bs.map(b => (b.maxHealth > 0 && b.health >= 0) ? b.health / b.maxHealth : null).filter(x => x != null); if (fr.length) behemoth = Math.round(100 * Math.min(...fr)); }
      players = Array.isArray(snap.players) ? snap.players.length : 0;
    }
    const hm = /HuntID=([^?]+)/.exec(String(want.url || ''));
    return { id: e.id, label: want.label || '', huntId: hm ? hm[1] : '', port: e.port, players, cap: 8, behemoth, age: want.at ? Math.max(0, Math.round((Date.now() - Date.parse(want.at)) / 1000)) : 0, tick: tickRate(e.port) };
  });
}
function relayInfo() {
  const st = readJson(path.join(dataDir(), 'relay-1147.json'), null);
  if (st && st.ip && st.base) return { ip: String(st.ip), base: Number(st.base) };
  return null;
}
function joinCode() { try { return fs.readFileSync(path.join(dir(), 'ONLINE-join-code.txt'), 'utf8').trim(); } catch { return ''; } }

// ------------------------------------------------------------------ roles
async function play(mode, worldHost) {
  S.wantWorld = typeof worldHost === 'string' && worldHost ? worldHost : null;   // a chosen world (Join this world on the board)
  if (S.helper && S.phase === 'hosting' && mode === 'fresh') return playAway();   // Host Mode is up: your game goes where the people are (your own world when that is it)
  if (S.phase !== 'off') throw new Error('Forever is already running. Stop it first.');
  const why = missing(); if (why) throw new Error(why);
  // 'helper': host a world for others with no game on this PC (Forever Host Mode); the world is a fresh one
  S.helper = mode === 'helper'; S.helperOnly = mode === 'helper'; S.autoPlay = false;
  S.mode = mode === 'fresh' || mode === 'helper' ? 'fresh' : 'any'; S.error = ''; S.phase = 'asking'; S.role = null; S.world = null; push();
  writeForeverMods();
  try {
    if (S.helper && !(S.score && S.score.score)) throw new Error('Run the host check and send it first: the director only hands worlds to PCs with a score.');
    if (S.mode === 'fresh') {
      await checkoutCharacter(S.season || 'S1');
      // a brand-new Forever character has to be made in game before it can join anyone: the game opens solo once
      if (!hasCharacter()) { await createCharacter(); if (!hasCharacter()) { S.phase = 'off'; await returnCharacter(); throw new Error('Your Forever character was not created. Press Play Forever again and finish character creation, then close the game.'); } }
    }
    await ask();
  } catch (e) { S.phase = 'off'; await returnCharacter(); throw e; }
}
async function ask() {
  const region = (() => { try { return (ctx.social.relayPing() || {}).id || ''; } catch { return ''; } })();
  // data folder \ forever-newworld.txt: start a world of my own instead of joining one (merge testing; a streamer's own world later)
  let newWorld = false; try { newWorld = fs.existsSync(path.join(P.dataRoot(), 'forever-newworld.txt')); } catch {}
  const pings = (() => { try { return ctx.social.relayPings ? ctx.social.relayPings() : {}; } catch { return {}; } })();
  const fv = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir(), 'version.json'), 'utf8').replace(/^\uFEFF/, '')).forever || {}; } catch { return {}; } })();   // DF-FV-VERSIONGATE: the director only lets current installs in
  const r = await api('POST', '/v1/forever/play', { mode: S.mode, region, pings, newWorld: newWorld || !!S.helper, helper: !!S.helper, world: S.wantWorld || undefined, pack: fv.overlay || '', core: fv.core || '' });
  if (r.action === 'update') { S.wantWorld = null; S.phase = 'off'; S.stale = true; await returnCharacter(); push(); throw new Error(r.why || 'Forever has an update. Press Update Forever first.'); }
  S.season = r.season || S.season;
  if (r.action === 'full' || r.action === 'gone') { S.wantWorld = null; S.phase = 'off'; await returnCharacter(); throw new Error((r.why || 'that world is not available') + '. Press Play Forever to join a world with room.'); }
  if (r.action === 'join') { S.world = r.world; await startJoin(r.world); }
  else if (r.action === 'host') { S.helper = true; S.autoPlay = !S.helperOnly; await startHost(r.rules); }   // every Forever host is a Host Mode host: the world runs headless, the player's own game joins it
  else if (r.action === 'needHost') { S.phase = 'needHost'; S.why = r.why || ''; log('nobody can host: ' + S.why); push(); }   // the tab asks the player; forever:checkAndHost or forever:wait continue
  else { S.phase = 'waiting'; S.why = r.why || ''; log('waiting: ' + S.why); push(); timer = setTimeout(() => ask().catch(e => { log(e.message, true); S.phase = 'off'; push(); }), (r.retryIn || 10) * 1000); }
}

async function startJoin(world) {
  S.phase = 'joining'; S.role = 'player'; push();
  gameSince = Date.now();
  log(`joining ${world.hostName}'s world (${world.code})`);
  placeRecord('join');
  const script = path.join(toolsDir(), 'lan-join-1147.ps1');
  ctx.runner.runVisible(FV + ':join', 'join', script, ['-Code', `'${world.code.replace(/'/g, "''")}'`], 'Dauntless Forever - in a world (keep open)', { closeWhenDone: true, env: ENV(), cwd: dir() })
    .then(() => { if (S.phase !== 'off') stop('the game closed'); });
  // the client DLL goes into the game once its window is up (loading screen + travel on a GO)
  ctx.runner.runHidden(FV + ':clientattach', 'attach', coreTool('clientAttach'), ['-Dll', coreBin('client')], (line) => {
    if (/^DFSTATUS ready/.test(line)) { S.clientDll = true; log('this PC is ready to follow a host change'); }
    else if (/^DFSTATUS (nogame|unconfirmed)/.test(line)) { S.clientDll = false; log('this PC may not follow a host change (set-up did not confirm)', true); }
  }, { env: ENV(), cwd: dir() });
  S.phase = 'playing'; push();
  beatLoop();
}

async function startHost(rules) {
  S.phase = 'hosting'; S.role = 'host'; push();
  writeRules(rules);
  log(`hosting a ${S.mode} world (open hunts ${rules && rules.forever_hunts || 8})`);
  placeRecord(S.helper ? 'join' : 'host');
  const script = path.join(toolsDir(), 'online-host-1147.ps1');
  try { fs.unlinkSync(path.join(dataDir(), 'hostmode_stop')); } catch {}
  let run;
  if (S.helper) {
    // a backend left on 64000 by an earlier run (a cut-off move, a crash) would make Host Mode refuse to start: close it first
    if (await backendAlive(63000 + HM_OFFSET)) { log('closing a backend left over from an earlier run'); try { await killStrayBackend(); } catch {} await new Promise(r => setTimeout(r, 1500)); }
    // Forever Host Mode (DF-FOREVER-HM): the world runs with no game window, its backend on 64000 (offset 1000) like a
    // standby's backup, so this PC's own game can join its own world through the join proxy on 63000 - and leave again
    // without taking the world down
    run = ctx.runner.runHidden(FV + ':host', 'host', script, ['-Public', '-HostMode'], (line, isErr) => { if (isErr) log(line.slice(0, 200), true); }, { env: HM_ENV(), cwd: dir() });
    run.then((code) => {
      if (S.phase === 'off' || S.phase === 'stopping') return;
      if (!folding && S.helper && !oldWorldPending) {
        log(`Forever Host Mode exited (code ${code}); check logs\\hostmode.log and logs\\recorder.err.log`, true);
        stop('Host Mode ended').catch(e => log('host cleanup: ' + e.message, true));
      } else if (!S.helper) log('the world this PC hosted is closed');
    });
    startHostHelpers();
    hostStartupReady = false;
    // Director heartbeats must continue during slow startup. Only gate the backend's
    // failure detector, which otherwise closes new Forever hosts after 2 misses.
    hostBeatLoop();
    waitForOwnWorld().then((ok) => {
      if (S.phase !== 'hosting') return;
      if (!ok) {
        log('Forever Host Mode did not finish startup; inspect logs\\hostmode.log and logs\\recorder.err.log', true);
        stop('host startup timed out').catch(e => log('host cleanup: ' + e.message, true));
        return;
      }
      hostStartupReady = true;
      backendMisses = 0;
      log('your Forever backend and city server are ready; health monitoring is active');
      if (S.autoPlay) {
        S.autoPlay = false; push(); log('your world is up: opening your game in it');
        playInOwnWorld().catch(e => log('could not open your game: ' + e.message, true));
      } else log('your world is up: press Play Forever - fresh character to play in it');
    }).catch(e => {
      log('Forever startup check failed: ' + e.message, true);
      if (S.phase === 'hosting') stop('host startup failed').catch(err => log('host cleanup: ' + err.message, true));
    });
    return;
  }
  run = ctx.runner.runVisible(FV + ':host', 'host', script, ['-Public'], 'Dauntless Forever - hosting a world (keep open)', { closeWhenDone: true, env: ENV(), cwd: dir() });   // the window closes by itself when the game ends
  run.then(() => { if (S.phase !== 'off' && !folding) stop('hosting ended'); });
  startHostHelpers();
  hostBeatLoop();
}
// Host Mode host steps down (promotion to a better standby, or a merge into a bigger world): the world's servers close,
// this PC becomes a plain player of its old world, and its own game - a joiner of that world - follows the GO like everyone
async function stepDown(why, targetCode) {
  if (!S.helper || S.phase !== 'hosting') return;
  log(why + ': stepping down; your game follows once the move is ready');
  clearTimeout(hostTimer);
  // a merge: the new host's backend must know everyone from this world (records + session tokens) before they travel
  if (targetCode) { try { await handOverPlayers(targetCode); } catch (e) { log('could not hand the players over to the new host: ' + e.message, true); } }
  try { await api('POST', '/v1/forever/leave', {}); } catch {}   // the director starts the move (merge: the GO is ready; promotion: the standby is told to take over)
  const myId = account && account.id;
  oldWorldPending = true;   // the old world's servers and backend stay up until this PC's game has travelled
  S.helper = false; S.role = 'player'; S.phase = 'playing'; standby = null;
  if (S.away && S.ownGame) { clearTimeout(awayTimer); S.world = { host: S.away.host, hostName: S.away.hostName, players: S.away.players || 0, cap: 8, mode: S.mode }; S.away = null; log('you keep playing where you are'); push(); await shutdownOldWorld(); beatLoop(); return; }
  S.world = { host: myId, hostName: account && account.name, players: 0, cap: 8, mode: S.mode }; push();
  if (!S.ownGame) { log('your game is not open: nothing to follow'); await shutdownOldWorld(); await stop('stepped down'); return; }
  clearTimeout(oldWorldTimer); oldWorldTimer = setTimeout(() => { if (oldWorldPending) { log('no move came in 2 minutes: closing the old world', true); shutdownOldWorld().then(() => stop('stepped down, no move')); } }, 120000);
  beatLoop();
}
let oldWorldPending = false, oldWorldTimer = null;
// signed backend calls (the shared Forever key, same scheme as the standby's pull)
function foreverSecret() { try { return fs.readFileSync(path.join(P.dataRoot(), (manifest() || {}).keyFile || 'forever_key.txt'), 'utf8').trim(); } catch { return ''; } }
const coreRoute = (name) => (((manifest() || {}).routes) || {})[name] || '';   // the core's backend routes come from its manifest
function postSigned(host, port, apiPath, bodyObj, timeoutMs) {
  const body = JSON.stringify(bodyObj), secret = foreverSecret(), t = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(`${t}\nPOST\n${apiPath}\n${body}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host, port, path: apiPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-DF-Time': t, 'X-DF-Sig': sig }, timeout: timeoutMs || 15000 }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (d) => { data += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch {} if (res.statusCode !== 200) reject(new Error(`${res.statusCode} ${(j && (j.reason || j.error)) || data.slice(0, 120)}`)); else resolve(j || {}); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.end(body);
  });
}
async function handOverPlayers(targetCode) {
  const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(String(targetCode || '')); if (!m) throw new Error('no target address');
  if (!coreRoute('pull') || !coreRoute('accept')) throw new Error('the core manifest has no routes');
  const r = await postSigned('127.0.0.1', 63000 + HM_OFFSET, coreRoute('pull'), { key: ownKey(), players: true, all: true }, 10000);
  const seen = new Set(), players = [];
  const take = (p) => { if (p && p.key && !seen.has(p.key)) { seen.add(p.key); players.push({ key: p.key, accountId: p.accountId, record: p.record, token: p.token }); } };
  for (const h of (r.hunts || [])) for (const p of (h.players || [])) take(p);
  for (const p of (r.town || [])) take(p);
  if (!players.length) { log('nobody to hand over'); return; }
  const a = await postSigned(m[1], Number(m[2]), coreRoute('accept'), { players }, 25000);
  log(`handed ${players.length} player record(s) to the new host (${a.town != null ? a.town : '?'} taken)`);
}
async function shutdownOldWorld() {
  if (!oldWorldPending) return;
  oldWorldPending = false; clearTimeout(oldWorldTimer);
  log('closing the world this PC hosted');
  try { fs.writeFileSync(path.join(dataDir(), 'hostmode_stop'), 'step down'); } catch {}
  await new Promise(r => setTimeout(r, 3000));
  for (const id of [':hostattach', ':host']) { try { ctx.runner.killTree(FV + id); } catch {} }
  // the old world's backend and server copies only - never server-1147.ps1 -Stop here: its port cleanup would close the
  // join proxy this PC's game is now using for the new world
  try { await killStrayBackend(); } catch {}
  try { await new Promise((res) => { const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='Dauntless-Win64-Shipping.exe'" | Where-Object { $_.CommandLine -match '(^|\\s)-server(\\s|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, stdio: 'ignore' }); ps.on('exit', res); ps.on('error', res); setTimeout(res, 8000); }); } catch {}
  for (const f of ['server.json', 'server_hunt.json', 'wanted.json']) { try { fs.unlinkSync(path.join(dataDir(), f)); } catch {} }
}
function killStrayBackend() {
  return new Promise((res) => { const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*recorder-1147.js*' -and $_.CommandLine -like '*${dir().replace(/\\/g, '\\\\').replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, stdio: 'ignore' }); ps.on('exit', res); ps.on('error', res); setTimeout(res, 8000); });
}
const HM_OFFSET = 1000;
const HM_ENV = () => Object.assign(ENV(), { RECORDER_LISTEN_OFFSET: String(HM_OFFSET), D1147_BACKEND_OFFSET: String(HM_OFFSET), DF_GATEWAY_TEST_SHIFT: String(HM_OFFSET) });
async function waitForOwnWorld() {
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (S.phase !== 'hosting') return false;
    const code = joinCode();
    if (code && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(code) && await backendAlive(63000 + HM_OFFSET) && readJson(path.join(dataDir(), 'server.json'), null)) return true;
  }
  log('your world did not come up in 3 minutes', true); return false;
}
// Host Mode: Play Forever asks the director like anyone; the game joins the world with people in it (this PC keeps
// hosting its own world underneath) - or its own world when that is the one with room
let awayTimer = null, lastAwayGoAt = 0;
async function playAway() {
  if (!S.helper || S.phase !== 'hosting') throw new Error('Host Mode is not running');
  if (ctx.runner.isRunning(FV + ':ownjoin')) throw new Error('your game is already open');
  const region = (() => { try { return (ctx.social.relayPing() || {}).id || ''; } catch { return ''; } })();
  let newWorld = false; try { newWorld = fs.existsSync(path.join(P.dataRoot(), 'forever-newworld.txt')); } catch {}   // the own-world switch applies here too
  const pings = (() => { try { return ctx.social.relayPings ? ctx.social.relayPings() : {}; } catch { return {}; } })();
  const fv = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir(), 'version.json'), 'utf8').replace(/^\uFEFF/, '')).forever || {}; } catch { return {}; } })();
  const r = await api('POST', '/v1/forever/play', { mode: S.mode, region, pings, newWorld, world: S.wantWorld || undefined, pack: fv.overlay || '', core: fv.core || '' });
  S.wantWorld = null;
  if (r.action === 'update') { S.stale = true; push(); throw new Error(r.why || 'Forever has an update. Stop, press Update Forever, then Play Forever.'); }
  if (r.action === 'full' || r.action === 'gone') throw new Error((r.why || 'that world is not available') + '. Press Play Forever to join a world with room.');
  if (r.action === 'join' && r.world && r.world.host !== (account && account.id)) return startAwayJoin(r.world);
  if (r.action === 'join' && r.world) { try { await api('POST', '/v1/forever/leaveWorld', {}); } catch {} }
  return playInOwnWorld();   // the director put you in your own world, or nobody else is hosting one with room
}
function startAwayJoin(world) {
  placeRecord('join');
  try { fs.unlinkSync(path.join(dataDir(), 'migrate_successor.txt')); } catch {}
  try { fs.unlinkSync(path.join(dataDir(), 'join-failover.txt')); } catch {}
  S.away = { host: world.host, hostName: world.hostName || '', code: world.code }; S.ownGame = true; push();
  log(`opening your game in ${world.hostName}'s world (your own world keeps running here)`);
  ctx.runner.runVisible(FV + ':ownjoin', 'join', path.join(toolsDir(), 'lan-join-1147.ps1'), ['-Code', `'${String(world.code).replace(/'/g, "''")}'`], 'Dauntless Forever - your game (keep open)', { closeWhenDone: true, env: Object.assign(ENV(), { DF_KEEP_OWN: '1' }), cwd: dir() })
    .then(() => { S.ownGame = false; S.away = null; clearTimeout(awayTimer); api('POST', '/v1/forever/leaveWorld', {}).catch(() => {}); if (S.helper && S.phase === 'hosting') log('your game closed; your world keeps running (Play Forever to go back in)'); push(); });
  ctx.runner.runHidden(FV + ':clientattach', 'attach', coreTool('clientAttach'), ['-Dll', coreBin('client')], (line) => {
    if (/^DFSTATUS ready/.test(line)) { S.clientDll = true; log('your game is ready to follow a host change'); }
  }, { env: ENV(), cwd: dir() });
  awayBeatLoop();
}
function awayBeatLoop() {
  clearTimeout(awayTimer);
  const tick = async () => {
    if (!S.away || !S.ownGame || S.phase !== 'hosting') return;
    try {
      const r = await api('POST', '/v1/forever/beat', { world: S.away.host, key: ownKey(), hunt: null });
      if (r.world) S.away = Object.assign({}, S.away, { hostName: r.world.hostName || S.away.hostName, players: r.world.players });
      if (r.go && r.go.at !== lastAwayGoAt) { lastAwayGoAt = r.go.at; await follow(r.go, true); }
      if (!r.role && !r.go) log('the world you were playing in is gone');
    } catch (e) { S.error = 'director: ' + e.message; }
    push();
    awayTimer = setTimeout(tick, BEAT_MS);
  };
  awayTimer = setTimeout(tick, 2000);
}
// Host Mode: this PC's own game joins its own world like any player (join proxy on 63000, switched straight to the local
// backend on 64000). Closing the game leaves the world running; "Play in your world" starts it again.
function playInOwnWorld() {
  if (!S.helper || S.phase !== 'hosting') throw new Error('Host Mode is not running');
  if (ctx.runner.isRunning(FV + ':ownjoin')) throw new Error('your game is already open');
  const code = joinCode();
  if (!code) throw new Error('no join code yet');
  placeRecord('join');
  try { fs.writeFileSync(path.join(dataDir(), 'migrate_successor.txt'), String(HM_OFFSET)); } catch {}
  try { fs.writeFileSync(path.join(dataDir(), 'join-failover.txt'), 'own world'); } catch {}   // the proxy goes local at its first check
  S.ownGame = true; push();
  log('opening your game in your own world');
  // the client core goes into this game too: it follows a GO when the world moves (promotion, merge)
  ctx.runner.runHidden(FV + ':clientattach', 'attach', coreTool('clientAttach'), ['-Dll', coreBin('client')], (line) => {
    if (/^DFSTATUS ready/.test(line)) { S.clientDll = true; log('your game is ready to follow a host change'); }
  }, { env: ENV(), cwd: dir() });
  ctx.runner.runVisible(FV + ':ownjoin', 'join', path.join(toolsDir(), 'lan-join-1147.ps1'), ['-Code', `'${code.replace(/'/g, "''")}'`], 'Dauntless Forever - your game in your world (keep open)', { closeWhenDone: true, env: Object.assign(ENV(), { DF_KEEP_OWN: '1' }), cwd: dir() })
    .then(() => { S.ownGame = false; try { fs.unlinkSync(path.join(dataDir(), 'migrate_successor.txt')); } catch {} if (S.helper && S.phase === 'hosting') log('your game closed; your world keeps running (Play Forever to go back in)'); else if (!S.helper && S.phase !== 'off') stop('the game closed'); push(); });
  return Promise.resolve();
}
function startHostHelpers() {
  ctx.runner.runHidden(FV + ':hostattach', 'attach', coreTool('hostAttach'), ['-Dll', coreBin('server'), '-DataDir', dataDir()], (line) => {
    const m = /^DFSTATUS hunt (\d+)/.exec(line); if (m) log(`hunt server on port ${m[1]} is covered`);
  }, { env: ENV(), cwd: dir() });
}
function backendAlive(port) {
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/_recorder/ping', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
let backendMisses = 0, hostStartupReady = false;
function hostBeatLoop() {
  clearTimeout(hostTimer); backendMisses = 0;
  const tick = async () => {
    if (S.phase !== 'hosting') return;
    // A new Forever host's backend can take minutes to start: don't treat this
    // as a game closing. Keep talking to the director throughout startup.
    if (await backendAlive(standby && standby.adopted ? 64000 : S.helper ? 63000 + HM_OFFSET : 63000)) backendMisses = 0;
    else if ((!S.helper || hostStartupReady) && ++backendMisses >= 3) { stop('backend stopped answering'); return; }
    const code = standby && standby.adopted ? standby.code : joinCode();
    const relay = standby && standby.adopted ? { ip: standby.relayIp, base: standby.relayBase } : relayInfo();
    if (code && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(code)) {
      try {
        const r = await api('POST', '/v1/forever/host', { code, relay, mode: S.mode, hunts: huntsForBeat(), closingIn: S.closingIn || 0, helper: !!S.helper, ownGame: !!(S.helper && S.ownGame && !S.away && (ownGameInTown() || huntsForBeat().some(h => h.players > 0))) });
        if (r.promote) { await stepDown(`${r.promote.name || 'a better PC'} takes the world over (promotion)`); return; }
        if (r.merge && r.merge.world) { if (S.helper) await stepDown(`your world folds into ${r.merge.world.hostName}'s`, r.merge.world.code); else await foldInto(r.merge); return; }
        S.world = r.world; S.standbyName = r.standby ? r.standby.name : ''; S.error = '';
      } catch (e) { S.error = 'director: ' + e.message; }
    }
    push();
    hostTimer = setTimeout(tick, HOST_BEAT_MS);
  };
  hostTimer = setTimeout(tick, 3000);
}

let goneMisses = 0;
function beatLoop() {
  clearTimeout(timer); goneMisses = 0;
  const tick = async () => {
    if (S.phase !== 'playing' && S.phase !== 'standby' && S.phase !== 'moving') return;
    try {
      const body = { world: S.world ? S.world.host : undefined, key: ownKey(), hunt: null };
      if (standby) body.standby = { prewarmed: standby.prewarmed, ready: standby.ready, backendUp: !!standby.backendUp, huntPort: standby.huntPort, adopted: standby.adopted, relay: standby.relayIp ? { ip: standby.relayIp, base: standby.relayBase } : null, code: standby.code, udpBase: UDP_BASE,
        hunts: Object.entries(standby.hunts || {}).map(([id, h]) => ({ id, port: h.port, ready: h.ready, keys: h.keys || [] })) };
      const r = await api('POST', '/v1/forever/beat', body);
      S.error = '';
      if (r.world) S.world = r.world;
      if (r.hostClosing) S.hostClosing = r.hostClosing; else S.hostClosing = null;
      S.noStandby = !!r.noStandby;
      if (r.role === 'standby' && S.role !== 'standby') await becomeStandby(r.pullFrom);
      if (r.takeover && standby && !standby.adopted && !standby.takeoverAsked) { standby.takeoverAsked = true; log('the director asks this PC to take the world over (promotion)'); try { fs.writeFileSync(path.join(dataDir(), 'forever_takeover.txt'), 'now'); } catch {} }
      if (r.role === 'host' && standby && standby.adopted) { becomeHost(); return; }
      if (r.go && r.go.at !== lastGoAt && !(standby && standby.adopted)) { lastGoAt = r.go.at; await follow(r.go); }
      if (!r.role && !r.go) { if (++goneMisses >= 3) { log('the world is gone'); stop('the world ended'); return; } } else goneMisses = 0;
    } catch (e) { S.error = 'director: ' + e.message; }
    push();
    timer = setTimeout(tick, BEAT_MS);
  };
  timer = setTimeout(tick, 2000);
}

// elected: connect this PC's own relay slot first (so the backup backend hands out reachable addresses), then run the
// standby flow: it follows the host's hunt through the join already up on 63000
async function becomeStandby(pullFrom) {
  S.role = 'standby'; S.phase = 'standby'; push();
  log(`you are the standby for this world: pre-warming the hunt from ${pullFrom ? pullFrom.code : 'the host'}`);
  standby = { relayIp: '', relayBase: 0, code: '', prewarmed: false, ready: false, huntPort: 0, adopted: false, hunts: {} };
  try { await connectOwnRelay(); } catch (e) { log('relay for the standby: ' + e.message, true); }
  const share = Math.max(1, Math.min(8, Number((S.score || {}).maxHunts) || 1));   // how many hunts this PC keeps a copy of
  const args = ['-Dll', coreBin('server'), '-MaxHunts', String(share)];
  if (standby.relayIp) args.push('-PublicHost', standby.relayIp, '-PublicOffset', String(standby.relayBase - UDP_BASE), '-PublicBackendPort', String(standby.relayBase));
  const sbLog = path.join(dir(), 'logs', 'standby.log'); try { P.ensureDir(path.dirname(sbLog)); fs.writeFileSync(sbLog, `--- standby started ${new Date().toISOString()} args ${args.join(' ')}\r\n`); } catch {}
  ctx.runner.runHidden(FV + ':standby', 'standby', coreTool('standby'), args, (line, isErr) => {
    let m;
    try { fs.appendFileSync(sbLog, (isErr ? 'ERR ' : '') + line + '\r\n'); } catch {}
    if (/^DFSTATUS backend up/.test(line)) { standby.backendUp = true; log('backup backend and town are up on this PC'); push(); }
    else if ((m = /^DFSTATUS prewarmed (\d+)/.exec(line))) { standby.prewarmed = true; standby.huntPort = Number(m[1]); log('backup hunt is up on this PC'); }
    else if ((m = /^DFSTATUS ready (\d+)/.exec(line))) { standby.ready = true; standby.huntPort = Number(m[1]); log('backup hunt is ready to take over'); }
    else if ((m = /^DFSTATUS cover (\S+) warm$/.exec(line))) { standby.hunts[m[1]] = { port: 0, ready: false, keys: [] }; push(); }
    else if ((m = /^DFSTATUS cover (\S+) ready (\d+)/.exec(line))) { standby.hunts[m[1]] = Object.assign(standby.hunts[m[1]] || { keys: [] }, { port: Number(m[2]), ready: true }); log(`backup copy ready (${Object.values(standby.hunts).filter(h => h.ready).length} hunt(s) covered)`); push(); }
    else if ((m = /^DFSTATUS covered (\S+) (\d+) ?(.*)$/.exec(line))) { standby.hunts[m[1]] = { port: Number(m[2]), ready: true, keys: (m[3] || '').split(',').filter(Boolean) }; }
    else if (/^DFSTATUS handoff/.test(line)) { log('the host left: taking over'); S.phase = 'moving'; push(); }
    else if ((m = /^DFSTATUS adopted (\d+)/.exec(line))) { standby.adopted = true; standby.huntPort = Number(m[1]); log('this PC now runs the hunt; telling everyone where it is'); }
    else if (isErr) log(line.slice(0, 200), true);
  }, { env: ENV(), cwd: dir() }).then((code) => { try { fs.appendFileSync(sbLog, `--- standby ended, exit code ${code}\r\n`); } catch {} if (standby && !standby.adopted && S.phase !== 'off') { log('the standby stopped (' + code + ') - see logs\\standby.log', true); S.role = 'player'; S.phase = 'playing'; standby = null; push(); } });
}
// a gateway shifted to the backup backend (64000-64027) + a relay slot of this PC's own: the address the others get
async function connectOwnRelay() {
  const node = await ctx.nodeFor();
  if (!node) throw new Error('node.exe not found');
  const logDir = path.join(dir(), 'logs'); P.ensureDir(logDir);
  const status = path.join(dataDir(), 'relay-forever-standby.json');
  try { fs.unlinkSync(status); } catch {}
  const env = Object.assign({}, process.env, { DF_GATEWAY_PORT: '63098', DF_GATEWAY_TEST_SHIFT: '1000' });
  const gw = spawn(node, [path.join(toolsDir(), 'df-gateway-1147.js')], { cwd: dir(), env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(logDir, 'gateway-standby.log'), 'a'), fs.openSync(path.join(logDir, 'gateway-standby.err'), 'a')] });
  const net = ctx.social.getNetwork();
  const list = (Array.isArray(net.relays) && net.relays.length ? net.relays : [net.relay]).filter(r => r && r.host);
  const bestId = (() => { try { return (ctx.social.relayPing() || {}).id; } catch { return null; } })();
  const relay = list.find(r => String(r.id || r.name || r.host) === bestId) || list[0];
  const envR = Object.assign({}, process.env, { LOCAL_BACKEND_PORT: '63098', LOCAL_GAME_PORT_BASE: String(UDP_BASE), RELAY_STATUS_FILE: status });
  const rc = spawn(node, [path.join(toolsDir(), 'relay-client.js'), relay.host, String(relay.controlPort || 7000), status], { cwd: dir(), env: envR, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(logDir, 'relay-standby.log'), 'a'), fs.openSync(path.join(logDir, 'relay-standby.err'), 'a')] });
  standby.procs = [gw, rc];
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const st = readJson(status, null);
    if (st && st.ip && st.base) { standby.relayIp = String(st.ip); standby.relayBase = Number(st.base); standby.code = `${st.ip}:${st.base}`; log(`this PC's own relay address: ${standby.code}`); return; }
  }
  throw new Error('the relay did not answer in 20 s');
}
// the director folded this world into a bigger one: the players in it travel there on their own (GO); this PC's own game
// is tied to its own backend, so it closes and comes back as a player in the other world (one trip through the menu)
let folding = false;
async function foldInto(mg) {
  if (folding) return;
  folding = true;
  const w = mg.world;
  log(`your world folds into ${w.hostName}'s (${w.players}/${w.cap}): your game restarts there`);
  S.phase = 'moving'; push(); clearTimeout(hostTimer);
  for (const id of [':hostattach', ':host']) { try { ctx.runner.killTree(FV + id); } catch {} }
  try {
    await new Promise((res) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir(), 'server-1147.ps1'), '-Stop'], { cwd: dir(), env: Object.assign({}, process.env, ENV()), windowsHide: true, stdio: 'ignore' });
      ps.on('exit', res); ps.on('error', res); setTimeout(res, 15000);
    });
  } catch {}
  await new Promise(r => setTimeout(r, 3000));   // the backend writes the save as it shuts down
  standby = null; S.standbyName = ''; S.world = w;
  folding = false;
  await startJoin(w);
}
function becomeHost() {
  S.role = 'host'; S.phase = 'hosting'; S.world = null; hostStartupReady = true; push();   // an adopted world is already up: its health checks count from now
  log('this PC hosts the world now');
  startHostHelpers();
  clearTimeout(timer);
  hostBeatLoop();
}
// the GO: the hunt moved to another PC; point the join at it, then the client DLL travels the game there
async function follow(go, away) {
  if (!away) { S.phase = 'moving'; push(); }
  log(go.merge ? `your world merged into ${go.newHostName || 'another'}'s: travelling to their town (${go.address})` : `the world moved to ${go.newHostName || 'another PC'}: following to ${go.address}`);
  // a standby of the old world has nothing to stand by for any more; the new world elects its own
  if (standby && !standby.adopted) { if (standby.procs) for (const p of standby.procs) { try { p.kill(); } catch {} } try { ctx.runner.killTree(FV + ':standby'); } catch {} standby = null; S.role = 'player'; }
  try {
    const node = await ctx.nodeFor();
    const [ip, port] = String(go.code).split(':');
    // the join proxy that lan-join started points at the old host; restart it at the new one (the game keeps running)
    await new Promise((res) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*join-proxy-1147.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', res); ps.on('error', res);
    });
    const logDir = path.join(dir(), 'logs'); P.ensureDir(logDir);
    const jp = spawn(node, [path.join(toolsDir(), 'join-proxy-1147.js'), ip, port, path.join(dataDir(), 'join-proxy.json')], { cwd: dir(), env: process.env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(logDir, 'join-proxy.log'), 'a'), fs.openSync(path.join(logDir, 'join-proxy.err'), 'a')] });
    jp.unref();
    await new Promise(r => setTimeout(r, 1500));
    fs.writeFileSync(path.join(dataDir(), (manifest() || {}).goFile || 'client_go.txt'), go.address);
    log('told your game to travel');
  } catch (e) { log('could not follow the world: ' + e.message, true); }
  if (oldWorldPending) setTimeout(() => { shutdownOldWorld().catch(() => {}); }, 15000);
  if (away) { S.away = { host: go.newHost, hostName: go.newHostName || '', code: go.code }; push(); return; }
  // from now on this PC beats against the new world (its host id); the next beat fills in the rest
  S.world = Object.assign({}, S.world || {}, { host: go.newHost, hostName: go.newHostName || '', code: go.code }); S.role = 'player'; S.phase = 'playing'; push();
}

// ------------------------------------------------------------------ stop
async function stop(why) {
  if (S.phase === 'off' || S.phase === 'stopping') return;
  const wasHost = S.role === 'host', hadOldWorld = oldWorldPending;
  S.phase = 'stopping'; push();
  clearTimeout(timer); clearTimeout(hostTimer);
  try { fs.writeFileSync(path.join(dataDir(), 'forever_stop'), why || 'stop'); } catch {}
  if (S.helper || oldWorldPending) { oldWorldPending = false; clearTimeout(oldWorldTimer); try { fs.writeFileSync(path.join(dataDir(), 'hostmode_stop'), 'stop'); } catch {} await new Promise(r => setTimeout(r, 4000)); }   // Host Mode shuts its backend down cleanly first
  for (const id of [':clientattach', ':hostattach', ':standby', ':join', ':ownjoin', ':host', ':create']) { try { ctx.runner.killTree(FV + id); } catch {} }
  try { fs.unlinkSync(path.join(dataDir(), 'migrate_successor.txt')); } catch {}
  if ((wasHost && S.helper) || hadOldWorld) {   // Host Mode's backend (64000) is not a child of anything we kill: close it by name
    try { await new Promise((res) => { const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*recorder-1147.js*' -and $_.CommandLine -like '*${dir().replace(/\\/g, '\\\\').replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, stdio: 'ignore' }); ps.on('exit', res); ps.on('error', res); setTimeout(res, 8000); }); } catch {}
  }
  if (standby && standby.procs) for (const p of standby.procs) { try { p.kill(); } catch {} }
  try {
    await new Promise((res) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir(), 'server-1147.ps1'), '-Stop'], { cwd: dir(), env: Object.assign({}, process.env, ENV()), windowsHide: true, stdio: 'ignore' });
      ps.on('exit', res); ps.on('error', res); setTimeout(res, 15000);
    });
  } catch {}
  try { await api('POST', '/v1/forever/leave', {}); } catch {}
  await returnCharacter();
  standby = null; S.role = null; S.world = null; S.hostClosing = null; S.phase = 'off'; S.why = ''; S.helper = false; S.helperOnly = false; S.autoPlay = false; S.ownGame = false; S.away = null; clearTimeout(awayTimer);
  log('stopped' + (why ? ' (' + why + ')' : ''));
  push();
}

// ------------------------------------------------------------------ the opt-in host check
function runHostCheck() {
  return new Promise((resolve) => {
    const net = ctx.social.getNetwork();
    const relays = ((Array.isArray(net.relays) && net.relays.length ? net.relays : [net.relay]) || []).map(r => r && r.host).filter(Boolean).join(',');
    let out = null;
    ctx.runner.runHidden(FV + ':check', 'check', coreTool('check'), relays ? ['-Relays', relays] : [], (line) => {
      const m = /^DFJSON (.+)$/.exec(line.trim()); if (m) { try { out = JSON.parse(m[1]); } catch {} }
    }).then(() => resolve(out));
  });
}

// ------------------------------------------------------------------ the Forever install: built here, never downloaded as a game
// versions\forever = the installed 1.14.7 package (same game folder) + the Forever overlay (patched backend and tools)
// + the Forever core pack, both from the service. The save (data\state.json) is never touched.
const SETUP_COPY_DIRS = ['backend', 'tools', 'bin', 'eos', 'eos_lan', 'eos_srv', 'eos_srv1', 'eos_srv2', 'captures', 'profile', 'seasons', 'source', 'srvhome', 'srvhome1', 'srvhome2', 'upload'];
const SETUP_COPY_DATA = ['hunts_1147.json', 'network.json', 'progression'];
// Forever is standard rules on every PC: no UE4SS, no Boss Health Bar, no spare trial server (written at setup and on every Play)
function writeForeverMods() {
  try { P.ensureDir(dataDir()); fs.writeFileSync(path.join(dataDir(), 'mods.txt'), '# Forever mode: Modded mode is always off here (standard rules for everyone).\r\nmods=off\r\nservers=off\r\nbossbar=off\r\ntrialsretry=off\r\n'); } catch {}
}
let setupState = null;   // { step, error }
function copyTree(src, dst) {
  if (!exists(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    // DF-FV-SETUPEPERM (Oct 26): the server copies' private homes (srvhome*) hold Windows' own protected caches
    // (AppData\Local\Microsoft\Windows\INetCache\Content.IE5 and friends). They are not part of the install and cannot
    // be listed: skip them, and skip any other folder Windows refuses to list instead of failing the whole set-up.
    if (/[\\/]AppData[\\/]Local[\\/]Microsoft([\\/]|$)/i.test(src) || /^(INetCache|INetCookies|WebCache|Content\.IE5)$/i.test(path.basename(src))) return;
    let names;
    try { names = fs.readdirSync(src); } catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') { log('skipped (no access): ' + path.basename(src)); return; } throw e; }
    P.ensureDir(dst); for (const n of names) copyTree(path.join(src, n), path.join(dst, n));
  }
  else {
    P.ensureDir(path.dirname(dst));
    // a log a running server copy still holds (EBUSY) or a lock file is not part of the install: skipped, not fatal
    try { fs.copyFileSync(src, dst); } catch (e) { if (/\.(log|lock|tmp)$/i.test(src) || /[\\/](Logs|Saved[\\/]Logs)[\\/]/i.test(src) || e.code === 'EBUSY') log('skipped (in use): ' + path.basename(src)); else throw e; }
  }
}
// DF-FV-DLRETRY (Oct 25): a busy director (everyone updating at once) can cut a download short: try 3 times
async function download(name, to, sha256) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await downloadOnce(name, to, sha256); }
    catch (e) { last = e; log(`${name}: download try ${i + 1} failed (${e.message})${i < 2 ? ', trying again' : ''}`, true); await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw last;
}
const WRAP_KEY = Buffer.from('DauntlessForever-core-wrap-v1:not-a-secret-just-not-a-zip-on-the-wire');
function downloadOnce(name, to, sha256) {
  return new Promise((resolve, reject) => {
    const base = directorBase(); const url = new URL('/v1/forever/files/' + name, base + '/');
    const time = Date.now();
    const headers = { 'X-DF-Id': account.id, 'X-DF-Time': String(time), 'X-DF-Sig': crypto.createHmac('sha256', account.secret).update(`${time}\nGET\n${url.pathname}\n`).digest('hex') };
    headers['X-DF-Wrap'] = 'xor1';   // DF-FV-WRAP: the director may send the zip XOR-ed so download scanners leave it alone
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(url, { headers, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${name}: HTTP ${res.statusCode}`)); }
      P.ensureDir(path.dirname(to));
      // DF-FV-DLSAFE (Oct 25): each try writes its own part file, and nothing here can throw outside the promise (an
      // antivirus that deletes or changes the file mid-download used to crash the launcher with ENOENT on the rename)
      const part = `${to}.${process.pid}-${Date.now()}.part`;
      const h = crypto.createHash('sha256'); const out = fs.createWriteStream(part);
      const AV = ' - if this keeps happening, your antivirus (or a "web protection" / "web shield" feature) is changing or removing the Forever files: allow them, or add the DauntlessForever folder as an exception';
      const wrapped = String(res.headers['x-df-wrapped'] || '') === 'xor1';
      let pos = 0;
      const unwrap = (d) => { if (!wrapped) return d; const o = Buffer.allocUnsafe(d.length); for (let i = 0; i < d.length; i++) o[i] = d[i] ^ WRAP_KEY[(pos + i) % WRAP_KEY.length]; pos += d.length; return o; };
      res.on('data', (d) => { const p = unwrap(d); h.update(p); if (!out.write(p)) { res.pause(); out.once('drain', () => res.resume()); } });
      res.on('end', () => out.end());
      res.on('aborted', () => { out.destroy(); reject(new Error(`${name}: the download was cut off`)); });
      out.on('finish', () => {
        const got = h.digest('hex');
        if (sha256 && got !== sha256) { try { fs.unlinkSync(part); } catch {} return reject(new Error(`${name}: the download did not match (checksum)` + AV)); }
        try { fs.renameSync(part, to); resolve(to); } catch (e) { try { fs.unlinkSync(part); } catch {} reject(new Error(`${name}: the downloaded file disappeared (${e.code || e.message})` + AV)); }
      });
      out.on('error', (e) => reject(new Error(`${name}: could not write the download (${e.code || e.message})` + AV)));
    });
    req.on('timeout', () => req.destroy(new Error(name + ': timed out'))); req.on('error', reject);
  });
}
function unzip(zipFile, into) {
  // Windows 10 ships bsdtar as tar.exe, which reads zip files; no extra module needed
  return new Promise((resolve, reject) => {
    P.ensureDir(into);
    const t = spawn('tar.exe', ['-xf', zipFile, '-C', into], { windowsHide: true, stdio: 'ignore' });
    t.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`could not unpack ${path.basename(zipFile)} (tar exit ${code})`)));
    t.on('error', reject);
  });
}
// DF-FV-MORE / DF-FV-SETUPCLEAN (Oct 26, Magpie: "could not unpack forever-core.zip (tar exit 1)"): programs still running
// from versions\forever (a backend, a backup server, a server copy with the core DLL in it) keep files locked, so the
// update cannot replace them. Closes them; only ever called while Forever is off on this PC.
async function killLeftovers() {
  const d = dir().replace(/'/g, "''");
  let n = 0;
  await new Promise((res) => { try { const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `$n = 0; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and (($_.CommandLine -and $_.CommandLine.IndexOf('${d}', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('${d}', [StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -eq 'Dauntless-Win64-Shipping.exe' -and $_.CommandLine -match '(^|\s)-server(\s|$)')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $n++ } catch {} }; Write-Output $n`], { windowsHide: true }); let out = ''; ps.stdout.on('data', (b) => { out += b; }); ps.on('exit', () => { n = parseInt(out, 10) || 0; res(); }); ps.on('error', res); setTimeout(res, 15000); } catch { res(); } });
  if (n) { log('closed ' + n + ' leftover Forever program(s)'); await new Promise((r) => setTimeout(r, 1500)); }
  return n;
}
async function setup(progress) {
  const say = (step) => { setupState = { step, error: '' }; if (progress) progress(step); push(); };
  const src = path.join(P.versionsDataDir(), '1.14.7');
  if (!exists(path.join(src, 'config.json')) || !exists(path.join(src, 'tools', 'start.ps1'))) throw new Error('Dauntless 1.14.7 is not set up on this PC yet. Download it on the Play page and let set-up finish first.');
  await ensureAccount();
  say('reading the file list from the server');
  const list = await api('GET', '/v1/forever/files', undefined);
  const want = (n) => (list.files || []).find(f => f.name === n);
  if (!want('forever-overlay.zip') || !want('forever-core.zip')) throw new Error('the Forever files are not on the server yet');
  const d = dir();
  say('copying the 1.14.7 files');
  P.ensureDir(d);
  for (const n of SETUP_COPY_DIRS) copyTree(path.join(src, n), path.join(d, n));
  for (const n of fs.readdirSync(src)) if (/\.(bat|json|txt)$/i.test(n) && n !== 'version.json' && n !== '.package-version') { try { fs.copyFileSync(path.join(src, n), path.join(d, n)); } catch {} }
  P.ensureDir(dataDir()); for (const n of ['logs', 'home', 'backup']) P.ensureDir(path.join(d, n));
  for (const n of SETUP_COPY_DATA) copyTree(path.join(src, 'data', n), path.join(dataDir(), n));
  writeForeverMods();
  // this PC's game folder and node, as 1.14.7 found them
  try { fs.copyFileSync(path.join(src, 'config.json'), path.join(d, 'config.json')); } catch {}
  const tmp = path.join(d, 'setup-tmp'); P.ensureDir(tmp);
  say('downloading the Forever files');
  const ov = want('forever-overlay.zip'), ds = want('forever-core.zip');
  await download('forever-overlay.zip', path.join(tmp, 'forever-overlay.zip'), ov.sha256);
  await download('forever-core.zip', path.join(tmp, 'forever-core.zip'), ds.sha256);
  say('closing anything Forever left running');
  await killLeftovers();   // DF-FV-SETUPCLEAN: locked files made tar fail (exit 1)
  say('unpacking');
  await unzip(path.join(tmp, 'forever-overlay.zip'), d);          // backend\, tools\, rules.json over the package copies
  await unzip(path.join(tmp, 'forever-core.zip'), coreDir());
  M = null;   // the manifest comes from the new pack
  P.ensureDir(path.join(coreDir(), 'bin', 'logs'));
  // version.json: the id this folder answers to; the package version it was built from
  let v = {}; try { v = JSON.parse(fs.readFileSync(path.join(src, 'version.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
  v.id = FV; v.name = 'Dauntless Forever (1.14.7 Forever mode)';
  v.forever = { base: '1.14.7', builtFrom: (() => { try { return fs.readFileSync(path.join(src, '.package-version'), 'utf8').trim(); } catch { return ''; } })(), overlay: ov.sha256.slice(0, 12), core: ds.sha256.slice(0, 12), at: new Date().toISOString() };
  fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify(v, null, 2));
  writeRules({ forever_hunts: 8 });
  // the shared key the PCs in a world sign their messages to each other with
  try { const r = await api('GET', '/v1/forever/secret', undefined); if (r && r.secret) fs.writeFileSync(path.join(P.dataRoot(), (manifest() || {}).keyFile || 'forever_key.txt'), r.secret); }
  catch (e) { log('could not fetch the Forever key (the server may be older than this launcher): ' + e.message, true); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  say('done');
  setupState = null;
  log('Forever is set up on this PC (from 1.14.7 ' + (v.forever.builtFrom || '') + ')');
  return true;
}
// is the install older than what the server offers? (the packs' checksums differ)
async function setupStale() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir(), 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
    const list = await api('GET', '/v1/forever/files', undefined);
    const f = (n) => ((list.files || []).find(x => x.name === n) || {}).sha256 || '';
    // also stale when the installed 1.14.7 package moved on (loader, bin, captures...): the Forever install is built from it
    let pkgNow = ''; try { pkgNow = fs.readFileSync(path.join(P.versionsDataDir(), '1.14.7', '.package-version'), 'utf8').trim(); } catch {}
    return !!(v.forever && (f('forever-overlay.zip').slice(0, 12) !== v.forever.overlay || f('forever-core.zip').slice(0, 12) !== v.forever.core || (pkgNow && v.forever.builtFrom && pkgNow !== v.forever.builtFrom)));
  } catch { return false; }
}

// ------------------------------------------------------------------ access (the VPS decides who sees the tab) + the character cards
let accessTimer = null;
async function checkAccess() {
  try {
    // a developer's PC: a file named forever-unlock.txt in the launcher's data folder shows the tab without the VPS
    if (exists(path.join(P.dataRoot(), 'forever-unlock.txt'))) S.allowed = true;
    else if (ctx.social.offlineMode()) { S.allowed = false; }
    else { const r = await api('GET', '/v1/forever/access', undefined); S.allowed = !!r.allowed; S.season = r.season || S.season; }
    S.accessError = '';
    if (S.allowed && installed()) S.stale = await setupStale();
  } catch (e) {   // keep the last answer; DF-FV-ACCESSLOG (Oct 26): say why once, so Check Forever and the logs show it
    const why = (e && (e.status ? 'HTTP ' + e.status + ': ' : '') + (e.message || String(e))) || 'unknown error';
    if (why !== S.accessError) log('could not ask the Forever server whether the tab is open: ' + why, true);
    S.accessError = why;
  }
  push();
  // while this launcher is not allowed yet, look again soon (someone may be adding it right now)
  clearTimeout(accessTimer); accessTimer = setTimeout(checkAccess, S.allowed ? 5 * 60 * 1000 : 30 * 1000);
}
// a few facts about a player record, the way the Slayer copy page shows them, plus the gear score
const WT = { SW: 'Sword', AX: 'Axe', HM: 'Hammer', CB: 'ChainBlades', DP: 'Repeaters', AC: 'Strikers', SP: 'Spear', IH: 'Spear', ST: 'Strikers' };
const CELL_RANK = { UC: 1, R: 2, E: 3 };
function summarize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const acc = Object.keys(rec.inventory || {})[0] || Object.keys(rec.progress || {})[0] || null;
  const inv = acc && rec.inventory ? rec.inventory[acc] : null;
  const tracks = (acc && rec.progress && rec.progress[acc] && rec.progress[acc].tracks) || (rec.progress && rec.progress.tracks) || {};
  const rank = (k) => (tracks[k] && Number(tracks[k].confirmed_fremium_rank)) || 0;
  const level = rank('ExperienceTrack_PlayerLevel'), mastery = rank('MasteryTrack_PlayerLevel');
  const l20 = Object.keys(tracks).filter(k => /^ExperienceTrack_Weapon_/.test(k) && rank(k) >= 20).length;
  const reforges = Object.keys(tracks).filter(k => /^ExperienceTrack_Weapon_/.test(k) && tracks[k].reforgedXp).length;
  const gear = inv && Array.isArray(inv.instancedItems) ? inv.instancedItems.filter(i => /^(WP|AR|LT)_/.test(String(i.catalogId || ''))).length : 0;
  const cosmetics = inv && Array.isArray(inv.instancedItems) ? inv.instancedItems.filter(i => !/^(WP|AR|LT)_/.test(String(i.catalogId || ''))).length : 0;
  // gear score: slayer level*4 + weapon level*10 + reforged 50 + cell ranks*15 + omnicell 50 + legendary part 50
  let score = 0, weapon = '';
  try {
    const lo = acc && rec.loadouts && rec.loadouts[acc]; const L = lo && lo.loadouts && lo.loadouts[lo.active_index || 0];
    if (L) {
      const wid = String((L.weapon || {}).instance_id || ''); weapon = wid;
      const wt = wid.startsWith('WP_') ? (WT[wid.split('_')[1]] || '') : '';
      const wl = wt ? rank('ExperienceTrack_Weapon_' + wt) : 0;
      const ref = wt && tracks['ExperienceTrack_Weapon_' + wt] && tracks['ExperienceTrack_Weapon_' + wt].reforgedXp ? 1 : 0;
      let cells = 0, leg = false;
      for (const slot of ['weapon', 'helmet', 'chest', 'arms', 'legs', 'lantern']) {
        let d = null; try { d = JSON.parse(L[slot].instance_data); } catch { continue; }
        for (const c of (d.EquippedCells || [])) cells += CELL_RANK[String(c.CellID || '').split('_').pop()] || 0;
        if (slot === 'weapon') for (const m of (d.SubTypeMetadataArray || [])) for (const q of (m.EquippedItemParts || [])) if (/LEGENDARY/.test(String(q.WeaponPartId || ''))) leg = true;
      }
      const omni = L.player_role && L.player_role.instance_id ? 1 : 0;
      score = level * 4 + wl * 10 + ref * 50 + cells * 15 + omni * 50 + (leg ? 50 : 0);
    }
  } catch {}
  const name = (Array.isArray(rec.characters) && rec.characters[0] && rec.characters[0].name) || rec.username || 'Slayer';
  return { name, created: !!(Array.isArray(rec.characters) && rec.characters.length), level, mastery, l20, reforges, gear, cosmetics, score, weapon, lastPlayed: rec.travelledIn || rec.updated || null };
}
function ownRecord1147() {
  const v = path.join(P.versionsDataDir(), '1.14.7');
  const st = readJson(path.join(v, 'data', 'state.json'), null);
  if (!st || !st.players) return null;
  const keys = [];
  for (const ini of [path.join(v, 'eos', 'eos_offline.ini'), path.join(v, 'eos_lan', 'eos_offline.ini')]) {
    try { const m = /^\s*EpicAccountId\s*=\s*(\S+)/m.exec(fs.readFileSync(ini, 'utf8')); if (m) keys.push(crypto.createHash('sha256').update('epic:' + m[1]).digest('hex').slice(0, 32)); } catch {}
  }
  if (st.lastPlayer) keys.push(st.lastPlayer);
  let best = null;
  for (const k of keys) { const r = st.players[k]; if (r && (!best || (r.characters || []).length > (best.characters || []).length)) best = r; }
  return best;
}
async function cards() {
  const out = { fresh: null, own: summarize(ownRecord1147()), season: S.season || 'S1' };
  try { const r = await api('GET', `/v1/forever/character?season=${encodeURIComponent(S.season || 'S1')}`, undefined); out.fresh = r.exists ? Object.assign({ exists: true }, summarize(r.record) || {}) : { exists: false }; }
  catch (e) { out.fresh = { exists: false, error: e.message }; }
  // while this PC plays, the Forever save on disk is newer than the server's copy (it goes up on Stop)
  if (S.phase !== 'off' && S.mode === 'fresh') {
    const own = ownForeverRecord(readJson(path.join(dataDir(), 'state.json'), null));
    if (own && (own.record.characters || []).length) out.fresh = Object.assign({ exists: true, local: true }, summarize(own.record) || {});
  }
  S.cards = out; push();
  return out;
}

// ------------------------------------------------------------------ state + IPC
function publicState() {
  return { allowed: !!S.allowed, accessError: S.accessError || '', setup: setupState, stale: !!S.stale, cards: S.cards || null, phase: S.phase, mode: S.mode, role: S.role, world: S.world, why: S.why || '', error: S.error || '', season: S.season || 'S1',
    standbyName: S.standbyName || '', standby: standby ? { prewarmed: standby.prewarmed, ready: standby.ready, adopted: standby.adopted, code: standby.code } : null,
    hostClosing: S.hostClosing || null, noStandby: !!S.noStandby, character: S.character || null, clientDll: !!S.clientDll, missing: missing(), score: S.score || null, check: S.check || null, board: S.board || null, leaderboard: S.leaderboard || null, helper: !!S.helper, autoPlay: !!S.autoPlay, ownGame: !!S.ownGame, away: S.away || null, pings: (() => { try { return ctx.social.relayPings ? ctx.social.relayPings() : {}; } catch { return {}; } })(), log: logLines.slice(-60) };
}
function init(c) {
  ctx = c;
  S = { phase: 'off', mode: 'fresh', role: null, world: null, season: 'S1', allowed: false };
  setTimeout(checkAccess, 4000);   // after the Friends sign-in and network.json are up
  ipcMain.handle('forever:state', () => publicState());
  ipcMain.handle('forever:play', async (_e, mode, worldHost) => { try { await play(mode, worldHost); return { ok: true }; } catch (e) { S.error = e.message; push(); return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:stop', async () => { await stop('stopped by you'); return { ok: true }; });
  ipcMain.handle('forever:playOwn', async () => { try { await playInOwnWorld(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:leaderboard', async () => { try { S.leaderboard = await api('GET', '/v1/forever/leaderboard', undefined); push(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:board', async () => { try { S.board = await api('GET', '/v1/forever/board', undefined); S.score = { score: S.board.score, maxHunts: S.board.maxHunts, canHost: S.board.canHost, maxHuntsChecked: S.board.maxHuntsChecked || 0, hitchAt: S.board.hitchAt || 0 }; push(); return { ok: true, board: S.board }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:check', async () => { S.check = { running: true }; push(); const r = await runHostCheck(); S.check = r ? Object.assign({ running: false, at: Date.now() }, r) : { running: false, failed: true }; push(); return S.check; });
  ipcMain.handle('forever:sendScore', async () => {
    const c = S.check; if (!c || c.running || c.failed) return { ok: false, error: 'run the check first' };
    try { const r = await api('POST', '/v1/forever/score', { score: c.score, maxHunts: c.maxHunts, numbers: { cpu: c.cpu, threads: c.threads, ramGB: c.ramGB, upload: c.upload, relay: c.bestRelay, parts: c.parts } }); S.score = { score: r.score, maxHunts: r.maxHunts, canHost: true }; push(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('forever:clearScore', async () => { try { await api('POST', '/v1/forever/score', { clear: true }); S.score = null; push(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  // needHost: the player chose to run the check and host (sends the score, then asks the director again) or to wait
  ipcMain.handle('forever:checkAndHost', async () => {
    if (S.phase !== 'needHost') return { ok: false, error: 'not waiting for a host' };
    S.check = { running: true }; push();
    const r = await runHostCheck();
    S.check = r ? Object.assign({ running: false, at: Date.now() }, r) : { running: false, failed: true }; push();
    if (!r || !r.maxHunts) { S.phase = 'off'; S.error = r ? 'This PC cannot host (RAM or GPU); wait for a world instead.' : 'the check did not finish'; push(); await returnCharacter(); return { ok: false, error: S.error }; }
    try { await api('POST', '/v1/forever/score', { score: r.score, maxHunts: r.maxHunts, numbers: { cpu: r.cpu, threads: r.threads, ramGB: r.ramGB, upload: r.upload, relay: r.bestRelay, parts: r.parts } }); S.score = { score: r.score, maxHunts: r.maxHunts, canHost: true }; }
    catch (e) { S.phase = 'off'; S.error = e.message; push(); await returnCharacter(); return { ok: false, error: e.message }; }
    S.phase = 'asking'; push();
    try { await ask(); return { ok: true }; } catch (e) { S.phase = 'off'; S.error = e.message; push(); await returnCharacter(); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('forever:wait', async () => { if (S.phase !== 'needHost') return { ok: false }; S.phase = 'waiting'; push(); timer = setTimeout(() => ask().catch(e => { log(e.message, true); S.phase = 'off'; push(); }), 10000); return { ok: true }; });
  ipcMain.handle('forever:setup', async () => { if (S.phase !== 'off') return { ok: false, error: 'stop Forever first' }; try { await setup(); S.stale = false; push(); return { ok: true }; } catch (e) { setupState = { step: '', error: e.message }; S.error = e.message; push(); return { ok: false, error: e.message }; } });
  // DF-FV-MORE: the Forever tab's More menu
  ipcMain.handle('forever:openFolder', async () => { try { const d = dir(); if (fs.existsSync(d)) await require('electron').shell.openPath(d); return { ok: fs.existsSync(d) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:cleanup', async () => {
    if (S.phase !== 'off') return { ok: false, error: 'stop Forever first' };
    const n = await killLeftovers();
    return { ok: true, closed: n };
  });
  ipcMain.handle('forever:cards', async () => { try { return { ok: true, cards: await cards() }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('forever:access', async () => { await checkAccess(); return { allowed: !!S.allowed }; });
  ipcMain.handle('forever:closing', async (_e, seconds) => { S.closingIn = Math.max(0, Number(seconds) || 0); return { ok: true }; });
}
function shutdown() { if (S && S.phase !== 'off') { try { fs.writeFileSync(path.join(dataDir(), 'forever_stop'), 'quit'); } catch {} try { api('POST', '/v1/forever/leave', {}).catch(() => {}); } catch {} } }
// for the launcher's close dialog: hosting a Forever world with people in it (or standing by for one)
// the Forever world's voice room: keyed by the world's host (the voice service checks world membership with the director)
function voiceRoom() {
  if (!S || S.phase === 'off') return null;
  const w = S.away || S.world;
  const host = w && w.host; if (!host) return null;
  const inIt = S.role === 'host' ? !!(S.ownGame && !S.away) : (S.phase === 'playing' || S.phase === 'standby' || S.phase === 'moving' || !!S.away);
  if (!inIt) return null;
  return { id: host, name: `${w.hostName || 'the'} world`, public: true, forever: true };
}
function hostingNow() {
  if (!S || S.phase === 'off') return null;
  if (S.role === 'host' && S.world) return { players: Math.max(0, Number(S.world.players) || 0), standby: !!S.standbyName, helper: !!S.helper };
  if (S.role === 'standby') return { standby: true, isStandby: true, players: S.world ? Number(S.world.players) || 0 : 0 };
  return null;
}
module.exports = { init, shutdown, publicState, hostingNow, voiceRoom };
