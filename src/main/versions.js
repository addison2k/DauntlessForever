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
      // DF-PKGVERIFY (Oct 29): the bundle's own package number is kept apart from whatever the data folder says. The
      // bundle (resources\versions next to app.asar) is frozen at the installer's date; small launcher updates never
      // change it. A copy from it must be stamped with ITS number - stamping it with the newer number below was the
      // "Set-up needed forever" loop (old files, new marker, updates.js saw nothing to do).
      const bundledPackageVersion = (v.package && v.package.packageVersion) || '';
      // a package update (updates.js) leaves its own version.json in the data folder; prefer it when newer
      try {
        const u = JSON.parse(fs.readFileSync(path.join(dataDir, 'version.json'), 'utf8'));
        if (u.package && v.package && cmpPackageVersion(u.package.packageVersion, v.package.packageVersion) > 0) v = u;
      } catch {}
      v.bundledDir = path.join(dir, id);
      v.dataDir = dataDir;
      v.bundledPackageVersion = bundledPackageVersion;
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
// Does this version's data folder need the bundled package copied in? (the player has nothing, or something older)
function needsSync(v) {
  if (!v.package) return false;
  const src = path.join(v.bundledDir, v.package.dir);
  if (!fs.existsSync(src)) return false;   // registry entry came from an update newer than the bundle; nothing to copy
  const have = installedPackageVersion(v);
  const playThere = fs.existsSync(path.join(v.dataDir, v.package.play));
  // DF-PKGVERIFY: measured against the BUNDLE's number. The bundle goes in when the marker is missing or older than
  // it, or the play script is gone - except when the data folder already holds an update newer than the bundle (its
  // version.json won above) and the play script is there: then the bundle would only put old files over new ones.
  // updates.js takes that case (a missing marker means "fetch the current package").
  const bundled = bundledPackageVersion(v);
  if (have && cmpPackageVersion(have, bundled) >= 0 && playThere) return false;
  if (playThere && cmpPackageVersion(v.package.packageVersion, bundled) > 0) return false;
  return true;
}
function bundledPackageVersion(v) { return v.bundledPackageVersion || (v.package && v.package.packageVersion) || ''; }
function syncPackage(v) {
  if (!needsSync(v)) return;
  applyPackage(v, path.join(v.bundledDir, v.package.dir), bundledPackageVersion(v));
}
// The same copy without freezing the launcher (start-up shows a "please wait" window meanwhile). onFile(n) after each file.
// .package-version is written last, so a copy that gets cut off simply runs again next time.
async function syncPackageAsync(v, onFile) {
  if (!needsSync(v)) return;
  const dst = ensureDir(v.dataDir);
  const keep = PRESERVE_PATHS.concat((v.package && v.package.saveFiles) || []).map(p => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  let n = 0;
  const copied = [];   // DF-PKGVERIFY
  const walk = async (src, d0, rel) => {
    for (const ent of await fs.promises.readdir(src, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      const s = path.join(src, ent.name), d = path.join(d0, ent.name);
      if ((PRESERVE_NAMES.has(ent.name) || keep.includes(r)) && fs.existsSync(d)) continue;
      if (ent.isDirectory()) { await fs.promises.mkdir(d, { recursive: true }); await walk(s, d, r); }
      else { await fs.promises.copyFile(s, d); copied.push({ rel: r, src: s }); n++; if (onFile) onFile(n); }
    }
  };
  await walk(path.join(v.bundledDir, v.package.dir), dst, '');
  sealPackage(dst, bundledPackageVersion(v), copied);
}
// Put a package (from the bundle, or an update that was just unzipped) into the version's data folder.
function applyPackage(v, srcDir, packageVersion) {
  const dst = ensureDir(v.dataDir);
  const keep = PRESERVE_PATHS.concat((v.package && v.package.saveFiles) || []).map(p => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  const copied = [];   // DF-PKGVERIFY
  copyTree(srcDir, dst, '', keep, copied);
  sealPackage(dst, packageVersion, copied);
}
// DF-PKGVERIFY (Oct 29): after a copy, every copied file is read back and compared with its source, and the list
// (path, size, sha256) goes into .package-files.json. .package-version is written LAST and only when every file is
// there as copied. A file that is missing or different afterwards (an antivirus took it, the copy was cut off) is
// named in the error and the marker stays as it was, so nothing claims a package that is not really there.
const FILES_MANIFEST = '.package-files.json';
function sealPackage(dst, packageVersion, copied) {
  const bad = [], files = {};
  for (const c of copied) {
    const want = sha256(c.src), have = sha256(path.join(dst, c.rel));
    if (!have) bad.push(c.rel + ' (missing)');
    else if (want && have !== want) bad.push(c.rel + ' (different)');
    let size = 0; try { size = fs.statSync(c.src).size; } catch {}
    files[c.rel] = { size, sha256: want || '' };
  }
  hashCache.clear();
  if (bad.length) throw new Error(badFilesText(bad));
  fs.writeFileSync(path.join(dst, FILES_MANIFEST), JSON.stringify({ packageVersion, written: new Date().toISOString(), files }, null, 1));
  fs.writeFileSync(path.join(dst, '.package-version'), packageVersion);
}
function badFilesText(bad) {
  return 'these server files are not in place: ' + bad.slice(0, 5).join(', ') + (bad.length > 5 ? ' and ' + (bad.length - 5) + ' more' : '') +
    '. An antivirus removing them is the usual reason.';
}
// DF-PKGVERIFY: is what was copied into the data folder still there, unchanged? { ok, bad: ['rel (why)'], unverified }.
// With no list yet (a copy made by a launcher before 0.3.23, or one whose marker does not match the list) the package's
// own bin\ files are checked against the hashes version.json expects in the game folder: same files, same names, so an
// old pak or a loader the antivirus deleted shows up (unverified: true says the check was the narrow one).
function verifyPackage(v) {
  const r = { ok: true, bad: [], unverified: false, marker: installedPackageVersion(v) };
  if (!v.package || !fs.existsSync(path.join(v.dataDir, v.package.play))) return r;   // nothing installed: not this check's job
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(v.dataDir, FILES_MANIFEST), 'utf8')); } catch {}
  if (m && m.files && r.marker && m.packageVersion === r.marker) {
    for (const [rel, want] of Object.entries(m.files)) {
      const have = sha256(path.join(v.dataDir, rel));
      if (!have) r.bad.push(rel + ' (missing)');
      else if (want.sha256 && have !== String(want.sha256).toUpperCase()) r.bad.push(rel + ' (different)');
    }
  } else {
    r.unverified = true;
    for (const f of v.package.installedFiles || []) {
      const name = path.basename(f.rel);
      if (!/\.(dll|pak)$/i.test(name) || !f.sha256) continue;
      const have = sha256(path.join(v.dataDir, 'bin', name));
      if (!have) r.bad.push('bin/' + name + ' (missing)');
      else if (have !== String(f.sha256).toUpperCase()) r.bad.push('bin/' + name + ' (old or different)');
    }
  }
  r.ok = !r.bad.length;
  return r;
}
// "2026-10-12" < "2026-10-14.1" < "2026-10-14.2"
function cmpPackageVersion(a, b) { return String(a).localeCompare(String(b), 'en', { numeric: true }); }
// Package files are always refreshed (so an update really updates data/ and eos/ too); only the
// preserved paths are left alone when the player already has them.
function copyTree(src, dst, rel, keep, copied) {   // DF-PKGVERIFY: copied (optional) collects { rel, src } per file
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    const kept = PRESERVE_NAMES.has(ent.name) || keep.includes(r);
    if (kept && fs.existsSync(d)) continue;
    if (ent.isDirectory()) { ensureDir(d); copyTree(s, d, r, keep, copied); }
    else { fs.copyFileSync(s, d); if (copied) copied.push({ rel: r, src: s }); }
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
// How a version plays online (Friends, Play online, Host Mode): version.json "package.online", else the 1.6.2 way.
// hostScript/joinScript are run as before (-Public, -HostMode / -Code '<code>'); relayFile is written by the host
// script while connected to the relay ({ip, base}); statusPort/statusPath answer 200 once the backend is up;
// accounts: the host makes a backend account per friend (/undaunted/api/Register, a UUK key in the join code);
// hostPlay: what Play starts while Host Mode runs this version (only the game, joining the local server). (Oct 17)
const ONLINE_DEFAULT = { hostScript: 'tools/online-host.ps1', joinScript: 'tools/lan-join.ps1', relayFile: 'data/relay.json',
  statusPort: 61000, statusPath: '/dauntless-status', accounts: true, hostPlay: 'tools/play-162.ps1', huntPorts: [8770, 8775] };
function online(v) {
  const o = Object.assign({}, ONLINE_DEFAULT, (v && v.package && v.package.online) || {});
  const d = (v && v.dataDir) || '';
  return { ...o, hostPath: path.join(d, o.hostScript), joinPath: path.join(d, o.joinScript), relayPath: path.join(d, o.relayFile), hostPlayPath: o.hostPlay ? path.join(d, o.hostPlay) : '' };
}
function cmpVersionStr(a, b) { return cmpVersion(String(a).replace(/^v/, ''), String(b).replace(/^v/, '')); }
module.exports = { online, cmpVersionStr, missingPrereqs, loadRegistry, syncPackage, syncPackageAsync, needsSync, applyPackage, installedPackageVersion, bundledPackageVersion, verifyPackage, badFilesText, cmpPackageVersion, status, sha256, resolveGameDir, knownGameDir, seedConfig, readPkgConfig };
