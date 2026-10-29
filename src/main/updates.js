// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// updates.js - server-file (package) updates without a new launcher build.
// On start the launcher reads packages.json from GitHub. For every version whose packageVersion there is
// newer than the player's copy, it downloads that version's small package zip, checks its sha256, unzips it
// with Windows' built-in tar.exe and applies it over the player's copy (saves, config, logs are never touched).
// The installed DLL hashes in version.json come with the index too, so "Set-up needed" shows up by itself.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { IS_WIN, MOCK, dataRoot, bundledVersionsDir, ensureDir } = require('./paths');
const V = require('./versions');

const RAW = 'https://raw.githubusercontent.com/addison2k/DauntlessForever/main/';
const INDEX_URL = RAW + 'packages.json';
const SUPPORTERS_URL = RAW + 'supporters.json';
const COMMUNITY_URL = RAW + 'resources/community.json';
const PATCHNOTES_URL = RAW + 'resources/patchnotes.json';
const TIMEOUT_MS = 15000;

function fetch(url, toFile, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DauntlessForever' }, timeout: TIMEOUT_MS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(fetch(res.headers.location, toFile, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      if (toFile) {
        const out = fs.createWriteStream(toFile);
        res.pipe(out); out.on('finish', () => out.close(() => resolve(toFile))); out.on('error', reject);
      } else {
        let body = ''; res.setEncoding('utf8'); res.on('data', d => body += d); res.on('end', () => resolve(body));
      }
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toLowerCase(); }
// A small zip reader in plain Node (stored and deflate entries, the only kinds our packages use). Used when tar is
// not there: Wine / Proton / CrossOver on Linux and Mac report themselves as Windows but have no tar.exe.
function unzipJs(zip, dir) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(zip);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(dir);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    const out = path.resolve(root, name);
    if (out !== root && !out.startsWith(root + path.sep)) throw new Error('unsafe path in zip: ' + name);
    if (name.endsWith('/')) { ensureDir(out); continue; }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('broken zip entry: ' + name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    let body;
    if (method === 0) body = data;
    else if (method === 8) body = zlib.inflateRawSync(data);
    else throw new Error('unsupported zip compression (' + method + ') in ' + name);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, body);
  }
}
function unzip(zip, dir) {
  return new Promise((resolve, reject) => {
    ensureDir(dir);
    const fallback = (why) => { try { unzipJs(zip, dir); resolve(); } catch (e2) { reject(new Error('unzip failed: ' + why + '; ' + e2.message)); } };
    // tar.exe ships with Windows 10 1803+ and reads zip files; no extra dependency. Wine and old Windows have none:
    // then the built-in reader above does it.
    try {
      execFile(IS_WIN ? 'tar.exe' : 'tar', ['-xf', zip, '-C', dir], (e, _o, err) => e ? fallback(String(err || e.message).trim()) : resolve());
    } catch (e) { fallback(e.message); }
  });
}

// Returns a list of { id, from, to, applied, error } ; onEvent(msg) for the log.
// onLauncher(info) hears about packages.json's "launcher" block: { version, url, notes } of the newest launcher.
// isHeld(id): the player keeps their own server files (Settings): say an update is there, don't apply it.
// DF-PKGVERIFY (Oct 29): opts.force (Set of ids) fetches the current package even when the number matches (the
// installed files failed their check); opts.skip (Set of ids) fetches nothing for those (a repair already failed on
// the same files - no 70 MB per start while an antivirus keeps deleting them). A version with no .package-version at
// all counts as "fetch": the number in the data folder's version.json says what SHOULD be there, not what is.
let tmpCleared = false;
async function checkAndApply(registry, onEvent, isBusy, onLauncher, isHeld, opts) {
  const results = [];
  if (MOCK) return results;
  opts = opts || {};
  let index;
  try { index = JSON.parse(await fetch(INDEX_URL)); }
  catch (e) { onEvent('No package update check: ' + e.message); return results; }
  if (index.launcher && onLauncher) { try { onLauncher(index.launcher); } catch {} }
  const tmpRoot = ensureDir(path.join(dataRoot(), 'tmp'));
  if (!tmpCleared) {   // DF-PKGVERIFY: leftovers of a download that never finished (closed launcher, crash)
    tmpCleared = true;
    try { for (const n of fs.readdirSync(tmpRoot)) { try { fs.rmSync(path.join(tmpRoot, n), { recursive: true, force: true }); } catch {} } } catch {}
  }
  for (const entry of (index.packages || [])) {
    const v = registry.find(x => x.id === entry.id);
    if (!v || !v.package || !entry.packageVersion || !entry.url || !entry.sha256) continue;
    const marker = V.installedPackageVersion(v);
    const have = marker || V.bundledPackageVersion(v) || '';
    const forced = !!(opts.force && opts.force.has(v.id));
    if (opts.skip && opts.skip.has(v.id)) { onEvent(`${v.id}: server files ${entry.packageVersion} not fetched again: the last copy was blocked on this PC (see above). Allow the launcher in your antivirus, then More > Repair.`); continue; }
    if (!forced && marker && V.cmpPackageVersion(entry.packageVersion, marker) <= 0) continue;
    if (forced) onEvent(`${v.id}: fetching server files ${entry.packageVersion} again (the installed copy failed its check).`);
    else if (!marker) onEvent(`${v.id}: no record of which server files are installed; fetching ${entry.packageVersion}.`);
    if (isHeld && isHeld(v.id)) { onEvent(`${v.id}: server files ${entry.packageVersion} are available but not applied (Keep my server files is on in Settings).`); continue; }
    if (isBusy(v.id)) { onEvent(`${v.id}: an update is available (${entry.packageVersion}) but the version is in use; next start.`); continue; }
    const r = { id: v.id, from: have, to: entry.packageVersion, applied: false, error: '' };
    results.push(r);
    const zip = path.join(tmpRoot, `${v.id}-${entry.packageVersion}.zip`);
    const dir = path.join(tmpRoot, `${v.id}-${entry.packageVersion}`);
    try {
      onEvent(`${v.id}: downloading server files ${entry.packageVersion}...`);
      await fetch(entry.url, zip);
      const h = sha256File(zip);
      if (h !== entry.sha256.toLowerCase()) throw new Error('the downloaded file does not match its checksum');
      fs.rmSync(dir, { recursive: true, force: true });
      await unzip(zip, dir);
      // the zip may hold the package at its root or in one top-level folder
      let src = dir;
      const kids = fs.readdirSync(dir);
      if (kids.length === 1 && fs.statSync(path.join(dir, kids[0])).isDirectory()) src = path.join(dir, kids[0]);
      if (!fs.existsSync(path.join(src, v.package.play))) throw new Error('the update does not look like a package (no ' + v.package.play + ')');
      if (!fs.existsSync(path.join(src, 'version.json'))) throw new Error('the update has no version.json');
      V.applyPackage(v, src, entry.packageVersion);   // DF-PKGVERIFY: throws, marker untouched, when a file does not read back
      // the new version.json (new DLL hashes etc.) now sits in the data folder; use it from here on
      const fresh = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'version.json'), 'utf8'));
      for (const k of Object.keys(fresh)) v[k] = fresh[k];
      r.applied = true;
      onEvent(`${v.id}: server files updated to ${entry.packageVersion}.`);
    } catch (e) {
      r.error = e.message; onEvent(`${v.id}: update failed: ${e.message}`);
    } finally {
      try { fs.rmSync(zip, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  return results;
}

async function fetchJson(url) { if (MOCK) return null; return JSON.parse(await fetch(url)); }
module.exports = { checkAndApply, fetchJson, INDEX_URL, SUPPORTERS_URL, COMMUNITY_URL, PATCHNOTES_URL };
