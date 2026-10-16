// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// boot.js - the first file the launcher runs. It picks which launcher code to start:
//   - the code that came with this install (app.asar next to the exe), or
//   - a newer "launcher update" that was downloaded earlier (<data>\app-update\<version>\app.asar, see
//     main/appupdate.js). Those are a few MB instead of the whole ~115 MB launcher: only the launcher's own code
//     and texts change, Electron and the bundled Node.js stay as they are.
// A launcher update is only used when it is newer than this install, was made for this install or an older one
// (minShell), still matches its checksum, and did not fail to open twice in a row. Otherwise this install's own
// code starts, exactly as before. DF_NO_APP_UPDATE=1 always starts the install's own code.
'use strict';
const path = require('path');
const { app } = require('electron');

const BUILTIN = require('../package.json').version;

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// the same folder as main/paths.js dataRoot() (that file can't be used yet: it may be the older copy)
function dataRoot(fs) {
  if (process.env.DL_DATA_DIR) return process.env.DL_DATA_DIR;
  const base = (process.platform === 'win32' && process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : app.getPath('userData');
  const old = path.join(base, 'DauntlessOffline');
  if (fs.existsSync(path.join(old, 'launcher.json')) || fs.existsSync(path.join(old, 'versions'))) return old;
  return path.join(base, 'DauntlessForever');
}

function pickUpdate() {
  if (!app.isPackaged || process.env.DF_NO_APP_UPDATE === '1') return null;
  let fs, cur, file;
  try {
    fs = require('original-fs');   // plain file access: Electron's fs treats *.asar files as folders
    const dir = path.join(dataRoot(fs), 'app-update');
    file = path.join(dir, 'current.json');
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cur || !cur.version || cur.bad) return null;
    if (cmp(cur.version, BUILTIN) <= 0) return null;                    // this install is as new or newer
    if (cur.minShell && cmp(BUILTIN, cur.minShell) < 0) return null;   // made for a newer install
    const asar = path.join(dir, String(cur.version), 'app.asar');
    const sum = require('crypto').createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
    if (sum !== String(cur.sha256 || '').toLowerCase()) { cur.bad = 'checksum'; fs.writeFileSync(file, JSON.stringify(cur, null, 1)); return null; }
    // main.js sets tries back to 0 once the window is up; two starts that never got there = don't use it again
    cur.tries = (cur.tries || 0) + 1;
    if (cur.tries > 2) { cur.bad = 'did not open'; fs.writeFileSync(file, JSON.stringify(cur, null, 1)); return null; }
    fs.writeFileSync(file, JSON.stringify(cur, null, 1));
    return { asar, version: String(cur.version), file };
  } catch { return null; }
}

// a second launcher only brings the open one forward (main.js asks again and gets the same answer); it must not
// count as a failed start of a launcher update
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const upd = pickUpdate();
global.DF_APP = { builtin: BUILTIN, version: upd ? upd.version : BUILTIN, patched: !!upd, root: upd ? upd.asar : path.join(__dirname, '..') };
if (upd) {
  try { require(path.join(upd.asar, 'src', 'main', 'main.js')); }
  catch (e) {
    // the update's code failed at once: mark it and start again with this install's own code
    try { const fs = require('original-fs'); const cur = JSON.parse(fs.readFileSync(upd.file, 'utf8')); cur.bad = 'error: ' + String(e && e.message || e).slice(0, 200); fs.writeFileSync(upd.file, JSON.stringify(cur, null, 1)); } catch {}
    app.relaunch(); app.exit(0);
  }
} else {
  require('./main/main.js');
}
