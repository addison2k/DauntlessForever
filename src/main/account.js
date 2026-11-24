// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// account.js (main) - DF-LINK (Nov 24): get a launcher's account back on another PC or after a fresh Windows.
//
//   - Link Discord: this launcher's account is tied to a Discord login. After a format, "Sign in with Discord" on the
//     new install brings the SAME account back (same id, a new secret), with the Infinite player id when the service
//     holds one. Nothing changes on the Infinite servers: the new PC simply is the old launcher.
//   - Move code: the old PC shows 6 digits for 10 minutes; the new PC sends the account name (name#1234) and the code.
//   - One account works on one PC at a time. Whoever takes it over gets a new secret; the PC it was on is told
//     "moved" by the service (social.js shows that and refuses online play there).
//
// What is trusted and what is checked:
//   - Every call here goes through social.callSecure: https only, never the plain fallback.
//   - The secret that comes back is PENDING on the service until one signed call is made with it. adopt() writes the
//     files, makes that call, and puts the old files back if it does not answer: a lost answer or a dropped connection
//     can never leave an account that nobody holds.
//   - The browser is only ever sent to https://discord.com/. The poll proves this launcher started the login with a
//     random verifier it never shows anyone (the service has only its hash).
//   - Nothing is deleted. The files a move replaces stay beside them as <name>.before-move-<date>.
//   - The secret, the code, the ticket, the verifier and the player id are never logged and never sent to the window.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const settings = require('./settings');

const POLL_MS = 2000, FLOW_MS = 5 * 60 * 1000, PENDING_MS = 9 * 60 * 1000;
const KNOWN = ['no-account', 'banned', 'expired', 'bad-verifier', 'bad-challenge', 'bad-playerid', 'discord-not-set', 'too-many', 'wrong', 'locked', 'playerid-refused', 'moved', 'not-known'];
let ctx = null;        // { social, runner, log(text), busy() }
let flow = null;       // the Discord login under way: { kind: 'link' | 'recover', cancelled }
let pending = null;    // what recover / moveClaim brought, until adopt() or drop(): { id, secret, name, playerId, at }
let uploadTriedAt = 0;

const S = () => ctx.social;
const fail = (code, extra) => Object.assign({ ok: false, code }, extra || {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; } }

// the same file main/forever.js keeps the Infinite player id in (DF25-KEEPID)
function playerIdFile() { try { return path.join(require('electron').app.getPath('userData'), 'player-id.json'); } catch { return path.join(P.dataRoot(), 'player-id.json'); } }
function localPlayerId() { const j = readJson(playerIdFile(), null); return j && /^[0-9a-f]{32}$/.test(String(j.id || '')) ? j.id : ''; }
const refusedFor = () => { try { return settings.load().linkPlayerIdRefused || ''; } catch { return ''; } };
function noteRefused() { const me = S().identity(); settings.update((s) => { s.linkPlayerIdRefused = (me && me.id) || 'yes'; }); ctx.log('the service did not take this PC\'s Infinite player id (it is on record for another launcher); not sent again'); }
// the player id goes along when this PC has one and the service has not refused it for this account
function playerIdToSend() { const me = S().identity(); const id = localPlayerId(); return id && !(me && refusedFor() === me.id) ? id : ''; }

function codeOf(e) {
  if (!e) return fail('other');
  if (e.code === 'SECURE') return fail('secure');
  const b = e.body || {};
  if (b.error === 'secure-only') return fail('secure');
  if (b.error === 'wrong') return fail('wrong', { triesLeft: Number.isInteger(b.triesLeft) ? b.triesLeft : null });
  if (KNOWN.includes(b.error)) return fail(b.error);
  if (e.status === 401) return fail(b.error === 'moved' ? 'moved' : 'not-signed-in');
  if (e.status === 404 || e.status === 501) return fail('not-available');
  if (e.status === 429) return fail('too-many');
  if (e.status === -1) return fail('not-signed-in');
  return fail('other', { error: String(e.message || e).slice(0, 200) });
}
// a game, a host window, Host Mode or Infinite: the account files are in use
function busy() {
  try { if (ctx.runner.anyRunning().some((r) => ['play', 'host', 'join', 'setup'].includes(r.kind))) return true; } catch {}
  try { return !!ctx.busy(); } catch { return false; }
}
// POST with this PC's player id; when the service refuses the id (409) the same request goes again without it
async function sendWithPlayerId(route, body) {
  const pid = playerIdToSend();
  if (pid) {
    try { return { r: await S().callSecure('POST', route, Object.assign({}, body, { playerId: pid })), refused: false }; }
    catch (e) { if (!(e.status === 409 && e.body && e.body.error === 'playerid-refused')) throw e; noteRefused(); }
    return { r: await S().callSecure('POST', route, body), refused: true };
  }
  return { r: await S().callSecure('POST', route, body), refused: false };
}

// ------------------------------------------------------------------ Discord: link and recover
async function discordFlow(kind) {
  if (flow) return fail('busy-flow');
  if (S().offlineMode()) return fail('offline-mode');
  if (kind === 'link' && !S().identity()) return fail('not-signed-in');
  if (kind === 'link' && !S().linkState()) return fail('not-available');
  if (kind === 'recover' && busy()) return fail('busy');
  const mine = flow = { kind, cancelled: false };
  try {
    const verifier = crypto.randomBytes(32).toString('hex');   // 64 characters of text; the service gets sha256 of this text
    const challenge = sha256(verifier);
    let start, refused = false;
    if (kind === 'link') { const x = await sendWithPlayerId('/v1/link/start', { challenge }); start = x.r; refused = x.refused; }
    else start = await S().callSecure('POST', '/v1/recover/start', { challenge }, true);
    if (!start || typeof start.ticket !== 'string' || typeof start.url !== 'string' || !/^https:\/\/discord\.com\//.test(start.url)) { ctx.log(kind + ': the service sent an address that is not Discord; not opened'); return fail('bad-url'); }
    mine.url = start.url;   // kept in the main process for "Copy the link"; never sent to the window
    await require('electron').shell.openExternal(start.url);
    ctx.log(kind + ': the browser is open at Discord, waiting');
    const t0 = Date.now();
    while (Date.now() - t0 < FLOW_MS) {
      await sleep(POLL_MS);
      if (mine.cancelled) return fail('cancelled');
      let r;
      try { r = await S().callSecure('POST', '/v1/link/poll', { ticket: start.ticket, verifier }, true); }
      catch (e) { if (e.code === 'SECURE') continue; return codeOf(e); }   // a dropped connection: the answer can be read again
      if (!r || r.pending) continue;
      if (kind === 'link') {
        if (!r.ok) return fail('other');
        { const me = S().identity(); if (me) saveKey(me.id, r.deviceKey); }   // DF-LINK2
        ctx.log('link: Discord linked' + (r.replaced ? ' (that Discord account was on another launcher before)' : ''));
        try { await S().readLink(true); S().poll(); } catch {}
        return { ok: true, discordName: String(r.discordName || ''), replaced: r.replaced ? String(r.replaced) : '', playerIdRefused: refused };
      }
      return hold(r, 'Discord');
    }
    return fail('timeout');
  } catch (e) { return codeOf(e); }
  finally { if (flow === mine) flow = null; }
}
function cancel() { if (flow) flow.cancelled = true; return { ok: true }; }
// the sign-in opened in a browser where the player is not signed in to Discord: the link goes to the clipboard
function copyUrl() { if (!flow || !flow.url) return fail('not-ready'); require('electron').clipboard.writeText(flow.url); ctx.log(flow.kind + ': the sign-in link was copied (to open it in another browser)'); return { ok: true }; }
async function unlink() {
  if (!S().identity()) return fail('not-signed-in');
  try { await S().callSecure('POST', '/v1/link/unlink', {}); ctx.log('link: Discord unlinked'); { const me = S().identity(); if (me) dropKey(me.id); } try { await S().readLink(true); S().poll(); } catch {} return { ok: true }; }
  catch (e) { return codeOf(e); }
}

// ------------------------------------------------------------------ move code
async function moveCode() {
  if (S().offlineMode()) return fail('offline-mode');
  if (!S().identity()) return fail('not-signed-in');
  if (!S().linkState()) return fail('not-available');
  try {
    const x = await sendWithPlayerId('/v1/move/code', {});
    const r = x.r || {};
    if (!/^\d{6}$/.test(String(r.code || '')) || typeof r.account !== 'string') return fail('other');
    ctx.log('move: a code was made for this account');
    return { ok: true, code: String(r.code), expiresIn: Math.max(1, Math.min(600, Number(r.expiresIn) || 600)), account: r.account.slice(0, 40), playerIdRefused: x.refused };
  } catch (e) { return codeOf(e); }
}
async function moveClaim(account, code) {
  if (S().offlineMode()) return fail('offline-mode');
  if (busy()) return fail('busy');
  account = String(account || '').trim(); code = String(code || '').replace(/\s+/g, '');
  if (!/^.{3,20}\s*#\s*\d{1,4}$/.test(account)) return fail('bad-account');
  if (!/^\d{6}$/.test(code)) return fail('bad-code');
  try { return hold(await S().callSecure('POST', '/v1/move/claim', { account, code }, true), 'a move code'); }
  catch (e) { return codeOf(e); }
}

// ------------------------------------------------------------------ taking an account over
// What came back is kept here, in the main process only. The window gets the names and decides (the prompt box).
function hold(r, how) {
  if (!r || !/^DF-[0-9a-fA-F-]{8,64}$/.test(String(r.id || '')) || typeof r.secret !== 'string' || r.secret.length < 16 || r.secret.length > 256 || typeof r.name !== 'string') return fail('other');
  const pid = /^[0-9a-f]{32}$/.test(String(r.playerId || '')) ? r.playerId : '';
  pending = { id: r.id, secret: r.secret, name: r.name.slice(0, 40), playerId: pid, deviceKey: /^[0-9a-f]{64}$/.test(String(r.deviceKey || '')) ? r.deviceKey : '', at: Date.now() };
  const me = S().identity();
  ctx.log('an account was brought here with ' + how + (how.indexOf('known PC') >= 0 ? '' : '; waiting for the player to confirm'));
  return { ok: true, name: pending.name, current: me ? String(me.name || '') : '', same: !!(me && me.id === pending.id), hasPlayerId: !!pid };
}
function drop() { if (pending) ctx.log('move: the player said no at the prompt; nothing changed'); pending = null; return { ok: true }; }
function copyAside(file, stamp) { try { if (fs.existsSync(file)) { fs.copyFileSync(file, file + '.before-move-' + stamp); return true; } } catch {} return false; }
function putBack(file, stamp, had) {
  try { if (had) fs.copyFileSync(file + '.before-move-' + stamp, file); else if (fs.existsSync(file)) fs.renameSync(file, file + '.not-finished-' + stamp); } catch (e) { ctx.log('could not put ' + path.basename(file) + ' back: ' + e.message); }
}
function writeAtomic(file, text) { P.ensureDir(path.dirname(file)); const tmp = file + '.dfnew'; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
async function adopt() {
  const p = pending;
  if (!p) return fail('nothing');
  if (Date.now() - p.at > PENDING_MS) { pending = null; return fail('expired'); }
  if (busy()) return fail('busy');
  pending = null;
  const sf = S().socialFile(), pf = playerIdFile();
  const before = S().identity();
  const stamp = before && before.id === p.id ? 'same-account' : new Date().toISOString().replace(/[:.]/g, '-');   // the same account coming back: one roll-back copy, not one per switch
  const NAME_RE = require('./player').NAME_RE, fits = NAME_RE.test(p.name);   // the game only takes 3-16 letters, numbers or _
  const hadS = copyAside(sf, stamp), hadP = p.playerId ? copyAside(pf, stamp) : false;
  try {
    writeAtomic(sf, JSON.stringify({ id: p.id, secret: p.secret, name: p.name, keepName: fits ? undefined : true, server: S().getNetwork().social.url, created: new Date().toISOString(), movedHere: new Date().toISOString() }, null, 2));
    if (p.playerId) writeAtomic(pf, JSON.stringify({ id: p.playerId, keptAt: new Date().toISOString(), from: 'moved here' }));
  } catch (e) {
    putBack(sf, stamp, hadS); if (p.playerId) putBack(pf, stamp, hadP);
    ctx.log('move: could not write the account files (' + e.message + '); nothing changed');
    return fail('write', { error: e.message });
  }
  // the confirm step: the first signed call with the new secret makes it the account's secret on the service
  let ok = false, last = null, st = null;
  for (let i = 0; i < 3 && !ok; i++) {
    if (i) await sleep(3000);
    try { st = await S().callSecure('GET', '/v1/state'); ok = true; } catch (e) { last = e; if (e.status === 401 || e.status === 403) break; }
  }
  if (!ok) {
    putBack(sf, stamp, hadS); if (p.playerId) putBack(pf, stamp, hadP);
    ctx.log('move: the service did not confirm the new sign-in (' + String((last && (last.code || last.status || last.message)) || '?') + '); the files from before are back, nothing changed');
    try { S().poll(); } catch {}
    return fail(last && last.code === 'SECURE' ? 'secure' : 'confirm');
  }
  try {
    settings.update((s) => { if (fits) s.playerName = p.name; else if (!NAME_RE.test(String(s.playerName || ''))) s.playerName = p.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16); delete s.movedAway; delete s.linkPlayerIdRefused; });
    S().forgetState(st); S().setLink(st && st.link); S().poll();   // st = the whole state: the #number shows at once
  } catch {}
  if (p.deviceKey) saveKey(p.id, p.deviceKey);   // DF-LINK2: the key counts on the service from the confirm call on
  if (!fits) ctx.log('move: the account name "' + p.name + '" has characters the game does not take; the account keeps it, the player name on this PC is ' + (settings.load().playerName || '?'));
  ctx.log('move: this PC is now ' + p.name + (before && before.id !== p.id ? ' (was ' + String(before.name || '?') + '; its files are kept as .before-move-' + stamp + ')' : '') + (p.playerId ? '' : '; no Infinite player id came with it'));
  return { ok: true, name: p.name, hasPlayerId: !!p.playerId, was: before && before.id !== p.id ? String(before.name || '') : '' };
}

// ------------------------------------------------------------------ the late player id
// A launcher that linked before it ever played Infinite has no player id on the service. Once this PC has one
// (forever.js keeps it after the first Play) it is sent, at most once a day, until the service says it holds one.
function tick() {
  const l = S().linkState();
  if (!l || !l.discordName || l.playerId || flow) return;
  if (!playerIdToSend() || Date.now() - uploadTriedAt < 24 * 3600 * 1000) return;
  uploadTriedAt = Date.now();
  S().callSecure('POST', '/v1/link/playerid', { playerId: playerIdToSend() })
    .then(() => { ctx.log('link: this PC\'s Infinite player id is now stored with the account'); return S().readLink(true); })
    .catch((e) => { if (e.status === 409 && e.body && e.body.error === 'playerid-refused') noteRefused(); else ctx.log('link: the Infinite player id was not stored yet (' + String(e.code || e.status || e.message) + ')'); });
}

// ------------------------------------------------------------------ known PCs (DF-LINK2)
// A PC that finished Link Discord or a Discord recover gets a device key from the service, once. With it this PC can
// take the account back later with no browser (resume). The key is kept in the launcher's own profile folder, apart
// from social.json and from anything a backup copies, protected by Windows for this user when that is available.
// It is never logged and never sent to the window: the window only learns "this PC is known" (yes or no).
const KEY_RE = /^[0-9a-f]{64}$/;
let keys = null;
function keyFile() { try { return path.join(require('electron').app.getPath('userData'), 'known-pc.json'); } catch { return ''; } }
function vault() { try { const s = require('electron').safeStorage; return s && s.isEncryptionAvailable() ? s : null; } catch { return null; } }
function loadKeys() {
  if (keys) return keys;
  keys = {};
  const j = keyFile() ? readJson(keyFile(), null) : null, v = vault();
  for (const id of Object.keys((j && j.keys) || {})) {
    try { const e = j.keys[id] || {}; const k = e.enc ? (v ? v.decryptString(Buffer.from(String(e.enc), 'base64')) : '') : String(e.key || ''); if (KEY_RE.test(k)) keys[id] = k; } catch {}
  }
  return keys;
}
function storeKeys() {
  const f = keyFile(); if (!f) return;
  const v = vault(), out = {};
  for (const id of Object.keys(keys)) out[id] = v ? { enc: v.encryptString(keys[id]).toString('base64') } : { key: keys[id] };
  try { writeAtomic(f, JSON.stringify({ note: 'Known PC keys of this launcher. Never copy, share or back up this file.', keys: out }, null, 1)); }
  catch (e) { ctx.log('known PC: the key file could not be written (' + e.message + ')'); }
}
function saveKey(id, k) { if (!id || !KEY_RE.test(String(k || ''))) return; loadKeys()[id] = k; storeKeys(); ctx.log('known PC: this PC is now a known PC of the account (it can take the account back without the browser)'); }
function dropKey(id) { if (id && loadKeys()[id]) { delete keys[id]; storeKeys(); ctx.log('known PC: this PC\'s key for the account was removed'); } }
function known() { try { const me = S().identity(); return !!(me && loadKeys()[me.id]); } catch { return false; } }
// "Use it here": no prompt, the account is the one this PC already has. Nothing switches by itself, ever.
async function resume() {
  if (S().offlineMode()) return fail('offline-mode');
  if (busy()) return fail('busy');
  const me = S().identity(), k = me && loadKeys()[me.id];
  if (!k) return fail('not-known');
  let r;
  try { r = await S().callSecure('POST', '/v1/link/resume', { id: me.id, deviceKey: k }, true); }
  catch (e) { if (e.status === 403 && e.body && e.body.error === 'not-known') { dropKey(me.id); try { S().poll(); } catch {} } return codeOf(e); }
  if (!r || r.id !== me.id) return fail('other');
  const h = hold(r, 'this PC\'s known PC key');
  return h.ok ? adopt() : h;
}
async function clearOthers() {
  const me = S().identity(); if (!me) return fail('not-signed-in');
  const k = loadKeys()[me.id];
  try {
    const r = await S().callSecure('POST', '/v1/link/devices/clear', k ? { deviceKey: k } : {});
    ctx.log('known PC: the other PCs of this account were signed out (' + (r && Number.isInteger(r.devices) ? r.devices : '?') + ' known PC left)');
    try { await S().readLink(true); } catch {}
    return { ok: true, devices: r && Number.isInteger(r.devices) ? r.devices : null };
  } catch (e) { return codeOf(e); }
}

// DF-LINK: every try that did not work goes to the launcher log in plain words, so a report shows what the player ran
// into. Only the reason is written: never what was typed, never a code, a secret or a player id.
const WHY = {
  wrong: 'the name#number or the code typed does not match a live code',
  'bad-account': 'the name was typed without its #number (it must look like slayer77#1234)',
  'bad-code': 'what was typed as the code is not 6 digits',
  locked: '5 wrong tries: that code is cancelled, the old PC has to show a new one',
  expired: 'no live code for that account (used, run out, or never made), or the wait at the prompt or at Discord was too long',
  timeout: 'the Discord sign-in was not finished in the browser within 5 minutes',
  'bad-verifier': 'the Discord sign-in was not started by this launcher run',
  'no-account': 'no launcher was ever linked to the Discord account that signed in (wrong Discord account, or never linked)',
  banned: 'the account is banned',
  'too-many': 'the service limit was hit (3 move codes per account per day, or tries per hour)',
  busy: 'a game, a host window, Host Mode or Infinite was running',
  'busy-flow': 'another Discord sign-in was still open in this launcher',
  'offline-mode': 'Offline Forever mode is on',
  'not-signed-in': 'this launcher has no working friends account yet',
  'not-available': 'the Friends service does not have these routes',
  'discord-not-set': 'Discord sign-in is not set up on the service',
  secure: 'the secure (https) connection to the Friends service did not work; nothing is sent over the plain one',
  'bad-url': 'the service sent a sign-in address that is not discord.com',
  moved: 'this launcher was moved to another PC',
  confirm: 'the service did not confirm the new sign-in; the files from before were put back',
  write: 'the account files could not be written (antivirus, rights or a full disk); the files from before were put back',
  nothing: 'the prompt was answered after the answer from the service was gone',
  'not-ready': 'the sign-in link had not come back from the service yet',
  'not-known': 'this PC is not a known PC of the account (never signed in with Discord here, Discord was unlinked, the other PCs were signed out, or 5 newer PCs pushed it out)',
};
function said(what, r) {
  try {
    if (!r || r.ok !== false) return;
    if (r.code === 'cancelled') { ctx.log(what + ': cancelled by the player'); return; }
    ctx.log(what + ': did not work [' + r.code + ']' + (Number.isInteger(r.triesLeft) ? ' (' + r.triesLeft + ' tries left)' : '') + ': ' + (WHY[r.code] || String(r.error || 'no reason given')));
  } catch {}
}

function init(c) {
  ctx = c;
  const { ipcMain } = require('electron');
  const safe = (what, fn) => async (_e, ...a) => { let r; try { r = await fn(...a); } catch (e) { r = fail('other', { error: String(e && e.message || e).slice(0, 200) }); } said(what, r); return r; };
  ipcMain.handle('account:link', safe('link Discord', () => discordFlow('link')));
  ipcMain.handle('account:recover', safe('get account back with Discord', () => discordFlow('recover')));
  ipcMain.handle('account:cancel', safe('cancel', () => cancel()));
  ipcMain.handle('account:copyUrl', safe('copy the sign-in link', () => copyUrl()));
  ipcMain.handle('account:unlink', safe('unlink Discord', () => unlink()));
  ipcMain.handle('account:moveCode', safe('show a move code', () => moveCode()));
  ipcMain.handle('account:moveClaim', safe('get account back with a move code', (account, code) => moveClaim(account, code)));
  ipcMain.handle('account:adopt', safe('take the account over', () => adopt()));
  ipcMain.handle('account:resume', safe('use the account here (known PC)', () => resume()));
  ipcMain.handle('account:clearOthers', safe('sign out my other PCs', () => clearOthers()));
  ipcMain.handle('account:drop', safe('drop', () => drop()));
}
module.exports = { init, tick, known };
