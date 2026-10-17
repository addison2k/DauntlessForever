// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// War Hammer ammo. The hammer Blueprint's ammo component starts with MaxAmmoCount 7, while 1.6.2's own weapon
// stats give the hammer 4 capsules; hunts sometimes start with 7. Found by KombatKing (Weapon Ammo Defaults 162 R1,
// AGPL-3.0): he audited all 800 weapon Blueprints and this is the only clear mismatch. This builds a small pak from the
// player's own game files with that one byte set to 4 (same size, nothing else touched). Extended Clip and other mods
// are unchanged. Used by mod-paks.cjs; nothing from the game is shipped.
const path = require('path'), crypto = require('crypto');
const { find, makePak } = require('./event-island-fix.cjs');
const ASSET = 'Archon/Content/Blueprints/Weapons/bp_ihammer_weapon';
const UEXP_SHA = 'fe4f0333ed55116e39f9e5aabac7b38da6aacd0d07c97cd48c46651b9538840c';
const PATCHED_SHA = '6c89f99ea09e307a4c13cec62e310ec2d2212e639bf94d6d126941c9ce360eb5';
const OFFSET = 55845, FROM = 7, TO = 4;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Returns the pak (Buffer) or throws.
function build(gameDir) {
  const t = find(gameDir, ASSET); if (!t) throw new Error('hammer Blueprint not found in the game files');
  if (sha(t.uexp) !== UEXP_SHA || t.uexp[OFFSET] !== FROM) throw new Error('hammer Blueprint is not the expected 1.6.2 file');
  const uexp = Buffer.from(t.uexp); uexp[OFFSET] = TO;
  if (sha(uexp) !== PATCHED_SHA) throw new Error('patched hammer Blueprint check failed');
  const base = path.posix.basename(ASSET), dir = path.posix.dirname(ASSET).replace(/^Archon\/Content\//, '') + '/';
  return makePak([[base + '.uasset', t.uasset], [base + '.uexp', uexp]], '../../../Archon/Content/' + dir);
}
module.exports = { build };
