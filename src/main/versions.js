// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// versions.js - the version registry (resources/versions/<id>/version.json), the writable copy of each
// package, and the status of each version: is the game there, is it the right build, was set-up done.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IS_WIN, MOCK, bundledVersionsDir, versionsDataDir, ensureDir } = require('./paths');
const settings = require('./settings');

// Never overwritten by a package copy/update: things set-up or the player made. Matched by name at any depth
// (node_modules) or by path from the package root. The version's saveFiles are added per version.
const PRESERVE_NAMES = new Set(['node_modules', '.env']);
const PRESERVE_PATHS = ['config.json', 'home', 'logs', 'upload', 'backup', 'captures', 'eos/eos_offline.ini', 'eos/eos_offline.log', 'data/gameserver.key', 'data/player.key'];

// ---------------------------------------------------------------- registry
function loadRegistry() {
  const dir = bundledVersionsDir();
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const f = path.join(dir, id, 'version.json');
    if (!fs.existsSync(f)) continue;
    try {
      let v = JSON.parse(fs.readFileSync(f, 'utf8'));
      const dataDir = path.join(versionsDataDir(), id);
      // a package update (updates.js) leaves its own version.json in the data folder; prefer it when newer
      try {
        const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'version.json'), 'utf8'));
        if (u.package && v.package && cmpPackageVersion(u.package.packageVersion, v.package.packageVersion) > 0) v = u;
      } catch {}
      v.bundledDir = path.join(dir, id);
      v.dataDir = dataDir;
      out.push(v);
    } catch (e) { console.error('bad version.json', f, e.message); }
  }
  // oldest first, by numeric version (a timeline, top to bottom)
  out.sort((a, b) => cmpVersion(a.id, b.id));
  return out;
}
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// ---------------------------------------------------------------- package copy (bundled -> writable)
// Copies the bundled package into the version's data folder. Files the player's set-up made
// (config.json, home, logs, backup, captures, node_modules, .env, eos_offline.ini, keys, saves) are never touched.
function installedPackageVersion(v) {
  try { return fs.readFileSync(path.join(v.dataDir, '.package-version'), 'utf8').trim(); } catch { return ''; }
}
function syncPackage(v) {
  if (!v.package) return;
  const src = path.join(v.bundledDir, v.package.dir);
  if (!fs.existsSync(src)) return;   // registry entry came from an update newer than the bundle; nothing to copy
  const have = installedPackageVersion(v);
  // only copy the bundled package in when the player has nothing, or something older than what is bundled
  if (have && cmpPackageVersion(have, v.package.packageVersion) >= 0 && fs.existsSync(path.join(v.dataDir, v.package.play))) return;
  applyPackage(v, src, v.package.packageVersion);
}
// Put a package (from the bundle, or an update that was just unzipped) into the version's data folder.
function applyPackage(v, srcDir, packageVersion) {
  const dst = ensureDir(v.dataDir);
  const keep = PRESERVE_PATHS.concat((v.package && v.package.saveFiles) || []).map(p => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  copyTree(srcDir, dst, '', keep);
  fs.writeFileSync(path.join(dst, '.package-version'), packageVersion);
  hashCache.clear();
}
// "2026-10-12" < "2026-10-14.1" < "2026-10-14.2"
function cmpPackageVersion(a, b) { return String(a).localeCompare(String(b), 'en', { numeric: true }); }
// Package files are always refreshed (so an update really updates data/ and eos/ too); only the
// preserved paths are left alone when the player already has them.
function copyTree(src, dst, rel, keep) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    const kept = PRESERVE_NAMES.has(ent.name) || keep.includes(r);
    if (kept && fs.existsSync(d)) continue;
    if (ent.isDirectory()) { ensureDir(d); copyTree(s, d, r, keep); }
    else fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------- hashing (cached by path+size+mtime)
const hashCache = new Map();
function sha256(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = file + '|' + st.size + '|' + st.mtimeMs;
  if (hashCache.has(key)) return hashCache.get(key);
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  const hex = h.digest('hex').toUpperCase();
  hashCache.set(key, hex);
  return hex;
}

// ---------------------------------------------------------------- game folder
function readPkgConfig(v) {
  try { return JSON.parse(fs.readFileSync(path.join(v.dataDir, 'config.json'), 'utf8')); } catch { return null; }
}
// The game folder the launcher knows about: what it downloaded / the player picked, else what set-up saved.
function knownGameDir(v) {
  const e = settings.versionEntry(v.id);
  if (e.gameDir) return e.gameDir;
  const c = readPkgConfig(v);
  return (c && c.GameDir) || '';
}
// Accept the game folder, a folder inside it, or a folder containing it (same rule as setup.ps1).
function resolveGameDir(pick, exeRel) {
  if (!pick) return null;
  let d = pick;
  for (let i = 0; i < 4 && d; i++) {
    if (fs.existsSync(path.join(d, exeRel))) return d;
    const p = path.dirname(d); if (p === d) break; d = p;
  }
  // one level of children (e.g. the folder the download tool was given, with the game inside)
  try {
    for (const ent of fs.readdirSync(pick, { withFileTypes: true })) {
      if (ent.isDirectory() && fs.existsSync(path.join(pick, ent.name, exeRel))) return path.join(pick, ent.name);
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------- Windows parts every version needs
// Visual C++ runtime + DirectX (June 2010). A game downloaded by the launcher never ran Epic's prerequisite
// installer; without these files every copy of the game closes at once with no log.
const PREREQ_FILES = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'xinput1_3.dll', 'x3daudio1_7.dll', 'xapofx1_5.dll'];
function missingPrereqs() {
  if (!IS_WIN || MOCK) return [];
  const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  return PREREQ_FILES.filter(f => !fs.existsSync(path.join(sys, f)));
}

// ---------------------------------------------------------------- status
// game: 'missing' | 'partial' | 'wrong' | 'ok';  setup: 'na' | 'needed' | 'ready'
function status(v) {
  if (MOCK) return mockStatus(v);
  const s = { id: v.id, gameDir: knownGameDir(v), game: 'missing', setup: 'na', exeHash: null, hasSave: false, config: null, nodeOk: null };
  if (s.gameDir) {
    const exe = path.join(s.gameDir, v.exeRel);
    if (fs.existsSync(path.join(s.gameDir, '.manifest-cache'))) s.game = 'partial';
    if (fs.existsSync(exe)) {
      s.exeHash = sha256(exe);
      s.game = (v.exeSha256 && s.exeHash === v.exeSha256.toUpperCase()) ? 'ok' : 'wrong';
      if (s.game === 'wrong' && fs.existsSync(path.join(s.gameDir, '.manifest-cache'))) s.game = 'partial';
    }
  }
  if (v.package) {
    s.config = readPkgConfig(v);
    s.setup = 'needed';
    if (s.game === 'ok' && s.config && s.config.GameDir) {
      const sameDir = norm(s.config.GameDir) === norm(s.gameDir);
      const dlls = v.package.installedFiles.every(f => sha256(path.join(s.gameDir, f.rel)) === f.sha256.toUpperCase());
      const extras = (v.package.setupDoneFiles || []).every(f => fs.existsSync(path.join(v.dataDir, f)));
      if (sameDir && dlls && extras) s.setup = 'ready';
    }
    s.prereqMissing = missingPrereqs();
    if (s.prereqMissing.length && s.setup === 'ready') s.setup = 'needed';
    s.hasSave = (v.package.saveFiles || []).some(f => fs.existsSync(path.join(v.dataDir, f)));
  }
  return s;
}
function norm(p) { return IS_WIN ? path.resolve(p).toLowerCase().replace(/[\\/]+$/, '') : path.resolve(p); }

function mockStatus(v) {
  const canned = {
    '1.14.7': { game: 'ok', setup: 'ready', gameDir: 'D:\\Games\\Dauntless_1.14.7', hasSave: true },
    '1.6.2':  { game: 'ok', setup: 'needed', gameDir: 'D:\\Games\\Dauntless_1.6.2', hasSave: false },
    '1.12.0': { game: 'missing', setup: 'na', gameDir: '', hasSave: false },
  };
  return { id: v.id, exeHash: null, config: null, ...(canned[v.id] || { game: 'missing', setup: 'na', gameDir: '' }) };
}

// Called before SETUP so the script reuses the folder instead of scanning the drives.
function seedConfig(v, gameDir) {
  if (!v.package || !gameDir) return;
  const f = path.join(v.dataDir, 'config.json');
  let c = readPkgConfig(v) || {};
  if (c.GameDir && norm(c.GameDir) === norm(gameDir)) return;
  c.GameDir = gameDir;
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

// "0.1.10" > "0.1.9"
function cmpVersionStr(a, b) { return cmpVersion(String(a).replace(/^v/, ''), String(b).replace(/^v/, '')); }
module.exports = { cmpVersionStr, missingPrereqs, loadRegistry, syncPackage, applyPackage, installedPackageVersion, cmpPackageVersion, status, sha256, resolveGameDir, knownGameDir, seedConfig, readPkgConfig };
