// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// player.js - one player name for everything: every Dauntless version (the launcher passes it to set-up and Play
// in DF_PLAYER_NAME, so set-up never asks) and the Friends page. Asked once, the first time the launcher opens.
// Names do not have to be unique: accounts are told apart by their long keys, and friends by a friend code
// (name#1234) when two players share a name.
'use strict';
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const P = require('./paths');
const settings = require('./settings');

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
let ctx = null;   // { registry (getter), social, log }

const get = () => { const n = settings.load().playerName; return typeof n === 'string' && NAME_RE.test(n) ? n : ''; };

// a name the player already gave somewhere: the Friends page, or a version's set-up
function suggestion() {
  try { const s = JSON.parse(fs.readFileSync(path.join(P.dataRoot(), 'social.json'), 'utf8')); if (s && NAME_RE.test(s.name || '')) return s.name; } catch {}
  for (const v of ctx.registry) {
    try { const c = JSON.parse(fs.readFileSync(path.join(v.dataDir, 'config.json'), 'utf8').replace(/^﻿/, '')); if (c && NAME_RE.test(c.PlayerName || '') && c.PlayerName !== 'Slayer') return c.PlayerName; } catch {}
  }
  return '';
}

async function set(name) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('Names are 3-16 letters, numbers or _ (no spaces).');
  const old = get();
  settings.update(s => { s.playerName = name; });
  if (old !== name) ctx.log(`player name: ${name}`);
  // the Friends page follows (best effort: offline is fine, it catches up on the next poll)
  Promise.resolve().then(() => ctx.social.applyName(name)).catch((e) => ctx.log('player name: friends service did not take it yet: ' + e.message));   // never makes the player wait
  return name;
}

function init(c) {
  ctx = c;
  ipcMain.handle('player:get', () => ({ name: get(), suggestion: get() ? '' : suggestion() }));
  ipcMain.handle('player:set', async (_e, name) => {
    try { return { ok: true, name: await set(name) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { init, get, NAME_RE };
