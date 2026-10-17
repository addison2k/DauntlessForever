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

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = path.resolve(argVal('--dir') || path.join(__dirname, '..'));
// DF-LAN-1147: LAN play. RECORDER_BIND=0.0.0.0 lets other PCs on the home network in (LAN - HOST also opens the
// firewall for the home network only); RECORDER_PUBLIC_HOST is this PC's address, given to games for the servers.
const BIND_HOST = argVal('--bind') || process.env.RECORDER_BIND || '127.0.0.1';
const PUBLIC_HOST = (argVal('--public') || process.env.RECORDER_PUBLIC_HOST || '').trim();
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
const MAX_BODY = 1024 * 1024;

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
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* first run */ }
  if (!state.players) state.players = {};
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
// matchmaker_hunts_table (data\hunts_1147.json, written by Claude from the FModel export; stays on this PC).
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
function destinationFor(b) {
  const mode = b.gameMode || 'CITY', type = b.gameType || '';
  const hunt = Array.isArray(b.hunts) && b.hunts.length ? String(b.hunts[0]) : '';
  const label = `${mode}/${type || '-'} ${b.playerHuntId || hunt || ''}`.trim();
  if (mode === 'CITY') return { city: true, label };
  if (type === 'FTUE') return { city: true, label, note: 'the tutorial island is skipped for now: straight to Ramsgate' };
  let url = '';
  if (typeof b.gameArgs === 'string' && b.gameArgs.startsWith('/Game/')) url = b.gameArgs;
  else if (hunt && huntUrl(hunt)) url = huntUrl(hunt);
  else if (MAP_BY_GAME_TYPE[type]) url = `${MAP_BY_GAME_TYPE[type]}?MaxPlayers=1${/^[A-Za-z0-9_]+$/.test(hunt) ? '?HuntID=' + hunt : ''}`;
  if (!url || !URL_OK.test(url)) return { city: true, label, note: 'this destination is not available yet: staying in Ramsgate' };
  return { city: false, label, url };
}
// DF-LAN-1147: the place outside the city that the second server is for, and who is (going) there.
let place = null;
const placeBase = (u) => String(u || '').replace(/\?PlayerHuntIds=[^?]*/g, '');
function leavePlace(key) {
  if (!place) return;
  place.owners.delete(key);
  if (!place.owners.size) { place = null; setWanted(null); }
}
function setWanted(w) {
  try {
    if (!w) { if (fs.existsSync(WANTED_FILE)) fs.unlinkSync(WANTED_FILE); return; }
    const tmp = WANTED_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(w)); fs.renameSync(tmp, WANTED_FILE);
  } catch (e) { /* the server script will simply not see it */ }
}
function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
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
function getPlayer(key) {
  if (!state.players[key]) {
    state.players[key] = { accountId: idFrom('account:' + key), username: 'Slayer', created: new Date().toISOString().slice(0, 10), characters: [], inventory: {} };
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
  return player.inventory[id];
}
function applyInventory(inv, body) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const created = [], updatedInst = [], updatedStack = [], removed = [];
  for (const it of arr(body.addInstancedItems)) {
    const item = Object.assign({}, it);
    if (!item.instanceId) item.instanceId = crypto.randomUUID();
    if (typeof item.updateVersion !== 'number') item.updateVersion = 1;
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
const trackOut = (p, id, t) => ({ phx_account_id: p.accountId, progression_id: id, progress: t.progress || 0, confirmed_fremium_rank: t.confirmed_fremium_rank || 0,
  confirmed_premium_rank: t.confirmed_premium_rank || 0, confirmed_date: t.confirmed_date || null });
const objectiveOut = (p, id, o) => ({ completed_count: o.completed_count || 0, created_date: o.created_date || isoNow(), last_modified_date: o.last_modified_date || isoNow(),
  objective_id: id, phx_account_id: p.accountId, progress: o.progress || 0 });
function grantProgress(c) {
  const p = playerFor(c.req); const pr = progressOf(p); const b = c.body && typeof c.body === 'object' ? c.body : {};
  const tracks = [], objectives = [];
  for (const t of Array.isArray(b.progress_tracks) ? b.progress_tracks : []) {
    if (!t || !t.progression_id) continue;
    const cur = pr.tracks[t.progression_id] || (pr.tracks[t.progression_id] = { progress: 0 });
    cur.progress = (Number(cur.progress) || 0) + (Number(t.progress) || 0); tracks.push(trackOut(p, t.progression_id, cur));
  }
  for (const o of Array.isArray(b.objectives) ? b.objectives : []) {
    if (!o || !o.objective_id) continue;
    const cur = pr.objectives[o.objective_id] || (pr.objectives[o.objective_id] = { progress: 0, completed_count: 0, created_date: isoNow() });
    if (o.value !== undefined) cur.progress = Number(o.value) || 0;
    if (o.completed_count !== undefined) cur.completed_count = Number(o.completed_count) || 0;
    cur.last_modified_date = isoNow(); objectives.push(objectiveOut(p, o.objective_id, cur));
  }
  saveState();
  return J(wrapped({ progress_tracks: tracks, objectives }), `${tracks.length} track(s), ${objectives.length} objective(s) saved, guess`);
}
function grantTrack(c) {
  const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
  const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 });
  cur.progress = (Number(cur.progress) || 0) + (Number(c.match[2]) || 0); saveState();
  return J(wrapped(trackOut(p, id, cur)), `${id} +${c.match[2]}, guess`);
}
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
const routes = [
  ['login-queue', 'POST', /^\/login\/?$/, () => J({ error_code: 'TicketRateOk', message: '', state: 'OPEN', timeout: 8000, title: '' })],   // captured
  ['login-queue', 'GET', /^\/maintenance\/status\/?$/, () => J({ 'show-status': false })],                                                // captured

  ['gamesession', 'GET', /^\/features\/platform\/[^/]+\/?$/, () => J(wrapped({ crossplay: true, crossprogression: true }))],   // captured
  ['gamesession', 'GET', /^\/account\/link\/[^/]+\/[^/]*\/?$/, () => J(wrapped({ isLinked: true }))],
  ['gamesession', 'PUT', /^\/gamesession\/[^/]+\/?$/, (c) => {
    const key = playerKeyFromEpicToken(bearerOf(c.req));
    const player = getPlayer(key);
    player.epicId = epicSubOf(bearerOf(c.req)) || player.epicId || '';
    delete player.candidate;   // a fresh sign-in is never already in a match
    state.lastPlayer = key; saveState();
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
    return J({ accountId: asked, isSubscribed: false, language: null, linkedAccounts: [{ accountId: asked === p.accountId ? (p.epicId || '') : '', accountType: 'epic' }], username: null });
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
    const result = applyInventory(inventoryOf(p, b.characterId), b); saveState();
    return J(result);
  }],

  ['tracking', 'POST', /^\/heartbeat\/?$/, () => TEXT('20000', 'guess')],

  // Matchmaking, first steps only. The region list points back at this recorder so the game's
  // latency test stays on this PC.
  ['mm2', 'POST', /^\/candidate\/player\/register\/?$/, () => J({})],                                // captured
  ['mm2', 'GET', /^\/candidate\/regions\/?$/, (c) => J({ code: 200, message: 'success', payload: { maxPingingStepTime: 3, pingCount: 5, pingFrequency: 0.25, regionUrls: [`http://${PUBLIC_HOST || '127.0.0.1'}:${c.basePort}`] } })],
  ['_external', 'GET', /^\/$/, () => ({ status: 200, html: '<!DOCTYPE html><html><body>pong</body></html>', note: 'latency ping' })],

  // Matchmaking proper. There is no matchmaker: the "match" is the local game server started by
  // server-211.ps1. While that server is not up the game is told it is still matching, so it waits.
  ['mm2', 'POST', /^\/candidate\/join(\/[^/]*)?\/?$/, (c) => {
    const p = playerFor(c.req); const b = c.body || {};
    const dest = destinationFor(b);
    // The second server needs to know which player hunt each player is on: quest objectives check it
    // (UObjective::HasRequiredPlayerHuntTags / IsInRequiredRegion). The game server reads it from the map option
    // PlayerHuntIds=<account>:<player hunt>[,...] (UHuntSystemComponent::ReadPlayerHuntIDFromCommandLine). Oct 17.
    if (!dest.city && dest.url && /^[A-Za-z0-9_]{1,100}$/.test(String(b.playerHuntId || '')) && !/[?]PlayerHuntIds=/.test(dest.url)) {
      dest.url += `?PlayerHuntIds=${p.accountId}:${b.playerHuntId}`;
    }
    // DF-LAN-1147: one second server serves everyone. A player asking for the place another player is already in
    // joins it; a different place while someone else is out there sends this player back to Ramsgate instead of
    // closing the other player's server.
    const me = keyFor(c.req);
    let joinId = null;
    if (!dest.city) {
      const base = placeBase(dest.url);
      if (place && place.base === base) { place.owners.add(me); joinId = place.id; dest.url = place.url; }
      else if (place && [...place.owners].some((k) => k !== me)) {
        dest.note = `another player is in ${place.label}: go there too, or wait for them to come back. Staying in Ramsgate`;
        dest.city = true; delete dest.url;
      }
    } else leavePlace(me);
    p.candidate = { id: joinId || ('local1$' + crypto.randomBytes(16).toString('hex')), gameMode: b.gameMode || 'CITY', gameType: b.gameType || null,
      huntId: Array.isArray(b.hunts) && b.hunts.length ? b.hunts[0] : null, playerHuntId: b.playerHuntId || null,
      buildId: b.buildId || '647472_rel-1.14.7_shipping', gameSessionId: crypto.randomBytes(16).toString('hex'),
      city: dest.city, url: dest.url || null, label: dest.label, asked: Date.now() };
    // Outside the city: ask server-211.ps1 (through a small file) to start a second server on that map.
    if (!dest.city && !joinId) {
      leavePlace(me);
      place = { id: p.candidate.id, url: dest.url, base: placeBase(dest.url), label: dest.label, owners: new Set([me]) };
      setWanted({ id: p.candidate.id, url: dest.url, label: dest.label, reuse: b.gameType === 'TRAINING_GROUND', at: new Date().toISOString() });
    }
    saveState();
    return J({ candidateId: p.candidate.id, gameMode: p.candidate.gameMode, huntId: null, status: 'MATCHING', statusReason: null },
      dest.label + (dest.note ? ' - ' + dest.note : dest.city ? '' : ' - asking for a server on ' + dest.url.split('?')[0]));
  }],
  ['mm2', 'GET', /^\/candidate\/status\/?$/, (c) => {
    const p = playerFor(c.req); const cd = p.candidate;
    if (!cd) return { status: 404, note: 'no match was asked for' };
    const city = cd.city !== false;
    let srv = liveServer(city ? SERVER_FILE : HUNT_SERVER_FILE);
    if (srv && !city && srv.id !== cd.id) srv = null;                       // a server for an earlier destination
    const out = { candidateId: cd.id, candidateStatusPeriodMillis: srv ? 10000 : 3000, gameMode: cd.gameMode, huntId: cd.huntId, playerStates: { [p.accountId]: {} } };
    if (srv) out.serverInfo = { buildId: cd.buildId, gameSessionId: cd.gameSessionId, host: (PUBLIC_HOST && (!srv.host || srv.host === '127.0.0.1')) ? PUBLIC_HOST : (srv.host || '127.0.0.1'), port: srv.port };
    const waited = Math.round((Date.now() - (cd.asked || Date.now())) / 1000);
    const failed = !srv && !city && waited > 300;
    out.status = srv ? 'IN_PROGRESS' : failed ? 'FAILED' : 'MATCHING'; out.statusDuration = 0.0; out.statusReason = failed ? 'no server started for this destination' : null;
    if (failed) { setWanted(null); place = null; }
    return J(out, srv ? `game server on port ${srv.port}` : failed ? 'gave up after 5 minutes: no server came up for this destination'
      : city ? 'waiting: the game server is not running' : `waiting ${waited}s for the second server (${liveServer(SERVER_FILE) ? 'starting' : 'server-211.ps1 -Run is not running'})`);
  }],
  ['mm2', 'POST', /^\/candidate\/leave\/?$/, (c) => { const p = playerFor(c.req); if (p.candidate && p.candidate.city === false) leavePlace(keyFor(c.req)); delete p.candidate; saveState(); return J({}, 'guess'); }],
  ['mm2', 'DELETE', /^\/candidate\/?$/, (c) => { const p = playerFor(c.req); if (p.candidate && p.candidate.city === false) leavePlace(keyFor(c.req)); delete p.candidate; saveState(); return J({}, 'guess'); }],
  ['mm2', 'DELETE', /^\/party\/member\/?$/, () => J({}, 'left the party')],                           // captured
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
  ['progression', 'POST', /^\/progression\/tracked_objectives\/[^/]*\/?$/, () => J(wrapped(null))],                              // captured
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
  ['progression', 'PUT', /^\/progression\/(?!objectives\/|tracked_objectives\/)[^/]+\/([^/]+)\/(-?\d+)\/?$/, (c) => grantTrack(c)],
  ['progression', 'POST', /^\/progression\/[^/]+\/([^/]+)\/(\d+)\/confirm\/([^/]+)\/?$/, (c) => { const p = playerFor(c.req); const pr = progressOf(p); const id = decodeURIComponent(c.match[1]);
    const cur = pr.tracks[id] || (pr.tracks[id] = { progress: 0 }); const rank = Number(c.match[2]) || 0;
    if (/prem/i.test(c.match[3])) cur.confirmed_premium_rank = rank; else cur.confirmed_fremium_rank = rank;
    cur.confirmed_date = isoNow(); saveState(); return J(wrapped(trackOut(p, id, cur)), 'rank confirmed, guess'); }],
  ['progression', 'GET', /^\/progression\/tracked_objectives\/[^/]*\/?$/, (c) => J(wrapped({ current_set: '', omitted_quests: [], phx_account_id: playerFor(c.req).accountId, tracked_craftables: [], tracked_quests: [] }), 'empty')],
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
  ['mm2', 'GET', /^\/party\/invites\/?$/, () => J({ invitations: [] }, 'none')],
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
  ['mm2', 'POST', /^\/party\/?$/, (c) => {
    const p = playerFor(c.req);
    const build = (c.body && c.body.buildId) || '647472_rel-1.14.7_shipping';
    if (!p.partyId) { p.partyId = crypto.randomBytes(16).toString('hex') + '_' + Buffer.from(build).toString('base64').replace(/=+$/, ''); saveState(); }
    const cd = p.candidate || null;
    return J({ candidateId: cd ? cd.id : null, candidateState: cd ? (liveServer() ? 'IN_PROGRESS' : 'MATCHING') : null, gauntletLevel: null, leaderPlayerId: p.accountId, partyId: p.partyId, playerHuntId: cd ? cd.playerHuntId : null,
      playerStates: [{ consoleSessionId: null, displayName: p.username, isMemberOfCandidate: !!cd, platform: 'win', playerId: p.accountId }] }, 'solo party, guess');
  }],

  // Status banner, polled about every 30 seconds. "show-status" must be a real boolean.
  ['steelyard.online', 'GET', /^\/dauntless-status\/?$/, () => J({ 'show-status': false, en: '', fr: '', it: '', es: '', de: '', pt: '', ru: '', ja: '' })],
  // Analytics. Nothing is known to need a reply, so these are only written to the log.
  ['telemetry-ingest', 'POST', /^\/event\/?$/, () => ({ status: 404, note: 'telemetry, logged only' })],
  ['telemetry', 'POST', /^\/log\/?$/, () => J({ text: 'Success', code: 0 })],
  ['mailbox', 'GET', /^\/patchnotes\/.*$/, CAP('Mailbox/Patchnotes.md')],
];

// ---------------------------------------------------------------- server
function logLine(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  const t = entry.t.slice(11, 19);
  const mark = entry.known ? ' ' : '?';
  console.log(`${t} ${mark} ${String(entry.status).padEnd(3)} ${entry.svc.padEnd(16)} ${entry.m.padEnd(6)} ${entry.path}${entry.note ? '   [' + entry.note + ']' : ''}`);
}

function handle(svc, port, req, res, bodyBuf) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathName = url.pathname;
  if (!privateAddress(req.socket && req.socket.remoteAddress)) { res.writeHead(403, { 'Content-Length': 0 }); res.end(); return; }
  let body;
  if (bodyBuf.length) { try { body = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { body = undefined; } }
  req._pkey = keyFromIds(pathName, body);   // DF-LAN-1147: which player a server request is about

  let reply = null, known = false;
  if (pathName === '/_recorder/ping') { reply = J({ ok: true, service: svc.service, port }); known = true; }
  else {
    for (const [rSvc, rMethod, rPath, fn] of routes) {
      if (rSvc !== svc.service || rMethod !== req.method) continue;
      const match = rPath.exec(pathName);
      if (!match) continue;
      try { reply = fn({ req, body, match, url, basePort: BASE_PORT }); } catch (e) { reply = { status: 500, note: 'handler error: ' + e.message }; }
      known = true; break;
    }
  }
  if (!reply) reply = NOT_FOUND;

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
      reqLen: bodyBuf.length, body: redactBody(bodyBuf, req.headers['content-type']),
      resLen: Buffer.byteLength(payload),
    });
  }
}

function onUpgrade(svc, port, req, socket) {
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
  for (const svc of services) {
    const server = http.createServer((req, res) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
      req.on('end', () => handle(svc, svc.port, req, res, Buffer.concat(chunks)));
      req.on('error', () => {});
    });
    server.on('upgrade', (req, socket) => onUpgrade(svc, svc.port, req, socket));
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
