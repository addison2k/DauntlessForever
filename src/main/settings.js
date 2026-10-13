// settings.js - launcher.json: the games folder and, per version, the game folder the player chose or downloaded.
'use strict';
const fs = require('fs');
const path = require('path');
const { settingsFile, dataRoot, ensureDir } = require('./paths');

const DEFAULTS = { gamesRoot: '', versions: {}, lastVersion: '' };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...DEFAULTS, ...s, versions: s.versions || {} };
  } catch { return { ...DEFAULTS, versions: {} }; }
}
function save(s) {
  ensureDir(dataRoot());
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
function update(fn) { const s = load(); fn(s); save(s); return s; }
function versionEntry(id) { const s = load(); return s.versions[id] || {}; }
function setVersionEntry(id, patch) { return update(s => { s.versions[id] = { ...(s.versions[id] || {}), ...patch }; }); }

module.exports = { load, save, update, versionEntry, setVersionEntry };
