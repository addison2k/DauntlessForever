// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// social.js - the Friends page: a launcher account (just a name), friends, who is online / playing / hosting,
// and one-click Join. Talks to the Dauntless Forever social service on the VPS.
//
//   - Where the VPS is comes from network.json in the GitHub repo (cached in network.json in the data folder),
//     so moving or scaling the VPS is: edit network.json, push. Nothing to reinstall.
//   - The account is created once with a display name; the launcher keeps the id and secret in social.json and
//     signs every request with the secret (it is never sent again).
//   - Hosting: a version that runs "ONLINE - HOST" has data\relay.json while it is connected to the relay. A friend's
//     Join request is answered here: the launcher makes (once) an account on this PC's backend for that friend and
//     sends back the join code. The friend's launcher then runs LAN - JOIN with that code.
//   - Public games: "Play online" looks for a game open to everyone on the same version (nearest relay first) for
//     40 seconds and joins it, or else hosts one that is open to everyone. "Allow randoms" (under Host with friends)
//     opens a hosted game the same way. The host sees who is in the game; "Stop hosting" with players in it gives them
//     60 seconds (a line in chat, and their launchers save their characters home) before it closes.
//   - Host Mode (hostmode.js): the same hosting without a window (no game opens here) that stays up until stopped;
//     it adds a server name, a player limit and a ban list (hostModeHooks below).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { ipcMain, Notification } = require('electron');
const P = require('./paths');
const settings = require('./settings');
const V = require('./versions');   // V.online(v): each version's host/join scripts, relay file and backend port (Oct 17)

const RAW = 'https://raw.githubusercontent.com/addison2k/DauntlessForever/main/';
const NETWORK_URL = RAW + 'network.json';
const DEFAULT_NETWORK = { version: 1, relay: { host: '209.145.57.41', controlPort: 7000 }, social: { url: 'http://209.145.57.41:7080' } };
const POLL_MS = 20000, FAST_POLL_MS = 2000;

let ctx = null;            // { registry, byId, runner, send(channel, payload), log(text) }
let network = DEFAULT_NETWORK;
let state = null;          // last state from the service
let lastError = '';
let pollTimer = null;
let waitingJoin = null;    // { reqId, host, hostName, version, since }
let gameWith = null;       // { host, hostName, version, public }: the game this PC joined (voice, saving home)
let hostPublicVersion = null;   // the version this PC hosts open to everyone (started with -Public), or null
let search = null;         // Play online: { version, since, phase: searching|asking|hosting, host, tried: Set }
let closing = null;        // this host closing with players in it: { until, version, timers: [] }
let hostClosingSeen = '';  // the host-closing notice already acted on (guest side)
const answering = new Set();
let hostModeHooks = null;  // hostmode.js: { refuse(fromId, isFriend) -> reason|'', heartbeat() -> {}, brief() -> {}, stopped(byUser), cancelled() }

const socialFile = () => path.join(P.dataRoot(), 'social.json');
const networkCacheFile = () => path.join(P.dataRoot(), 'network.json');
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function writeJson(f, o) { P.ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
const identity = () => readJson(socialFile(), null);
// Offline Forever mode (Settings): no friends service at all, nobody sees this player online
const offlineMode = () => { try { return !!settings.load().offlineMode; } catch { return false; } };

// ------------------------------------------------------------------ network.json
function getText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'DauntlessForever' }, timeout: 10000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) { res.resume(); return resolve(getText(res.headers.location, redirects + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d); res.on('end', () => resolve(b));
    }).on('timeout', function () { this.destroy(new Error('timed out')); }).on('error', reject);
  });
}
function validNetwork(n) { return n && n.social && typeof n.social.url === 'string' && /^https?:\/\//.test(n.social.url) && n.relay && typeof n.relay.host === 'string'; }
async function loadNetwork() {
  const cached = readJson(networkCacheFile(), null);
  if (validNetwork(cached)) network = cached;
  try {
    const fresh = JSON.parse(await getText(NETWORK_URL + '?t=' + Date.now()));
    if (validNetwork(fresh)) { network = fresh; writeJson(networkCacheFile(), fresh); }
  } catch { /* offline or not published yet: cached or built-in */ }
  return network;
}
// network.json can switch online play off for everyone ("online": {"enabled": false, "message": "..."}), e.g. while the
// server is down and nobody can look after it. Solo play never depends on it.
const onlineOn = () => !(network && network.online && network.online.enabled === false);
const onlineOffMessage = () => (network.online && network.online.message) || 'Online play is switched off for now.';
// How far this PC is from the relay(s): the host page says when it is far (EU players on a US relay, say)
let relayPing = null;    // { name, ms } of the fastest relay, or null
let relayPings = {};     // every relay: id -> ms (Forever: the director places you by these)
function measureOne(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now(); const s = require('net').connect({ host, port });
    const done = (ms) => { s.destroy(); resolve(ms); };
    s.setTimeout(2500, () => done(null)); s.on('connect', () => done(Date.now() - t0)); s.on('error', () => done(null));
  });
}
const relayList = () => (Array.isArray(network.relays) && network.relays.length ? network.relays : [network.relay]).filter(r => r && r.host);
// which relay region a host address belongs to ("us", "eu"...): public games list it, Play online prefers your own
function regionOf(ip) { const r = relayList().find(x => x.host === ip); return r ? String(r.id || r.name || r.host) : ''; }
async function measureRelays() {
  const list = relayList();
  let best = null; const all = {};
  for (const r of list) {
    if (!r || !r.host) continue;
    let ms = null;
    for (let i = 0; i < 3; i++) { const m = await measureOne(r.host, Number(r.controlPort) || 7000); if (m !== null && (ms === null || m < ms)) ms = m; }
    if (ms !== null) all[String(r.id || r.name || r.host)] = ms;
    if (ms !== null && (!best || ms < best.ms)) best = { name: r.name || r.host, ms, id: String(r.id || r.name || r.host) };
  }
  relayPing = best; relayPings = all;
  push();
}

// ------------------------------------------------------------------ signed requests
// DF-SOCIAL-FALLBACK (Oct 21): some dorm, school and work networks cut the secure connection to sites they do not
// know (the TLS handshake is reset). When the secure address cannot be reached at all, the same request goes to the
// plain address of the same server (network.json social.fallback, else the built-in one); requests are signed either
// way. After that works, the plain address is used for 10 minutes before the secure one is tried again.
// HTTP answers (401, 403...) never switch: only a connection that could not be made.
const FALLBACK_MS = 10 * 60 * 1000;
let plainUntil = 0, plainSaid = false;
const fallbackBase = () => (network.social && typeof network.social.fallback === 'string' && /^http:\/\//.test(network.social.fallback) ? network.social.fallback : LEGACY_SOCIAL);
const connectionFailed = (e) => !!e && !e.status;
function usingPlain() { return /^https:/i.test(network.social.url) && Date.now() < plainUntil; }
async function call(method, apiPath, body, unsigned, timeoutMs) {
  const secure = network.social.url;
  if (!/^https:/i.test(secure)) return callAt(secure, method, apiPath, body, unsigned, timeoutMs);
  if (Date.now() < plainUntil) {
    try { return await callAt(fallbackBase(), method, apiPath, body, unsigned, timeoutMs); }
    catch (e) { if (!connectionFailed(e)) throw e; plainUntil = 0; }   // the plain one is gone now (another network): back to secure
  }
  try { return await callAt(secure, method, apiPath, body, unsigned, timeoutMs); }
  catch (e) {
    if (!connectionFailed(e)) throw e;
    let r;
    try { r = await callAt(fallbackBase(), method, apiPath, body, unsigned, timeoutMs); }
    catch (e2) { if (connectionFailed(e2)) throw e; throw e2; }   // both unreachable: the secure address's reason
    plainUntil = Date.now() + FALLBACK_MS;
    if (!plainSaid) { plainSaid = true; try { ctx.log(`Friends: the secure connection is blocked on this network (${e.code || e.message}); using the plain connection to the same server.`); } catch {} }
    return r;
  }
}
function callAt(base, method, apiPath, body, unsigned, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, base);
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    const me = identity();
    if (!unsigned) {
      if (!me) return reject(Object.assign(new Error('not signed in'), { status: -1 }));
      const time = Date.now();
      headers['X-DF-Id'] = me.id; headers['X-DF-Time'] = String(time);
      headers['X-DF-Sig'] = crypto.createHmac('sha256', me.secret).update(`${time}\n${method}\n${url.pathname}\n${data}`).digest('hex');
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout: timeoutMs || 10000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d);
      res.on('end', () => {
        let j = {}, bad = false; try { j = b ? JSON.parse(b) : {}; } catch { bad = true; }
        if (res.statusCode >= 200 && res.statusCode < 300 && !bad) resolve(j);
        else if (bad && res.statusCode >= 200 && res.statusCode < 400) { const e = new Error('a web page answered instead of the friends service (internet provider or network filter)'); e.status = res.statusCode; reject(e); }
        else { const e = new Error(j.error || ('HTTP ' + res.statusCode)); e.status = res.statusCode; reject(e); }
      });
    });
    req.on('timeout', () => { const e = new Error('the friends service did not answer'); e.code = 'TIMEOUT'; req.destroy(e); });
    req.on('error', (e) => { const x = new Error(e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'TIMEOUT' ? 'the friends service is not reachable' : e.message); x.code = e.code; reject(x); });
    req.end(data);
  });
}

// ------------------------------------------------------------------ what this PC is doing
// What the launcher last found: hosting only counts while this PC's backend answers (a relay.json left behind by a
// host window that was closed the hard way must not keep saying "hosting" forever).
let hostingNow = null;   // version id or null
function hostingVersion() {
  for (const v of ctx.registry) {
    if (!v.package) continue;
    try { const st = JSON.parse(fs.readFileSync(V.online(v).relayPath, 'utf8')); if (st && st.base) return { v, relay: st }; } catch {}
  }
  return null;
}
function playingVersion() {
  const r = ctx.runner.anyRunning().find(x => x.kind === 'play' || x.kind === 'host' || x.kind === 'join');
  return r ? String(r.id).split(':')[0] : null;
}

// ------------------------------------------------------------------ host side: answer Join requests
function postLocal(port, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: apiPath, method: 'POST', timeout: 8000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('backend answered ' + res.statusCode)); } });
    });
    req.on('timeout', () => req.destroy(new Error('the local backend did not answer')));
    req.on('error', reject);
    req.end(data);
  });
}
// the host's backend answers on this PC (it takes a minute to start after "Host with friends")
function backendUp(v) {
  const o = V.online(v);
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: o.statusPort, path: o.statusPath, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
  });
}
async function answerJoin(r) {
  if (answering.has(r.reqId)) return;
  answering.add(r.reqId);
  try {
    const h = hostingVersion();
    if (!h) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'The host stopped hosting.' }); return; }
    const isFriend = (state && state.friends || []).some(f => f.id === r.from);
    if (!isFriend && hostPublicVersion !== h.v.id) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'That game is for friends only.' }); return; }
    // Host Mode: its ban list and player limit
    const refused = hostModeHooks ? hostModeHooks.refuse(r.from, isFriend) : '';
    if (refused) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: refused }); ctx.log(`Host Mode: did not let ${r.name} in (${refused})`); return; }
    if (closing) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'That game is closing.' }); return; }
    const filesBad = filesProblem(h.v.id, filesState(h.v), r);
    if (filesBad) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: filesBad }); ctx.log(`Friends: did not let ${r.name} in: ${filesBad}`); return; }
    // one account on this PC's backend per friend, kept in data\friend_accounts.json (never shared with anyone else)
    const file = path.join(h.v.dataDir, 'data', 'friend_accounts.json');
    // a friend who presses Join while this game is still starting: wait for the backend (up to 2 minutes)
    for (let i = 0; i < 40 && !(await backendUp(h.v)); i++) {
      if (!hostingVersion()) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'The host stopped hosting.' }); return; }
      await new Promise(res => setTimeout(res, 3000));
    }
    const o = V.online(h.v);
    if (!o.accounts) {
      // this version keeps each player apart by their own sign-in (1.14.7): the code is only the address
      await call('POST', '/v1/join/answer', { reqId: r.reqId, code: `${h.relay.ip}:${h.relay.base}` });
      ctx.log(`Friends: let ${r.name} join your ${h.v.id} game${isFriend ? '' : ' (open to everyone)'}.`);
      return;
    }
    const accounts = readJson(file, {});
    let key = accounts[r.from] && accounts[r.from].key;
    if (!key) {
      const reply = await postLocal(o.statusPort, '/undaunted/api/Register', { Username: String(r.name || 'Friend').slice(0, 20) });
      key = String(reply.UUK || '');
      if (!key.startsWith('UUK_')) throw new Error('the backend did not make the account');
      accounts[r.from] = { key, name: r.name, made: new Date().toISOString() };
      writeJson(file, accounts);
    }
    const code = `${h.relay.ip}:${h.relay.base}|${key}`;
    await call('POST', '/v1/join/answer', { reqId: r.reqId, code });
    ctx.log(`Friends: let ${r.name} join your ${h.v.id} game${isFriend ? '' : ' (open to everyone)'}.`);
  } catch (e) {
    ctx.log('Friends: could not answer a join request: ' + e.message);
    try { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'The host could not let you in (' + e.message + ').' }); } catch {}
  } finally { setTimeout(() => answering.delete(r.reqId), 60000); }
}

// ------------------------------------------------------------------ join side
function startJoin(versionId, code, w) {
  const v = ctx.byId(versionId);
  if (!v) throw new Error('This version is not installed.');
  const script = V.online(v).joinPath;
  if (!v.package || !fs.existsSync(script)) throw new Error('This version has no join script yet. Update its server files.');
  ctx.runner.runVisible(versionId + ':join', 'join', script, ['-Code', `'${code.replace(/'/g, "''")}'`], `Dauntless ${versionId} - joining a friend`, { closeWhenDone: true })   // DF-JOINCLOSE: 'You are in X's game' clears when the game closes
    .then(() => { if (gameWith && gameWith.since === since) gameWith = null; push(); });
  const since = Date.now();
  gameWith = w ? { host: w.host, hostName: w.hostName, version: versionId, since, public: !!w.public } : null;
  push();
}
// The voice room of the game this PC is in: its own when hosting, the host's after joining a friend
function currentRoom() {
  const me = identity();
  if (!me || offlineMode()) return null;
  // public: a game open to everyone (voice there starts only when the player presses Join voice)
  const h = hostingVersion();
  if (h) return { id: me.id, name: 'your game', public: hostPublicVersion === h.v.id };
  if (gameWith && ctx.runner.isRunning(gameWith.version + ':join')) return { id: gameWith.host, name: gameWith.hostName + "'s game", public: !!gameWith.public };
  return null;
}

// ------------------------------------------------------------------ poll
function push() { ctx.send('social:update', publicState()); }
// The launcher's one player name (player.js) is also the friends name: sign up with it, or rename to it.
async function applyName(name) {
  if (offlineMode() || !name) return;
  push();   // the panel shows the new name at once, even if the friends service is slow or offline
  const me = identity();
  if (!me) {
    const r = await call('POST', '/v1/register', { name }, true);
    writeJson(socialFile(), { id: r.id, secret: r.secret, name: r.name, server: network.social.url, created: new Date().toISOString() });
    ctx.log(`Friends: signed up as ${r.name}`);
  } else if (me.name !== name) {
    const r = await call('POST', '/v1/name', { name });
    me.name = r.me.name; writeJson(socialFile(), me);
    if (r.friends) state = Object.assign(state || {}, r);
  } else return;
  push();
  setTimeout(poll, 100);
}
function publicState() {
  const me = identity();
  return {
    offlineMode: offlineMode(),
    signedIn: !!me, name: me ? me.name : '', tag: state && state.me && state.me.tag ? state.me.tag : '', playerName: require('./player').get(),
    error: lastError, server: network.social.url,
    friends: state ? state.friends : [], incoming: state ? state.incoming : [], outgoing: state ? state.outgoing : [],
    hosting: hostingNow,
    waiting: waitingJoin ? { host: waitingJoin.hostName, version: waitingJoin.version } : null,
    running: ctx.runner.anyRunning(),
    onlineOff: onlineOn() ? null : onlineOffMessage(),
    relay: relayPing,     // the Play page: hosting / in a friend's game
    allowRandoms: allowRandoms(),
    hostPublic: hostingNow && hostPublicVersion === hostingNow ? true : false,
    hostMode: hostModeHooks ? hostModeHooks.brief() : null,   // Host Mode: {version, state, name, mode} or null
    guests: hostingNow && state && state.guests ? state.guests : [],
    closingIn: closing ? Math.max(0, Math.ceil((closing.until - Date.now()) / 1000)) : 0,
    hostClosing: state && state.hostClosing && gameWith ? { name: state.hostClosing.name, inSec: Math.max(0, Math.ceil(state.hostClosing.inMs / 1000)) } : null,
    search: search ? { version: search.version, phase: search.phase, host: search.host || '', left: Math.max(0, Math.ceil((search.since + SEARCH_MS - Date.now()) / 1000)) } : null,
    inGameWith: gameWith && ctx.runner.isRunning(gameWith.version + ':join') ? { name: gameWith.hostName, version: gameWith.version, public: !!gameWith.public } : null,
    chat: chatState(),   // DF-CHAT: { cap, unread: { friendId: n }, open: friendId|null }
  };
}
// ------------------------------------------------------------------ DF-CHAT (Oct 29): friend-to-friend text in the Friends panel
// Friends only. Chat is its own small service on the VPS (df-chat, behind the same address under /v1/chat/*), kept
// OUT of the director's process so chat changes never restart the director. It keeps the last 50 messages per pair
// for 24 h; the launcher asks it /v1/chat/unread on every poll (that answer is also how the launcher knows chat
// exists: a 404 means no chat service yet -> no chat UI, asked again in 5 minutes). This PC keeps its own copy of
// each conversation in chat\<friendId>.json under the data folder (last 200) so the view does not go blank after the
// server's 24 hours. While a conversation is open the poll runs fast (2 s). A message arriving while the window is
// not focused shows a Windows notification, at most one per friend per minute.
const CHAT_KEEP = 200, CHAT_MAX = 500, CHAT_RETRY_MS = 5 * 60 * 1000;
const chatSvc = { cap: false, unread: {}, nextTry: 0, said: false };   // what the chat service last said
function chatBase() { return (network.chat && typeof network.chat.url === 'string' && /^https?:\/\//.test(network.chat.url)) ? network.chat.url : null; }   // network.json chat.url = another address for it (optional)
function chatCall(method, apiPath, body, timeoutMs) { const b = chatBase(); return b ? callAt(b, method, apiPath, body, false, timeoutMs) : call(method, apiPath, body, false, timeoutMs); }
async function chatPollUnread() {
  if (CHAT_MOCK || !identity() || offlineMode()) return;
  if (!chatSvc.cap && Date.now() < chatSvc.nextTry) return;
  try {
    const r = await chatCall('POST', '/v1/chat/unread', {}, 8000);
    chatSvc.cap = !!(r && r.cap); chatSvc.unread = (r && r.unread) || {};
    if (chatSvc.cap && !chatSvc.said) { chatSvc.said = true; ctx.log('Friends: chat is available'); }
  } catch (e) {
    if (e.status === 404 || e.status === 501) { chatSvc.cap = false; chatSvc.unread = {}; chatSvc.nextTry = Date.now() + CHAT_RETRY_MS; }   // no chat service there (yet)
    // any other failure (network, 5xx): keep what we had, try again next poll
  }
}
const CHAT_MOCK = !!process.env.DF_CHAT_MOCK;   // test hook (dev only): the service has no chat yet -> pretend it does and echo messages back locally
let chatOpen = null;                 // friendId whose conversation is on screen (fast poll, read marks)
const chatLastNotified = {};         // friendId -> time of the last notification
const chatKnownLast = {};            // friendId -> highest message id this PC has seen (notification + unread guard)
function chatDir() { return P.ensureDir(path.join(P.dataRoot(), 'chat')); }
function chatFile(id) { return path.join(chatDir(), String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
function chatLoad(id) { try { const a = JSON.parse(fs.readFileSync(chatFile(id), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function chatSave(id, list) { try { writeJson(chatFile(id), list.slice(-CHAT_KEEP)); } catch {} }
function chatMerge(id, fresh) {
  const have = chatLoad(id), seen = new Set(have.map(m => String(m.id)));
  let changed = false;
  for (const m of fresh || []) { if (!m || seen.has(String(m.id))) continue; have.push({ id: m.id, from: m.from, text: String(m.text || '').slice(0, CHAT_MAX), at: m.at }); seen.add(String(m.id)); changed = true; }
  have.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  if (changed) chatSave(id, have);
  return have.slice(-CHAT_KEEP);
}
function chatState() {
  return { cap: chatSvc.cap || (CHAT_MOCK && !!identity()), unread: chatSvc.unread || {}, open: chatOpen };
}
function friendName(id) { const f = (state && state.friends || []).find(x => x.id === id); return f ? f.name : ''; }
// called from poll(): new unread from a friend whose conversation is not open -> one notification per friend per minute
function chatNotify() {
  if (!chatSvc.cap) return;
  for (const [id, n] of Object.entries(chatSvc.unread || {})) {
    if (!n || id === chatOpen) continue;
    const key = id + '|' + n; if (chatKnownLast[id] === key) continue; chatKnownLast[id] = key;
    const focused = (() => { try { const w = require('electron').BrowserWindow.getAllWindows().find(x => x.isFocused()); return !!w; } catch { return false; } })();
    if (focused) continue;
    if (Date.now() - (chatLastNotified[id] || 0) < 60000) continue; chatLastNotified[id] = Date.now();
    try { if (Notification.isSupported()) { const no = new Notification({ title: require('./i18n').t('{name} sent you a message', { name: friendName(id) || 'A friend' }), body: require('./i18n').t('Open the Friends panel to read it.') }); no.on('click', () => { try { ctx.send('social:chatOpen', { id }); const w = require('electron').BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } } catch {} }); no.show(); } } catch {}
  }
}
async function chatFetch(id) {
  const have = chatLoad(id);
  const after = have.length ? have[have.length - 1].id : 0;
  let fresh = [];
  if (CHAT_MOCK) return { ok: true, messages: chatMerge(id, []) };
  try { const r = await chatCall('POST', '/v1/chat/fetch', { with: id, after }); fresh = (r && r.messages) || []; }
  catch (e) { if (e.status === 403) return { ok: false, error: 'You are not friends any more.' }; if (!have.length) return { ok: false, error: e.message }; }
  const list = chatMerge(id, fresh);
  if (list.length && chatOpen === id) { const last = list[list.length - 1].id; chatCall('POST', '/v1/chat/read', { with: id, upTo: last }).catch(() => {}); delete chatSvc.unread[id]; }
  return { ok: true, messages: list };
}
async function poll() {
  clearTimeout(pollTimer);
  try {
    if (offlineMode()) { state = null; waitingJoin = null; lastError = ''; return; }
    if (!onlineOn()) { waitingJoin = null; lastError = ''; return; }   // switched off in network.json: no calls at all
    if (!identity()) {
      state = null;
      const name = require('./player').get();
      if (name) { try { await applyName(name); } catch (e) { lastError = e.message; } }
      return;
    }
    // the player name changed while the friends service could not be reached: catch up
    const pn = require('./player').get();
    if (pn && identity().name !== pn) { try { await applyName(pn); } catch {} }
    // friends see "Hosting" (and a Join button) only once this PC's backend answers: no Join into a game still starting
    let h = hostingVersion();
    if (h && !(await backendUp(h.v))) {
      // nothing answers: if no host window of ours is open either, the relay.json is left over: tidy it away
      if (!ctx.runner.isRunning(h.v.id + ':host')) { try { fs.unlinkSync(V.online(h.v).relayPath); } catch {} }
      h = null;
    }
    hostingNow = h ? h.v.id : null;
    const playing = playingVersion();
    if (!h && !(ctx.runner.isRunning((hostPublicVersion || '') + ':host'))) hostPublicVersion = null;   // that hosting ended
    const inGame = gameWith && ctx.runner.isRunning(gameWith.version + ':join') ? gameWith.host : null;
    state = await call('POST', '/v1/heartbeat', {
      status: playing ? 'playing' : 'online', version: h ? h.v.id : playing, hosting: !!h,
      public: !!h && hostPublicVersion === h.v.id, region: h ? regionOf(h.relay.ip) : '', inGame,
      closingIn: h && closing ? Math.max(1, Math.ceil((closing.until - Date.now()) / 1000)) : 0,
      ...(h && hostModeHooks ? hostModeHooks.heartbeat(h.v.id) : {}),   // Host Mode: {hostMode, server, max}
      ...filesFields(filesState(h ? h.v : (playing ? ctx.byId(playing) : null))),   // DF-FILES: server files number and game folder check
      launcher: launcherVersion(),
    });
    lastError = '';
    guestSideClosing();
    for (const r of state.joinRequests || []) answerJoin(r);
    if (waitingJoin) {
      const a = (state.joinAnswers || []).find(x => x.reqId === waitingJoin.reqId);
      if (a) {
        const w = waitingJoin; waitingJoin = null;
        call('POST', '/v1/join/done', { reqId: a.reqId }).catch(() => {});
        if (a.code) { ctx.log(`Friends: joining ${w.hostName}...`); try { startJoin(w.version, a.code, w); } catch (e) { lastError = e.message; } }
        else if (w.fromSearch) w.failed = a.error || 'not let in';      // Play online: try the next game
        else lastError = a.error || 'The host did not let you in.';
      } else if (Date.now() - waitingJoin.since > (waitingJoin.fromSearch ? 45000 : 150000)) {
        if (!waitingJoin.fromSearch) lastError = 'The host did not answer. Is their launcher open?';
        waitingJoin = null;
      }
    }
  } catch (e) {
    lastError = e.status === 401 ? 'Your friends account was not recognised by the server. Settings > Friends account can check why and fix it.' : e.message;
  } finally {
    try { await chatPollUnread(); chatNotify(); } catch {}   // DF-CHAT
    push();
    // in someone's game: a little more often, so a host closing reaches this PC in time to save the character home
    const inGame = gameWith && ctx.runner.isRunning(gameWith.version + ':join');
    pollTimer = setTimeout(poll, (waitingJoin || chatOpen) ? FAST_POLL_MS : (inGame ? 10000 : POLL_MS));   // DF-CHAT: fast while a conversation is open
  }
}

// ------------------------------------------------------------------ public games
const SEARCH_MS = 40000;
const allowRandoms = () => { try { return settings.load().allowRandoms !== false; } catch { return true; } };   // on unless the player unticked it
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ------------------------------------------------------------------ server files check (DF-FILES, Oct 19)
// What this PC runs for a version: the server files number, and whether every file Set up put in the game folder
// (loader dxgi.dll, server DLL, EOSSDK, paks) is the one those server files expect (same check as Settings ->
// "What you are running"). Sent in the heartbeat (dashboard) and with join requests: the host refuses a player whose
// number differs or whose game folder has swapped files, and the other way round. "Keep my server files" (modders)
// is reported, not refused. Hashes are cached per file (size + time), so the 20 s poll stays cheap.
const hashCache = new Map();
function fileHash(file) {
  let st; try { st = fs.statSync(file); } catch { return ''; }
  const k = file + '|' + st.size + '|' + st.mtimeMs, c = hashCache.get(file);
  if (c && c.k === k) return c.h;
  const h = V.sha256(file) || ''; hashCache.set(file, { k, h }); return h;
}
function filesState(v) {
  if (!v || !v.package) return null;
  const out = { pkg: V.installedPackageVersion(v) || '', kept: false, changed: [] };
  try { out.kept = !!settings.load().keepServerFiles; } catch {}
  const gameDir = V.knownGameDir(v);
  if (gameDir) for (const f of v.package.installedFiles || []) {
    const have = fileHash(path.join(gameDir, f.rel));
    if (!have || have.toUpperCase() !== String(f.sha256).toUpperCase()) out.changed.push(path.basename(f.rel));
  }
  out.ok = !out.changed.length;
  return out;
}
const filesFields = (f) => (f ? { pkg: f.pkg, pkgOk: f.ok, pkgChanged: f.changed.slice(0, 8), pkgKept: f.kept } : {});
const launcherVersion = () => { try { return require('electron').app.getVersion(); } catch { return ''; } };
const pkgNum = (x) => { const m = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(String(x || '')); return m ? Number(m[1] + m[2] + m[3]) * 1000 + Number(m[4]) : 0; };
// why this host and that player cannot play together, or '' (who: 'you' = the player asking, from the host's side)
function filesProblem(version, host, guest) {
  if (!host || !guest || !guest.pkg) return '';   // an older launcher reports nothing: let it in
  if (host.kept || guest.pkgKept) return '';      // "Keep my server files": the players chose that themselves
  if (guest.pkgOk === false) return `Your ${version} game folder has changed files (${(guest.pkgChanged || []).join(', ') || 'unknown'}). In the launcher, press Set up for ${version} to put the right ones back, then join again.`;
  if (!host.ok) return `The host's ${version} game folder has changed files (${host.changed.join(', ')}). The host needs to press Set up for ${version} in their launcher.`;
  if (host.pkg && guest.pkg !== host.pkg) {
    const older = pkgNum(guest.pkg) < pkgNum(host.pkg) ? 'You have the older ones: restart your launcher to update' : 'The host has the older ones: they need to restart their launcher to update';
    return `Your ${version} server files (${guest.pkg}) are not the host's (${host.pkg}). ${older}, then join again.`;
  }
  return '';
}
// Host a version: friends only, or open to everyone (pub: Play online, or "Allow randoms" ticked)
function startHost(versionId, pub) {
  if (!onlineOn()) throw new Error(onlineOffMessage() + ' Solo play still works.');
  const v = ctx.byId(versionId);
  if (!v) throw new Error('This version is not installed.');
  const script = V.online(v).hostPath;
  if (!v.package || !fs.existsSync(script)) throw new Error('This version cannot host online yet. Update its server files.');
  hostPublicVersion = pub ? versionId : null;
  ctx.runner.runVisible(versionId + ':host', 'host', script, pub ? ['-Public'] : [], `Dauntless ${versionId} - hosting online${pub ? ', open to everyone' : ''} (keep open)`)
    .then(() => { if (hostPublicVersion === versionId) hostPublicVersion = null; closing = null; push(); });
  push();
  setTimeout(poll, 15000);
}
// Host Mode (hostmode.js): the same hosting without a window: no game opens on this PC, and the server stays up until
// it is stopped. Every line the script prints goes to onLine. Resolves with its exit code when it ends.
function startHostMode(versionId, pub, onLine) {
  if (!onlineOn()) return Promise.reject(new Error(onlineOffMessage()));
  const v = ctx.byId(versionId);
  if (!v) return Promise.reject(new Error('This version is not installed.'));
  const script = V.online(v).hostPath;
  if (!v.package || !fs.existsSync(script)) return Promise.reject(new Error('This version cannot host online yet. Update its server files.'));
  hostPublicVersion = pub ? versionId : null;
  const p = ctx.runner.runHidden(versionId + ':host', 'host', script, pub ? ['-HostMode', '-Public'] : ['-HostMode'], onLine)
    .then((code) => { if (hostPublicVersion === versionId) hostPublicVersion = null; closing = null; push(); return code; });
  push();
  setTimeout(poll, 15000);
  return p;
}
// Play online: join a public game on this version (nearest relay first, then the fullest with room), or host one
function checkPlayOnline(versionId) {
  if (!onlineOn()) throw new Error(onlineOffMessage() + ' Solo play still works.');
  if (!identity()) throw new Error('Still signing you in to the online service. Try again in a moment.');
  const v = ctx.byId(versionId);
  if (!v) throw new Error('This version is not installed.');
  if (!v.package || !fs.existsSync(V.online(v).hostPath) || !fs.existsSync(V.online(v).joinPath))
    throw new Error('This version cannot play online yet. Update its server files.');
  if (ctx.runner.anyRunning().length) throw new Error('Close the game that is running first.');
  if (search) throw new Error('Already looking for a game.');
}
async function playOnline(versionId) {
  const me = search = { version: versionId, since: Date.now(), phase: 'searching', host: '', tried: new Set() };
  ctx.log(`Play online: looking for a ${versionId} game...`);
  push();
  const ticker = setInterval(push, 1000);   // the button counts down
  try {
    while (search === me && Date.now() - me.since < SEARCH_MS) {
      let games = [];
      try { games = (await call('POST', '/v1/public/list', { version: versionId })).games || []; } catch (e) { ctx.log('Play online: ' + e.message); }
      if (search !== me) return;
      const mine = relayPing && relayPing.id;
      games = games.filter(g => !me.tried.has(g.id) && g.players < g.max)
        .sort((a, b) => ((b.region === mine) - (a.region === mine)) || (b.players - a.players) || (b.since - a.since));
      const g = games[0];
      if (!g) { push(); await sleep(4000); continue; }
      me.tried.add(g.id); me.phase = 'asking'; me.host = g.hostMode && g.server ? g.server : g.name; push();
      let r;
      try { r = await call('POST', '/v1/join', { host: g.id, ...filesFields(filesState(ctx.byId(versionId))) }); } catch (e) { me.phase = 'searching'; ctx.log(`Play online: ${g.name}: ${e.message}`); continue; }
      const w = waitingJoin = { reqId: r.reqId, host: g.id, hostName: g.name, version: versionId, since: Date.now(), fromSearch: true, public: true };
      setTimeout(poll, 500);
      while (search === me && waitingJoin === w) await sleep(500);
      if (search !== me) return;
      if (ctx.runner.isRunning(versionId + ':join')) { ctx.log(`Play online: joined ${g.name}'s game.`); return; }
      ctx.log(`Play online: ${g.name} did not let us in (${w.failed || 'no answer'}).`);
      me.phase = 'searching'; me.host = ''; push();
    }
    if (search !== me) return;
    me.phase = 'hosting'; push();
    ctx.log('Play online: no open game found, hosting one that is open to everyone.');
    startHost(versionId, true);
  } finally { clearInterval(ticker); if (search === me) search = null; push(); }
}
// The host closes with players in the game: they get a line in chat and 60 seconds (their launchers save their
// characters home at once); then the game closes. "Keep playing" calls it off.
function announce(v, text) {
  try { fs.writeFileSync(path.join(v.dataDir, 'data', 'announce.txt'), text); } catch (e) { ctx.log('Friends: could not post the closing notice: ' + e.message); }
}
async function stopHostNow(byUser) {
  if (closing) { closing.timers.forEach(clearTimeout); closing = null; }
  for (const v of ctx.registry) {
    const id = v.id + ':host';
    if (!v.package) continue;
    const relayFile = V.online(v).relayPath;
    if (!ctx.runner.isRunning(id) && !fs.existsSync(relayFile)) continue;   // this version is not hosting: leave it alone
    if (ctx.runner.isRunning(id)) ctx.runner.killTree(id);
    try { await ctx.runner.runStop(v, () => {}); } catch {}
    try { fs.unlinkSync(relayFile); } catch {}
  }
  hostingNow = null; hostPublicVersion = null;
  ctx.log('Friends: stopped hosting.');
  if (hostModeHooks) hostModeHooks.stopped(!!byUser);
  setTimeout(poll, 500);
}
// byUser: the player asked (Stop hosting); false for Host Mode's own daily restart
function stopHostLater(seconds, byUser, who) {
  const h = hostingVersion();
  if (!h) return stopHostNow(byUser);
  if (closing) return;
  const me = who || (identity() || {}).name || 'The host';
  closing = { until: Date.now() + seconds * 1000, version: h.v.id, timers: [], byUser: !!byUser };
  announce(h.v, `${me} is closing this game in ${seconds} seconds. Your character is being saved home: finish up and head back.`);
  closing.timers.push(setTimeout(() => { const hh = hostingVersion(); if (hh && closing) announce(hh.v, `${me}'s game closes in 15 seconds.`); }, Math.max(0, (seconds - 15) * 1000)));
  closing.timers.push(setTimeout(() => { stopHostNow(closing ? closing.byUser : byUser).catch(() => {}); }, seconds * 1000));
  closing.timers.push(setInterval(push, 1000));   // the panel counts down (clearTimeout clears it too)
  ctx.log(`Friends: closing your game in ${seconds} seconds (${(state && state.guests || []).length} player(s) in it).`);
  poll();
}
// Guest side: the host is closing. Save the character home now (lan-join.ps1 watches data\travel_save_now) and say so.
function guestSideClosing() {
  const hc = state && state.hostClosing;
  if (!hc || !gameWith || hc.id !== gameWith.host) return;
  const key = hc.id + ':' + hc.at;
  if (hostClosingSeen === key) return;
  hostClosingSeen = key;
  const v = ctx.byId(gameWith.version);
  if (v) { try { fs.writeFileSync(path.join(v.dataDir, 'data', 'travel_save_now'), new Date().toISOString()); } catch {} }
  const secs = Math.max(0, Math.ceil(hc.inMs / 1000));
  ctx.log(`Friends: ${hc.name} is closing their game in ${secs} seconds. Saving your character home.`);
  try { if (Notification.isSupported()) new Notification({ title: require('./i18n').t('{name} is closing their game', { name: hc.name }), body: require('./i18n').t('In about {secs} seconds. Your character is being saved home now.', { secs }) }).show(); } catch {}
}

// ------------------------------------------------------------------ Settings > Friends account (DF-ACCOUNT, Oct 21)
// "Check connection" writes a short report a player can paste in Discord; "Reset account" makes a fresh friends account
// (same player name, empty friends list) when the server no longer knows the old one. Both replace the PowerShell steps
// that were sent to players by hand.
const LEGACY_SOCIAL = 'http://209.145.57.41:7080';   // the plain-HTTP door, kept open on the VPS: a second probe
const CLOCK_LIMIT_S = 5 * 60;                         // the service refuses signed requests more than 5 minutes off
// One GET, redirects NOT followed (an internet provider's quota or login page shows up as a redirect or a web page)
function rawGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = lib.request(url, { method: 'GET', headers: { 'User-Agent': 'DauntlessForever' }, timeout: timeoutMs || 8000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => { if (b.length < 4096) b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, ms: Date.now() - t0 }));
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; req.destroy(e); });
    req.on('error', reject);
    req.end();
  });
}
// What a failed connection most likely means, in words a player understands
function netProblem(e) {
  const c = String((e && e.code) || '');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'the server name could not be looked up (no internet, or a DNS problem)';
  if (c === 'ECONNREFUSED') return 'the connection was refused (a firewall or antivirus may be blocking the launcher)';
  if (c === 'TIMEOUT' || c === 'ETIMEDOUT') return 'no answer (no internet, or a firewall is blocking the launcher)';
  if (c === 'ECONNRESET') return 'the connection was cut (a firewall, antivirus or your internet provider closed it)';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(c + ' ' + ((e && e.message) || ''))) return 'the secure connection was intercepted (your internet provider showing its own page, e.g. data cap used up or a Wi-Fi login, or an antivirus web shield)';
  return (e && (e.code || e.message)) || 'unknown error';
}
const looksLikeJson = (r) => /json/i.test(String(r.headers['content-type'] || '')) || /^\s*[{[]/.test(r.body || '');
// Probe one address of the friends service: { ok, text, clockOffS }
async function probeService(base, label) {
  try {
    const r = await rawGet(new URL('/v1/health', base).toString(), 8000);
    const date = Date.parse(r.headers.date || '');
    const clockOffS = Number.isFinite(date) ? Math.round((Date.now() - date) / 1000) : null;
    if (r.status >= 300 && r.status < 400) {
      let to = String(r.headers.location || ''); try { to = new URL(to, base).host; } catch {}
      return { ok: false, redirected: true, text: `FAIL ${label}: your internet provider sent the launcher to another page${to ? ' (' + to + ')' : ''} instead of our server. This is usually a "data cap used up" page or a Wi-Fi login page.` };
    }
    if (r.status === 200 && looksLikeJson(r)) {
      let j = {}; try { j = JSON.parse(r.body); } catch {}
      if (j && j.ok) return { ok: true, clockOffS, text: `OK   ${label}: reachable (${r.ms} ms)` };
    }
    if (!looksLikeJson(r)) return { ok: false, redirected: true, clockOffS, text: `FAIL ${label}: a web page answered instead of our server (HTTP ${r.status}). This is usually a "data cap used up" page, a Wi-Fi login page or a filter.` };
    return { ok: false, clockOffS, text: `FAIL ${label}: the server answered HTTP ${r.status}` };
  } catch (e) {
    const why = netProblem(e);
    return { ok: false, intercepted: /intercepted/.test(why), text: `FAIL ${label}: ${why}` };
  }
}
// DF-FV-CHECKLINE: the Forever server (secure address, then plain) and whether the Forever tab is open for this launcher.
// Used by Check connection and by the Settings row "Forever server". Never throws.
async function foreverCheckLines(todo) {
  const lines = [];
  // DF-FV-CHECKLINE: the Forever tab. The Forever server decides who sees it; show whether it answers and what it said.
  try {
    const d = (network && network.director) || {};
    const dirs = [d.secure, d.url].filter((x) => typeof x === 'string' && /^https?:\/\//.test(x)).map((x) => x.replace(/\/+$/, ''));
    let fvReach = !dirs.length || offlineMode(), fvWhy = '';
    for (const [i, b] of dirs.entries()) {
      if (fvReach) break;
      const p = await probeService(b, i ? 'Forever server (plain connection)' : 'Forever server');   // the Forever server is part of the same service: /v1/health
      if (p.ok) { fvReach = true; lines.push(p.text); } else if (!fvWhy) fvWhy = p.text;
    }
    if (!fvReach) {
      lines.push(fvWhy || 'FAIL Forever server: no answer');
      todo.push('The Forever tab needs the Forever server: allow the Dauntless Forever launcher in your firewall and antivirus (turn off "web shield" / "HTTPS scanning" for it), then press Check connection again.');
    }
    const fv = (() => { try { return require('./forever').publicState(); } catch { return null; } })();
    if (offlineMode()) lines.push('NOTE Forever tab: hidden while Offline Forever mode is on.');
    else if (fv && fv.allowed) lines.push(`OK   Forever tab: open for this launcher (season ${fv.season || 'S1'})`);
    else if (fv && fv.accessError) lines.push(`FAIL Forever tab: the launcher could not ask the Forever server (${fv.accessError}). Send your logs from the Play page (More -> Send my logs).`);
    else if (fv) lines.push('NOTE Forever tab: not open for this launcher yet. The launcher asks again every 30 s; if the Forever server is reachable above, the Forever team has to open it for you.');
  } catch { /* the Forever line is extra: never break the check */ }
  return lines;
}
async function diagnose() {
  const lines = [], todo = [];
  const base = network.social.url;
  lines.push(`Dauntless Forever ${launcherVersion()}  -  connection check ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  lines.push(`Friends server: ${base}`);
  if (offlineMode()) { lines.push('NOTE Offline Forever mode is on (Settings): the launcher does not sign in at all.'); todo.push('Turn off Offline Forever mode in Settings to use the Friends page.'); }
  // 1. the internet in general (GitHub is where launcher and server-file updates come from)
  try { const r = await rawGet(NETWORK_URL, 8000); lines.push(r.status === 200 ? `OK   Internet: GitHub reachable (${r.ms} ms)` : `FAIL Internet: GitHub answered HTTP ${r.status}`); }
  catch (e) { lines.push(`FAIL Internet: GitHub not reachable: ${netProblem(e)}`); }
  // 2. the friends service, on its address and on the plain-HTTP door (a quota page only catches the plain one)
  const main = await probeService(base, 'Friends server');
  lines.push(main.text);
  let legacy = null;
  if (/^https:/i.test(base)) {
    legacy = await probeService(LEGACY_SOCIAL, 'Plain connection test');
    // the launcher uses the secure address: a provider page on the plain one only matters when the secure one fails too
    if (main.ok && !legacy.ok) legacy.text = legacy.text.replace(/^FAIL/, 'NOTE') + ' Not a problem right now: the launcher uses the secure connection.';
    lines.push(legacy.text);
    // DF-SOCIAL-FALLBACK: secure blocked, plain fine: the launcher uses the plain one, nothing to fix
    if (!main.ok && legacy.ok && !main.redirected) { plainUntil = Date.now() + FALLBACK_MS; lines.push('OK   The launcher uses the plain connection instead: this network blocks the secure one, friends still work.'); }
  }
  const reachable = main.ok || !!(legacy && legacy.ok && !main.redirected);
  if (!reachable && (main.redirected || (legacy && legacy.redirected)))
    todo.push('Your internet provider is stopping the launcher. If you are on a data plan, check whether your monthly data is used up (top up or wait for the reset). On Wi-Fi at a hotel, school or work, open a browser and log in to the Wi-Fi first.');
  else if (!reachable && main.intercepted) todo.push('Something is opening the launcher\'s secure connection: usually an antivirus "web shield" / "HTTPS scanning" (turn it off for the launcher or add an exception), or your internet provider showing its own page (data cap used up, Wi-Fi login: open a browser to see it).');
  else if (!reachable) todo.push('Allow the Dauntless Forever launcher in your firewall and antivirus, check your internet, then press Check connection again.');
  // 3. the PC clock (signed requests more than 5 minutes off are refused, which looks like a lost account)
  const off = main.clockOffS !== undefined && main.clockOffS !== null ? main.clockOffS : (legacy && legacy.clockOffS !== undefined ? legacy.clockOffS : null);
  let clockBad = false;
  if (off === null) lines.push('??   PC clock: could not compare (no answer from the server)');
  else if (Math.abs(off) > CLOCK_LIMIT_S) {
    clockBad = true;
    lines.push(`FAIL PC clock: ${Math.round(Math.abs(off) / 60)} minutes ${off > 0 ? 'ahead' : 'behind'} (the server refuses more than 5)`);
    todo.push('Fix the PC clock: Windows Settings > Time & language > Date & time > turn on "Set time automatically" and press "Sync now". Then press Check connection again. Do not reset the account for this.');
  } else lines.push(`OK   PC clock: right (${Math.abs(off)} s off)`);
  // 4. the account itself
  const me = identity();
  let accountGone = false;
  if (!me) { lines.push('??   Account: not signed up yet (the launcher signs up with your player name by itself)'); }
  else if (!reachable) { lines.push(`??   Account: ${me.name} (could not check: the server is not reachable)`); }
  else {
    try {
      const s = await call('GET', '/v1/state', undefined, false, 8000);
      const tag = s && s.me && s.me.tag ? '#' + s.me.tag : '';
      lines.push(`OK   Account: ${me.name}${tag}, ${(s && s.friends ? s.friends.length : 0)} friend(s)`);
    } catch (e) {
      if (e.status === 401 && !clockBad) {
        accountGone = true;
        lines.push(`FAIL Account: the server does not know this launcher's account (${me.name})`);
        todo.push('Press "Reset account" below. You keep your name; your friends need to add you again. Slayers and saves are not touched.');
      } else if (e.status === 401) lines.push(`FAIL Account: refused, because of the PC clock (${me.name})`);
      else if (e.status === 403) { lines.push(`FAIL Account: ${e.message}`); }
      else lines.push(`FAIL Account: ${e.message}`);
    }
  }
  for (const l of await foreverCheckLines(todo)) lines.push(l);   // 5. DF-FV-CHECKLINE: the Forever server and tab
  lines.push('');
  if (todo.length) { lines.push('What to do:'); todo.forEach((x, i) => lines.push(`${i + 1}. ${x}`)); }
  else lines.push('Everything looks fine.');
  const report = lines.join('\n');
  try { ctx.log('Friends: connection check\n' + report); } catch {}
  return { report, accountGone, clockBad, reachable };
}
// A fresh account with the player's name. The old one is only renamed (social.old-<time>.json), never deleted, and only
// after the new one exists, so a failed reset leaves everything as it was.
async function resetAccount() {
  if (offlineMode()) throw new Error('Offline Forever mode is on (Settings). Turn it off first.');
  let main = await probeService(network.social.url, 'Friends server');
  if (!main.ok && /^https:/i.test(network.social.url) && !main.redirected) {   // DF-SOCIAL-FALLBACK
    const plain = await probeService(fallbackBase(), 'Plain connection');
    if (plain.ok) { main = plain; plainUntil = Date.now() + FALLBACK_MS; }
  }
  if (!main.ok) throw new Error('The friends server cannot be reached from this PC right now, so a new account cannot be made. Press Check connection to see why.');
  if (main.clockOffS !== null && main.clockOffS !== undefined && Math.abs(main.clockOffS) > CLOCK_LIMIT_S)
    throw new Error('Your PC clock is more than 5 minutes off, so a new account would be refused too. Fix the clock first (Windows Settings > Time & language > Date & time > Set time automatically, Sync now).');
  const old = identity();
  const name = require('./player').get() || (old && old.name) || '';
  if (!name) throw new Error('Set a player name first (Settings > Player name).');
  const r = await call('POST', '/v1/register', { name }, true);
  const f = socialFile();
  if (fs.existsSync(f)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    try { fs.renameSync(f, path.join(path.dirname(f), `social.old-${stamp}.json`)); } catch {}
  }
  writeJson(f, { id: r.id, secret: r.secret, name: r.name, server: network.social.url, created: new Date().toISOString() });
  state = null; lastError = '';
  ctx.log(`Friends: account reset, signed up again as ${r.name}` + (old ? ` (the old account file was kept as social.old-*.json)` : ''));
  push();
  setTimeout(poll, 100);
  return { name: r.name };
}

// ------------------------------------------------------------------ IPC
function init(c) {
  ctx = c;
  const act = (fn) => async (_e, ...a) => {
    if (offlineMode()) return { ok: false, error: 'Offline Forever mode is on (Settings).' };
    try { const r = await fn(...a); if (r && r.friends) state = Object.assign(state || {}, r); lastError = ''; push(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  };
  ipcMain.handle('social:state', () => publicState());
  ipcMain.handle('social:register', act(async (name) => {
    const r = await call('POST', '/v1/register', { name }, true);
    writeJson(socialFile(), { id: r.id, secret: r.secret, name: r.name, server: network.social.url, created: new Date().toISOString() });
    setTimeout(poll, 100);
    return r;
  }));
  ipcMain.handle('social:rename', act(async (name) => {
    const r = await call('POST', '/v1/name', { name });
    const me = identity(); me.name = r.me.name; writeJson(socialFile(), me);
    return r;
  }));
  ipcMain.handle('social:add', act((name) => call('POST', '/v1/friends/request', { name })));
  ipcMain.handle('social:accept', act((id) => call('POST', '/v1/friends/accept', { id })));
  ipcMain.handle('social:remove', act((id) => call('POST', '/v1/friends/remove', { id })));
  ipcMain.handle('social:join', act(async (hostId) => {
    if (!onlineOn()) throw new Error(onlineOffMessage());
    const f = (state && state.friends || []).find(x => x.id === hostId);
    if (!f || f.status !== 'hosting') throw new Error('That friend is not hosting right now.');
    const v = ctx.byId(f.version);
    if (!v) throw new Error(`You need Dauntless ${f.version} installed to join them.`);
    // DF-FILES: say it now when this PC and the host cannot play together (the host checks again)
    const mineF = filesState(v);
    const bad = f.pkg ? filesProblem(f.version, { pkg: f.pkg, ok: f.pkgOk !== false, changed: [], kept: !!f.pkgKept }, filesFields(mineF)) : '';
    if (bad && !/host's .* game folder/.test(bad)) throw new Error(bad);
    const r = await call('POST', '/v1/join', { host: hostId, ...filesFields(mineF) });
    waitingJoin = { reqId: r.reqId, host: hostId, hostName: f.name, version: f.version, since: Date.now() };
    setTimeout(poll, 500);
  }));
  ipcMain.handle('social:host', act(async (versionId) => { startHost(versionId, allowRandoms()); }));
  // Play online: runs in the background (the state shows the search); errors before it starts come back here
  ipcMain.handle('social:playOnline', act(async (versionId) => {
    checkPlayOnline(versionId);
    playOnline(versionId).catch((e) => { lastError = e.message; push(); });
  }));
  ipcMain.handle('social:cancelOnline', () => {
    if (search) { ctx.log('Play online: stopped looking.'); search = null; }
    if (waitingJoin && waitingJoin.fromSearch) waitingJoin = null;
    push();
    return { ok: true };
  });
  // "Allow randoms": a hosted game is listed for everyone (takes effect the next time you host)
  ipcMain.handle('social:setAllowRandoms', (_e, on) => { settings.update(s => { s.allowRandoms = !!on; }); push(); return publicState(); });
  ipcMain.handle('social:refresh', () => { poll(); return true; });
  // DF-CHAT
  ipcMain.handle('social:chatOpen', (_e, id) => { chatOpen = id || null; if (chatOpen) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 50); } return chatOpen ? chatFetch(chatOpen) : { ok: true, messages: [] }; });
  ipcMain.handle('social:chatFetch', (_e, id) => (offlineMode() || !identity()) ? { ok: false, error: 'Not signed in.' } : chatFetch(id));
  ipcMain.handle('social:chatSend', async (_e, id, text) => {
    if (offlineMode() || !identity()) return { ok: false, error: 'Not signed in.' };
    text = String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    if (!text) return { ok: false, error: 'Nothing to send.' };
    if (text.length > CHAT_MAX) return { ok: false, error: 'Too long (500 characters at most).' };
    if (CHAT_MOCK) {   // echo from the "friend" 1.5 s later
      const me = identity(), now = Date.now();
      chatMerge(id, [{ id: now, from: me.id, text, at: new Date(now).toISOString() }]);
      setTimeout(() => chatMerge(id, [{ id: now + 1500, from: id, text: 'echo: ' + text, at: new Date(now + 1500).toISOString() }]), 1500);
      return { ok: true, id: now, at: new Date(now).toISOString() };
    }
    try {
      const r = await chatCall('POST', '/v1/chat/send', { to: id, text });
      const me = identity();
      chatMerge(id, [{ id: r.id, from: me.id, text, at: r.at || new Date().toISOString() }]);
      return { ok: true, id: r.id, at: r.at };
    } catch (e) { return { ok: false, error: e.status === 403 ? 'You are not friends any more.' : e.status === 429 ? 'Slow down a little.' : e.message }; }
  });
  // "Stop hosting": closes the host window and everything it started (backend, game servers, game) for that version.
  // {later: seconds}: players in the game get that long first (see stopHostLater); {cancel: true} calls it off.
  ipcMain.handle('social:stopHost', async (_e, opts) => {
    opts = opts || {};
    if (opts.cancel) {
      if (closing) {
        closing.timers.forEach(clearTimeout);
        const v = ctx.byId(closing.version); if (v) announce(v, `${(identity() || {}).name || 'The host'} is keeping the game open after all.`);
        closing = null; ctx.log('Friends: keeping your game open.'); poll();
        if (hostModeHooks) hostModeHooks.cancelled();
      }
      return { ok: true };
    }
    const later = Math.min(300, Math.max(0, Number(opts.later) || 0));
    if (later > 0) stopHostLater(later, true); else await stopHostNow(true);
    return { ok: true };
  });
  ipcMain.handle('social:setOffline', async (_e, on) => {
    settings.update(s => { s.offlineMode = !!on; });
    if (on && identity()) { try { await call('POST', '/v1/offline', {}); } catch {} }
    ctx.log(on ? 'Offline Forever mode on.' : 'Offline Forever mode off.');
    poll();
    return publicState();
  });
  // Settings > Friends account (DF-ACCOUNT)
  ipcMain.handle('social:foreverCheck', async () => { try { const todo = []; const lines = await foreverCheckLines(todo); return { ok: true, lines: lines.concat(todo.map((x) => 'What to do: ' + x)) }; } catch (e) { return { ok: false, error: e.message }; } });   // Settings > Forever server
  ipcMain.handle('social:diagnose', async () => { try { return Object.assign({ ok: true }, await diagnose()); } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('social:resetAccount', async () => { try { return Object.assign({ ok: true }, await resetAccount()); } catch (e) { return { ok: false, error: e.message }; } });
  loadNetwork().then(() => { poll(); measureRelays(); });
  // network.json is read again every 10 minutes, so switching online play off (or moving the server) reaches open launchers
  setInterval(() => { loadNetwork().then(() => { push(); measureRelays(); }).catch(() => {}); }, 10 * 60 * 1000);
}
function shutdown() { search = null; if (identity() && !offlineMode()) call('POST', '/v1/offline', {}).catch(() => {}); }

module.exports = { init, shutdown, loadNetwork, getNetwork: () => network, call, identity, offlineMode, currentRoom, applyName,
  // Host Mode (hostmode.js)
  setHostModeHooks: (h) => { hostModeHooks = h; }, startHostMode, stopHostNow, stopHostLater, announce, onlineOn, onlineOffMessage,
  hostingVersion: () => { const h = hostingVersion(); return h && hostingNow === h.v.id ? h : null; },
  guests: () => (hostingNow && state && state.guests) || [], friendsCount: () => ((state && state.friends) || []).length,
  closingIn: () => (closing ? Math.max(0, Math.ceil((closing.until - Date.now()) / 1000)) : 0), relayPing: () => relayPing, relayPings: () => relayPings,
  regionName: (ip) => { const r = relayList().find(x => x.host === ip); return r ? String(r.name || r.id || ip) : ''; }, push: () => push(), poll: () => poll() };
