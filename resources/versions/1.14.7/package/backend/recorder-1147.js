// Dauntless Forever - Dauntless 1.14.7 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
/*
  recorder-1147.js - a small local stand-in backend for the Dauntless 1.14.7 client.
  Part of the Dauntless 1.14.7 offline package. Started for you by "2 - PLAY.bat"; you normally never run it by hand.

  What it does
    - Listens on 127.0.0.1 only, one port per original game host (from services_1147.json).
    - Answers the login chain (login queue, session, account info, characters, inventory).
    - Answers everything it does not know with an empty 404, which is what the client expects.
    - Writes one line per request to logs\requests.jsonl with tokens and personal details removed.

  It needs nothing installed besides Node, reads no game files, and touches nothing outside its own folder.

  Run     : node backend\recorder-1147.js              (from the package folder)
  Summary : node backend\recorder-1147.js --summary    (safe to paste into a chat)
  Events  : node backend\recorder-1147.js --events     (what the game reported about itself)
  Folder  : defaults to the folder above this file (the package folder). Override with --dir <folder>.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const quality = require('./quality');
const freePlatinum1147 = require('./free-platinum1147'); // KK-FREE-PLATINUM-1147-R1
let runtime = null;
let quiet = false;
const metrics = { requests: 0, failed: 0, unsupported: 0, saves: 0, recovered: false, missing: new Map() };
let nextConsoleWarning = 0;

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(argVal('--dir') || path.join(__dirname, '..'));
// Game Rules 1.14.7: isolated settings and catalog-verified transformations.
const gameRules = require('./game-rules1147').create(ROOT);
process.env.DF_FREE_PLATINUM = gameRules.settings.free_platinum === 1 ? '1' : '0';   // read by free-platinum1147 and huntpass1147
// DF-LAN-1147: LAN play. RECORDER_BIND=0.0.0.0 lets other PCs on the home network in (LAN - HOST also opens the
// firewall for the home network only); RECORDER_PUBLIC_HOST is this PC's address, given to games for the servers.
const BIND_HOST = argVal('--bind') || process.env.RECORDER_BIND || '127.0.0.1';
const PUBLIC_HOST = (argVal('--public') || process.env.RECORDER_PUBLIC_HOST || '').trim();
// DF-ONLINE-1147: through the relay the game servers are reached on the relay's ports (local 8780+i -> public
// base+i) and the backend on the relay's TCP port (ONLINE - HOST sets both).
const PUBLIC_PORT_OFFSET = Number(process.env.RECORDER_PUBLIC_PORT_OFFSET) || 0;
const PUBLIC_BACKEND_PORT = Number(process.env.RECORDER_PUBLIC_BACKEND_PORT) || 0;
// Only these may talk to the backend: this PC, home networks, Tailscale. Nothing from the open internet.
function privateAddress(a) {
  a = String(a || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);
}
const SERVICES_FILE = path.join(ROOT, 'services_1147.json');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(LOG_DIR, 'requests.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PID_FILE = path.join(DATA_DIR, 'recorder.pid');
const SERVER_FILE = path.join(DATA_DIR, 'server.json');   // written by server-211.ps1 while the city (Ramsgate) server is listening
const WANTED_FILE = path.join(DATA_DIR, 'wanted.json');   // written here: the place outside the city the player asked to go to
const HUNT_SERVER_FILE = path.join(DATA_DIR, 'server_hunt.json');   // written by server-211.ps1 while the second server is listening
const MAX_BODY = 8 * 1024 * 1024;   // a travelling character (DF-TRAVEL-1147) is a few hundred KB

// ---------------------------------------------------------------- redaction
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_KEY_RE = /token|password|secret|authorization|ticket|jwt|signature|credential|exchange/i;

function scrubString(s) {
  let out = String(s).replace(JWT_RE, '<jwt>').replace(EMAIL_RE, '<email>');
  if (out.length > 300) out = out.slice(0, 300) + `...(+${out.length - 300})`;
  return out;
}
function redact(value, key, depth) {
  if (depth > 8) return '<deep>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (key && SECRET_KEY_RE.test(key)) return `<redacted ${value.length}>`;
    if (key === 'server' || key === 'machine' || key === 'computerName') return '<pc>';
    return scrubString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => redact(v, key, depth + 1));
    if (value.length > 20) head.push(`...(+${value.length - 20} more)`);
    return head;
  }
  if (typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = redact(value[k], k, depth + 1);
    return o;
  }
  return String(value);
}
function redactBody(buf, contentType) {
  if (!buf || buf.length === 0) return undefined;
  const text = buf.toString('utf8');
  try {
    const j = JSON.parse(text);
    let s = JSON.stringify(redact(j, '', 0));
    if (s.length > 4000) s = s.slice(0, 4000) + `...(+${s.length - 4000})`;
    return s;
  } catch (e) {
    return `(${contentType || 'no type'}, ${buf.length} bytes) ` + scrubString(text.slice(0, 400));
  }
}
function redactQuery(search) {
  if (!search) return undefined;
  const p = new URLSearchParams(search);
  const parts = [];
  for (const [k, v] of p) parts.push(SECRET_KEY_RE.test(k) ? `${k}=<redacted ${v.length}>` : `${k}=${scrubString(v)}`);
  return parts.join('&');
}
const shortHash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

// ---------------------------------------------------------------- state
let BASE_PORT = 63000;
let state = { players: {}, lastPlayer: null };
const sessions = new Map(); // session token -> player key (kept in memory only)

function loadState() {
  // KK-QUALITY-1147 (KombatKing, AGPL): a damaged save falls back to the last good copy (state.json.bak)
  const loaded = quality.loadState(STATE_FILE); state = loaded.state;
  metrics.recovered = loaded.recovered;
  if (loaded.recovered) console.warn('[Backend] Recovered the previous valid save; the damaged file was preserved.');
  if (!state.players) state.players = {};
  // DF-HOSTID-1147: this server's own id (made once). Joiners remember which host has their character by it, not by
  // the join code, which changes every time the host goes online.
  if (!/^[0-9a-f]{16}$/.test(state.hostId || '')) state.hostId = crypto.randomBytes(8).toString('hex');
}
function liveServer(file) {
  try {
    const srv = JSON.parse(fs.readFileSync(file || SERVER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (!srv || !srv.port || !srv.pid) return null;
    try { process.kill(srv.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }   // the server process is gone
    return srv;
  } catch (e) { return null; }
}
// Places outside the city. The live matchmaker knew which map belongs to each hunt; here only what is known so far.
// A request that carries its own map (the game sends one for private hunts and the tutorial island) is used as sent.
const MAP_BY_GAME_TYPE = { TRAINING_GROUND: '/Game/Maps/islands/dojo/training_dojo_persistent' };
const URL_OK = /^\/Game\/[A-Za-z0-9_\/.?=:,+\-]{1,900}$/;
// Hunts: which map(s), behemoth, atmosphere and game mode each matchmaker hunt uses, made from the game's own
// matchmaker_hunts_table (data\hunts_1147.json, made from the FModel export; stays on this PC).
let HUNTS = null;
function huntsTable() {
  if (HUNTS) return HUNTS;
  try { HUNTS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hunts_1147.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { HUNTS = {}; console.error('No hunt table (data\\hunts_1147.json): ' + e.message); }
  return HUNTS;
}
function huntUrl(id) {
  const h = huntsTable()[id];
  if (!h || !Array.isArray(h.maps) || !h.maps.length) return '';
  const total = h.maps.reduce((t, m) => t + (m.w > 0 ? m.w : 1), 0);
  let pick = Math.random() * total, m = h.maps[0];
  for (const x of h.maps) { pick -= (x.w > 0 ? x.w : 1); if (pick <= 0) { m = x; break; } }
  let url = `${m.map}?MaxPlayers=${h.max || 4}`;
  if (h.behemoth) url += `?MonsterClass=${h.behemoth}`;
  if (m.tod) url += `?TODClass=${m.tod}`;
  url += `?HuntID=${id}`;
  if (h.game) url += `?game=${h.game}`;
  return url;
}
// DF-DOJO-1147 (Oct 20): on PCs with 8 GB of memory or less the Training Grounds stay off: the second server copy
// it needs is what those PCs run out of memory on. The player stays in Ramsgate and df-watch.ps1 shows "Error 6".
// (2026-10-20.2 used 32 GB as the line, which kept almost everyone out; 2026-10-20.3 is 8 GB.)
// data\dojo.txt: "on" = Training Grounds on (any PC), "off" = off (any PC).
const DOJO_RAM_LIMIT = 10 * 1024 * 1024 * 1024;   // 8 GB sticks show about 7.9 GB to Windows; 12 GB and up are fine
function dojoOff1147() {
  let pick = '';
  try { pick = fs.readFileSync(path.join(DATA_DIR, 'dojo.txt'), 'utf8').trim().toLowerCase(); } catch (e) {}
  if (pick === 'on') return false;
  if (pick === 'off') return true;
  return require('os').totalmem() < DOJO_RAM_LIMIT;
}
let lastWatchNotice = 0;
function watchNotice(code) {   // read by tools\df-watch.ps1 (the box on top of the game)
  const now = Date.now();
  if (now - lastWatchNotice < 20000) return;
  lastWatchNotice = now;
  try { fs.writeFileSync(path.join(DATA_DIR, 'watch_notice.json'), JSON.stringify({ code, at: new Date(now).toISOString() })); } catch (e) {}
}
function destinationFor(b) {
  if (String(b.gameType || '') === 'TRAINING_GROUND' && dojoOff1147()) {   // DF-DOJO-1147
    watchNotice(6);
    return { city: true, label: `${b.gameMode || '-'}/TRAINING_GROUND`, note: 'Training Grounds is off on this PC (8 GB of memory or less; data\\dojo.txt = on turns it on): staying in Ramsgate' };
  }
  const modesDestination = require('./modes1147').destination(b);
  if (modesDestination) return modesDestination;
  const mode = b.gameMode || 'CITY', type = b.gameType || '';
  const hunt = Array.isArray(b.hunts) && b.hunts.length ? String(b.hunts[0]) : '';
  const label = `${mode}/${type || '-'} ${b.playerHuntId || hunt || ''}`.trim();
  if (mode === 'CITY') return { city: true, label };
  if (type === 'FTUE') return { city: true, label, note: 'the tutorial island is skipped for now: straight to Ramsgate' };
  let url = '';
  if (typeof b.gameArgs === 'string' && b.gameArgs.startsWith('/Game/')) url = b.gameArgs;
  else if (hunt && huntUrl(hunt)) url = huntUrl(hunt);
  else if (MAP_BY_GAME_TYPE[type]) url = `${MAP_BY_GAME_TYPE[type]}?MaxPlayers=4${/^[A-Za-z0-9_]+$/.test(hunt) ? '?HuntID=' + hunt : ''}`;
  if (!url || !URL_OK.test(url)) return { city: true, label, note: 'this destination is not available yet: staying in Ramsgate' };
  return { city: false, label, url };
}
// DF-TRAVEL-1147: a LAN guest's own character travels to the host for the session and back home afterwards
// (same idea as 1.6.2's travel.js). The guest's LAN - JOIN sends the record of its home save here before the game
// starts (PUT) and takes it back when the game closes (GET). The key is the guest's LAN sign-in
// (sha256('epic:' + its LAN Epic id), the same key the game's sign-in gives it here). Home networks only.
function travel(method, key, body) {
  if (method === 'GET') {
    const p = state.players[key];
    if (!p) return { status: 404, json: { error: 'no character of this player here' }, note: 'travel: nothing to send home' };
    const out = Object.assign({}, p); delete out.candidate; delete out.partyId; delete out.partyRejoin; delete out.partyRejoinDone;
    return J({ player: out, at: new Date().toISOString() }, `travel: ${key.slice(0, 8)} goes home (${(out.characters || []).length} character(s))`);
  }
  if (method === 'PUT') {
    const rec = body && body.player;
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.characters) || !rec.characters.length) return { status: 400, json: { error: 'no character in the request' }, note: 'travel: refused, empty' };
    // every character must be a real record (an object with a name and, when present, JSON in data): junk never replaces a save here
    for (const ch of rec.characters) {
      if (!ch || typeof ch !== 'object' || typeof ch.name !== 'string') return { status: 400, json: { error: 'a character in the request is not a character' }, note: 'travel: refused, bad character' };
      if (ch.data !== undefined && ch.data !== null) { try { JSON.parse(ch.data); } catch (e) { return { status: 400, json: { error: `character ${ch.name} has broken data` }, note: 'travel: refused, broken data' }; } }
    }
    const p = Object.assign({}, rec);
    delete p.candidate; delete p.partyId; delete p.partyRejoin; delete p.partyRejoinDone;
    p.accountId = idFrom('account:' + key);          // the host's id for this guest (home ids can be the same on every PC)
    p.travelledIn = new Date().toISOString();
    if (state.players[key]) state.travelBackups = Object.assign(state.travelBackups || {}, { [key]: state.players[key] });
    state.players[key] = p;
    saveState();
    return J({ ok: true, accountId: p.accountId }, `travel: ${key.slice(0, 8)} arrived with ${p.characters.length} character(s)`);
  }
  return { status: 405, json: {}, note: 'travel: GET or PUT' };
}
// DF-LAN-1147 / DF-MULTIHUNT-1147 (Oct 21): the places outside the city that hunt servers are for, and who is (going)
// there. Several at once: players who are not in a party each get their own hunt server (tools\server-1147.ps1 starts
// one per place on UDP 8781-8787); a party shares one, and Training Grounds is shared by everyone.
const places = new Map();
const multiplayer1147 = require('./multiplayer1147').create({root:ROOT,getState:()=>state,liveServer,huntServer}); // KK-MULTIPLAYER-R4-R1
function placeOf(key) { for (const pl of places.values()) if (pl.owners.has(key)) return pl; return null; }
function dropPlace(pl) { multiplayer1147.retire(pl.id); places.delete(pl.id); writeWanted(); }
function addPlace(pl, reuse) { pl.reuse = !!reuse; pl.asked = new Date().toISOString(); places.set(pl.id, pl); writeWanted(); return pl; }
function maintainPlace(key) {
  multiplayer1147.recover(places);
  multiplayer1147.touch(key);
  for (const pl of [...places.values()]) { multiplayer1147.prune(pl); if (!pl.owners.size) dropPlace(pl); }
}
// the listening hunt server for one place (data\server_hunt.json lists every one), or null
function huntServer(id) {
  try {
    const f = JSON.parse(fs.readFileSync(HUNT_SERVER_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const srv = (Array.isArray(f.list) ? f.list : [f]).find((x) => x && x.id === id && x.port && x.pid);
    if (!srv) return null;
    try { process.kill(srv.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
    return srv;
  } catch (e) { return null; }
}
const placeBase = (u) => String(u || '').replace(/\?PlayerHuntIds=[^?]*/g, '');
// DF-FOREVERHUNTS-1147: may `me` (+ party mates not already there) join this open hunt? Room under the cap; a hunt
// stays open until its server ends.
function foreverRoom(pl, me, mates, max) {
  const coming = 1 + [...mates].filter((k) => k !== me && !pl.owners.has(k)).length;
  const there = [...pl.owners].filter((k) => k !== me).length;
  if (there + coming > max) return false;
  return true;
}
function trialsRetryOn() {   // DF-WARM-1147: data\mods.txt trialsretry=on (launcher Mods page)
  try { return fs.readFileSync(path.join(DATA_DIR, 'mods.txt'), 'utf8').split(/\r?\n/).some((l) => l.trim().toLowerCase() === 'trialsretry=on'); } catch (e) { return false; }
}
function leavePlace(key) {
  multiplayer1147.recover(places);
  for (const pl of [...places.values()]) if (pl.owners.delete(key) && !pl.owners.size) dropPlace(pl);
}
// data\wanted.json for tools\server-1147.ps1: every place in "list"; the newest also at the top (older readers)
function writeWanted() {
  const list = [...places.values()].filter((pl) => pl.url).map((pl) => ({ id: pl.id, url: pl.url, label: pl.label, reuse: !!pl.reuse, at: pl.asked || new Date().toISOString() }));
  try {
    if (!list.length) { if (fs.existsSync(WANTED_FILE)) fs.unlinkSync(WANTED_FILE); return; }
    const w = Object.assign({}, list[list.length - 1], { list });
    const tmp = WANTED_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(w)); fs.renameSync(tmp, WANTED_FILE);
  } catch (e) { throw quality.httpError(503, 'Hunt request could not be saved; retry after checking disk space'); }
}
function saveStateNative() {
  try { if (quality.saveState(STATE_FILE, state)) metrics.saves++; }
  catch (error) {
    // A failed disk write must not leave unsaved rewards or equipment in memory.
    try { state = quality.loadState(STATE_FILE).state; } catch {}
    throw quality.httpError(503, 'Player save could not be written; previous save preserved');
  }
}
// Ids in the same format the live game used: 26 characters (base32 of 16 bytes).
function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
const idFrom = (seed) => base32(crypto.createHash('sha256').update(seed).digest().subarray(0, 16));
const newId = () => base32(crypto.randomBytes(16));
const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
// DF-HEADSTART-1147 (Addison, Oct 29): a brand-new player (no record for this key yet) starts from data\head-start.json, a
// character captured right after the tutorial island, the Training Grounds and the 5,000-damage quest (default rules): the
// game opens in Ramsgate with the starter gear and the Embermane quest, skipping the tutorial level and the Training Grounds
// (both failed for many players). Only a key with NO record is seeded; existing saves are never touched; no file = as before.
const HEAD_START_FILE = path.join(DATA_DIR, 'head-start.json');
function headStartRecord(key) {
  try {
    if (!fs.existsSync(HEAD_START_FILE)) return null;
    const t = JSON.parse(fs.readFileSync(HEAD_START_FILE, 'utf8').replace(/^\uFEFF/, '')); const tp = t && t.player;
    if (!tp || !Array.isArray(tp.characters) || !tp.characters.length) return null;
    const j = JSON.stringify(tp).split('{{ACCOUNT_ID}}').join(idFrom('account:' + key)).split('{{CHARACTER_ID}}').join(newId()).split('{{NAME}}').join('Slayer').split('{{CREATED}}').join(new Date().toISOString().slice(0, 10));
    const p = JSON.parse(j); p.headStart = true;   // the sign-in that follows puts the player's name on the character, then clears this
    console.log(`head start: ${key.slice(0, 8)} begins after the Training Grounds (data\\head-start.json)`);
    return p;
  } catch (e) { console.warn('head start: template not used: ' + e.message); return null; }
}
function getPlayer(key) {
  if (!state.players[key]) {
    state.players[key] = headStartRecord(key) || { accountId: idFrom('account:' + key), username: 'Slayer', created: new Date().toISOString().slice(0, 10), characters: [], inventory: {} };
    saveState();
  }
  return state.players[key];
}
function bearerOf(req) {
  const h = req.headers['authorization'];
  if (!h) return null;
  const m = /^\s*bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : h.trim();
}
// The Epic token is a JWT. We read its "sub" (the Epic account id) only to keep the same
// player between logins. The signature is not checked: this is a private single-player test server.
function epicSubOf(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && payload.sub ? String(payload.sub) : null;
  } catch (e) { return null; }
}
// DF-NAME-1147: the offline sign-in puts the player's name in the token too ("dn", from eos_offline.ini DisplayName,
// which the launcher fills with its one player name). Use it as the account name, so players are not all "Slayer".
function epicNameOf(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const n = payload && typeof payload.dn === 'string' ? payload.dn.trim() : '';
    return /^[A-Za-z0-9_ ]{2,20}$/.test(n) ? n : null;
  } catch (e) { return null; }
}
function playerKeyFromEpicToken(token) {
  const sub = epicSubOf(token);
  return sub ? crypto.createHash('sha256').update('epic:' + sub).digest('hex').slice(0, 32) : 'local';
}
// DF-LAN-1147: with two players, a request must reach the right save. The players' games send their session token;
// the game servers send none, but name the player in the path or body (account id, character id). Only when neither
// is there does "the last player who signed in" stand in (always right with one player).
function keyFromIds(pathName, body) {
  const want = new Set(String(pathName || '').split('/').filter((x) => /^[A-Z2-7]{26}$/.test(x)));
  if (body && typeof body === 'object') for (const f of ['accountId', 'phx_account_id', 'account_id', 'characterId', 'character_id', 'playerId']) {
    if (typeof body[f] === 'string' && /^[A-Z2-7]{26}$/.test(body[f])) want.add(body[f]);
  }
  if (!want.size) return null;
  for (const [k, p] of Object.entries(state.players)) {
    if (want.has(p.accountId)) return k;
    for (const ch of p.characters || []) if (ch && want.has(ch.id)) return k;
  }
  return null;
}
function keyFor(req) {
  const b = bearerOf(req);
  return (b ? sessions.get(b) : null) || (req && req._pkey) || state.lastPlayer || 'local';
}
// DF-HOSTGUARD-1147 (Oct 19): a joiner must never land on the host's save. The host's own game talks to the backend
// from 127.0.0.1; joiners come from the LAN address or, through the online gateway, from 127.0.0.2. A joiner whose
// game signs in with no id / the default id / the host's id is refused, a joiner's sign-in never becomes
// "the last player" (the stand-in for server requests that name nobody), and a joiner request that names nobody
// is refused instead of guessed.
const DEFAULT_EPIC_ID = 'd211000000000000000000000000e91c';
function guestRequest(req) {
  const a = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  return !(a === '' || a === '127.0.0.1' || a === '::1');
}
function hostEpicId() {
  try {
    const t = fs.readFileSync(path.join(ROOT, 'eos', 'eos_offline.ini'), 'utf8');
    const m = /^\s*EpicAccountId\s*=\s*([0-9a-fA-F]{32})\s*$/m.exec(t);
    if (m) return m[1].toLowerCase();
  } catch (e) { /* no file: the default id */ }
  return DEFAULT_EPIC_ID;
}
const HOST_KEY = crypto.createHash('sha256').update('epic:' + hostEpicId()).digest('hex').slice(0, 32);
const PRE_SESSION_RE = /^\/(dauntless-status|maintenance\/status|features\/platform|patchnotes|account\/link|login|gamesession|heartbeat|progression\/config|_recorder|_travel)(\/|$)/;
function playerFor(req) { return getPlayer(keyFor(req)); }

// ---------------------------------------------------------------- captures
// Game-wide data (hunt pass and progression tables, event schedule, patch notes...) is not invented here.
// It is read from a local copy of the public traffic captures of the live 2.1.1 servers:
//   https://github.com/EisigesEis/DauntlessEndpointDocumentation  ->  unzip into <folder>\captures
const CAP_DIR = path.join(ROOT, 'captures');
let capRoot = null;
const capCache = new Map();
function findCaptures() {
  const candidates = [];
  for (const dir of [CAP_DIR]) {
    candidates.push(dir);
    try { for (const d of fs.readdirSync(dir)) candidates.push(path.join(dir, d)); } catch (e) { /* not there */ }
  }
  for (const c of candidates) { try { if (fs.statSync(path.join(c, 'Login', 'README.md')).isFile()) return c; } catch (e) { /* keep looking */ } }
  return null;
}
// The captures are JSON with // notes added by their author; remove the notes without touching text inside strings.
function stripJsonComments(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { out += ch; if (ch === '\\') { out += text[++i] || ''; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += ch;
  }
  return out;
}
function parseLoose(text) {
  let t = stripJsonComments(text).replace(/(\d),(\d{6,})/g, '$1.$2');     // one capture has 1,000000 for 1.000000
  try { return JSON.parse(t); } catch (e) { /* try once more without trailing commas */ }
  return JSON.parse(t.replace(/,(\s*[}\]])/g, '$1'));
}
function loadCapture(rel) {
  if (capCache.has(rel)) return capCache.get(rel);
  let value = null;
  try {
    if (!capRoot) throw new Error('no captures folder');
    let text = fs.readFileSync(path.join(capRoot, ...rel.split('/')), 'utf8');
    if (rel.toLowerCase().endsWith('.md')) {
      const h = /^#+\s*Example\s+Re\w*pon\w*\s*$/mi.exec(text);
      const from = h ? h.index : 0;
      const m = /(`{3,})[a-zA-Z]*\r?\n([\s\S]*?)\r?\n\s*`{3,}/.exec(text.slice(from));
      if (!m) throw new Error('no example reply found');
      text = m[2];
    }
    value = parseLoose(text);
  } catch (e) { value = null; capCache.set(rel + ':error', e.message); }
  capCache.set(rel, value);
  return value;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- replies
// Shapes marked "captured" below match traffic recorded from the live 2.1.1 servers
// (EisigesEis/DauntlessEndpointDocumentation).
const wrapped = (payload) => ({ code: null, message: 'OK', payload });
const charOut = (p, ch) => ({ accountId: p.accountId, catalogDaoId: null, createdDate: ch.created || today(), data: ch.data, id: ch.id, lastModifiedDate: today(), name: ch.name, updateVersion: ch.updateVersion });
const J = (obj, note) => ({ status: 200, json: obj, note });
const TEXT = (text, note) => ({ status: 200, text, note });
const NOT_FOUND = { status: 404 };
// Reply taken from a capture file, optionally adjusted; an empty 404 if the captures are not installed.
const CAP = (rel, adjust) => (c) => {
  const j = loadCapture(rel);
  if (j === null) return { status: 404, note: `needs captures (${rel}): ${capCache.get(rel + ':error') || 'missing'}` };
  return J(adjust ? adjust(clone(j), c) : j, 'from captures');
};
const zeroed = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = 0; return o; };

// DF-STAFFTITLES (Oct 20): staff and test titles (Dev Team, Phoenix Labs, Moderator, Test Title) are never handed to
// the game, whatever a save, a reward list or an inventory edit holds, so nobody can show them over their name.
const STAFF_TITLE_RX = /^TITLE_(DEV|PHOENIX|PHX|MODERATOR|TEST|STAFF|ADMIN)(_|$)/i;
function IsStaffTitle(Item) { return !!Item && typeof Item.catalogId === "string" && STAFF_TITLE_RX.test(Item.catalogId); }
function WithoutStaffTitles(List) { return Array.isArray(List) ? List.filter((Item) => !IsStaffTitle(Item)) : List; }
function stripStaffTitles(inv) {
  if (inv.stackedItems.some(IsStaffTitle)) inv.stackedItems = WithoutStaffTitles(inv.stackedItems);
  if (inv.instancedItems.some(IsStaffTitle)) inv.instancedItems = WithoutStaffTitles(inv.instancedItems);
}
function ensureStarterItems(inv) {
  // The game will not spawn a player without a weapon and a lantern. Retail handed these out in the tutorial.
  for (const id of ['WP_EB_TRAINING', 'LT_BASIC']) {
    if (!inv.instancedItems.some((i) => i.catalogId === id)) inv.instancedItems.push({ catalogId: id, instanceId: id, updateVersion: 1 });
  }
}
function inventoryOf(player, characterId) {
  const id = characterId || (player.characters[0] && player.characters[0].id) || 'none';
  if (!player.inventory[id]) player.inventory[id] = { stackedItems: [], instancedItems: [] };
  ensureStarterItems(player.inventory[id]);
  stripStaffTitles(player.inventory[id]);   // DF-STAFFTITLES
  return player.inventory[id];
}
function applyInventory(inv, body) {
  body = freePlatinum1147.inventory(body);
  body = huntpass1147.inventory(inv, body);
  body = gameRules.inventory(inv, body);
  if (body && typeof body === 'object') for (const k of ['addInstancedItems', 'saveInstancedItems', 'addStackedItems']) if (Array.isArray(body[k])) body[k] = WithoutStaffTitles(body[k]);   // DF-STAFFTITLES
  quality.validateInventory(body);
  for(const item of body.removeInstancedItems || []) if(typeof item!=='string' && (!item || typeof item.instanceId!=='string')) throw quality.httpError(400,'Invalid equipment removal');
  const incomingIds = new Map(inv.instancedItems.map(x => [x.instanceId,x.catalogId]));
  for (const item of body.addInstancedItems || []) if (item.instanceId) {
    if(incomingIds.has(item.instanceId) && incomingIds.get(item.instanceId)!==item.catalogId) throw quality.httpError(409,'Equipment instanceId belongs to another item');
    incomingIds.set(item.instanceId,item.catalogId);
  }
  for(const item of body.saveInstancedItems || []) {
    const existing=inv.instancedItems.find(x=>x.instanceId===item.instanceId);
    if(!existing&&!item.catalogId)throw quality.httpError(400,'New equipment requires catalogId');
    if(existing&&item.catalogId&&existing.catalogId!==item.catalogId)throw quality.httpError(409,'Equipment catalogId cannot change');
  }
  const quantities=new Map(inv.stackedItems.map(x=>[x.catalogId,x.quantity]));
  for(const item of body.addStackedItems||[]) {
    const total=(quantities.get(item.catalogId)||0)+Number(item.quantity);
    if(!Number.isSafeInteger(total))throw quality.httpError(400,'Stacked quantity is too large');
    quantities.set(item.catalogId,total);
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const created = [], updatedInst = [], updatedStack = [], removed = [];
  for (const it of arr(body.addInstancedItems)) {
    const item = Object.assign({}, it);
    if (!item.instanceId) item.instanceId = crypto.randomUUID();
    if (typeof item.updateVersion !== 'number') item.updateVersion = 1;
    const existing = inv.instancedItems.find(x => x.instanceId === item.instanceId);
    if (existing && existing.catalogId !== item.catalogId) throw quality.httpError(409, 'Equipment instanceId belongs to another item');
    if (existing) { created.push(existing); continue; }
    inv.instancedItems.push(item); created.push(item);
  }
  for (const it of arr(body.saveInstancedItems)) {
    const i = inv.instancedItems.findIndex((x) => x.instanceId === it.instanceId);
    if (i >= 0) inv.instancedItems[i] = Object.assign({}, inv.instancedItems[i], it); else inv.instancedItems.push(it);
    updatedInst.push(i >= 0 ? inv.instancedItems[i] : it);
  }
  for (const it of arr(body.removeInstancedItems)) {
    const id = typeof it === 'string' ? it : it.instanceId;
    const i = inv.instancedItems.findIndex((x) => x.instanceId === id);
    if (i >= 0) removed.push(inv.instancedItems.splice(i, 1)[0]);
  }
  const bump = (it, sign) => {
    const q = Number(it.quantity) || 0;
    if (!q) return;
    let s = inv.stackedItems.find((x) => x.catalogId === it.catalogId);
    if (!s) { s = { catalogId: it.catalogId, quantity: 0 }; inv.stackedItems.push(s); }
    s.quantity = Math.max(0, s.quantity + sign * q);
    updatedStack.push({ catalogId: s.catalogId, quantity: s.quantity });
  };
  for (const it of arr(body.addStackedItems)) bump(it, +1);
  for (const it of arr(body.removeStackedItems)) bump(it, -1);
  return { createdInstancedItems: created, updatedInstancedItems: updatedInst, updatedStackedItems: updatedStack, removedInstancedItems: removed };
}

// ---------------------------------------------------------------- player data kept for the game server
// A new character starts with the game's own default gear (the DefaultLoadout in the game's settings).
// For those defaults the item id doubles as the instance id, as in the Undaunted backend.
const DEFAULT_APPEARANCE = JSON.stringify({ CreationState: 'EArchonCharacterCreationState::NewCharacter', Data: [], AssetReferences: [], StringData: [] });
function defaultPersistent() {
  return {
    manual_emotes: ['', '', '', '', '', ''], intro_emote: 'EM_INTRO_BEGINNER_01', banner: 'BN_BEGINNER_00',
    bannerCustomization: JSON.stringify({ BannerMeshItemID: 'BNC_MESH_BEGINNER_00', FabricMaterialItemID: 'BNC_FABRIC_BEGINNER_00', SigilTextureItemID: 'BNC_SIGIL_BEGINNER_00', PlantVFXItemID: '', PersistantStandardVFXItemID: '', AnimationItemID: 'BNC_ANIMATION_BEGINNER_00' }),
    flare: 'QI_BASIC_FLARE_DURABLE', title: '', head_accessory: '', back_accessory: '', pet: '', glider: 'GD_FRAME_STARTER_BASE', update_version: 0,
    quick_chats: ['', '', '', '', '', '', '', '', ''], emojis: ['', '', '', '', '', '', '', '', ''],
    quick_curiosities_items: Array.from({ length: 8 }, (_, i) => ({ item_index: i, item_id: '', instance_id: '' })), quickwheel: [],
  };
}
function defaultLoadoutSlot(persistent) {
  const gear = (id) => ({ item_id: id, instance_id: id, instance_data: '' });
  return { weapon: gear('WP_EB_TRAINING'), helmet: gear('AR_UNEQUIPPED_HELM'), chest: gear('AR_BEGINNER_CHEST'), arms: gear('AR_BEGINNER_ARMS'), legs: gear('AR_BEGINNER_LEGS'),
    lantern: gear('LT_BASIC'), player_role: null, subweapon: null, persistent, appearance: DEFAULT_APPEARANCE, flask: 'FL_HEALING_DEFAULT', custom_name: '', quick_items: [], slot_index: 0, update_version: 0 };
}
function loadoutsOf(p, characterId) {
  if (!p.loadouts) p.loadouts = {};
  if (!p.loadouts[characterId]) { const persistent = defaultPersistent(); p.loadouts[characterId] = { loadouts: [defaultLoadoutSlot(persistent)], persistent, active_index: 0 }; }
  return p.loadouts[characterId];
}
const loadoutReply = (l) => ({ loadouts: l.loadouts, persistent: l.persistent, num_account_slots: 1, max_account_slots: 1, num_character_slots: 1, max_character_slots: 1, active_index: l.active_index || 0, needs_migration: false });
function saveLoadout(c) {
  const p = playerFor(c.req); const l = loadoutsOf(p, c.match[2]); const which = c.match[3];
  let data = c.body && (c.body.data !== undefined ? c.body.data : c.body);
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return { status: 400, note: 'loadout data is not JSON' }; } }
  if (!data || typeof data !== 'object') return { status: 400, note: 'no loadout data' };
  if (which === 'persistent') l.persistent = data;
  else { const i = Number(which); if (!Number.isInteger(i) || i < 0 || i > 15) return { status: 400, note: 'bad loadout index' }; l.loadouts[i] = data; }
  saveState();
  return J(wrapped(loadoutReply(l)), `saved ${which}`);
}
function setActiveLoadout(c) {
  const p = playerFor(c.req); const l = loadoutsOf(p, c.match[2]); const i = Number(c.match[3]);
  if (Number.isInteger(i) && l.loadouts[i]) { l.active_index = i; saveState(); }
  return J(wrapped(loadoutReply(l)), 'guess');
}
function escalationOf(p, season) {
  if (!p.escalation) p.escalation = {};
  if (!p.escalation[season]) p.escalation[season] = { escalation_level: 1, next_level_xp: 0, talents_progress: [], unlock_progress: [], update_version: 1 };
  return p.escalation[season];
}
// Player journey ("Slayer's Path"). The main map is asked for by account id; faction maps add "-<season>-<faction>".
// Captured shape: nodes is an OBJECT keyed by node id -> { node_id, node_status, objectives: [{ objective_amount,
// objective_status, online_objective_id }] }, plus update_version. A new player's main map starts as the captured
// brand-new one (every node present, nothing unlocked but the starting node).
function pjmNodeMap(x) {
  const out = {};
  if (Array.isArray(x)) { for (const n of x) if (n && n.node_id) out[n.node_id] = n; }
  else if (x && typeof x === 'object') { for (const [k, n] of Object.entries(x)) if (n && typeof n === 'object') out[n.node_id || k] = Object.assign({ node_id: k }, n); }
  return out;
}
function pjmStarter() {
  const cap = loadCapture('Progression/GetSlayersPath.md');
  const nodes = cap && cap.payload && cap.payload.nodes ? pjmNodeMap(clone(cap.payload.nodes)) : {};
  return { nodes, update_version: 1 };
}
function pjmOf(p, segment) {
  const dash = segment ? segment.indexOf('-') : -1;
  const key = dash >= 0 ? segment.slice(dash + 1) : 'main';
  if (!p.pjmMaps) p.pjmMaps = {};
  let m = p.pjmMaps[key];
  if (m && Array.isArray(m.nodes)) m.nodes = pjmNodeMap(m.nodes);                 // older saves kept a list
  if (!m || !m.nodes) m = p.pjmMaps[key] = { nodes: {}, update_version: 0 };
  if (key === 'main' && Object.keys(m.nodes).length === 0) { const st = pjmStarter(); m.nodes = st.nodes; m.update_version = Math.max(m.update_version || 0, st.update_version); }
  return m;
}
function savePjm(c) {
  const m = pjmOf(playerFor(c.req), c.match[1]);
  let b = c.body && typeof c.body === 'object' ? c.body : {};
  if (b.payload && typeof b.payload === 'object') b = b.payload;
  const incoming = pjmNodeMap(b.nodes !== undefined ? b.nodes : (b.node_id ? [b] : (Array.isArray(b) ? b : null)));
  let n = 0;
  for (const [id, node] of Object.entries(incoming)) { m.nodes[id] = Object.assign({}, m.nodes[id], node); n++; }
  m.update_version = (Number(m.update_version) || 0) + 1; saveState();
  return J(wrapped({ nodes: m.nodes, update_version: m.update_version }), `${n} node(s) saved`);
}
// Progression tracks (slayer level, weapon and behemoth mastery, hunt pass...) and objectives (quests, challenges).
// Shapes read from the game's reply parsers; a new player has none. What the game server grants is added up here.
const isoNow = () => new Date().toISOString().slice(0, 19);                    // 2024-10-06T12:58:38, as the live servers wrote dates
function progressOf(p) { if (!p.progress) p.progress = { tracks: {}, objectives: {} }; return p.progress; }
const isPrestige = (id) => /^PrestigeTrack_Weapon_[A-Za-z]+$/.test(String(id));
const trackOut = (p, id, t) => ({ phx_account_id: p.accountId, progression_id: id, progress: t.progress || 0,
  confirmed_fremium_rank: isPrestige(id) ? (t.progress || 0) : (t.confirmed_fremium_rank || 0),
  confirmed_premium_rank: isPrestige(id) ? (t.progress || 0) : (t.confirmed_premium_rank || 0), confirmed_date: t.confirmed_date || null });
// DF-REFORGE-1147: Sparkforge "Reforge Weapon Skill" (same calls as 1.6.2, see the 1.6.2 Sparkforge notes):
//   1. POST /inventory that only removes 100 CURRENCY_PJM_PRESTIGE_EMPTY (Aethersparks)  -> the Aetherheart is added
//      in the same transaction, so the game shows it at once;
//   2. POST /progression/<acc>/PrestigeTrack_Weapon_<W>/1  -> one more reforge (pays the heart here instead if step 1
//      did not, within 60 s);
//   3. DELETE /progression/<acc>/ExperienceTrack_Weapon_<W>  -> the weapon back to level 1 (old XP kept in reforgedXp);
//   4. GET /progression/<acc>/ExperienceTrack_Weapon_<W>.
const REFORGE_SPARK = 'CURRENCY_PJM_PRESTIGE_EMPTY', REFORGE_HEART = 'CURRENCY_PJM_PRESTIGE_FILLED';
function isReforgeSpend(b) {
  if (!b || typeof b !== 'object') return false;
  const rem = Array.isArray(b.removeStackedItems) ? b.removeStackedItems : [];
  const empty = (k) => !b[k] || (Array.isArray(b[k]) && b[k].length === 0);
  return rem.length > 0 && rem.every((x) => x && x.catalogId === REFORGE_SPARK && Number(x.quantity) > 0)
    && empty('addStackedItems') && empty('addInstancedItems') && empty('removeInstancedItems') && empty('saveInstancedItems');
}
function giveStacked(inv, id, n) {
  const row = inv.stackedItems.find((x) => x.catalogId === id);
  if (row) row.quantity = (Number(row.quantity) || 0) + n; else inv.stackedItems.push({ catalogId: id, quantity: n });
}
const objectiveOut = (p, id, o) => ({ completed_count: o.completed_count || 0, created_date: o.created_date || isoNow(), last_modified_date: o.last_modified_date || isoNow(),
  objective_id: id, phx_account_id: p.accountId, progress: o.progress || 0 });
function grantProgressNative(c) {
  const p = playerFor(c.req); const pr = clone(progressOf(p)); const b = gameRules.progress(huntpass1147.progressBody(c.body && typeof c.body === 'object' ? c.body : {}));
  const tracks = [], objectives = [];
  for (const t of Array.isArray(b.progress_tracks) ? b.progress_tracks : []) {
    if (!t || !t.progression_id) continue;
    const cur = pr.tracks[t.progression_id] || (pr.tracks[t.progression_id] = { progress: 0 });
    cur.progress = gameRules.sumTrack(t.progression_id, cur.progress, Number(t.progress) || 0); tracks.push(trackOut(p, t.progression_id, cur));
  }
  for (const o of Array.isArray(b.objectives) ? b.objectives : []) {
    if (!o || !o.objective_id) continue;
    const cur = pr.objectives[o.objective_id] || (pr.objectives[o.objective_id] = { progress: 0, completed_count: 0, created_date: isoNow() });
    if (o.value !== undefined) cur.progress = Number(o.value) || 0;
    if (o.completed_count !== undefined) cur.completed_count = Number(o.completed_count) || 0;
    cur.last_modified_date = isoNow(); objectives.push(objectiveOut(p, o.objective_id, cur));
  }
  p.progress = pr; huntpass1147.settle(p); saveState();
  return J(wrapped({ progress_tracks: tracks.map(t=>trackOut(p,t.progression_id,p.progress.tracks[t.progression_id])), objectives }), `${tracks.length} track(s), ${objectives.length} objective(s) saved, guess`);
}
function grantTrackNative(c) {
  const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
  huntpass1147.assertDelta(id, Number(c.match[2]));
  if (isPrestige(id)) {   // DF-REFORGE-1147
    const n = Math.max(0, Math.min(10, Number(c.match[2]) || 0));
    const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 });
    cur.progress = (Number(cur.progress) || 0) + n; cur.confirmed_date = isoNow();
    if (n > 0 && !(p.reforgePaidAt && Date.now() - p.reforgePaidAt < 60000)) {
      giveStacked(inventoryOf(p, (p.characters[0] || {}).id), REFORGE_HEART, n);
      reforgeLog(`${p.accountId}: ${id} +${n}, Aetherheart paid with the reforge count`);
    } else reforgeLog(`${p.accountId}: ${id} +${n} (reforge ${cur.progress}), heart already paid with the spark transaction`);
    delete p.reforgePaidAt; saveState();
    return J(wrapped(trackOut(p, id, cur)), `reforge ${id} now ${cur.progress}`);
  }
  const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 });
  cur.progress = gameRules.sumTrack(id, cur.progress, gameRules.track(id, Number(c.match[2]) || 0)); huntpass1147.settle(p); saveState();
  return J(wrapped(trackOut(p, id, cur)), `${id} +${c.match[2]}, guess`);
}
// DF-TRACKED-QUESTS-1147 (Oct 25): the game saves which quest set / quests a player follows (current_set, e.g. the
// new-player chain CR20_PJM_FTUE_00). It was thrown away, so a game that started on another server (a Forever world, a
// friend's game) came back with no quest. Kept per player; it travels with the player's record.
function saveTracked(c) {
  const p = playerFor(c.req); const b = c.body && typeof c.body === 'object' ? c.body : {};
  const list = (x) => Array.isArray(x) ? x.filter((v) => typeof v === 'string' || (v && typeof v === 'object')).slice(0, 200) : [];
  p.trackedObjectives = { current_set: typeof b.current_set === 'string' ? b.current_set.slice(0, 128) : '', omitted_quests: list(b.omitted_quests), tracked_quests: list(b.tracked_quests), tracked_craftables: list(b.tracked_craftables) };
  saveState(); return J(wrapped(null), 'saved set ' + (p.trackedObjectives.current_set || '(none)'));
}
function grantProgress(c) { const p=playerFor(c.req); return huntpass1147.atomic(p,()=>grantProgressNative(c)); }
function grantTrack(c) { const p=playerFor(c.req); return huntpass1147.atomic(p,()=>grantTrackNative(c)); }
function saveBounties(c) {
  const p = playerFor(c.req); const b = c.body && typeof c.body === 'object' ? (c.body.payload && typeof c.body.payload === 'object' ? c.body.payload : c.body) : {};
  const cur = Object.assign(emptyBounties(), p.bounties || {});
  let n = 0;
  for (const k of ['bounties', 'draft_data', 'draft_data_daily', 'draft_data_weekly']) if (b[k] !== undefined) { cur[k] = b[k]; n++; }
  if (n) { p.bounties = cur; saveState(); }
  return J(wrapped(cur), n ? 'saved, guess' : 'guess');
}
function saveCooldowns(c) {
  const p = playerFor(c.req); if (!p.cooldowns) p.cooldowns = [];
  const b = c.body && typeof c.body === 'object' ? c.body : {};
  const incoming = Array.isArray(b.cooldowns) ? b.cooldowns : (Array.isArray(b) ? b : (b.cooldown_id ? [b] : []));
  for (const n of incoming) {
    if (!n || !n.cooldown_id) continue;
    const i = p.cooldowns.findIndex((x) => x.cooldown_id === n.cooldown_id);
    if (i >= 0) p.cooldowns[i] = n; else p.cooldowns.push(n);
  }
  // "start this cooldown now": PUT /cooldown/{account}/{id} without a list
  const one = /^\/cooldown\/[^/]+\/([^/]+)\/?$/.exec(new URL(c.req.url, 'http://x').pathname);
  if (!incoming.length && one && one[1] !== 'batch') {
    const id = decodeURIComponent(one[1]); const n = { cooldown_id: id, cooldown_started_date: new Date().toISOString() };
    const i = p.cooldowns.findIndex((x) => x.cooldown_id === id);
    if (i >= 0) p.cooldowns[i] = n; else p.cooldowns.push(n);
    saveState();
    return J(wrapped(cooldownMap(p.cooldowns)), `${id} started`);
  }
  saveState();
  return J(wrapped(cooldownMap(p.cooldowns)), `${incoming.length} cooldown(s) saved`);
}
function cooldownMap(list) { const m = {}; for (const x of list || []) if (x && x.cooldown_id) m[x.cooldown_id] = String(x.cooldown_started_date || ''); return m; }
function saveTrackers(c) {
  const p = playerFor(c.req); const b = c.body && typeof c.body === 'object' ? c.body : {};
  if (!p.trackers) p.trackers = { equipped: '', trackers: [] };
  if (typeof b.equipped === 'string') p.trackers.equipped = b.equipped;
  if (Array.isArray(b.trackers)) p.trackers.trackers = b.trackers;
  saveState();
  return J(wrapped(p.trackers), 'saved, guess');
}
const emptyDraft = () => ({ current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 });
const emptyBounties = () => ({ bounties: [], draft_data: emptyDraft(), draft_data_daily: emptyDraft(), draft_data_weekly: emptyDraft() });

// Each route: service name, method, path pattern, handler(ctx) -> reply.
// "guess" in a note means the exact shape is not known yet and may need changing.
// ---------------------------------------------------------------- parties (DF-PARTY-1147)
// Group up in Ramsgate and hunt together: a port of the 1.6.2 party code (backend/metagame social162, Oct 14), which
// follows Dauntless Revived's findings (AGPL-3.0). The game names players by their account id (26 characters).
// Parties live in memory while this backend runs (one host's game). A party of one answers exactly what the old
// stub answered, so solo play is unchanged.
const PARTY_MAX = 4;
const PARTY_INVITE_TTL_MS = 5 * 60 * 1000;
const PARTY_MEMBER_TIMEOUT_MS = 180 * 1000;     // not heard from (the game polls about every 10 s)
const PARTY_HUNT_FOLLOW_MS = 15 * 60 * 1000;   // members can still follow the leader's hunt this long after it started
// The party also follows the leader into the training grounds (1.6.2 and the live game did not). On for now: in 1.14.7 the
// training grounds are the one place every player can reach, so it is how a party gets somewhere together. false = old way.
const PARTY_FOLLOW_TRAINING = true;
const PARTY_HOME_SKIP = new Set(['ESCALATION', 'TRIALS']);   // DF-PARTY-ENDSCREEN: no "back with the leader" after these
const parties = new Map();      // partyId -> { id, leader, members: [accountId], created, build }
const partyOfAcc = new Map();   // accountId -> partyId (only parties of two or more)
const invitesTo = new Map();    // accountId -> [{ partyId, sender, senderName, at }]
const partySeen = new Map();    // accountId -> last poll
let partySweptAt = 0;
const isAcc = (x) => typeof x === 'string' && /^[A-Z2-7]{26}$/.test(x);
function keyOfAcc(acc) { for (const [k, p] of Object.entries(state.players)) if (p.accountId === acc) return k; return null; }
function playerOfAcc(acc) { const k = keyOfAcc(acc); return k ? state.players[k] : null; }
const nameOfAcc = (acc) => { const p = playerOfAcc(acc); return (p && p.username) || 'Slayer'; };
function partyIdFor(build) { return crypto.randomBytes(16).toString('hex') + '_' + Buffer.from(build || '647472_rel-1.14.7_shipping').toString('base64').replace(/=+$/, ''); }
let multiplayerPartiesLoaded=false;
function restoreMultiplayerParties(){
 if(multiplayerPartiesLoaded)return;multiplayerPartiesLoaded=true;
 for(const row of (Array.isArray(state.multiplayer1147Parties)?state.multiplayer1147Parties:[])){
  if(!row||typeof row.id!=='string'||!Array.isArray(row.members))continue;
  const members=[...new Set(row.members)].filter(a=>isAcc(a)&&playerOfAcc(a));
  if(members.length<2||members.length>PARTY_MAX||!members.includes(row.leader))continue;
  if(members.some(a=>partyOfAcc.has(a)))continue;
  const P={id:row.id,leader:row.leader,members,created:Date.now()};parties.set(P.id,P);
  for(const a of members){partyOfAcc.set(a,P.id);partySeen.set(a,Date.now());}
 }
}
function persistMultiplayerParties(){state.multiplayer1147Parties=[...parties.values()].map(p=>({id:p.id,leader:p.leader,members:[...p.members],created:p.created}));try{saveState();}catch(e){parties.clear();partyOfAcc.clear();multiplayerPartiesLoaded=false;restoreMultiplayerParties();throw e;}}
function availableMultiplayerCandidate(cd){
 if(!cd||cd.city!==false)return false;
 const srv=huntServer(cd.id);
 return !!(srv&&srv.id===cd.id)||Date.now()-(cd.asked||0)<=5*60*1000;
}
function groupOf(acc) { restoreMultiplayerParties();const id = partyOfAcc.get(acc); return id ? parties.get(id) || null : null; }
function partyLog(msg) { try { fs.appendFileSync(path.join(LOG_DIR, 'party.log'), `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* logs are optional */ } }
function partyRemove(P, acc, why) {
  if (!P || !P.members.includes(acc)) return;
  P.members = P.members.filter((m) => m !== acc);
  if (partyOfAcc.get(acc) === P.id) partyOfAcc.delete(acc);
  // DF-PARTY-NEWID: the one who left never gets the same id back either (2-PC test Oct 25: the leader left the automatic
  // party, was put back into a party with that same id 10 s later, and left it again 1.6 s after)
  { const lp = playerOfAcc(acc); if (lp && lp.partyId === P.id) lp.partyId = partyIdFor(P.id.includes('_') ? Buffer.from(P.id.slice(P.id.indexOf('_') + 1), 'base64').toString() : undefined); }
  if (P.members.length <= 1) {
    // one left: back to their own party of one. DF-PARTY-NEWID (Oct 24; reports 66 94): with a NEW solo party id. With
    // the old one, the next group reused the id the member's game had just left, and that game left it again ~7 s
    // after accepting (the first re-invite after an escalation; the second always held).
    for (const m of P.members) { const lp = playerOfAcc(m); if (lp) lp.partyId = partyIdFor(P.id.includes('_') ? Buffer.from(P.id.slice(P.id.indexOf('_') + 1), 'base64').toString() : undefined); }
    for (const m of P.members) partyOfAcc.delete(m);
    parties.delete(P.id);
    for (const [r, l] of invitesTo) invitesTo.set(r, l.filter((i) => i.partyId !== P.id));
  } else if (P.leader === acc) P.leader = P.members[0];
  persistMultiplayerParties();
  partyLog(`${acc} left ${P.id.slice(0, 8)} (${why}); ${P.members.length} left, leader ${P.leader}`);
}
function partySweep() {
  restoreMultiplayerParties();
  const now = Date.now();
  if (now - partySweptAt < 5000) return;
  partySweptAt = now;
  for (const P of [...parties.values()]) {
    for (const m of [...P.members]) {
      const seen = partySeen.get(m) || P.created;
      const lp = playerOfAcc(m);
      const loading = lp && lp.candidate && lp.candidate.city === false && now - (lp.candidate.asked || 0) < 5 * 60 * 1000;
      if (now - seen > PARTY_MEMBER_TIMEOUT_MS && !loading) partyRemove(P, m, `not heard from for ${Math.round((now - seen) / 1000)} s`);
    }
  }
  for (const [r, l] of invitesTo) {
    // an invite stays while its party exists: a group, or the inviter's own party of one (not in the list)
    const live = l.filter((i) => now - i.at < PARTY_INVITE_TTL_MS && (parties.has(i.partyId) || (playerOfAcc(i.sender) || {}).partyId === i.partyId));
    if (live.length) invitesTo.set(r, live); else invitesTo.delete(r);
  }
}
// The leader's hunt, while members can still follow it: { id, playerHuntId, live }
function partyHunt(P) {
  const lp = playerOfAcc(P.leader); const cd = lp && lp.candidate;
  if (leaderHome(cd)) return { id: cd.id, playerHuntId: null, gauntletLevel: null, live: !!liveServer(SERVER_FILE) };
  if (!cd || cd.city !== false || (!PARTY_FOLLOW_TRAINING && cd.gameType === 'TRAINING_GROUND') || !availableMultiplayerCandidate(cd)) return null;
  const srv = huntServer(cd.id);
  return { id: cd.id, playerHuntId: cd.playerHuntId || null, gauntletLevel: cd.gauntletLevel ?? null, live: !!(srv && srv.id === cd.id) };
}
function partyReply(P) {
  const hunt = partyHunt(P);
  return {
    candidateId: hunt ? hunt.id : null, candidateState: hunt ? (hunt.live ? 'IN_PROGRESS' : 'MATCHING') : null, gauntletLevel: hunt ? hunt.gauntletLevel : null,
    leaderPlayerId: P.leader, partyId: P.id, playerHuntId: hunt ? hunt.playerHuntId : null, playerIds: [...P.members],
    playerStates: P.members.map((m) => ({ consoleSessionId: null, displayName: nameOfAcc(m), isMemberOfCandidate: !!hunt, platform: 'win', playerId: m })),
  };
}
function soloReply(p, build) {
  if (!p.partyId) { p.partyId = partyIdFor(build); saveState(); }
  const cd = p.candidate || null;
  const srv=cd?(cd.city===false?huntServer(cd.id):liveServer(SERVER_FILE)):null;
  const ready=!!(srv&&(cd.city!==false||srv.id===cd.id));
  return { candidateId: cd ? cd.id : null, candidateState: cd ? (ready ? 'IN_PROGRESS' : 'MATCHING') : null, gauntletLevel: (cd && cd.gauntletLevel) ?? null, leaderPlayerId: p.accountId, partyId: p.partyId, playerHuntId: cd ? cd.playerHuntId : null,
    playerStates: [{ consoleSessionId: null, displayName: p.username, isMemberOfCandidate: !!cd, platform: 'win', playerId: p.accountId }] };
}
// DF-PARTY-REJOIN (Oct 24; reports 18 66 94, 7 escalations in one day): when the leader goes back to Ramsgate from an
// escalation or a trial, the members' games stay on the island, and about 2 s after the leader's player is gone from
// that island server they leave the party by themselves (leave, solo party, Return to Ramsgate; both members in the
// same second). Pulling them along did not help (Oct 22): the summary screen takes the city candidate and sits on it.
// So the drop is noted here, and the member is put back into the leader's party as soon as their game is in Ramsgate.
const PARTY_REJOIN_LEADER_HOME_MS = 90 * 1000;    // the leader went home this recently
const PARTY_REJOIN_TTL_MS = 180 * 1000;           // the member has this long to arrive
const PARTY_REJOIN_SETTLE_MS = 12 * 1000;         // after the member asked for Ramsgate (their game is loading it)
function partyNoteDrop(p, P) {
  // The game spends one more "leave" on the first party it is in after the drop, whoever made it (2-PC test Oct 25:
  // the automatic party was left 0.2 s after the poll showed it, the member's own next party 7 s after the leader
  // joined). So a party left within 20 s of an automatic rejoin is rejoined once more; the second one holds.
  const done = p.partyRejoinDone;
  if (done && done.leader === P.leader && Date.now() - done.at < 20 * 1000 && !done.again) {
    delete p.partyRejoinDone;
    p.partyRejoin = { leader: P.leader, from: done.from, at: Date.now(), until: Date.now() + PARTY_REJOIN_TTL_MS, again: true, notBefore: Date.now() + 4000 };
    partyLog(`${p.accountId} left the automatic party ${Math.round((Date.now() - done.at) / 1000)} s after joining it (the game's one-shot leave): rejoins once more`);
    return;
  }
  const lp = playerOfAcc(P.leader); const cd = lp && lp.candidate;
  if (!cd || cd.city === false || !cd.partyHome || Date.now() - (cd.asked || 0) > PARTY_REJOIN_LEADER_HOME_MS) return;
  if (!p.candidate || p.candidate.city !== false) return;   // the member is not on the island the leader just left
  p.partyRejoin = { leader: P.leader, from: cd.partyHome, at: Date.now(), until: Date.now() + PARTY_REJOIN_TTL_MS };
  partyLog(`${p.accountId} dropped out of ${P.id.slice(0, 8)} on the leader's way home from ${cd.partyHome}: rejoins automatically in Ramsgate`);
}
function partyRejoin(p, build) {
  const r = p.partyRejoin; if (!r) return;
  const now = Date.now();
  const drop = (why) => { delete p.partyRejoin; saveState(); if (why) partyLog(`${p.accountId} is not put back into the party: ${why}`); };
  if (now > r.until) return drop('too late');
  if (r.notBefore && now < r.notBefore) return;
  if (groupOf(p.accountId)) return drop('');   // grouped again by hand (an invite was accepted)
  const cd = p.candidate;
  if (!cd || cd.city === false || now - (cd.asked || 0) < PARTY_REJOIN_SETTLE_MS) return;   // not back in Ramsgate yet
  const lp = playerOfAcc(r.leader);
  if (!lp || now - (partySeen.get(r.leader) || 0) > 60 * 1000) return drop('the leader is gone');
  if (lp.candidate && lp.candidate.city === false) return drop('the leader is on a hunt again');
  let P = groupOf(r.leader);
  if (P) { if (P.members.length >= PARTY_MAX) return drop('the party is full'); }
  else {
    if (!lp.partyId) lp.partyId = partyIdFor(build);
    P = { id: lp.partyId, leader: r.leader, members: [r.leader], created: now };
    parties.set(P.id, P); partyOfAcc.set(r.leader, P.id);
  }
  P.members.push(p.accountId); partyOfAcc.set(p.accountId, P.id);
  P.autoAt = now; P.autoAgain = !!r.again;   // the leader's game may spend its own one-shot leave on this party
  invitesTo.set(p.accountId, (invitesTo.get(p.accountId) || []).filter((i) => i.sender !== r.leader));
  partyPresence(p, P);   // DF-PARTY-PRESENCE
  delete p.partyRejoin; p.partyRejoinDone = { leader: r.leader, from: r.from, at: now, again: !!r.again }; persistMultiplayerParties();
  partyLog(`${p.accountId} rejoined ${P.id.slice(0, 8)} automatically${r.again ? ' (second time)' : ''} (leader ${P.leader}, back from ${r.from}); ${P.members.length} members`);
}
// DF-PARTY-PRESENCE (Oct 25, the guest's own log): "UArchonPartyPrimary::UpdateParty - Leaving party due to all members
// being offline". The game takes a party member's online state from chat presence; this chat server sends none
// (no friends store), so a member counts as online only once its game has joined the party's chat room and seen the
// others there. When the party poll came first (after an escalation, or right after an accept) the game left.
// Every party poll now tells the polling game, over chat, that its party members are online (from their own
// chat sessions, both under their sign-in id and under their account id).
function partyPresence(p, P) {
  try {
    if (!P || !chat || !chat.byUid || typeof chat.send !== 'function') return;
    const sessionsOf = (acc) => { const q = playerOfAcc(acc); const uid = q && String(q.epicId || '').toLowerCase(); return ((uid && chat.byUid.get(uid)) || []).filter((S) => S && !S.Ended && S.Uid && S.Resource && S.Domain); };
    // every member hears every other member (2-PC test: the guest, told at the accept, stayed; the leader, told
    // only later, left), whoever's poll it is
    for (const a of P.members) for (const b of P.members) {
      if (a === b) continue;
      const to = sessionsOf(b); if (!to.length) continue;
      for (const S of sessionsOf(a)) for (const T of to) {
        for (const from of [`${S.Uid}@${S.Domain}/${S.Resource}`, `${a}@${S.Domain}/${S.Resource}`])
          chat.send(T, `<presence xmlns="jabber:client" from="${from}" to="${T.Uid}@${T.Domain}/${T.Resource}"/>`);
      }
    }
  } catch (e) { /* presence is a hint; the party itself never depends on it */ }
}
function partyPoll(p, build) {
  partySeen.set(p.accountId, Date.now()); partySweep();
  partyRejoin(p, build);   // DF-PARTY-REJOIN
  partyPresence(p, groupOf(p.accountId));   // DF-PARTY-PRESENCE
  const P = groupOf(p.accountId);
  return P ? J(partyReply(P), `party of ${P.members.length}${P.leader === p.accountId ? ' (leader)' : ''}`) : J(soloReply(p, build), 'solo party');
}
function partyInvite(p, to, build) {
  partySeen.set(p.accountId, Date.now()); partySweep();
  if (!isAcc(to) || to === p.accountId || !playerOfAcc(to)) return { status: 404, json: {}, note: 'party invite: no such player on this server' };
  let P = groupOf(p.accountId);
  if (P && P.leader !== p.accountId) return { status: 403, json: {}, note: 'party invite: only the leader invites' };
  if (P && P.members.includes(to)) return J(partyReply(P), 'party invite: already in the party');
  if (P && P.members.length >= PARTY_MAX) return { status: 409, json: {}, note: 'party invite: party is full' };
  // the inviter's own party id until someone joins (the game already knows it from the poll)
  const partyId = P ? P.id : (p.partyId || (p.partyId = partyIdFor(build)));
  const l = (invitesTo.get(to) || []).filter((i) => i.sender !== p.accountId);
  l.push({ partyId, sender: p.accountId, senderName: p.username || 'Slayer', at: Date.now() });
  invitesTo.set(to, l.slice(-10));
  partyLog(`${p.accountId} invited ${to} (party ${partyId.slice(0, 8)})`);
  return J(P ? partyReply(P) : soloReply(p, build), `party invite sent to ${nameOfAcc(to)}`);
}
function partyAccept(p, id) {
  partySeen.set(p.accountId, Date.now()); partySweep();
  const l = invitesTo.get(p.accountId) || [];
  const inv = l.find((i) => i.partyId === id) || l.find((i) => i.sender === id) || (l.length === 1 ? l[0] : null);
  if (!inv) {
    const mine = groupOf(p.accountId);
    if (mine && (mine.id === id || mine.members.includes(String(id)))) return J(partyReply(mine), 'party accept: already in that party');
    return { status: 404, json: {}, note: 'party accept: no such invite' };
  }
  invitesTo.set(p.accountId, l.filter((i) => i !== inv));
  const inviter = playerOfAcc(inv.sender);
  if (!inviter) return { status: 404, json: {}, note: 'party accept: the inviter is gone' };
  let P = groupOf(inv.sender);
  if (!P) {
    // the inviter was alone: their solo party becomes the group (same id the game already knows)
    if (inviter.partyId !== inv.partyId) return { status: 404, json: {}, note: 'party accept: that party is gone' };
    P = { id: inv.partyId, leader: inv.sender, members: [inv.sender], created: Date.now() };
    parties.set(P.id, P); partyOfAcc.set(inv.sender, P.id);
  } else if (P.id !== inv.partyId) return { status: 404, json: {}, note: 'party accept: that party is gone' };
  if (P.members.length >= PARTY_MAX) return { status: 409, json: {}, note: 'party accept: party is full' };
  const old = groupOf(p.accountId);
  if (old && old !== P) partyRemove(old, p.accountId, 'joined another party');
  if (!P.members.includes(p.accountId)) P.members.push(p.accountId);
  partyOfAcc.set(p.accountId, P.id);
  partySeen.set(inv.sender, partySeen.get(inv.sender) || Date.now());
  persistMultiplayerParties();
  partyLog(`${p.accountId} joined ${P.id.slice(0, 8)} (leader ${P.leader}); ${P.members.length} members`);
  partyPresence(p, P);   // DF-PARTY-PRESENCE
  return J(partyReply(P), `joined ${nameOfAcc(P.leader)}'s party (${P.members.length})`);
}
function partyDecline(p, b) {
  b = b && typeof b === 'object' ? b : {};
  if (b.recipientPlayerId === undefined || b.recipientPlayerId === p.accountId) {
    invitesTo.set(p.accountId, (invitesTo.get(p.accountId) || []).filter((i) => !((b.sendingPlayerId === undefined || i.sender === b.sendingPlayerId) && (b.partyId === undefined || i.partyId === b.partyId))));
  } else if (isAcc(b.recipientPlayerId)) {
    invitesTo.set(b.recipientPlayerId, (invitesTo.get(b.recipientPlayerId) || []).filter((i) => i.sender !== p.accountId));
  }
  return J({}, 'party invite declined or withdrawn');
}
function partyLeave(p) {
  const P = groupOf(p.accountId);
  if (P && P.leader !== p.accountId) partyNoteDrop(p, P);   // DF-PARTY-REJOIN
  // The leader's game does the same one-shot leave (2-PC test Oct 25: 2.8 s after the automatic rejoin, the member
  // stayed). Its members are put back once more, into the same leader's party.
  if (P && P.leader === p.accountId && P.autoAt && !P.autoAgain && Date.now() - P.autoAt < 20 * 1000) {
    for (const m of P.members) {
      if (m === p.accountId) continue; const mp = playerOfAcc(m); if (!mp) continue;
      mp.partyRejoin = { leader: p.accountId, from: 'the leader\'s one-shot leave', at: Date.now(), until: Date.now() + PARTY_REJOIN_TTL_MS, again: true, notBefore: Date.now() + 4000 };
      delete mp.partyRejoinDone;
    }
    partyLog(`${p.accountId} (leader) left the automatic party ${Math.round((Date.now() - P.autoAt) / 1000)} s after it formed (the game's one-shot leave): the party is put back once more`);
  }
  if (P) partyRemove(P, p.accountId, 'left');
  return J({}, P ? 'left the party' : 'not in a party');
}
function partyKick(p, m) {
  const P = groupOf(p.accountId);
  if (!P || P.leader !== p.accountId || m === p.accountId || !P.members.includes(m)) return { status: 403, json: {}, note: 'party kick: not allowed' };
  partyRemove(P, m, `kicked by ${p.accountId}`); return J({}, 'kicked from the party');
}
function partyPromote(p, m) {
  const P = groupOf(p.accountId);
  if (!P || P.leader !== p.accountId || !P.members.includes(m)) return { status: 403, json: {}, note: 'party promote: not allowed' };
  P.leader = m; persistMultiplayerParties(); partyLog(`${p.accountId} made ${m} leader of ${P.id.slice(0, 8)}`); return J({}, `${nameOfAcc(m)} leads the party`);
}
function partyEvictLeader(p, leader) {
  const P = groupOf(p.accountId);
  if (!P || P.leader !== leader || !P.members.includes(p.accountId)) return { status: 403, json: {}, note: 'party evict: not allowed' };
  if (Date.now() - (partySeen.get(leader) || 0) < 60 * 1000) return { status: 409, json: {}, note: 'party evict: the leader is still here' };
  partyRemove(P, leader, `evicted as offline by ${p.accountId}`); return J({}, 'offline leader removed');
}
function partyStatus(p, ids) {
  partySeen.set(p.accountId, Date.now()); partySweep();
  const out = [], seen = new Set();
  for (const id of (Array.isArray(ids) ? ids.filter(isAcc).slice(0, 16) : [])) {
    const P = groupOf(id);
    if (P && !seen.has(P.id)) { seen.add(P.id); out.push(partyReply(P)); }
  }
  return J({ parties: out, invitations: partyInvitesOf(p).invitations });
}
function partyInvitesOf(p) {
  partySeen.set(p.accountId, Date.now()); partySweep();
  return { invitations: (invitesTo.get(p.accountId) || []).map((i) => ({ partyId: i.partyId, recipientPlayerId: p.accountId, sendingDisplayName: i.senderName, sendingPlatform: 'win', sendingPlayerId: i.sender })) };
}
// For matchmaking: the hunt a party member should be sent to (their leader's), or null
// DF-PARTY-HOME: party mates move with their leader, so they never count as "someone else is in that hunt".
function partyMateKeys(p) { const P = groupOf(p.accountId); return new Set(P ? P.members.map(keyOfAcc).filter(Boolean) : []); }
// DF-PARTY-HOME: the leader went back to Ramsgate from a hunt in the last 2 minutes (members in that hunt go too)
function leaderHome(cd) { return !!(cd && cd.city !== false && cd.returnFrom && Date.now() - (cd.asked || 0) < 120000); }
function partyFollowTarget(p, askedId) {
  const P = groupOf(p.accountId);
  if (!P || P.leader === p.accountId) return null;
  const lp = playerOfAcc(P.leader); const cd = lp && lp.candidate;
  if (leaderHome(cd)) { const mine = p.candidate; return mine && mine.city === false && mine.id === cd.returnFrom && (!askedId || askedId === cd.id) ? cd : null; }
  if (!cd || cd.city !== false || !cd.url || (!PARTY_FOLLOW_TRAINING && cd.gameType === 'TRAINING_GROUND') || !availableMultiplayerCandidate(cd)) return null;
  if (askedId && askedId !== cd.id) return null;
  return cd;
}

const routes = [
  ['login-queue', 'POST', /^\/login\/?$/, () => J({ error_code: 'TicketRateOk', message: '', state: 'OPEN', timeout: 8000, title: '' })],   // captured
  ['login-queue', 'GET', /^\/maintenance\/status\/?$/, () => J({ 'show-status': false })],                                                // captured

  ['gamesession', 'GET', /^\/features\/platform\/[^/]+\/?$/, () => J(wrapped({ crossplay: true, crossprogression: true }))],   // captured
  ['gamesession', 'GET', /^\/account\/link\/[^/]+\/[^/]*\/?$/, () => J(wrapped({ isLinked: true }))],
  ['gamesession', 'PUT', /^\/gamesession\/[^/]+\/?$/, (c) => {
    const key = playerKeyFromEpicToken(bearerOf(c.req));
    if (guestRequest(c.req)) {   // DF-HOSTGUARD-1147
      const sub = String(epicSubOf(bearerOf(c.req)) || '').toLowerCase();
      if (!sub || sub === DEFAULT_EPIC_ID || key === HOST_KEY) {
        console.log(`HOSTGUARD: refused a joiner (${c.req.socket.remoteAddress}) signing in as the host's account (${sub ? 'id ' + sub.slice(0, 8) : 'no id'}). Their game is not using its join sign-in: update their 1.14.7 server files and join again.`);
        return { status: 403, json: { error_code: 'DF_HOSTGUARD', message: 'This game tried to sign in as the host. Update your 1.14.7 server files and join again.' }, note: 'hostguard: joiner signed in as the host' };
      }
    }
    const player = getPlayer(key);
    player.epicId = epicSubOf(bearerOf(c.req)) || player.epicId || '';
    const dn = epicNameOf(bearerOf(c.req));
    if (dn) player.username = dn;   // DF-NAME-1147
    leavePlace(key);
    delete player.candidate;   // a fresh sign-in releases its previous hunt lease
    if (!guestRequest(c.req)) state.lastPlayer = key;   // DF-HOSTGUARD-1147: a joiner is never "the last player"
    saveState();
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, key);
    return J(wrapped({ error_code: null, sessionid: crypto.randomBytes(16).toString('hex'), sessiontoken: token }), `player ${player.accountId.slice(0, 8)}`);
  }],
  ['gamesession', 'PUT', /^\/account\/?$/, (c) => {
    const player = playerFor(c.req);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, keyFor(c.req));
    return J(wrapped({ id: player.accountId, sessiontoken: token }), 'guess');
  }],

  ['auth', 'GET', /^\/accountinfo\/?$/, (c) => {
    const p = playerFor(c.req);
    if (p.headStart && p.username && p.username !== 'Slayer') { for (const ch of p.characters || []) if (ch && ch.name === 'Slayer') ch.name = p.username; delete p.headStart; saveState(); }   // DF-HEADSTART-1147: the seeded character takes the player's name once sign-in has set it
    return J({ accountId: p.accountId, creationDate: `${p.created || '2026-01-01'} 00:00:00`, email: null, preferredLanguage: null, username: p.username, verified: false });
  }],
  ['auth', 'GET', /^\/tags\/?$/, (c) => J({ accountId: playerFor(c.req).accountId, tags: [] })],   // captured
  ['auth', 'GET', /^\/isbanned\/?$/, () => J({ isBanned: false })],                                   // captured
  // Entitlements (unlock flags). The game server grants some as quest rewards; the reply to a grant is the whole list
  // (shape read from the game: { entitlements: [{ name, duration, activatedDate }] }).
  ['auth', 'GET', /^\/entitlementsv2\/?$/, (c) => { const e = playerFor(c.req).entitlements || []; return J({ entitlements: e }, e.length ? `${e.length} entitlement(s)` : undefined); }],
  ['auth', 'POST', /^\/entitlementv2\/[^/]*\/?$/, (c) => {
    const p = playerFor(c.req); if (!p.entitlements) p.entitlements = [];
    const b = c.body && typeof c.body === 'object' ? c.body : {}; const name = typeof b.entitlement === 'string' ? b.entitlement : '';
    if (!name) return { status: 400, note: 'no entitlement named' };
    const dur = Number(b.duration) || 0;
    const e = { activatedDate: dur ? new Date().toISOString().slice(0, 19) : null, duration: dur, name };
    const i = p.entitlements.findIndex((x) => x.name === name);
    if (i >= 0) p.entitlements[i] = e; else p.entitlements.push(e);
    saveState();
    return J({ entitlements: p.entitlements }, `granted ${name}`);
  }],
  ['auth', 'POST', /^\/accountinfo\/public\/?$/, (c) => {                                             // captured
    const p = playerFor(c.req);
    const asked = (c.body && c.body.accountId) || p.accountId;
    const who = asked === p.accountId ? p : playerOfAcc(asked);   // DF-PARTY-1147: other players on this server have names too
    return J({ accountId: asked, isSubscribed: false, language: null, linkedAccounts: [{ accountId: who ? (who.epicId || '') : '', accountType: 'epic' }], username: who && who !== p ? (who.username || null) : null });
  }],
  ['auth', 'POST', /^\/account\/mapping\/?$/, (c) => {                                                // captured
    const p = playerFor(c.req);
    const map = {};
    for (const id of (c.body && Array.isArray(c.body.ids) ? c.body.ids : [])) if (id === p.epicId) map[id] = { accountId: p.accountId, accountType: 'phoenix' };
    return J({ accountMappings: map, sourceAccountType: (c.body && c.body.srcAccountType) || 'epic' });
  }],

  ['dauntless', 'GET', /^\/character\/?$/, (c) => { const p = playerFor(c.req); return J(p.characters.map((ch) => charOut(p, ch))); }],
  ['dauntless', 'PUT', /^\/character\/?$/, (c) => {
    const p = playerFor(c.req);
    const name = (c.body && typeof c.body.name === 'string' && c.body.name) || 'Slayer';
    const ch = { id: newId(), name, updateVersion: 0, data: null, created: today() };
    p.characters.push(ch); saveState();
    return J(charOut(p, ch));
  }],
  ['dauntless', 'POST', /^\/character\/?$/, (c) => {
    const p = playerFor(c.req);
    const b = c.body || {};
    const ch = p.characters.find((x) => x.id === b.characterId) || p.characters[0];
    if (!ch) return NOT_FOUND;
    // Several game copies save the same character (Ramsgate, training grounds, each hunt, the client). A copy that
    // loaded the character earlier still holds the old data and saves it when the player leaves, which used to wipe
    // newer quest progress. Each save carries the version it is based on + 1, so a save at or below the stored
    // version is out of date: answer 409 Conflict. The game handles that itself ("Conflict Detected, Clearing Cache
    // & Retrying"): it fetches the character again and resends on top of the newer data.
    const cur = typeof ch.updateVersion === 'number' ? ch.updateVersion : 0;
    if (typeof b.updateVersion === 'number' && b.updateVersion <= cur && ch.data != null) {
      return { status: 409, json: { errorCode: 'errors.com.epicgames.conflict', errorMessage: 'updateVersion is out of date', numericErrorCode: 409 },
        note: `out-of-date save refused: v${b.updateVersion}, stored v${cur}` };
    }
    if (typeof b.data === 'string' || b.data === null) ch.data = b.data;
    if (typeof b.updateVersion === 'number') ch.updateVersion = b.updateVersion; // stored exactly as sent
    saveState();
    return J(charOut(p, ch), `saved v${ch.updateVersion}`);
  }],
  ['dauntless', 'GET', /^\/character\/([A-Z2-7]{26})\/?$/, (c) => {
    const p = playerFor(c.req);
    const ch = p.characters.find((x) => x.id === c.match[1]);
    return ch ? J(charOut(p, ch), 'guess') : NOT_FOUND;
  }],
  ['dauntless', 'GET', /^\/inventory\/([^/]*)\/([^/]*)\/?$/, (c) => {
    const p = playerFor(c.req);
    const inv = inventoryOf(p, c.match[2]); saveState();
    return J(inv);
  }],
  // "Has this character's inventory been migrated to this game version?" - nothing to migrate.
  ['dauntless', 'POST', /^\/inventory\/([A-Z2-7]{26})\/([^/]+)\/?$/, () => J({ code: 'NONE', message: '' })],   // captured
  ['dauntless', 'POST', /^\/inventory\/?$/, (c) => {
    const p = playerFor(c.req);
    const b = c.body || {};
    // DF-LOADOUT-SLOT: the game pays for a Slayer's Path loadout node here and asks for the new slot right after,
    // but saves the node itself only with its next full path save (up to 30 s later). Record the node now.
    { const ls = /^PJM Unlock: (LoadoutSlot_0[1-5])$/.exec(String(b.source || ''));
      if (ls) { const m = pjmOf(p); const n = m.nodes[ls[1]]; if (!n || n.node_status !== 2) m.nodes[ls[1]] = Object.assign({ node_id: ls[1], objectives: [] }, n || {}, { node_status: 2 }); } }
    const transaction=typeof b.transactionId==='string'&&b.transactionId.length<=128?b.transactionId:null;
    const digest=crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
    const history=p.inventoryTransactions||[];
    const prior=transaction&&history.find(x=>x.id===transaction&&x.character===b.characterId);
    if(prior) {
      if(prior.digest!==digest)throw quality.httpError(409,'Inventory transactionId was reused with different data');
      return J(prior.result,'repeated inventory request; already saved');
    }
    // Work on a copy: a rejected batch must never leave half its changes in memory.
    const inv=JSON.parse(JSON.stringify(inventoryOf(p,b.characterId)));
    const reforge = isReforgeSpend(b);   // DF-REFORGE-1147
    const tx = reforge ? Object.assign({}, b, { addStackedItems: [{ catalogId: REFORGE_HEART, quantity: 1 }] }) : b;
    const result = applyInventory(inv,tx);
    if (reforge) { p.reforgePaidAt = Date.now(); reforgeLog(`${p.accountId}: reforge spark spend, Aetherheart paid in the same transaction`); }
    p.inventory[b.characterId||p.characters[0]?.id||'none']=inv;
    if(transaction){history.push({id:transaction,character:b.characterId,digest,result});p.inventoryTransactions=history.slice(-128);}
    saveState();return J(result);
  }],

  ['tracking', 'POST', /^\/heartbeat\/?$/, () => TEXT('20000', 'guess')],

  // Matchmaking, first steps only. The region list points back at this recorder so the game's
  // latency test stays on this PC.
  ['mm2', 'POST', /^\/candidate\/player\/register\/?$/, () => J({})],                                // captured
  ['mm2', 'GET', /^\/candidate\/regions\/?$/, (c) => J({ code: 200, message: 'success', payload: { maxPingingStepTime: 3, pingCount: 5, pingFrequency: 0.25, regionUrls: [`http://${PUBLIC_HOST || '127.0.0.1'}:${PUBLIC_BACKEND_PORT || c.basePort}`] } })],
  ['_external', 'GET', /^\/$/, () => ({ status: 200, html: '<!DOCTYPE html><html><body>pong</body></html>', note: 'latency ping' })],

  // Matchmaking proper. There is no matchmaker: the "match" is the local game server started by
  // server-211.ps1. While that server is not up the game is told it is still matching, so it waits.
  ['mm2', 'POST', /^\/candidate\/join(\/[^/]*)?\/?$/, (c) => {
    const p = playerFor(c.req); const b = c.body || {};
    maintainPlace(keyFor(c.req));
    const dest = destinationFor(b);
    // DF-PARTY-1147: a party member joining their leader's hunt (by its candidate id, or by asking for any hunt
    // while the leader is out there) goes to the leader's server.
    const askedId = c.match[1] ? decodeURIComponent(c.match[1].slice(1)) : '';
    const follow = partyFollowTarget(p, askedId || null);
    if (follow && follow.city !== false) { dest.city = true; delete dest.url; dest.label = 'Ramsgate (with the party)'; }
    else if (follow && (askedId || !dest.city)) {
      dest.city = false; dest.url = follow.url; dest.label = follow.label + ' (with the party)'; delete dest.note;
      b.playerHuntId = follow.playerHuntId || b.playerHuntId; b.gameMode = follow.gameMode; b.hunts = follow.huntId ? [follow.huntId] : b.hunts;
    }
    // DF-FOREVERHUNTS-1147 (Oct 23): hunts open to everyone (Game Rule forever_hunts = max players, 0 = off). A hunt
    // started under it is a shared place: anyone asking for the same hunt joins it (the game's own drop-in arrival)
    // while there is room and the behemoth is alive; a party that does not fit gets its own hunt. Not for trials,
    // Gauntlet, escalations, the tutorial or the Training Grounds.
    const fhMax = Number(gameRules.settings.forever_hunts) || 0;
    const fhOk = fhMax > 1 && !dest.city && !!dest.url && !follow && !['TRIALS', 'GAUNTLET', 'TRAINING_GROUND', 'FTUE', 'ESCALATION'].includes(String(b.gameType || ''));
    if (fhOk) dest.url = /\?MaxPlayers=\d+/.test(dest.url) ? dest.url.replace(/\?MaxPlayers=\d+/, `?MaxPlayers=${fhMax}`) : dest.url + `?MaxPlayers=${fhMax}`;
    // The second server needs to know which player hunt each player is on: quest objectives check it
    // (UObjective::HasRequiredPlayerHuntTags / IsInRequiredRegion). The game server reads it from the map option
    // PlayerHuntIds=<account>:<player hunt>[,...] (UHuntSystemComponent::ReadPlayerHuntIDFromCommandLine). Oct 17.
    if (!dest.city && dest.url && /^[A-Za-z0-9_]{1,100}$/.test(String(b.playerHuntId || '')) && !/[?]PlayerHuntIds=/.test(dest.url)) {
      const grp = groupOf(p.accountId);   // DF-PARTY-1147: the whole party's player hunts when the leader starts it
      const accs = grp && grp.leader === p.accountId ? grp.members : [p.accountId];
      dest.url += `?PlayerHuntIds=${accs.map((a) => `${a}:${b.playerHuntId}`).join(',')}`;
    }
    // DF-MULTIHUNT-1147: a player joins their party's place for this map (Training Grounds: anyone's); everyone else
    // gets their own hunt server, so players who are not grouped can hunt different places at the same time.
    const me = keyFor(c.req);
    const mates = partyMateKeys(p);
    let joinId = null, fhPlaceId = null;   // DF-FOREVERHUNTS-1147
    if (!dest.city) {
      const base = placeBase(dest.url);
      const mine = placeOf(me);
      const ours = (pl) => [...pl.owners].every((k) => k === me || mates.has(k));
      // DF-WARM-1147: with Trials Quick Retry on, a retry of the trial the player (and only their party) is already
      // in asks for a FRESH server under a new id, so tools\server-1147.ps1 hands over the spare it kept warm.
      if (mine && mine.base === base && b.gameType === 'TRIALS' && trialsRetryOn() && ours(mine)) {
        for (const k of [...mine.owners]) leavePlace(k);
        console.log('Trials Quick Retry: a retry: asking for a fresh trial server (the spare takes over)');
      }
      const join = (follow && places.get(follow.id)) || [...places.values()].find((pl) => pl.base === base && pl.owners.size && (ours(pl) || (b.gameType === 'TRAINING_GROUND' && pl.reuse) || (fhOk && pl.forever && foreverRoom(pl, me, mates, fhMax))));   // DF-FOREVERHUNTS-1147: an open hunt with room is joined
      if (join) {
        if (placeOf(me) && placeOf(me) !== join) leavePlace(me);
        join.owners.add(me); joinId = join.id; dest.url = join.url || dest.url;
        if (fhOk && join.forever) { fhPlaceId = join.id; joinId = 'local1$' + crypto.randomBytes(16).toString('hex'); }   // DF-FOREVERHUNTS-1147: fresh match id, same place
      }
      else if (follow) {
        // the leader's place is not (or no longer) being served: ask for it again under the same id
        leavePlace(me);
        addPlace({ id: follow.id, url: dest.url, base, label: dest.label, at: Date.now(), owners: new Set([me, keyOfAcc(groupOf(p.accountId).leader)].filter(Boolean)) }, false);
        joinId = follow.id;
      }
    } else leavePlace(me);
    const prevPlaceId = p.candidate && p.candidate.city === false ? p.candidate.id : null;
    const prevType = p.candidate && p.candidate.city === false ? p.candidate.gameType : null;   // DF-PARTY-ENDSCREEN
    p.candidate = { id: joinId || ('local1$' + crypto.randomBytes(16).toString('hex')), gameMode: b.gameMode || 'CITY', gameType: b.gameType || null,
      huntId: Array.isArray(b.hunts) && b.hunts.length ? b.hunts[0] : null, playerHuntId: b.playerHuntId || null, gauntletLevel: b.gameType === 'GAUNTLET' ? b.gauntlet_level : null,
      buildId: b.buildId || '647472_rel-1.14.7_shipping', gameSessionId: crypto.randomBytes(16).toString('hex'),
      city: dest.city, url: dest.url || null, label: dest.label, asked: Date.now(), placeId: fhPlaceId || undefined };   // DF-FOREVERHUNTS-1147
    // DF-PARTY-HOME: the leader's way home is offered to the party. DF-PARTY-ENDSCREEN (Oct 22): not after an escalation
    // or a trial. Those end on the game's own results screen: the members' games did not take the trip there, left the
    // party, and for about 3 minutes left again after every re-invite (report 18). They come home by themselves.
    // Hunts and patrols keep it (the party comes back with the leader).
    if (dest.city && prevPlaceId && !PARTY_HOME_SKIP.has(String(prevType || ''))) p.candidate.returnFrom = prevPlaceId;
    else if (dest.city && prevPlaceId && groupOf(p.accountId) && groupOf(p.accountId).leader === p.accountId) {
      p.candidate.partyHome = String(prevType || '');   // DF-PARTY-REJOIN: members dropping out on this trip are put back
      partyLog(`${p.accountId} goes back to Ramsgate after ${prevType}: the party is not pulled along (the game brings them back itself; members are put back into the party in Ramsgate)`);
    }
    // Outside the city: ask server-211.ps1 (through a small file) to start a second server on that map.
    if (!dest.city && !joinId) {
      leavePlace(me);
      addPlace({ id: p.candidate.id, url: dest.url, base: placeBase(dest.url), label: dest.label, at: Date.now(), owners: new Set([me]), forever: fhOk }, b.gameType === 'TRAINING_GROUND');   // DF-FOREVERHUNTS-1147
    }
    saveState();
    return J({ candidateId: p.candidate.id, gameMode: p.candidate.gameMode, huntId: null, status: 'MATCHING', statusReason: null },
      dest.label + (dest.note ? ' - ' + dest.note : dest.city ? '' : ' - asking for a server on ' + dest.url.split('?')[0]));
  }],
  ['mm2', 'GET', /^\/candidate\/status\/?$/, (c) => {
    const p = playerFor(c.req);
    maintainPlace(keyFor(c.req));
    // DF-PARTY-1147: a party member whose leader is on a hunt is sent there (the game asks for this status as soon
    // as the party poll shows the leader's candidate)
    const follow = partyFollowTarget(p, null);
    const mates = partyMateKeys(p);
    const busyElse = false;   // DF-MULTIHUNT-1147: the leader's place always gets its own hunt server
    if (follow && follow.city !== false && p.candidate && p.candidate.id !== follow.id) {   // DF-PARTY-HOME: back to Ramsgate with the leader
      leavePlace(keyFor(c.req));
      p.candidate = { id: follow.id, gameMode: 'CITY', gameType: null, huntId: null, playerHuntId: null, buildId: follow.buildId,
        gameSessionId: crypto.randomBytes(16).toString('hex'), city: true, url: null, label: 'Ramsgate (with the party)', asked: Date.now() };
      saveState(); partyLog(`${p.accountId} goes back to Ramsgate with the leader`);
    }
    if (follow && follow.city === false && !busyElse && (!p.candidate || p.candidate.id !== follow.id)) {
      const me = keyFor(c.req);
      if (p.candidate && p.candidate.city === false) leavePlace(me);
      p.candidate = { id: follow.id, gameMode: follow.gameMode, gameType: follow.gameType, huntId: follow.huntId, playerHuntId: follow.playerHuntId,
        buildId: follow.buildId, gameSessionId: crypto.randomBytes(16).toString('hex'), city: false, url: follow.url, label: follow.label + ' (with the party)', asked: Date.now() };
      const fpl = places.get(follow.id);
      if (fpl) fpl.owners.add(me);
      else addPlace({ id: follow.id, url: follow.url, base: placeBase(follow.url), label: follow.label, at: Date.now(), owners: new Set([me, keyOfAcc(groupOf(p.accountId).leader)].filter(Boolean)) }, false);
      saveState();
      partyLog(`${p.accountId} follows the leader to ${follow.label}`);
    }
    const cd = p.candidate;
    if (!cd) return { status: 404, note: 'no match was asked for' };
    const city = cd.city !== false;
    const cdPlace = cd.placeId || cd.id;   // DF-FOREVERHUNTS-1147: a rejoin's match id differs from its place id
    let srv = city ? liveServer(SERVER_FILE) : huntServer(cdPlace);
    if (srv && !city && srv.id !== cdPlace) srv = null;                       // a server for an earlier destination
    const out = { candidateId: cd.id, candidateStatusPeriodMillis: srv ? 10000 : 3000, gameMode: cd.gameMode, huntId: cd.huntId, playerStates: { [p.accountId]: {} } };
    if (srv) out.serverInfo = { buildId: cd.buildId, gameSessionId: cd.gameSessionId, host: (PUBLIC_HOST && (!srv.host || srv.host === '127.0.0.1')) ? PUBLIC_HOST : (srv.host || '127.0.0.1'), port: srv.port + (PUBLIC_HOST ? PUBLIC_PORT_OFFSET : 0) };
    const waited = Math.round((Date.now() - (cd.asked || Date.now())) / 1000);
    // DF-FIX4: tools\server-1147.ps1 says why the hunt server failed; the game then stops searching right away
    let why = '';
    if (!srv && !city) { try { const f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'server_hunt_failed.json'), 'utf8')); if (f && f.id === cd.id && f.reason) why = String(f.reason); } catch (e) { /* none */ } }
    const failed = !srv && !city && (!!why || waited > 300);
    out.status = srv ? 'IN_PROGRESS' : failed ? 'FAILED' : 'MATCHING'; out.statusDuration = 0.0; out.statusReason = failed ? (why || 'no server started for this destination') : null;
    if (why && !cd.failedSaid) { cd.failedSaid = true; console.log('HUNT SERVER FAILED: ' + why); }
    if(failed){const fp=places.get(cd.id);if(fp){fp.owners.delete(keyFor(c.req));if(!fp.owners.size)dropPlace(fp);}}
    return J(out, srv ? `game server on port ${srv.port}` : failed ? 'gave up after 5 minutes: no server came up for this destination'
      : city ? 'waiting: the game server is not running' : `waiting ${waited}s for the second server (${liveServer(SERVER_FILE) ? 'starting' : 'server-211.ps1 -Run is not running'})`);
  }],
  ['mm2', 'POST', /^\/candidate\/leave\/?$/, (c) => { const p = playerFor(c.req); if (p.candidate && p.candidate.city === false) leavePlace(keyFor(c.req)); delete p.candidate; saveState(); return J({}, 'guess'); }],
  ['mm2', 'DELETE', /^\/candidate\/?$/, (c) => { const p = playerFor(c.req); if (p.candidate && p.candidate.city === false) leavePlace(keyFor(c.req)); delete p.candidate; saveState(); return J({}, 'guess'); }],
  ['mm2', 'DELETE', /^\/party\/member\/?$/, (c) => partyLeave(playerFor(c.req))],                        // captured (DF-PARTY-1147)
  ['mm2', 'DELETE', /^\/party\/member\/([^/]+)\/?$/, (c) => partyKick(playerFor(c.req), decodeURIComponent(c.match[1]))],
  ['mm2', 'PUT', /^\/party\/member\/promote\/([^/]+)\/?$/, (c) => partyPromote(playerFor(c.req), decodeURIComponent(c.match[1]))],
  ['mm2', 'DELETE', /^\/party\/leader\/([^/]+)\/?$/, (c) => partyEvictLeader(playerFor(c.req), decodeURIComponent(c.match[1]))],
  ['mm2', 'PUT', /^\/party\/invite\/?$/, (c) => partyInvite(playerFor(c.req), c.body && c.body.recipientPlayerId, c.body && c.body.buildId)],
  ['mm2', 'PUT', /^\/party\/invite\/accept\/([^/]+)\/?$/, (c) => partyAccept(playerFor(c.req), decodeURIComponent(c.match[1]))],
  ['mm2', 'DELETE', /^\/party\/invite\/?$/, (c) => partyDecline(playerFor(c.req), c.body)],
  ['mm2', 'POST', /^\/party\/status\/?$/, (c) => partyStatus(playerFor(c.req), c.body && c.body.playerIds)],
  ['mm2', 'POST', /^\/candidate\/player\/ready\/?$/, () => J({}, 'guess')],
  ['mm2', 'PUT', /^\/candidate\/player\/ready\/?$/, () => J({}, 'guess')],
  ['mm2', 'POST', /^\/candidate\/player\/[^/]+\/loadout\/?$/, () => J({}, 'guess')],
  ['mm2', 'PUT', /^\/candidate\/player\/[^/]+\/loadout\/?$/, () => J({}, 'guess')],
  ['mm2', 'GET', /^\/candidate\/players\/loadout\/?$/, () => J({}, 'guess')],
  // The live game fetched an encryption key for the connection here. An empty one means "no encryption".
  ['mm2', 'POST', /^\/key\/generate\/?$/, () => J({ key: '', nonce: '', token: '' }, 'no encryption')],
  ['mm2', 'GET', /^\/key\/generate\/?$/, () => J({ key: '', nonce: '', token: '' }, 'no encryption')],
  ['mm2', 'POST', /^\/key\/consume\/?$/, () => J({ key: '', nonce: '' }, 'guess, asked by the game server')],

  // A new player starts with nothing recorded: empty progress, empty mailbox, no party.
  // Served exactly as captured. The last hunt pass season (d24_season1) ended with the live game in May 2025 and
  // must stay ended: when it is presented as still running, the game server tries to draw weekly challenges for
  // a week far past the season's table and never comes back from that (run of Oct 11, 13:08: player kicked).
  ['progression', 'GET', /^\/progression\/config\/?$/, CAP('Progression/Config.json')],
  ['progression', 'GET', /^\/game_tuning\/seasonal_event_schedule\/?$/, CAP('Progression/Game Tuning/GetEventSchedule.md')],
  ['progression', 'GET', /^\/game_tuning\/huntpass_xp_config\/?$/, CAP('Progression/Game Tuning/GetHPXPConfig.md')],
  ['progression', 'GET', /^\/game_tuning\/bounty_game_data\/?$/, CAP('Progression/Game Tuning/Bounty/GetData.md')],
  ['progression', 'GET', /^\/game_tuning\/bounty_game_data_daily\/?$/, CAP('Progression/Game Tuning/Bounty/GetDailyChallenges.md')],
  ['progression', 'GET', /^\/game_tuning\/bounty_game_data_weekly\/?$/, CAP('Progression/Game Tuning/Bounty/GetWeeklyChallenges.md')],
  ['progression', 'POST', /^\/progression\/tracked_objectives\/[^/]*\/?$/, (c) => saveTracked(c)],   // DF-TRACKED-QUESTS-1147                              // captured
  // What the player has already met (townspeople talked to, tutorial hints read...). Captured shapes.
  ['progression', 'POST', /^\/encountered-content\/query\/[^/]*\/?$/, (c) => {
    const seen = playerFor(c.req).encountered || {};
    const want = c.body && Array.isArray(c.body.content_types) ? c.body.content_types.map(Number) : Object.keys(seen).map(Number);
    const list = want.filter((t) => Array.isArray(seen[t]) && seen[t].length).map((t) => ({ content: seen[t].slice().sort(), content_type: t }));
    return J(wrapped({ content_types: list }), list.length ? `${list.reduce((n, x) => n + x.content.length, 0)} item(s)` : 'empty');
  }],
  ['progression', 'GET', /^\/encountered-content\/[^/]+\/(\d+)\/?$/, (c) => { const seen = playerFor(c.req).encountered || {}; const t = Number(c.match[1]);
    return J(wrapped({ content: (seen[t] || []).slice().sort(), content_type: t }), 'guess'); }],
  ['progression', 'POST', /^\/encountered-content\/[^/]+\/?$/, (c) => {
    const p = playerFor(c.req); if (!p.encountered) p.encountered = {};
    const b = c.body && typeof c.body === 'object' ? c.body : {}; const t = Number(b.content_type);
    if (!Number.isInteger(t) || typeof b.content_id !== 'string' || !b.content_id) return J(wrapped({}), 'nothing to save');
    if (!p.encountered[t]) p.encountered[t] = [];
    if (!p.encountered[t].includes(b.content_id)) { p.encountered[t].push(b.content_id); saveState(); }
    return J(wrapped({}), `${b.content_id} noted`);
  }],
  ['migration', 'POST', /^\/migration\/trigger\/?$/, () => J({ migration_failed: false, migration_finished: true })],              // captured
  ['leaderboards', 'POST', /^\/profile\/update\/?$/, () => ({ status: 200 })],                                                    // captured
  ['store', 'POST', /^\/reconcile\/?$/, CAP('Store/Reconcile.md', (j) => { if (j.balances) zeroed(j.balances); return j; })],
  // Store shelves by tag, from the captures where one was recorded; an empty shelf otherwise. Nothing can be bought.
  ['store', 'GET', /^\/product\/skus\/public\/?$/, (c) => {
    const tag = (c.url.searchParams.get('requiredTags') || '').split(',')[0];
    if (!tag) return { status: 400, json: { code: '400', message: 'missing requiredTags query parameter' }, note: 'no tag' };   // captured
    const j = /^[A-Za-z0-9_]+$/.test(tag) ? loadCapture(`Store/Product/Skus/${tag}.json`) : null;
    return J(Array.isArray(j) ? j : [], Array.isArray(j) ? `${tag}: ${j.length} offer(s) from captures` : `${tag}: empty shelf`);
  }],
  ['store', 'GET', /^\/balance\/?$/, CAP('Store/Balance.md', (j) => zeroed(j))],
  ['store', 'GET', /^\/creator\/?$/, () => J({ expirationDate: null, slug: '', success: false }, 'no creator code, guess')],
  ['subscription', 'GET', /^\/subscription\/?$/, () => J(wrapped({ id: crypto.randomUUID(), subscribed: false, verified: true }))],
  ['gauntlet', 'GET', /^\/progression\/level_access\/.*$/, () => J(wrapped(1))],                                                  // captured
  ['progression', 'GET', /^\/game_tuning\/island_content_config\/?$/, () => J(wrapped({ DisallowedIslandContentAssets: [] }))],   // captured
  // Player journey ("Slayer's Path" map): see pjmOf above.
  ['progression', 'GET', /^\/pjm(?:\/seasonal)?(?:\/([^/]*))?\/?$/, (c) => { const m = pjmOf(playerFor(c.req), c.match[1]); return J(wrapped({ nodes: m.nodes, update_version: m.update_version })); }],
  ['progression', 'POST', /^\/pjm(?:\/seasonal)?(?:\/([^/]*))?\/?$/, (c) => savePjm(c)],
  ['progression', 'PUT', /^\/pjm(?:\/seasonal)?(?:\/([^/]*))?\/?$/, (c) => savePjm(c)],
  ['progression', 'GET', /^\/progression\/objectives\/[^/]*\/?$/, (c) => { const p = playerFor(c.req); const o = progressOf(p).objectives;
    const list = Object.keys(o).map((id) => objectiveOut(p, id, o[id])); return J(wrapped(list), list.length ? `${list.length} objective(s)` : 'empty'); }],
  ['progression', 'GET', /^\/progression\/objectives\/[^/]+\/([^/]+)\/?$/, (c) => { const p = playerFor(c.req); const id = decodeURIComponent(c.match[1]);
    return J(wrapped(objectiveOut(p, id, progressOf(p).objectives[id] || {})), 'guess'); }],
  // All progression tracks of a player: a list (shape read from the game's reply parser).
  ['progression', 'GET', /^\/progression\/(?!config\/?$)[^/]+\/?$/, (c) => { const p = playerFor(c.req); const t = progressOf(p).tracks;
    const list = Object.keys(t).map((id) => trackOut(p, id, t[id])); return J(wrapped(list), list.length ? `${list.length} track(s)` : 'empty'); }],
  ['progression', 'POST', /^\/progression\/(?!tracked_objectives\/)[^/]+\/?$/, (c) => grantProgress(c)],
  ['progression', 'POST', /^\/progression\/?$/, (c) => grantProgress(c)],
  ['progression', 'GET', /^\/progression\/(?!objectives\/|tracked_objectives\/)[^/]+\/([^/]+)\/?$/, (c) => { const p = playerFor(c.req); const id = decodeURIComponent(c.match[1]);
    return J(wrapped(trackOut(p, id, progressOf(p).tracks[id] || {})), 'guess'); }],
  ['progression', 'POST', /^\/progression\/(?!objectives\/|tracked_objectives\/)[^/]+\/([^/]+)\/(-?\d+)\/?$/, (c) => grantTrack(c)],
  // DF-REFORGE-1147: reforge resets the weapon to level 1. The old XP is kept in reforgedXp (nothing reads it yet).
  // DF-BANKED-XP-1147 (Oct 25, report 147): XP earned past level 20 is the weapon's banked XP. It is kept in bankedXp at
  // the reset, and the game pays it out right after with POST /progression/purchase/<acc>/<track>/<xp> (see below).
  ['progression', 'DELETE', /^\/progression\/(?!objectives\/|tracked_objectives\/)[^/]+\/(ExperienceTrack_Weapon_[A-Za-z]+)\/?$/, (c) => {
    const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
    const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 });
    const banked = Math.max(0, (Number(cur.progress) || 0) - weaponMaxXp(id));
    cur.bankedXp = (Number(cur.bankedXp) || 0) + banked;
    cur.reforgedXp = (Number(cur.reforgedXp) || 0) + (Number(cur.progress) || 0); cur.progress = 0; cur.confirmed_fremium_rank = 0; cur.confirmed_premium_rank = 0;
    saveState(); reforgeLog(`${p.accountId}: ${id} reset to level 1 (reforged XP ${cur.reforgedXp}, banked XP ${cur.bankedXp})`);
    return J(wrapped(trackOut(p, id, cur)), `${id} reset to level 1, ${cur.bankedXp} XP banked`);
  }],
  // DF-BANKED-XP-1147: the game spends the banked XP on the reforged weapon (amount = the XP past level 20 it saw).
  // Paid once: never more than what was banked at the reset; a repeated call pays the rest (usually nothing).
  ['progression', 'POST', /^\/progression\/purchase\/[^/]+\/(ExperienceTrack_Weapon_[A-Za-z]+)\/(\d+)\/?$/, (c) => {
    const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
    const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 });
    const asked = Math.max(0, Number(c.match[2]) || 0), bank = Math.max(0, Number(cur.bankedXp) || 0), paid = Math.min(asked, bank);
    if (paid > 0) { cur.progress = (Number(cur.progress) || 0) + paid; cur.bankedXp = bank - paid; cur.confirmed_date = isoNow(); saveState(); }
    reforgeLog(`${p.accountId}: ${id} banked XP paid ${paid} of ${asked} asked (bank ${bank} -> ${Number(cur.bankedXp) || 0}), now ${cur.progress}`);
    return J(wrapped(trackOut(p, id, cur)), `${id} banked XP +${paid}${paid < asked ? ` (asked ${asked}, banked ${bank})` : ''}`);
  }],
  ['progression', 'PUT', /^\/progression\/(?!objectives\/|tracked_objectives\/)[^/]+\/([^/]+)\/(-?\d+)\/?$/, (c) => grantTrack(c)],
  ['progression', 'POST', /^\/progression\/[^/]+\/([^/]+)\/(\d+)\/confirm\/([^/]+)\/?$/, (c) => { const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
    const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 }); const rank = Number(c.match[2]) || 0;
    if (/prem/i.test(c.match[3])) cur.confirmed_premium_rank = rank; else cur.confirmed_fremium_rank = rank;
    cur.confirmed_date = isoNow(); saveState(); return J(wrapped(trackOut(p, id, cur)), 'rank confirmed, guess'); }],
  ['progression', 'GET', /^\/progression\/tracked_objectives\/[^/]*\/?$/, (c) => { const p = playerFor(c.req); const s = p.trackedObjectives || {}; return J(wrapped({ current_set: s.current_set || '', omitted_quests: s.omitted_quests || [], phx_account_id: p.accountId, tracked_craftables: s.tracked_craftables || [], tracked_quests: s.tracked_quests || [] }), s.current_set ? 'saved set ' + s.current_set : 'empty'); }],   // DF-TRACKED-QUESTS-1147
  // Cooldowns (daily grants, gathering spots...). Read back as a plain map { id: start time } - the game's reply
  // parser takes "payload" as a map of text values; saved by the game server as a list of { cooldown_id, cooldown_started_date }.
  ['progression', 'GET', /^\/cooldown\/[^/]*\/?$/, (c) => { const list = playerFor(c.req).cooldowns || []; return J(wrapped(cooldownMap(list)), list.length ? `${list.length} cooldown(s)` : 'none'); }],
  ['progression', 'PUT', /^\/cooldown\/batch\/[^/]*\/?$/, (c) => saveCooldowns(c)],
  ['progression', 'POST', /^\/cooldown\/batch\/[^/]*\/?$/, (c) => saveCooldowns(c)],
  ['progression', 'POST', /^\/cooldown\/[^/]*(\/[^/]*)?\/?$/, (c) => saveCooldowns(c)],
  ['progression', 'PUT', /^\/cooldown\/[^/]*(\/[^/]*)?\/?$/, (c) => saveCooldowns(c)],

  // ---- What the GAME SERVER asks for when a player joins. Shapes were read out of the game's own
  // ---- reply parsers; the starting values follow the Undaunted project's backend (AGPL-3.0).
  ['mailbox', 'GET', /^\/eventstats\/?$/, () => J(wrapped({ stats: [] }), 'empty')],
  ['mailbox', 'POST', /^\/eventstats\/increment\/?$/, () => J(wrapped({ stats: [] }), 'guess')],
  ['progression', 'GET', /^\/tracker\/[^/]+\/?$/, (c) => J(wrapped(playerFor(c.req).trackers || { equipped: '', trackers: [] }))],
  ['progression', 'POST', /^\/tracker\/[^/]+\/?$/, (c) => saveTrackers(c)],
  ['progression', 'PUT', /^\/tracker\/[^/]+\/?$/, (c) => saveTrackers(c)],
  ['progression', 'DELETE', /^\/tracker\/[^/]+\/[^/]+\/?$/, (c) => J(wrapped(playerFor(c.req).trackers || { equipped: '', trackers: [] }), 'guess')],
  ['progression', 'GET', /^\/escalation\/([^/]+)\/[^/]+\/?$/, (c) => J(wrapped(escalationOf(playerFor(c.req), c.match[1])))],
  ['progression', 'POST', /^\/escalation\/([^/]+)\/[^/]+\/?$/, (c) => {
    const p = playerFor(c.req); const cur = escalationOf(p, c.match[1]);
    if (c.body && typeof c.body === 'object') Object.assign(cur, c.body.payload && typeof c.body.payload === 'object' ? c.body.payload : c.body);
    cur.update_version = (Number(cur.update_version) || 0) + 1; saveState();
    return J(wrapped(cur), 'saved, guess');
  }],
  ['gauntlet', 'GET', /^\/config\/?$/, () => J(wrapped({}), 'no gauntlet season, guess')],
  // Gauntlet was retired before 2.1.1; the game still asks, with an empty season id.
  ['gauntlet', 'GET', /^\/progression\/(?!level_access\/)[^/]*\/[^/]*\/?$/, () => J(wrapped(null), 'gauntlet is retired: nothing')],
  ['gauntlet', 'GET', /^\/rewards\/(personal|guild)\/[^/]*\/[^/]*\/?$/, () => J(wrapped([]), 'gauntlet is retired: nothing')],
  ['gauntlet', 'GET', /^\/leaderboard\/(get_leaderboard|get_entry)\/.*$/, () => J(wrapped(null), 'gauntlet is retired: nothing')],
  // No guild, no invitations (both as the live servers answered a player without a guild).
  ['guild', 'GET', /^\/guild\/?$/, () => ({ status: 204, note: 'no guild' })],
  ['guild', 'GET', /^\/guild\/invite\/player\/?$/, () => J(wrapped({ invites: [] }), 'none')],
  ['mm2', 'GET', /^\/party\/invites\/?$/, (c) => { const r = partyInvitesOf(playerFor(c.req)); return J(r, r.invitations.length ? `${r.invitations.length} invite(s)` : 'none'); }],
  // Trials leaderboards: nobody else is here, so the boards are empty (captured shape, without entries).
  ['leaderboards', 'POST', /^\/trials\/leaderboards\/all\/?$/, (c) => { const b = c.body && typeof c.body === 'object' ? c.body : {};
    return J(wrapped({ difficulty: b.difficulty || 0, guild: {}, page: b.page || 0, page_size: b.page_size || 100, trial_id: b.trial_id || '', world: {} }), 'empty board'); }],
  // Which hunt pass the player picked: { progression_id } (shape read from the game). None picked = the current season.
  ['progression', 'GET', /^\/huntpass\/[^/]+\/?$/, (c) => { const id = playerFor(c.req).huntPass || ''; return J(wrapped({ progression_id: id }), id ? id : 'none picked'); }],
  ['progression', 'POST', /^\/huntpass\/[^/]+\/?$/, (c) => { const p = playerFor(c.req); if (c.body && typeof c.body.progression_id === 'string') { p.huntPass = c.body.progression_id; saveState(); }
    return J(wrapped({ progression_id: p.huntPass || '' }), 'saved'); }],
  ['progression', 'GET', /^\/bounty\/game-data\/?$/, CAP('Progression/Game Tuning/Bounty/GetData.md')],
  ['progression', 'GET', /^\/bounty\/[^/]+\/?$/, (c) => { const b = playerFor(c.req).bounties; return J(wrapped(Object.assign(emptyBounties(), b || {})), b ? undefined : 'empty'); }],
  ['progression', 'POST', /^\/bounty\/delete\/[^/]+\/?$/, (c) => { const p = playerFor(c.req); const ids = c.body && Array.isArray(c.body.bounty_ids) ? c.body.bounty_ids : [];
    if (p.bounties && Array.isArray(p.bounties.bounties)) { p.bounties.bounties = p.bounties.bounties.filter((x) => !ids.includes(x.bounty_id)); saveState(); }
    return J(wrapped(Object.assign(emptyBounties(), p.bounties || {})), `${ids.length} removed, guess`); }],
  ['progression', 'POST', /^\/bounty\/[^/]+\/?$/, (c) => saveBounties(c)],
  ['progression', 'PUT', /^\/bounty\/[^/]+\/?$/, (c) => saveBounties(c)],
  ['loadout', 'GET', /^\/loadout\/([^/]+)\/([^/]+)\/all\/?$/, (c) => { const p = playerFor(c.req); const l = loadoutsOf(p, c.match[2]); saveState(); return J(wrapped(loadoutReply(l)), `${l.loadouts.length} loadout(s)`); }],
  ['loadout', 'GET', /^\/loadout\/([^/]+)\/([^/]+)\/?$/, (c) => { const p = playerFor(c.req); const l = loadoutsOf(p, c.match[2]); saveState(); return J(wrapped(l.loadouts[l.active_index] || l.loadouts[0]), 'active loadout, guess'); }],
  ['loadout', 'GET', /^\/loadout\/([^/]+)(\/[^/]+)?\/slotcount\/?$/, () => J(wrapped({ num_account_slots: 1, max_account_slots: 1, num_character_slots: 1, max_character_slots: 1 }), 'guess')],
  ['loadout', 'POST', /^\/loadout\/([^/]+)\/([^/]+)\/active\/([^/]+)\/?$/, (c) => setActiveLoadout(c)],
  ['loadout', 'PUT', /^\/loadout\/([^/]+)\/([^/]+)\/active\/([^/]+)\/?$/, (c) => setActiveLoadout(c)],
  ['loadout', 'POST', /^\/loadout\/([^/]+)\/([^/]+)\/([^/]+)\/?$/, (c) => saveLoadout(c)],
  ['loadout', 'PUT', /^\/loadout\/([^/]+)\/([^/]+)\/([^/]+)\/?$/, (c) => saveLoadout(c)],
  ['cohort', 'GET', /^\/playertreatments\/[^/]*\/?$/, () => J({ code: null, message: 'OK', payload: { treatments: [] }, treatments: [] })],
  ['mailbox', 'GET', /^\/all\/?$/, () => J(wrapped({ messages: [] }), 'empty')],
  ['mailbox', 'GET', /^\/survey\/config\/?$/, () => ({ status: 400, note: 'no survey (as the live servers answered)' })],
  ['motd', 'POST', /^\/motd\/?$/, () => ({ status: 204 })],                                              // captured
  ['motd', 'GET', /^\/motd\/trigger\/?$/, () => ({ status: 200 })],                                     // captured
  ['breadcrumbs', 'GET', /^\/breadcrumbs\/[^/]*\/?$/, () => J(wrapped({ breadcrumbs: [] }), 'empty')],
  ['breadcrumbs', 'POST', /^\/breadcrumbs\/[^/]*\/?$/, () => J(wrapped({ breadcrumbs: [] }), 'guess')],
  ['mm2', 'POST', /^\/party\/?$/, (c) => partyPoll(playerFor(c.req), c.body && c.body.buildId)],   // DF-PARTY-1147

  // Status banner, polled about every 30 seconds. "show-status" must be a real boolean.
  ['steelyard.online', 'GET', /^\/dauntless-status\/?$/, () => J({ 'show-status': false, en: '', fr: '', it: '', es: '', de: '', pt: '', ru: '', ja: '' })],
  // Analytics. Nothing is known to need a reply, so these are only written to the log.
  ['telemetry-ingest', 'POST', /^\/event\/?$/, () => ({ status: 404, note: 'telemetry, logged only' })],
  ['telemetry', 'POST', /^\/log\/?$/, () => J({ text: 'Success', code: 0 })],
  ['mailbox', 'GET', /^\/patchnotes\/.*$/, CAP('Mailbox/Patchnotes.md')],
];

// ---------------------------------------------------------------- server
function logLine(entry) {
  try { quality.appendLog(LOG_FILE, entry); }
  catch (error) { if (Date.now() > nextConsoleWarning) { console.error('[Backend] Request log could not be written: ' + error.code); nextConsoleWarning = Date.now() + 30000; } }
  metrics.requests++; if (entry.status >= 500) metrics.failed++;
  if (!entry.known) {
    metrics.unsupported++;
    const route = entry.svc + ' ' + entry.m + ' ' + entry.path.replace(/[A-Z2-7]{26}|[0-9a-f]{24,}/gi, '{id}');
    if (metrics.missing.size < 250 || metrics.missing.has(route)) metrics.missing.set(route, (metrics.missing.get(route) || 0) + 1);
  }
  if (quiet && entry.known && entry.status < 400) return;
  if (quiet && Date.now() < nextConsoleWarning) return;
  if (quiet) nextConsoleWarning = Date.now() + 10000;
  const t = entry.t.slice(11, 19);
  const mark = entry.known ? ' ' : '?';
  console.log(`${t} ${mark} ${String(entry.status).padEnd(3)} ${entry.svc.padEnd(16)} ${entry.m.padEnd(6)} ${entry.path}${entry.note ? '   [' + entry.note + ']' : ''}`);
}

// Version-specific Ramsgate feature routes.
const mega1147 = require('./mega1147').create({playerFor,bearerOf,sessions,inventoryOf,saveState,loadCapture});
const middleman1147 = require('./middleman1147').create({playerFor,bearerOf,sessions,inventoryOf,applyInventory,saveState,next:c=>mega1147.handle(c)});
const trials1147 = require('./trials1147').create({playerFor,bearerOf,sessions,inventoryOf,saveState,next:c=>middleman1147.handle(c)});
var huntpassSeasons1147 = require('./huntpass-seasons1147').create(ROOT);
const huntpass1147 = require('./huntpass1147').create({playerFor,bearerOf,sessions,inventoryOf,saveState,loadCapture,next:c=>trials1147.handle(c)}, {data:huntpassSeasons1147.data,seasons:huntpassSeasons1147});
const bounties1147 = require('./bounties1147').create({playerFor,bearerOf,sessions,getPlayers:()=>Object.values(state.players||{}),saveState,loadCapture,next:c=>huntpass1147.handle(c)});
const equipment1147 = require('./equipment1147').create({playerFor,bearerOf,sessions,getPlayers:()=>Object.values(state.players||{}),saveState,next:c=>bounties1147.handle(c)});
const dyes1147 = require('./dyes1147').create({playerFor,bearerOf,sessions,inventoryOf,saveState,next:c=>equipment1147.handle(c)});
const storeRams1147 = require('./store-rams1147').create({playerFor,bearerOf,sessions,inventoryOf,saveState,loadCapture,next:c=>dyes1147.handle(c)}); // DF-STORE-RAMS-1147
const transmogDrops1147 = require('./transmog-drops1147').create({playerFor,bearerOf,sessions,next:c=>storeRams1147.handle(c)}); // DF-TRANSMOG-DROPS-1147
const modes1147 = require('./modes1147').create({playerFor,bearerOf,sessions,getPlayers:()=>Object.values(state.players||{}),saveState,next:c=>transmogDrops1147.handle(c)});


// KK-LOADOUTS-1147-R1
const loadoutsFix1147 = require('./loadouts-fix1147').create({root:ROOT,getPlayers:()=>Object.values(state.players||{}),playerFor,bearerOf,sessions,saveState,defaultLoadoutSlot,defaultPersistent});
function handle(svc, port, req, res, bodyBuf) {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const pathName = url.pathname;
  if (!privateAddress(req.socket && req.socket.remoteAddress)) { res.writeHead(403, { 'Content-Length': 0 }); res.end(); return; }
  let body;
  if (bodyBuf.length) { try { body = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { body = undefined; } }
  req._pkey = keyFromIds(pathName, body);   // DF-LAN-1147: which player a server request is about
  if (guestRequest(req) && !(bearerOf(req) && sessions.get(bearerOf(req))) && !req._pkey && !PRE_SESSION_RE.test(pathName)) {   // DF-HOSTGUARD-1147
    console.log(`HOSTGUARD: refused ${req.method} ${pathName} from ${req.socket.remoteAddress}: a joiner request that names no player`);
    res.writeHead(401, { 'Content-Length': 0 }); res.end(); return;
  }
  { const token=bearerOf(req); const identified=(token&&sessions.get(token))||req._pkey; if(identified) multiplayer1147.touch(identified); }

  let reply = null, known = false;
  if (pathName === '/_recorder/ping') { reply = J({ ok: true, service: svc.service, port, host: state.hostId }); known = true; }
  else if (/^\/_travel\/[0-9a-f]{32}$/.test(pathName)) { reply = travel(req.method, pathName.slice(9), body); known = true; }
  else if (pathName === '/_recorder/status') { reply = J(status()); known = true; }
  else {
    try { reply = loadoutsFix1147.handle({service:svc.service,method:req.method,path:pathName,req,body,url}) || modes1147.handle({service:svc.service,method:req.method,path:pathName,req,body,url}); known=!!reply; }
    catch(e) { reply={status:e.status||500,note:'feature module: '+scrubString(e.message)}; known=true; }
    for (const [rSvc, rMethod, rPath, fn] of routes) {
      if(reply) break;
      if (rSvc !== svc.service || rMethod !== req.method) continue;
      const match = rPath.exec(pathName);
      if (!match) continue;
      try { reply = fn({ req, body, match, url, basePort: BASE_PORT }); } catch (e) { reply = { status: e.status || (e instanceof URIError ? 400 : 500), note: 'handler error: ' + scrubString(e.message) }; }
      known = true; break;
    }
  }
  if (!reply) reply = NOT_FOUND;
  if (svc.service === 'progression' && req.method === 'GET' && /^\/progression\/config\/?$/.test(pathName) && reply.json) prestigeRanks(reply.json);   // DF-REFORGE-1147

  if (svc.service === 'store' && reply.json !== undefined) reply = freePlatinum1147.reply(reply);
  let payload = '';
  const headers = { 'Connection': 'keep-alive' };
  if (reply.json !== undefined) { payload = JSON.stringify(reply.json); headers['Content-Type'] = 'application/json; charset=utf-8'; }
  else if (reply.text !== undefined) { payload = reply.text; headers['Content-Type'] = 'text/plain; charset=utf-8'; }
  else if (reply.html !== undefined) { payload = reply.html; headers['Content-Type'] = 'text/html; charset=utf-8'; }
  headers['Content-Length'] = Buffer.byteLength(payload);
  res.writeHead(reply.status, headers);
  res.end(payload);

  const b = bearerOf(req);
  if (pathName !== '/_recorder/ping') {
    logLine({
      t: new Date().toISOString(), port, svc: svc.service, m: req.method, path: pathName,
      q: redactQuery(url.search), status: reply.status, known, note: reply.note,
      auth: b ? `bearer(len ${b.length}, id ${shortHash(b)}${sessions.has(b) ? ', ours' : ''})` : undefined,
      reqLen: bodyBuf.length, body: pathName.startsWith('/_travel/') ? undefined : redactBody(bodyBuf, req.headers['content-type']),
      resLen: Buffer.byteLength(payload),
    });
  }
}

// DF-CHAT-1147 (Oct 20): in-game text chat (XMPP over WebSocket), the chat server of the 1.6.2 package (Dauntless
// Revived's, AGPL-3.0) in realtime/. It takes WebSocket upgrades on port 63000, which LAN joiners reach directly and
// online joiners through their join proxy and the host's gateway (no relay change). CHAT=0 turns it off.
const CHAT_PORT = 63000, CHAT_GAME_PORT = 5222;
let chatHub = null, chat = null;
function startChat() {
  if ((process.env.CHAT || '').trim() === '0') { require('./logger').logger.info('chat: off (CHAT=0)'); return; }
  try {
    const compat = require('./realtime/compat');
    // Chat knows a player by the sign-in id (EOS EpicAccountId, lower-case): the game's rooms and nicknames use it,
    // and the loader logs the game's chat connection in with it. The account id is accepted too.
    const chatPlayer = (id) => { const want = String(id || '').toLowerCase(); return Object.values(state.players || {}).find((p) => p && (p.accountId === id || String(p.epicId || '').toLowerCase() === want)) || null; };
    compat.bind({
      playerByAccount: chatPlayer,
      accountFromToken: (token) => {
        let key = sessions.get(token) || null;
        if (!key && epicSubOf(token)) key = playerKeyFromEpicToken(token);
        const p = key && state.players[key];
        return p ? (String(p.epicId || '').toLowerCase() || p.accountId) : null;
      },
      partyIdOf: (id) => { const p = chatPlayer(id); if (!p) return null; const P = groupOf(p.accountId); return P ? P.id : (p.partyId || null); },
    });
    chatHub = new (require('node:events').EventEmitter)();
    // data\chat_trace.txt: log every chat frame (tokens, passwords and message text are blanked by the chat server)
    const env = Object.assign({}, process.env, fs.existsSync(path.join(DATA_DIR, 'chat_trace.txt')) ? { CHAT_TRACE: '1' } : {});
    chat = require('./realtime/chat').AttachChat(chatHub, env);
    if (!chat) chatHub = null;
    // the game itself connects to ws://<ChatEndpoint>:5222 (its XMPP port is fixed in the exe): a listener of its own
    if (chatHub) {
      const cs = http.createServer((req, res) => { res.writeHead(404, { 'Content-Length': 0 }); res.end(); });
      cs.on('upgrade', (req, socket, head) => { try { if (!privateAddress(socket.remoteAddress)) { socket.destroy(); return; } chatHub.emit('upgrade', req, socket, head); } catch (e) { try { socket.destroy(); } catch (x) {} } });
      cs.on('error', (e) => require('./logger').logger.warn(`chat: cannot listen on port ${CHAT_GAME_PORT} (${e.code || e.message}); chat only through 63000`));
      cs.listen(CHAT_GAME_PORT, BIND_HOST, () => require('./logger').logger.info(`chat: listening on ${BIND_HOST}:${CHAT_GAME_PORT} and ${CHAT_PORT}`));
    }
  } catch (e) { chatHub = null; chat = null; require('./logger').logger.error('chat: not started (' + (e && e.message) + '). The backend runs without chat.'); }
  // the launcher leaves data\announce.txt (Host Mode welcome, "closing in a minute"); it is said in chat, then deleted
  const announceFile = path.join(DATA_DIR, 'announce.txt');
  setInterval(() => {
    try {
      if (!fs.existsSync(announceFile)) return;
      const text = fs.readFileSync(announceFile, 'utf8').trim();
      fs.rmSync(announceFile, { force: true });
      if (text && chat && chat.muc && typeof chat.muc.Announce === 'function') chat.muc.Announce(text);
    } catch (e) { /* next time */ }
  }, 2000).unref();
}
function onUpgrade(svc, port, req, socket, head) {
  if (chatHub && port === CHAT_PORT) {
    if (!privateAddress(socket.remoteAddress)) { socket.destroy(); return; }
    chatHub.emit('upgrade', req, socket, head);
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!key || !privateAddress(socket.remoteAddress)) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const proto = (req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (proto) lines.push(`Sec-WebSocket-Protocol: ${proto}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  socket.on('data', () => { /* the client is not expected to send anything; ignore */ });
  socket.on('error', () => {});
  logLine({ t: new Date().toISOString(), port, svc: svc.service, m: 'WS', path: url.pathname, status: 101, known: true, note: proto ? `websocket, protocol ${proto}` : 'websocket' });
}

function start() {
  let services;
  try { services = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8')); }
  catch (e) { console.error(`Cannot read ${SERVICES_FILE}. Run make-gameini-1147.ps1 first.\n${e.message}`); process.exit(1); }
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // DF-KEEPALIVE-1147: an unexpected error must not take the backend down (that kicks every player and makes
  // Host Mode restart the whole server). It is written to logs\recorder-errors.log and the backend carries on.
  const crashLog = path.join(LOG_DIR, 'recorder-errors.log');
  const noteError = (what, e) => { try { fs.appendFileSync(crashLog, `${new Date().toISOString()} ${what}: ${(e && e.stack) || e}\n`); } catch (x) {} };
  process.on('uncaughtException', (e) => noteError('uncaught', e));
  process.on('unhandledRejection', (e) => noteError('unhandled', e));
  loadState();
  capRoot = findCaptures();
  BASE_PORT = (services.find((x) => x.service === '_external') || services[0]).port;

  const servers = [];
  const failed = [];
  let pending = services.length;
  const done = () => {
    if (--pending > 0) return;
    if (failed.length) {
      console.error('\nCould not open these ports, so the recorder is stopping:');
      for (const f of failed) console.error(`  ${f.port} (${f.service}): ${f.error}`);
      for (const s of servers) s.close();
      process.exit(1);
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
    console.log(`Recorder ready: ${services.length} ports on ${BIND_HOST}, ${services[0].port} to ${services[services.length - 1].port}.`);
    if (PUBLIC_HOST) console.log(`LAN: games are sent to the servers at ${PUBLIC_HOST}.`);
    console.log(`Log: ${LOG_FILE}`);
    console.log(capRoot ? `Captures: ${capRoot}` : `Captures: NOT FOUND in ${CAP_DIR} - game-wide data (progression tables, events, patch notes) will be missing.`);
    console.log('Lines marked ? are requests this recorder does not answer yet (empty 404). Press Ctrl+C to stop.\n');
  };
  startChat();   // DF-CHAT-1147
  for (const svc of services) {
    const server = http.createServer((req, res) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => { try { handle(svc, svc.port, req, res, Buffer.concat(chunks)); } catch (e) { noteError('handle ' + req.url, e); try { res.writeHead(500, { 'Content-Length': 0 }); res.end(); } catch (x) {} } });
      req.on('error', () => {});
    });
    server.on('upgrade', (req, socket, head) => { try { onUpgrade(svc, svc.port, req, socket, head); } catch (e) { noteError('upgrade ' + req.url, e); try { socket.destroy(); } catch (x) {} } });
    server.on('error', (e) => { failed.push({ port: svc.port, service: svc.service, error: e.code || e.message }); done(); });
    server.listen(svc.port, BIND_HOST, () => { servers.push(server); done(); });
  }
  const stop = () => { try { fs.unlinkSync(PID_FILE); } catch (e) {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

// ---------------------------------------------------------------- summary
function summary() {
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean); }
  catch (e) { console.log(`No log yet at ${LOG_FILE}`); return; }
  const norm = (p) => p
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '{id}')
    .replace(/\/[0-9a-fA-F]{24,}(?=\/|$)/g, '/{hex}')
    .replace(/\/[A-Z2-7]{26}(?=\/|$)/g, '/{id}')
    .replace(/\/\d{3,}(?=\/|$)/g, '/{n}');
  const rows = new Map();
  let first = null, last = null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch (x) { continue; }
    first = first || e.t; last = e.t;
    const k = `${e.svc} ${e.m} ${norm(e.path)}`;
    if (!rows.has(k)) rows.set(k, { svc: e.svc, m: e.m, path: norm(e.path), n: 0, status: new Set(), known: e.known, note: e.note, firstT: e.t });
    const r = rows.get(k); r.n++; r.status.add(e.status);
  }
  console.log(`Requests: ${lines.length}   from ${first} to ${last}`);
  console.log('In order of first appearance. ? = not answered yet (empty 404).\n');
  for (const r of rows.values()) {
    console.log(`${r.firstT.slice(11, 19)} ${r.known ? ' ' : '?'} x${String(r.n).padEnd(4)} ${[...r.status].join('/').padEnd(7)} ${r.svc.padEnd(16)} ${r.m.padEnd(6)} ${r.path}${r.note ? '   [' + r.note + ']' : ''}`);
  }
}

// ---------------------------------------------------------------- events
// Prints what the game reported about itself (analytics events), already redacted when logged.
function events() {
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean); }
  catch (e) { console.log(`No log yet at ${LOG_FILE}`); return; }
  let n = 0;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch (x) { continue; }
    if (e.svc !== 'telemetry-ingest' && e.svc !== 'telemetry') continue;
    n++;
    const body = e.body ? (e.body.length > 2500 ? e.body.slice(0, 2500) + '...' : e.body) : '(no body)';
    console.log(`${e.t.slice(11, 19)} ${e.svc} ${e.m} ${e.path}${e.q ? '?' + e.q : ''}\n  ${body}\n`);
  }
  if (n === 0) console.log('No analytics events in the log yet.');
}

if (args.includes('--summary')) summary(); else if (args.includes('--events')) events(); else start();

// KK-QUALITY-1147: backend status for checks (GET /_recorder/status)
function status() {
  return { ok: true, version: '1147-df-kk-r1', captures_available: !!capRoot, requests: metrics.requests, errors: metrics.failed,
    unsupported_requests: metrics.unsupported, saves_written: metrics.saves, recovered_save: metrics.recovered,
    unsupported_routes: [...metrics.missing].map(([route, count]) => ({ route, count })) };
}
// Hunt Pass seasons (KombatKing) keep each season's progress apart; they wrap the save.
function saveState() { return huntpassSeasons1147 ? huntpassSeasons1147.save(state, saveStateNative) : saveStateNative(); }

// DF-REFORGE-1147: the shipped config gives every PrestigeTrack_Weapon_* only rank 0, so the reforge badge under the
// weapon level can never show. Ranks 1..100 at 1 progress each (one per reforge).
function prestigeRanks(j) {
  const paths = (j && j.payload && Array.isArray(j.payload.paths)) ? j.payload.paths : (j && Array.isArray(j.paths) ? j.paths : null);
  if (!paths) return;
  for (const x of paths) {
    if (!x || !isPrestige(x.progression_id) || !Array.isArray(x.requirements) || x.requirements.length > 1) continue;
    x.requirements = [{ rank_id: 0, xp_required: 0 }];
    for (let r = 1; r <= 100; r++) x.requirements.push({ rank_id: r, xp_required: 1 });
  }
}
// DF-BANKED-XP-1147: XP for level 20 of a weapon track (sum of its ranks in the progression config; 27,775 in 1.14.7).
const weaponMaxCache = new Map();
function weaponMaxXp(id) {
  if (weaponMaxCache.has(id)) return weaponMaxCache.get(id);
  let total = 27775;
  try {
    const j = loadCapture('Progression/Config.json'); const paths = j && ((j.payload && j.payload.paths) || j.paths);
    const x = Array.isArray(paths) ? paths.find((q) => q && q.progression_id === id) : null;
    if (x && Array.isArray(x.requirements) && x.requirements.length) { const t = x.requirements.reduce((a, r) => a + (Number(r && r.xp_required) || 0), 0); if (t > 0) total = t; }
  } catch (e) { /* keep the default */ }
  weaponMaxCache.set(id, total); return total;
}
function reforgeLog(msg) { try { fs.appendFileSync(path.join(LOG_DIR, 'reforge.log'), `${new Date().toISOString()} ${msg}\n`); } catch (e) { /* logs are optional */ } }
