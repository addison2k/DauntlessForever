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
  let best = null;
  for (const r of list) {
    if (!r || !r.host) continue;
    let ms = null;
    for (let i = 0; i < 3; i++) { const m = await measureOne(r.host, Number(r.controlPort) || 7000); if (m !== null && (ms === null || m < ms)) ms = m; }
    if (ms !== null && (!best || ms < best.ms)) best = { name: r.name || r.host, ms, id: String(r.id || r.name || r.host) };
  }
  relayPing = best;
  push();
}

// ------------------------------------------------------------------ signed requests
function call(method, apiPath, body, unsigned, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, network.social.url);
    const data = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    const me = identity();
    if (!unsigned) {
      if (!me) return reject(new Error('not signed in'));
      const time = Date.now();
      headers['X-DF-Id'] = me.id; headers['X-DF-Time'] = String(time);
      headers['X-DF-Sig'] = crypto.createHmac('sha256', me.secret).update(`${time}\n${method}\n${url.pathname}\n${data}`).digest('hex');
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout: timeoutMs || 10000 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', d => b += d);
      res.on('end', () => {
        let j = {}; try { j = b ? JSON.parse(b) : {}; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else { const e = new Error(j.error || ('HTTP ' + res.statusCode)); e.status = res.statusCode; reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the friends service did not answer')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' ? 'the friends service is not reachable' : e.message)));
    req.end(data);
  });
}

// ------------------------------------------------------------------ what this PC is doing
// What the launcher last found: hosting only counts while this PC's backend answers (a relay.json left behind by a
// host window that was closed the hard way must not keep saying "hosting" forever).
let hostingNow = null;   // version id or null
function hostingVersion() {
  for (const v of ctx.registry) {
    try { const st = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'data', 'relay.json'), 'utf8')); if (st && st.base) return { v, relay: st }; } catch {}
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
function backendUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 61000, path: '/dauntless-status', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
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
    // one account on this PC's backend per friend, kept in data\friend_accounts.json (never shared with anyone else)
    const file = path.join(h.v.dataDir, 'data', 'friend_accounts.json');
    // a friend who presses Join while this game is still starting: wait for the backend (up to 2 minutes)
    for (let i = 0; i < 40 && !(await backendUp()); i++) {
      if (!hostingVersion()) { await call('POST', '/v1/join/answer', { reqId: r.reqId, error: 'The host stopped hosting.' }); return; }
      await new Promise(res => setTimeout(res, 3000));
    }
    const accounts = readJson(file, {});
    let key = accounts[r.from] && accounts[r.from].key;
    if (!key) {
      const reply = await postLocal(61000, '/undaunted/api/Register', { Username: String(r.name || 'Friend').slice(0, 20) });
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
  const script = path.join(v.dataDir, 'tools', 'lan-join.ps1');
  if (!fs.existsSync(script)) throw new Error('This version has no join script yet. Update its server files.');
  ctx.runner.runVisible(versionId + ':join', 'join', script, ['-Code', `'${code.replace(/'/g, "''")}'`], `Dauntless ${versionId} - joining a friend`)
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
  };
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
    if (h && !(await backendUp())) {
      // nothing answers: if no host window of ours is open either, the relay.json is left over: tidy it away
      if (!ctx.runner.isRunning(h.v.id + ':host')) { try { fs.unlinkSync(path.join(h.v.dataDir, 'data', 'relay.json')); } catch {} }
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
    lastError = e.status === 401 ? 'Your friends account was not recognised by the server.' : e.message;
  } finally {
    push();
    // in someone's game: a little more often, so a host closing reaches this PC in time to save the character home
    const inGame = gameWith && ctx.runner.isRunning(gameWith.version + ':join');
    pollTimer = setTimeout(poll, waitingJoin ? FAST_POLL_MS : (inGame ? 10000 : POLL_MS));
  }
}

// ------------------------------------------------------------------ public games
const SEARCH_MS = 40000;
const allowRandoms = () => { try { return !!settings.load().allowRandoms; } catch { return false; } };
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
// Host a version: friends only, or open to everyone (pub: Play online, or "Allow randoms" ticked)
function startHost(versionId, pub) {
  if (!onlineOn()) throw new Error(onlineOffMessage() + ' Solo play still works.');
  const v = ctx.byId(versionId);
  if (!v) throw new Error('This version is not installed.');
  const script = path.join(v.dataDir, 'tools', 'online-host.ps1');
  if (!fs.existsSync(script)) throw new Error('This version cannot host online yet. Update its server files.');
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
  const script = path.join(v.dataDir, 'tools', 'online-host.ps1');
  if (!fs.existsSync(script)) return Promise.reject(new Error('This version cannot host online yet. Update its server files.'));
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
  if (!fs.existsSync(path.join(v.dataDir, 'tools', 'online-host.ps1')) || !fs.existsSync(path.join(v.dataDir, 'tools', 'lan-join.ps1')))
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
      try { r = await call('POST', '/v1/join', { host: g.id }); } catch (e) { me.phase = 'searching'; ctx.log(`Play online: ${g.name}: ${e.message}`); continue; }
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
    const relayFile = path.join(v.dataDir, 'data', 'relay.json');
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
  try { if (Notification.isSupported()) new Notification({ title: `${hc.name} is closing their game`, body: `In about ${secs} seconds. Your character is being saved home now.` }).show(); } catch {}
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
    const r = await call('POST', '/v1/join', { host: hostId });
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
  closingIn: () => (closing ? Math.max(0, Math.ceil((closing.until - Date.now()) / 1000)) : 0), relayPing: () => relayPing,
  regionName: (ip) => { const r = relayList().find(x => x.host === ip); return r ? String(r.name || r.id || ip) : ''; }, push: () => push(), poll: () => poll() };
