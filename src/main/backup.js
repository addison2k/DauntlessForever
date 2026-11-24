// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// backup.js (main) - DF-BACKUP (Nov 24): "Back up my saves" and "Restore from a backup" (Settings).
//
// One .dfbackup file (a zip) for a USB stick or another PC:
//   versions/<id>/...        the save files of every installed version (version.json saveFiles; 1.14.7 also
//                            data/progression)
//   launcher/...             saved builds, chats, and a few launcher settings (never game folders or the games root:
//                            those belong to the PC)
//   identity.json or .enc    only when the player asks for it: the friends account file and the Infinite player id.
//                            With a passphrase it is encrypted (scrypt, AES-256-GCM). It is a key to the account.
//   manifest.json            what is inside, with a sha256 per file
//
// Rules:
//   - The known PC key (account.js, known-pc.json) is NEVER put in a backup.
//   - A restore first copies everything it replaces to <data>\backup\before-restore-<date>\. Nothing is deleted.
//   - A restore is refused while a game, a host window, Host Mode or Infinite runs.
//   - After an account restore the launcher asks the service for a fresh secret (rotate), so every other PC that holds
//     the same files is signed out. When that cannot be done the restore still finishes and the player is told.
//   - The secret, the passphrase and the player id are never logged and never sent to the window.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const P = require('./paths');
const settings = require('./settings');
const { makeZip } = require('./report');

const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 400 * 1024 * 1024, MAX_ENTRIES = 20000;
const SKIP = /(^|\/)(tmp|node_modules|logs)(\/|$)|\.(pid|log|lock|tmp|part|dfnew)$|(^|\/)watch_stop$/i;
const KEEP_SETTINGS = ['uiLanguage', 'hostMode', 'voice', 'lightHost', 'allowRandoms'];
const FILTERS = [{ name: 'Dauntless Forever backup', extensions: ['dfbackup'] }];
let ctx = null;    // { social, runner, registry(), win(), log(text), busy() }
let held = null;   // the backup picked for a restore: { zip: Map, man, file }

const S = () => ctx.social;
const fail = (code, extra) => Object.assign({ ok: false, code }, extra || {});
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const owner = (id) => sha(Buffer.from('dfbackup:' + String(id), 'utf8')).slice(0, 16);
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; } }
function playerIdFile() { try { return path.join(require('electron').app.getPath('userData'), 'player-id.json'); } catch { return path.join(P.dataRoot(), 'player-id.json'); } }
function busy() {
  try { if (ctx.runner.anyRunning().some((r) => ['play', 'host', 'join', 'setup'].includes(r.kind))) return true; } catch {}
  try { return !!ctx.busy(); } catch { return false; }
}
function walk(base, rel, out) {
  let list = []; try { list = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (SKIP.test(r)) continue;
    if (e.isDirectory()) walk(base, r, out);
    else if (e.isFile()) { try { if (fs.statSync(path.join(base, r)).size <= MAX_FILE) out.push(r); } catch {} }
  }
}
function versionFiles(v) {
  const out = [];
  const roots = ((v.package && v.package.saveFiles) || []).slice();
  if (v.id === '1.14.7') roots.push('data/progression');
  for (const r0 of roots) {
    const r = String(r0).replace(/\\/g, '/').replace(/\/+$/, '');
    try { const st = fs.statSync(path.join(v.dataDir, r)); if (st.isDirectory()) walk(v.dataDir, r, out); else if (st.size <= MAX_FILE && !SKIP.test(r)) out.push(r); } catch {}
  }
  return Array.from(new Set(out));
}
const installed = () => (ctx.registry() || []).filter((v) => v && v.id && v.dataDir && fs.existsSync(v.dataDir));

// ---- the account part
function seal(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('base64') };
}
function unseal(box, pass) {
  const key = crypto.scryptSync(pass, Buffer.from(String(box.salt), 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(box.iv), 'hex'));
  d.setAuthTag(Buffer.from(String(box.tag), 'hex'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(String(box.data), 'base64')), d.final()]).toString('utf8'));
}
function goodIdentity(o) {
  const s = o && o.social;
  return !!(s && /^DF-[0-9a-fA-F-]{8,64}$/.test(String(s.id || '')) && typeof s.secret === 'string' && s.secret.length >= 16 && s.secret.length <= 256 && typeof s.name === 'string');
}

// ---- making a backup
async function create(opts) {
  opts = opts || {};
  const pass = typeof opts.passphrase === 'string' ? opts.passphrase : '';
  let withId = !!opts.identity;
  if (withId && !pass && !opts.unprotectedOk) return fail('need-ack');
  if (withId && pass && pass.length < 8) return fail('short-pass');
  const me = S().identity();
  let skippedId = '';
  if (withId && !me) { withId = false; skippedId = 'none'; }
  if (withId && S().movedAway()) { withId = false; skippedId = 'moved'; }   // that secret is retired: it would restore a dead account
  const entries = [], files = {}, versions = [];
  let total = 0;
  const add = (name, data) => {
    total += data.length;
    if (total > MAX_TOTAL || entries.length >= MAX_ENTRIES) throw Object.assign(new Error('too big'), { code: 'too-big' });
    entries.push({ name, data }); files[name] = { size: data.length, sha256: sha(data) };
  };
  try {
    for (const v of installed()) {
      let n = 0;
      for (const r of versionFiles(v)) { let d = null; try { d = fs.readFileSync(path.join(v.dataDir, r)); } catch { continue; } add('versions/' + v.id + '/' + r, d); n++; }
      if (n) versions.push({ id: v.id, files: n });
    }
    const root = P.dataRoot();
    try { add('launcher/saved-builds.json', fs.readFileSync(path.join(root, 'saved-builds.json'))); } catch (e) { if (e.code === 'too-big') throw e; }
    const chats = []; walk(root, 'chat', chats);
    for (const r of chats) { if (!/^chat\/[^/]+\.json$/.test(r)) continue; let d = null; try { d = fs.readFileSync(path.join(root, r)); } catch { continue; } add('launcher/' + r, d); }
    const cur = settings.load(), keep = {};
    for (const k of KEEP_SETTINGS) if (k in cur) keep[k] = cur[k];
    add('launcher/settings.json', Buffer.from(JSON.stringify(keep, null, 1), 'utf8'));
    if (withId) {
      const pid = readJson(playerIdFile(), null);
      const obj = { social: me, playerId: pid && /^[0-9a-f]{32}$/.test(String(pid.id || '')) ? pid.id : '' };
      if (pass) add('identity.enc', Buffer.from(JSON.stringify(seal(obj, pass)), 'utf8'));
      else add('identity.json', Buffer.from(JSON.stringify(obj), 'utf8'));
    }
  } catch (e) {
    if (e.code === 'too-big') return fail('too-big');
    return fail('other', { error: String(e.message || e).slice(0, 200) });
  }
  const man = { format: 'dfbackup', v: 1, made: new Date().toISOString(), launcher: (global.DF_APP && global.DF_APP.version) || '',
    owner: me ? owner(me.id) : '', identity: withId ? { name: String(me.name || '').slice(0, 40), protected: !!pass } : null, versions, files };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(man, null, 1), 'utf8') });
  const zip = makeZip(entries);
  const { dialog } = require('electron');
  const day = new Date().toISOString().slice(0, 10);
  const safeName = String((me && me.name) || require('./player').get() || 'saves').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
  const r = await dialog.showSaveDialog(ctx.win(), { title: 'Back up my saves', defaultPath: 'DauntlessForever-' + safeName + '-' + day + '.dfbackup', filters: FILTERS });
  if (!r || r.canceled || !r.filePath) return fail('cancelled');
  let file = r.filePath; if (!/\.dfbackup$/i.test(file)) file += '.dfbackup';
  try {
    fs.writeFileSync(file + '.part', zip);
    if (sha(fs.readFileSync(file + '.part')) !== sha(zip)) throw new Error('the file read back differently');   // a bad USB stick shows here
    fs.renameSync(file + '.part', file);
  } catch (e) {
    ctx.log('backup: could not write the file (' + e.message + ')');
    return fail('write', { error: String(e.message || e).slice(0, 200) });
  }
  const how = withId ? (pass ? 'protected' : 'open') : 'none';
  ctx.log('backup: written, ' + (entries.length - 1) + ' files, ' + Math.max(1, Math.round(zip.length / 1024)) + ' KB, account inside: ' + (how === 'protected' ? 'yes, with a passphrase' : how === 'open' ? 'yes, NOT protected' : 'no') + (skippedId === 'moved' ? ' (left out: this launcher was moved to another PC)' : ''));
  return { ok: true, file: path.basename(file), files: entries.length - 1, bytes: zip.length, identity: how, skippedId };
}

// ---- reading a backup (in memory; nothing is written by this)
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES + 1) throw new Error('too many entries');
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!name || name.endsWith('/')) continue;
    if (/\\|:|^\/|(^|\/)\.\.?(\/|$)|\/\//.test(name) || name.length > 300) throw new Error('unsafe name');
    total += usize; if (usize > MAX_FILE || total > MAX_TOTAL) throw new Error('too big');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('broken zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    const body = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_FILE }) : null;
    if (!body) throw new Error('unsupported compression');
    out.set(name, body);
  }
  return out;
}
async function pick() {
  held = null;
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(ctx.win(), { title: 'Restore from a backup', properties: ['openFile'], filters: FILTERS });
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return fail('cancelled');
  const f = r.filePaths[0];
  let zip, man;
  try {
    if (fs.statSync(f).size > MAX_TOTAL) return fail('too-big');
    zip = readZip(fs.readFileSync(f)); man = JSON.parse(zip.get('manifest.json').toString('utf8'));
  } catch { return fail('not-backup'); }
  if (!man || man.format !== 'dfbackup' || man.v !== 1 || !man.files || typeof man.files !== 'object') return fail('not-backup');
  for (const [name, data] of zip) { if (name === 'manifest.json') continue; const m = man.files[name]; if (!m || m.sha256 !== sha(data)) return fail('damaged'); }
  for (const name of Object.keys(man.files)) if (!zip.has(name)) return fail('damaged');
  held = { zip, man, file: path.basename(f) };
  const here = installed(), counts = {};
  let other = 0;
  for (const name of zip.keys()) { const m = /^versions\/([^/]+)\//.exec(name); if (m) counts[m[1]] = (counts[m[1]] || 0) + 1; else if (/^launcher\//.test(name)) other++; }
  const versions = Object.keys(counts).map((id) => { const v = here.find((x) => x.id === id); return { id, name: String((v && v.name) || id).slice(0, 40), files: counts[id], here: !!v }; });
  const me = S().identity();
  const idKind = zip.has('identity.enc') ? 'protected' : zip.has('identity.json') ? 'open' : 'none';
  ctx.log('restore: a backup was opened (' + (zip.size - 1) + ' files, account inside: ' + idKind + ')');
  return { ok: true, file: held.file, made: String(man.made || '').slice(0, 30), launcher: String(man.launcher || '').slice(0, 20), versions, other,
    identity: idKind, identityName: man.identity ? String(man.identity.name || '').slice(0, 40) : '', current: me ? String(me.name || '') : '',
    same: !!(me && man.owner && man.owner === owner(me.id)) };
}
function drop() { held = null; return { ok: true }; }

// ---- restoring
function writeAtomic(file, data) { P.ensureDir(path.dirname(file)); const tmp = file + '.dfnew'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
async function restore(opts) {
  opts = opts || {};
  const h = held;
  if (!h) return fail('nothing');
  if (busy()) return fail('busy');
  let idObj = null;
  if (opts.identity && (h.zip.has('identity.enc') || h.zip.has('identity.json'))) {
    try { idObj = h.zip.has('identity.enc') ? unseal(JSON.parse(h.zip.get('identity.enc').toString('utf8')), String(opts.passphrase || '')) : JSON.parse(h.zip.get('identity.json').toString('utf8')); }
    catch { return fail('wrong-pass'); }
    if (!goodIdentity(idObj)) return fail('damaged');
  }
  const me = S().identity();
  const sameOwner = !!(me && h.man.owner && h.man.owner === owner(me.id));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const asideRel = path.join('backup', 'before-restore-' + stamp), aside = path.join(P.dataRoot(), asideRel);
  const put = (target, data, rel) => {
    if (fs.existsSync(target)) { const a = path.join(aside, rel); P.ensureDir(path.dirname(a)); fs.copyFileSync(target, a); }
    writeAtomic(target, data);
  };
  const here = installed(), skipped = new Set();
  let n = 0;
  try {
    for (const [name, data] of h.zip) {
      let m = /^versions\/([^/]+)\/(.+)$/.exec(name);
      if (m) {
        const v = here.find((x) => x.id === m[1]);
        if (!v) { skipped.add(m[1]); continue; }
        const root = path.resolve(v.dataDir), target = path.resolve(root, m[2]);
        if (!target.startsWith(root + path.sep)) continue;
        put(target, data, name); n++; continue;
      }
      if (name === 'launcher/saved-builds.json') { put(path.join(P.dataRoot(), 'saved-builds.json'), data, name); n++; continue; }
      m = /^launcher\/chat\/([^/]+\.json)$/.exec(name);
      if (m && (idObj || sameOwner)) { put(path.join(P.dataRoot(), 'chat', m[1]), data, name); n++; continue; }   // chats belong to the account
      if (name === 'launcher/settings.json') {
        let s = null; try { s = JSON.parse(data.toString('utf8')); } catch {}
        if (s && typeof s === 'object') {
          try { const lf = path.join(P.dataRoot(), 'launcher.json'); if (fs.existsSync(lf)) { P.ensureDir(path.join(aside, 'launcher')); fs.copyFileSync(lf, path.join(aside, 'launcher', 'launcher.json')); } } catch {}
          settings.update((c) => { for (const k of KEEP_SETTINGS) if (k in s) c[k] = s[k]; });
          n++;
        }
      }
    }
  } catch (e) {
    ctx.log('restore: stopped after ' + n + ' files (' + e.message + '); what was replaced is in ' + asideRel);
    return fail('write', { error: String(e.message || e).slice(0, 200), files: n });
  }
  let idResult = 'none';
  if (idObj) idResult = await restoreIdentity(idObj, aside, stamp);
  held = null;
  ctx.log('restore: ' + n + ' files put back' + (skipped.size ? ', skipped (not installed here): ' + Array.from(skipped).join(', ') : '') + ', account: ' + idResult + '; what was replaced is in ' + asideRel);
  return { ok: true, files: n, skipped: Array.from(skipped), identity: idResult, name: idObj && (idResult === 'rotated' || idResult === 'kept') ? String(idObj.social.name).slice(0, 40) : '' };
}
// 'rotated' = restored and every other holder signed out; 'kept' = restored, no fresh secret (one PC at a time);
// 'dead' = the service no longer takes that secret (the account moved since the backup); 'other-service' = made on
// another Friends service than the one this launcher is pointed at (test override)
async function restoreIdentity(idObj, aside, stamp) {
  const sf = S().socialFile(), pf = playerIdFile();
  const url = S().getNetwork().social.url;
  let override = ''; if (process.env.DL_DATA_DIR) try { override = fs.readFileSync(path.join(P.dataRoot(), 'social-url.txt'), 'utf8').trim(); } catch {}
  if (override && idObj.social.server && idObj.social.server !== url) return 'other-service';
  const hadS = fs.existsSync(sf), hadP = fs.existsSync(pf);
  const ia = path.join(aside, 'account'); P.ensureDir(ia);
  try { if (hadS) fs.copyFileSync(sf, path.join(ia, 'social.json')); if (hadP) fs.copyFileSync(pf, path.join(ia, 'player-id.json')); } catch (e) { ctx.log('restore: could not copy the account files aside (' + e.message + '); the account was not restored'); return 'none'; }
  const back = () => {
    try { if (hadS) fs.copyFileSync(path.join(ia, 'social.json'), sf); else if (fs.existsSync(sf)) fs.renameSync(sf, sf + '.not-finished-' + stamp); } catch {}
    try { if (hadP) fs.copyFileSync(path.join(ia, 'player-id.json'), pf); else if (idObj.playerId && fs.existsSync(pf)) fs.renameSync(pf, pf + '.not-finished-' + stamp); } catch {}
    try { S().poll(); } catch {}
  };
  const NAME_RE = require('./player').NAME_RE, fits = NAME_RE.test(idObj.social.name);
  const soc = Object.assign({}, idObj.social, { restoredHere: new Date().toISOString() });
  if (!fits) soc.keepName = true;
  try {
    writeAtomic(sf, JSON.stringify(soc, null, 2));
    if (/^[0-9a-f]{32}$/.test(String(idObj.playerId || ''))) writeAtomic(pf, JSON.stringify({ id: idObj.playerId, keptAt: new Date().toISOString(), from: 'restored from a backup' }));
  } catch (e) { back(); ctx.log('restore: the account files could not be written (' + e.message + ')'); return 'none'; }
  let result = 'kept', st = null;
  try {
    const r = await S().callSecure('POST', '/v1/account/rotate', {});
    if (r && typeof r.secret === 'string' && r.secret.length >= 16 && r.secret.length <= 256) {
      writeAtomic(sf, JSON.stringify(Object.assign({}, soc, { secret: r.secret }), null, 2));
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        if (i) await new Promise((res) => setTimeout(res, 3000));
        try { st = await S().callSecure('GET', '/v1/state'); ok = true; } catch (e) { if (e.status === 401 || e.status === 403) break; }
      }
      if (ok) result = 'rotated'; else writeAtomic(sf, JSON.stringify(soc, null, 2));   // the restored secret is still the valid one
    }
  } catch (e) {
    if (e.status === 401) { back(); return 'dead'; }
  }
  try {
    settings.update((s) => { if (fits) s.playerName = idObj.social.name; else if (!NAME_RE.test(String(s.playerName || ''))) s.playerName = idObj.social.name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16); delete s.movedAway; delete s.linkPlayerIdRefused; });
    S().forgetState(st); if (st) S().setLink(st.link); S().poll();
  } catch {}
  return result;
}

const WHY = {
  'need-ack': 'the account was asked for with no passphrase and the box was not ticked',
  'short-pass': 'the passphrase was shorter than 8 characters',
  'too-big': 'the saves are bigger than one backup file may be',
  write: 'the file could not be written (a full or bad stick, rights, antivirus)',
  'not-backup': 'the file picked is not a Dauntless Forever backup',
  damaged: 'the backup does not match its own list of files; nothing was changed',
  'wrong-pass': 'the passphrase typed does not open the account part; nothing was changed',
  busy: 'a game, a host window, Host Mode or Infinite was running',
  nothing: 'no backup was open any more',
};
function init(c) {
  ctx = c;
  const { ipcMain } = require('electron');
  const safe = (what, fn) => async (_e, ...a) => {
    let r; try { r = await fn(...a); } catch (e) { r = fail('other', { error: String(e && e.message || e).slice(0, 200) }); }
    try { if (r && r.ok === false && r.code !== 'cancelled') ctx.log(what + ': did not work [' + r.code + ']: ' + (WHY[r.code] || String(r.error || 'no reason given'))); } catch {}
    return r;
  };
  ipcMain.handle('backup:create', safe('backup', (o) => create(o)));
  ipcMain.handle('backup:pick', safe('restore (open a backup)', () => pick()));
  ipcMain.handle('backup:restore', safe('restore', (o) => restore(o)));
  ipcMain.handle('backup:drop', safe('drop', () => drop()));
}
module.exports = { init };
