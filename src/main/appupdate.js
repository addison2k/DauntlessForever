// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// appupdate.js - small launcher updates. packages.json's "launcher" block can carry an "app" entry:
//   "launcher": { "version": "0.2.6", "url": "<release page>", "notes": "...",
//                 "app": { "url": ".../releases/download/v0.2.6/app-0.2.6.asar", "sha256": "...", "size": 4123456, "minShell": "0.2.5" } }
// app-<version>.asar is only the launcher's own code and texts (a few MB). When this install (its exe, Electron and
// bundled Node.js) is minShell or newer, the file is downloaded in the background, checked, and kept in
// <data>\app-update\<version>\; boot.js starts it from the next launch on ("Restart now" in the banner does that).
// Otherwise the old banner shows with a Download button for the full launcher, as before.
'use strict';
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const ofs = require('original-fs');   // *.asar files are plain files here
const { app } = require('electron');
const P = require('./paths');
const V = require('./versions');

const URL_OK = /^https:\/\/github\.com\/addison2k\/DauntlessForever\/releases\/download\/[\w.-]+\/[\w.-]+\.asar$/;

function info() { return global.DF_APP || { builtin: app.getVersion(), version: app.getVersion(), patched: false }; }
function dir() { const d = path.join(P.dataRoot(), 'app-update'); ofs.mkdirSync(d, { recursive: true }); return d; }
function readCur() { try { return JSON.parse(ofs.readFileSync(path.join(dir(), 'current.json'), 'utf8')); } catch { return null; } }
function writeCur(c) { const f = path.join(dir(), 'current.json'); ofs.writeFileSync(f + '.tmp', JSON.stringify(c, null, 1)); ofs.renameSync(f + '.tmp', f); }
function sha(f) { return crypto.createHash('sha256').update(ofs.readFileSync(f)).digest('hex'); }

// The window opened: a launcher update that got this far works (boot.js counts failed starts)
function markGood() {
  const me = info(); if (!me.patched) return;
  const c = readCur(); if (!c || c.version !== me.version) return;
  if (c.tries || !c.good) { c.tries = 0; c.good = true; writeCur(c); }
}

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DauntlessForever' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return resolve(download(new URL(res.headers.location, url).toString(), file, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = ofs.createWriteStream(file);
      res.pipe(out); out.on('finish', () => out.close(() => resolve())); out.on('error', reject); res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// Old launcher updates (not the one running, not the new one) are only taking space
function tidy(keep) {
  const me = info();
  for (const n of ofs.readdirSync(dir())) {
    if (n === keep || n === me.version || !/^\d+(\.\d+)*$/.test(n)) continue;
    try { ofs.rmSync(path.join(dir(), n), { recursive: true, force: true }); } catch {}
  }
}

let busy = false;
// l = packages.json "launcher". Returns 'ready' (downloaded, used from the next start), 'full' (needs the full
// download) or null (nothing to do, or try again next start).
async function consider(l, log) {
  const me = info();
  if (!l || !l.version || V.cmpVersionStr(String(l.version), me.version) <= 0) return null;
  const a = l.app, ver = String(l.version);
  const fits = a && app.isPackaged && URL_OK.test(String(a.url || '')) && /^[0-9a-f]{64}$/i.test(String(a.sha256 || '')) &&
    V.cmpVersionStr(me.builtin, String(a.minShell || ver)) >= 0;
  if (!fits) return 'full';
  const c = readCur();
  if (c && c.version === ver) {
    if (c.bad) return 'full';
    try { if (sha(path.join(dir(), ver, 'app.asar')) === String(c.sha256)) return 'ready'; } catch {}
  }
  if (busy) return null;
  busy = true;
  const d = path.join(dir(), ver); ofs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'app.asar'), part = file + '.part';
  try {
    log(`launcher ${ver}: downloading the update (${Math.max(1, Math.round((Number(a.size) || 0) / 1048576))} MB)`);
    await download(a.url, part);
    if (sha(part) !== String(a.sha256).toLowerCase()) throw new Error('the download does not match its checksum');
    try { ofs.rmSync(file, { force: true }); } catch {}
    ofs.renameSync(part, file);
    writeCur({ version: ver, sha256: String(a.sha256).toLowerCase(), minShell: String(a.minShell || ver), notes: String(l.notes || ''), tries: 0, at: new Date().toISOString() });
    tidy(ver);
    log(`launcher ${ver}: ready, used from the next start`);
    return 'ready';
  } catch (e) {
    try { ofs.rmSync(part, { force: true }); } catch {}
    log(`launcher ${ver}: update not downloaded (${e.message}); trying again next start`);
    return null;
  } finally { busy = false; }
}

module.exports = { info, markGood, consider };
