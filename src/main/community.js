// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// community.js (main) - DF-CMODS (Nov 10): reviewed mods from the mods page (mods.dauntlessforever.com), installed into
// the same UE4SS Mods folder the Mods page already manages and switched on through the same mods.txt (tools\ue4ss.cjs).
//
// What it trusts and what it checks:
//   - Only approved code ever comes from the site's launcher routes. The list says which version and its SHA-256; the
//     mod's own answer carries the files and the SHA-256 again. The files text is hashed exactly as it arrived, and
//     NOTHING is written unless that hash matches both answers and the versions agree.
//   - Every path is checked again here (the site checks too): plain names only, known text types, Lua under Scripts,
//     and each one must resolve inside the mod's own folder.
//   - Each installed mod gets a dfmod.json in its folder (id, version, sha256, files). It is written LAST, so an install
//     that stops half way is never mistaken for a finished one. A folder without it is somebody's own mod and is never
//     written into.
//   - Nothing is deleted. A file an update no longer has is renamed to <name>.removed, so it can never be loaded.
// The section on the Mods page shows only while the site answers, so this can ship before the site is up.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const DEFAULT_BASE = 'https://mods.dauntlessforever.com';
const MARKER = 'dfmod.json';
const EXTS = ['lua', 'txt', 'ini', 'json', 'cfg', 'md'];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const LIST_MAX = 2 * 1024 * 1024, MOD_MAX = 1024 * 1024, CACHE_MS = 60 * 1000;
let ctx = null;   // { social, runModsTool(v, args), byId(id), log(text) }
const cache = new Map();   // game -> { at, list }

function base() {
  let n = null; try { n = ctx.social.getNetwork(); } catch {}
  const u = n && n.mods && n.mods.url;   // network.json mods.url = another address for it (optional)
  return (typeof u === 'string' && /^https:\/\/[^/]+/.test(u)) ? u.replace(/\/+$/, '') : DEFAULT_BASE;
}
// https only, no redirects, a size cap, a timeout. The answer is kept as text so its hash can be checked byte for byte.
function getText(url, max) {
  if (ctx && typeof ctx.get === 'function') return ctx.get(url, max);   // tests only: the launcher never passes one
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('Bad address.')); }
    if (u.protocol !== 'https:') return reject(new Error('The mods page must be https.'));
    const req = https.get(u, { timeout: 15000, headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); const e = new Error('The mods page answered ' + res.statusCode + '.'); e.status = res.statusCode; return reject(e); }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > max) { req.destroy(new Error('The answer was too big.')); return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The mods page did not answer.')));
    req.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' ? 'The mods page is not reachable.' : e.message)));
  });
}
async function list(game, fresh) {
  const c = cache.get(game);
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.list;
  const text = await getText(base() + '/api/launcher/mods?game=' + encodeURIComponent(game), LIST_MAX);
  const j = JSON.parse(text);
  if (!j || j.format !== 1 || !Array.isArray(j.mods)) throw new Error('The mods page sent something unexpected.');
  const mods = j.mods.filter(m => m && /^[a-z0-9]{6,16}$/.test(String(m.id)) && /^[0-9a-f]{64}$/.test(String(m.sha256)) && Number.isInteger(m.version) && m.version > 0)
    .map(m => ({ id: m.id, title: String(m.title || '').slice(0, 60), summary: String(m.summary || '').slice(0, 140), author: String(m.author || '').slice(0, 40),
      category: String(m.category || ''), version: m.version, sha256: m.sha256, bytes: Number(m.bytes) || 0, likes: Number(m.likes) || 0 }));
  cache.set(game, { at: Date.now(), list: mods });
  return mods;
}

// ---------------------------------------------------------------- the files
function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > 120 || /[\\:*?"<>|\u0000-\u001f]/.test(p)) return false;
  const segs = p.split('/');
  if (segs.length > 3) return false;
  for (const s of segs) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_\-. ]{0,63}$/.test(s) || /[. ]$/.test(s) || RESERVED.test(s.split('.')[0])) return false;
  }
  const last = segs[segs.length - 1], ext = last.includes('.') ? last.split('.').pop().toLowerCase() : '';
  if (!EXTS.includes(ext)) return false;
  if (ext === 'lua' && segs[0].toLowerCase() !== 'scripts') return false;
  if (segs.map(s => s.toLowerCase()).join('/') === MARKER) return false;   // the marker is ours
  return true;
}
function inside(dir, rel) {
  const full = path.resolve(dir, ...rel.split('/'));
  return full.startsWith(path.resolve(dir) + path.sep) ? full : null;
}
// The folder a mod goes in. DF-CMODFOLDER (Nov 18): NO spaces. UE4SS 3.0.1 removes every space from a mods.txt line before
// it looks the mod up, so "PotionTweaks - id : 1" looked for "PotionTweaks-id" and the mod never started. The folder is
// the mod's title alone when that name is free (the name its author tested with: some mods find their files by it),
// else title-id, else title-id-2..9. Characters: [\w.-] only.
function folderBase(title) {
  const t = String(title || '').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+/, '').slice(0, 40).replace(/[-.]+$/, '');
  return t && t.toLowerCase() !== 'shared' && !RESERVED.test(t.split('.')[0]) ? t : 'Mod';
}
function folderName(title, id) { return folderBase(title) + '-' + id; }
function pickFolder(modsDir, title, id) {
  const b = folderBase(title), names = [b, b + '-' + id];
  for (let n = 2; n <= 9; n++) names.push(b + '-' + id + '-' + n);
  return names.find(n => !fs.existsSync(path.join(modsDir, n))) || null;
}
// A mod installed before DF-CMODFOLDER sits in a folder with spaces and never starts. Renamed to a name without them,
// and its mods.txt line follows it (same on/off). Not while the game runs (its files are in use then). Never throws.
function fixFolders(v, modsDir) {
  let n = 0;   // how many were renamed (the Mods page draws its list again then)
  try {
    if (ctx.isRunning && ctx.isRunning(v.id)) return 0;
    const mine = installed(modsDir);
    for (const id of Object.keys(mine)) {
      const old = mine[id].folder; if (!/\s/.test(old)) continue;
      const to = pickFolder(modsDir, mine[id].title, id); if (!to) continue;
      try { fs.renameSync(path.join(modsDir, old), path.join(modsDir, to)); }
      catch (e) { ctx.log(`Community mods: could not rename "${old}" to "${to}" (${e.code || e.message}); tried again next time.`); continue; }
      try {
        const list = path.join(modsDir, 'mods.txt');
        if (fs.existsSync(list)) {
          const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('^(\\s*)' + esc + '(\\s*:\\s*[01]\\s*)$');
          const lines = fs.readFileSync(list, 'utf8').split(/\r?\n/);
          let hit = false; const outL = lines.map(l => { const m = re.exec(l); if (!m) return l; hit = true; return m[1] + to + m[2]; });
          if (hit) writeAtomic(list, outL.join('\r\n'));
        }
      } catch (e) { ctx.log(`Community mods: renamed "${old}" to "${to}" but could not update mods.txt (${e.message}). Switch it on again under Your mods.`); continue; }
      n++; ctx.log(`Community mods: renamed "${old}" to "${to}" (UE4SS cannot start a mod whose folder name has spaces)`);
    }
  } catch (e) { ctx.log('Community mods: folder check: ' + e.message); }
  return n;
}
function readMarker(dir) {
  try {
    const st = fs.statSync(path.join(dir, MARKER)); if (st.size > 64 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return j && /^[a-z0-9]{6,16}$/.test(String(j.id)) ? j : null;
  } catch { return null; }
}
// id -> { folder, version, sha256, title } for every folder the launcher installed
function installed(modsDir) {
  const out = {};
  let ds = []; try { ds = fs.readdirSync(modsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of ds) {
    if (!d.isDirectory()) continue;
    const m = readMarker(path.join(modsDir, d.name));
    if (m) out[m.id] = { folder: d.name, version: Number(m.version) || 0, sha256: String(m.sha256 || ''), title: String(m.title || '') };
  }
  return out;
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.dfnew';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- what the Mods page asks
async function status(versionId, fresh) {   // fresh: the Mods page was just opened, so ask the site again
  const v = ctx.byId(versionId); if (!v) return { ok: false, error: 'Unknown version.' };
  const ms = await ctx.runModsTool(v, ['status']);
  if (!ms || !ms.ok) return { ok: false, error: (ms && ms.error) || 'The mods helper did not answer.' };
  const renamed = ms.installed && ms.folder ? fixFolders(v, ms.folder) : 0;   // DF-CMODFOLDER
  const mine = ms.installed && ms.folder ? installed(ms.folder) : {};
  let mods = null;
  try { mods = await list(versionId, !!fresh); } catch (e) { return { ok: true, cap: false, why: e.message, installed: mine, ue4ss: !!ms.installed, on: !!ms.on, renamed }; }
  return { ok: true, cap: true, base: base(), mods, installed: mine, ue4ss: !!ms.installed, on: !!ms.on, renamed };
}
async function install(versionId, modId) {
  if (!/^[a-z0-9]{6,16}$/.test(String(modId || ''))) return { ok: false, error: 'Unknown mod.' };
  const v = ctx.byId(versionId); if (!v) return { ok: false, error: 'Unknown version.' };
  const ms = await ctx.runModsTool(v, ['status']);
  if (!ms || !ms.ok) return { ok: false, error: (ms && ms.error) || 'The mods helper did not answer.' };
  if (!ms.installed || !ms.folder) return { ok: false, error: 'Get UE4SS first (the button above). Mods go in the folder that comes with it.' };
  const modsDir = ms.folder;
  fixFolders(v, modsDir);   // DF-CMODFOLDER: an older install with spaces in its folder is renamed first

  // 1. what the list says, asked fresh
  let entry;
  try { entry = (await list(versionId, true)).find(m => m.id === modId); } catch (e) { return { ok: false, error: e.message }; }
  if (!entry) return { ok: false, error: 'That mod is not approved for ' + versionId + ' any more.' };
  // 2. the mod itself, kept as text
  let text, body;
  try { text = await getText(base() + '/api/launcher/mod/' + modId, MOD_MAX); body = JSON.parse(text); } catch (e) { return { ok: false, error: e.message }; }
  const at = text.indexOf('"files":');
  if (at < 0 || !text.endsWith('}')) return { ok: false, error: 'The mods page sent something unexpected. Nothing was installed.' };
  const filesText = text.slice(at + 8, -1);
  const sha = crypto.createHash('sha256').update(filesText, 'utf8').digest('hex');
  if (sha !== body.sha256 || sha !== entry.sha256 || body.version !== entry.version || body.id !== modId) {
    ctx.log(`Community mods: ${modId} did not match its fingerprint (got ${sha.slice(0, 16)}, list ${entry.sha256.slice(0, 16)}, answer ${String(body.sha256).slice(0, 16)}). Nothing written.`);
    return { ok: false, error: 'What arrived does not match the fingerprint the mods page gave. Nothing was installed. Try again in a minute.' };
  }
  // 3. the files, checked again
  let files; try { files = JSON.parse(filesText); } catch { files = null; }
  if (!Array.isArray(files) || !files.length || files.length > 20) return { ok: false, error: 'The mod has no usable files. Nothing was installed.' };
  const seen = new Set();
  for (const f of files) {
    if (!f || !checkPath(f.path) || typeof f.text !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(f.text)) return { ok: false, error: 'The mod has a file the launcher will not write (' + String(f && f.path).slice(0, 60) + '). Nothing was installed.' };
    const k = f.path.toLowerCase(); if (seen.has(k)) return { ok: false, error: 'The mod lists a file twice. Nothing was installed.' }; seen.add(k);
  }
  if (!seen.has('scripts/main.lua')) return { ok: false, error: 'The mod has no Scripts/main.lua. Nothing was installed.' };

  // 4. where it goes: its own folder from before, or a new one that is not somebody else's
  const before = installed(modsDir)[modId];
  let folder = before ? before.folder : pickFolder(modsDir, entry.title, modId);   // DF-CMODFOLDER
  if (!folder) return { ok: false, error: 'There is already a folder with this mod\'s name in the mods folder. Nothing was installed.' };
  if (!/^[\w.-]{1,80}$/.test(folder)) return { ok: false, error: 'Could not name the mod\'s folder. Nothing was installed.' };
  const dir = path.join(modsDir, folder);
  const targets = files.map(f => ({ f, full: inside(dir, f.path) }));
  if (targets.some(t => !t.full)) return { ok: false, error: 'A file would land outside the mod\'s folder. Nothing was installed.' };

  // 5. write: files first, the old files this version no longer has made inert, the marker last
  try {
    fs.mkdirSync(dir, { recursive: true });
    const old = readMarker(dir);
    if (old) fs.renameSync(path.join(dir, MARKER), path.join(dir, MARKER + '.updating'));   // half way through, it is not "installed"
    for (const t of targets) writeAtomic(t.full, t.f.text);
    const keep = new Set(files.map(f => f.path.toLowerCase()));
    const gone = [];
    for (const p of (old && Array.isArray(old.files) ? old.files : [])) {
      if (typeof p !== 'string' || keep.has(p.toLowerCase()) || !checkPath(p)) continue;
      const full = inside(dir, p);
      if (full && fs.existsSync(full)) { let to = full + '.removed', k = 2; while (fs.existsSync(to)) to = full + '.removed' + k++; fs.renameSync(full, to); gone.push(p); }
    }
    writeAtomic(path.join(dir, MARKER), JSON.stringify({ id: modId, title: entry.title, author: entry.author, version: entry.version, sha256: sha,
      files: files.map(f => f.path), from: base() + '/m/' + modId, installedAt: new Date().toISOString() }, null, 2));
    try { fs.unlinkSync(path.join(dir, MARKER + '.updating')); } catch {}
    if (gone.length) ctx.log(`Community mods: ${folder}: no longer in v${entry.version}, renamed to .removed: ${gone.join(', ')}`);
  } catch (e) {
    return { ok: false, error: 'Could not write the mod (' + e.message + '). Close the game and try again.' };
  }
  // 6. switch it on in mods.txt, the same way the Mods page's own switches do
  const on = await ctx.runModsTool(v, ['mod', folder, 'on']);
  ctx.log(`Community mods: ${before ? 'updated' : 'installed'} "${entry.title}" v${entry.version} (${sha.slice(0, 16)}) into ${folder}`);
  if (!on || !on.ok) return { ok: true, folder, version: entry.version, title: entry.title, updated: !!before, switchedOn: false, warn: (on && on.error) || 'Installed, but it could not be switched on. Use its switch under Your mods.' };
  return { ok: true, folder, version: entry.version, title: entry.title, updated: !!before, switchedOn: true, modded: !!ms.on };
}

function init(c) {
  ctx = c;
  const { ipcMain } = require('electron');
  ipcMain.handle('community:status', (_e, versionId, fresh) => status(versionId, fresh).catch(e => ({ ok: false, error: e.message })));
  ipcMain.handle('community:install', (_e, versionId, modId) => install(versionId, modId).catch(e => ({ ok: false, error: e.message })));
}
module.exports = { init, status, install, installed, checkPath, folderName, pickFolder, fixFolders, _setCtx: (c) => { ctx = c; cache.clear(); } };
