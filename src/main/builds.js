// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// builds.js (main) - the local build library for the Builds page: a JSON file in the launcher's data folder, written
// atomically, capped at 1 MB and 200 builds, every field checked. Never opens a game save (the renderer reads the
// inventory through the existing items helper). DF-BUILDS v2 (Nov 6): cells are per piece ({ weapon: [..], head: [..] }).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const MAX_BYTES = 1024 * 1024, MAX_BUILDS = 200;
const VERSIONS = ['1.14.7', '1.6.2'];
const SLOTS = ['weapon', 'bond', 'part', 'part2', 'part3', 'head', 'chest', 'arms', 'legs', 'lantern', 'omnicell'];   // DF-BUILDS-IMPORT: bonded weapon and up to three parts
const ID = /^[A-Za-z0-9_\-]{3,100}$/;
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
const savedFile = () => path.join(P.dataRoot(), 'saved-builds.json');
function load() { const d = readJson(savedFile()); return d && Array.isArray(d.builds) ? d.builds.slice(0, MAX_BUILDS) : []; }
function valid(d) {
  if (!d || typeof d !== 'object' || !VERSIONS.includes(d.version)) return null;
  const slots = {};
  for (const k of SLOTS) { const v = d.slots && d.slots[k]; slots[k] = ID.test(String(v || '')) ? String(v) : ''; }
  const cells = {};
  if (Array.isArray(d.cells)) { const a = d.cells.slice(0, 6).map(x => ID.test(String(x || '')) ? String(x) : ''); cells.weapon = a.slice(0, 2); cells.head = [a[2] || '']; cells.chest = [a[3] || '']; cells.arms = [a[4] || '']; cells.legs = [a[5] || '']; }
  else if (d.cells && typeof d.cells === 'object') for (const k of SLOTS) { const a = d.cells[k]; if (Array.isArray(a)) cells[k] = a.slice(0, 4).map(x => ID.test(String(x || '')) ? String(x) : ''); }
  const locks = Array.isArray(d.locks) ? d.locks.filter(x => SLOTS.includes(x)).slice(0, SLOTS.length) : [];
  return { id: /^[a-zA-Z0-9-]{8,80}$/.test(String(d.id)) ? d.id : crypto.randomUUID(), name: String(d.name || 'My build').slice(0, 90), notes: String(d.notes || '').slice(0, 280), version: d.version, slots, cells, locks, likes: Math.min(1, Math.max(0, Number(d.likes) || 0)), createdAt: Number(d.createdAt) || Date.now() };
}
function local(action, arg) {
  if (action === 'list') return { ok: true, builds: load() };
  if (action !== 'put' && action !== 'delete' && action !== 'like') return { ok: false, error: 'Unknown action.' };
  const builds = load();
  if (action === 'put') {
    const item = valid(arg); if (!item) return { ok: false, error: 'That is not a valid build.' };
    const i = builds.findIndex(x => x.id === item.id);
    if (i >= 0) { item.createdAt = builds[i].createdAt; item.likes = builds[i].likes; builds[i] = item; }
    else if (builds.length < MAX_BUILDS) builds.unshift(item);
    else return { ok: false, error: 'The library holds ' + MAX_BUILDS + ' builds; delete one first.' };
  } else {
    const i = builds.findIndex(x => x.id === arg); if (i < 0) return { ok: false, error: 'Build not found.' };
    if (action === 'delete') builds.splice(i, 1); else builds[i].likes = builds[i].likes ? 0 : 1;
  }
  const text = JSON.stringify({ schema: 2, builds }, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) return { ok: false, error: 'The build library is full (1 MB).' };
  try { fs.mkdirSync(P.dataRoot(), { recursive: true }); const tmp = savedFile() + '.tmp'; fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, savedFile()); return { ok: true, builds }; }
  catch (e) { return { ok: false, error: 'Could not save the builds: ' + e.message }; }
}
// catalog(): kept for the first Builds page's route; the page now ships its data with the launcher
function catalog() { return { ok: false, error: 'The Builds page carries its own data now.' }; }
module.exports = { catalog, local, valid };
