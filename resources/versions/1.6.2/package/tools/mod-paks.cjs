// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// Puts the package's add-on paks (paks/paks.json: the goat fix, holiday quests, holiday art and maps, the Mega dye
// bundles, and this month's holiday pak; all by KombatKing) into the game's Archon/Content/Paks, and takes out the
// ones this script put there earlier that are no longer wanted. Run by start.ps1 and lan-join.ps1 before anything of
// the game starts, so the player's game and the hunt servers always load the same files.
//   node mod-paks.cjs <game folder>            sync
//   node mod-paks.cjs <game folder> remove     take all of ours out (Uninstall)
// data/mod_paks_off.txt (any content) switches them off: everything of ours is taken out.
// A file can't be replaced while a copy of the game runs: then it says so and leaves it (exit code 0 either way).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const game = process.argv[2], mode = process.argv[3] || 'sync';
const say = (m) => console.log('    ' + m);
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
function main() {
  if (!game || !fs.existsSync(path.join(game, 'Archon', 'Content', 'Paks'))) { say('Add-ons: game folder not found; skipped.'); return; }
  const paks = path.join(game, 'Archon', 'Content', 'Paks');
  let man; try { man = JSON.parse(fs.readFileSync(path.join(ROOT, 'paks', 'paks.json'), 'utf8')); } catch { say('Add-ons: none in this package.'); return; }
  const stateFile = path.join(ROOT, 'data', 'mod_paks.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const installed = new Set(Array.isArray(state.installed) ? state.installed : []);
  const want = new Map();   // file name in Paks -> source file
  let theme = 'none';
  const off = mode === 'remove' || fs.existsSync(path.join(ROOT, 'data', 'mod_paks_off.txt'));
  if (!off) {
    for (const [name, hash] of Object.entries(man.always || {})) want.set(name, { src: path.join(ROOT, 'paks', name), hash });
    const h = man.holiday;
    if (h && h.name && h.themes) {
      try { const cal = require(path.join(ROOT, 'tools', 'holiday-schedule.cjs')); theme = (cal.active(new Date())[0] || {}).id || 'none'; } catch {}
      const t = h.themes[theme] || h.themes.none;
      if (t) want.set(h.name, { src: path.join(ROOT, 'paks', t.file), hash: t.sha256 });
    }
  }
  // Built from the player's own game files: the Dark Harvest hunts get the normal island description instead of the
  // Springtide one (event-island-fix.cjs). Nothing from the game is shipped for this one.
  const built = new Map();
  if (!off) {
    try { built.set('zzzzzzzzzzzzzzz_DF_EventIslandFix_P.pak', require(path.join(__dirname, 'event-island-fix.cjs')).build(game)); }
    catch (e) { say('Add-ons: Dark Harvest island fix skipped (' + e.message + ').'); }
    for (const [name, buf] of built) want.set(name, { buf, hash: crypto.createHash('sha256').update(buf).digest('hex') });
  }
  const done = [], kept = [], failed = [];
  for (const [name, w] of want) {
    if (!/^[\w.-]+\.pak$/.test(name)) continue;
    const dst = path.join(paks, name);
    if (!w.buf && sha(w.src) !== w.hash) { failed.push(name + ' (package file damaged)'); continue; }
    installed.add(name);
    if (sha(dst) === w.hash) { kept.push(name); continue; }
    try { const tmp = dst + '.df-tmp'; if (w.buf) fs.writeFileSync(tmp, w.buf); else fs.copyFileSync(w.src, tmp); fs.renameSync(tmp, dst); done.push(name); }
    catch (e) { failed.push(name + ' (' + (e.code || e.message) + ')'); }
  }
  for (const name of [...installed]) {
    if (want.has(name) || !/^[\w.-]+\.pak$/.test(name)) continue;
    try { fs.rmSync(path.join(paks, name), { force: true }); installed.delete(name); done.push('removed ' + name); }
    catch (e) { failed.push('remove ' + name + ' (' + (e.code || e.message) + ')'); }
  }
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify({ installed: [...installed].sort(), theme, at: new Date().toISOString() }, null, 1)); } catch {}
  if (mode === 'remove') say(`Add-ons taken out of the game folder: ${done.length}.`);
  else if (off) say('Add-ons are switched off (data\\mod_paks_off.txt).' + (done.length ? ` Taken out: ${done.length}.` : ''));
  else say(`Add-ons: ${want.size} in place (holiday: ${theme === 'none' ? 'none this month' : theme})${done.length ? `, ${done.length} updated` : ''}.`);
  if (failed.length) say('Add-ons not changed (close every copy of the game and try again): ' + failed.join(', '));
}
try { main(); } catch (e) { say('Add-ons skipped: ' + e.message); }
