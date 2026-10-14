// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// paths.js - where the launcher keeps its own things. No hard-coded drive letters anywhere.
'use strict';
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const IS_WIN = process.platform === 'win32';
const MOCK = !!process.env.DL_MOCK;

// Bundled, read-only: the version packages and the download tool.
// In development they live in <repo>/resources; in a packaged app electron-builder copies them to <app>/resources.
function bundledRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
}
function bundledVersionsDir() { return path.join(bundledRoot(), 'versions'); }
function bundledToolsDir() { return path.join(bundledRoot(), 'tools'); }
// The official portable Node.js shipped with the launcher (tools/fetch-node.ps1 puts it in resources/runtime/node).
function bundledNode() { const p = path.join(bundledRoot(), 'runtime', 'node', 'node.exe'); return fs.existsSync(p) ? p : null; }

// Writable: a copy of each package (it writes config.json, data\, logs\ ...), plus launcher.json.
function dataRoot() {
  if (process.env.DL_DATA_DIR) return process.env.DL_DATA_DIR;
  const base = (IS_WIN && process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : app.getPath('userData');
  // Players from before the rename (Dauntless Offline) keep their folder: the backend's .env files hold full
  // paths into it, so moving it would cut the backend off from the save. New players get DauntlessForever.
  const old = path.join(base, 'DauntlessOffline');
  if (fs.existsSync(path.join(old, 'launcher.json')) || fs.existsSync(path.join(old, 'versions'))) return old;
  return path.join(base, 'DauntlessForever');
}
function versionsDataDir() { return path.join(dataRoot(), 'versions'); }
function settingsFile() { return path.join(dataRoot(), 'launcher.json'); }
function launcherLog() { return path.join(dataRoot(), 'launcher.log'); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

module.exports = { IS_WIN, MOCK, bundledRoot, bundledVersionsDir, bundledToolsDir, bundledNode, dataRoot, versionsDataDir, settingsFile, launcherLog, ensureDir };
