// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// Trials. The game decides which Trial is on (and whether the Trials board opens at all) from its own table
// Gameplay/hunts/gen_arena_hunts_schedule: 100 weekly rows whose dates ended on 2021-06-17, so every Trial counts as
// over. Same idea as Dauntless Revived's in-memory fix (mixutin/dauntless-revived, TrialsSchedule.h), done here as a
// pak instead of a DLL hook: this builds a small pak from the player's own game files with the weekly rows moved to
// now. Row by row they get the same week and the same Hard/Elite Trial as KombatKing's rotation (trials-schedule.cjs),
// which the backend's schedule and the hunt launcher already use, so the board, the countdown and the hunt you get all
// agree. Only dates and the two Trial ids per row change (same size); the daily test rows stay as they are.
// Everyone with the same package and the same UTC date builds the same pak, so hosts and joiners match.
const path = require('path'), fs = require('fs');
const { find, names, tagAt, props, makePak } = require('./event-island-fix.cjs');
const rotation = require('./trials-schedule.cjs');
const ASSET = 'Archon/Content/Gameplay/hunts/gen_arena_hunts_schedule';
const DAY = 86400000, WEEK = 7 * DAY, ANCHOR = Date.UTC(2026, 9, 12);   // a Monday, the same anchor as trials-schedule.cjs
const BLOCK = 26;   // the rows are moved in half-year steps, so the pak only changes twice a year
const TICKS_1970 = 621355968000000000n;
const ticks = (ms) => TICKS_1970 + BigInt(ms) * 10000n;

function rotationFor(gameRoot) {
  const dir = path.join(gameRoot || path.resolve(__dirname, '..'), 'backend', 'deploy', 'dist', 'vendor');
  return rotation.create(JSON.parse(fs.readFileSync(path.join(dir, 'trials_hard_table.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(dir, 'trials_elite_table.json'), 'utf8')));
}

function patch(t, rot, now = Date.now()) {
  const N = names(t.uasset), ue = Buffer.from(t.uexp);
  const nameAt = (o) => { const i = ue.readUInt32LE(o), n = ue.readUInt32LE(o + 4); return n ? N[i] + '_' + (n - 1) : N[i]; };
  let o = props(ue, N, 0).end;
  if (ue.readUInt32LE(o) !== 0) throw new Error('unexpected table layout'); o += 4;
  const count = ue.readUInt32LE(o); o += 4;
  const weekly = [];
  for (let i = 0; i < count; i++) {
    const row = nameAt(o); o += 8;
    const p = props(ue, N, o);
    const m = /^Scheduled_Arena_Hunt_(\d+)$/.exec(row);
    if (m) {
      const start = p.out.find(x => x.name === 'StartTime'), end = p.out.find(x => x.name === 'EndTime'), items = p.out.find(x => x.name === 'ScheduledItems');
      if (!start || !end || !items || start.size !== 8 || end.size !== 8) throw new Error('unexpected row ' + row);
      // ScheduledItems: count, the inner struct tag, then each item's tagged properties (ID is a NameProperty)
      let q = items.start; const n = ue.readUInt32LE(q); q += 4; q = tagAt(ue, N, q).start;
      const ids = [];
      for (let k = 0; k < n; k++) { const e = props(ue, N, q); const id = e.out.find(x => x.name === 'ID' && x.type === 'NameProperty'); if (id) ids.push(id.start); q = e.end; }
      weekly.push({ num: Number(m[1]), start: start.start, end: end.start, ids });
    }
    o = p.end;
  }
  if (o !== ue.length - 4) throw new Error('table not read to the end');
  if (weekly.length < 20) throw new Error('weekly Trials rows not found');
  weekly.sort((a, b) => a.num - b.num);
  const week = Math.floor((now - ANCHOR) / WEEK);
  const first = Math.floor(week / BLOCK) * BLOCK - 1;   // one week back, so the board's Previous tab has a week too
  for (let k = 0; k < weekly.length; k++) {
    const r = weekly[k], at = ANCHOR + (first + k) * WEEK, c = rot.current(at + DAY);
    ue.writeBigInt64LE(ticks(at), r.start); ue.writeBigInt64LE(ticks(at + WEEK), r.end);
    for (const p of r.ids) {
      const was = N[ue.readUInt32LE(p)];
      const want = /_Elite/.test(was) ? c.elite : /_Hard/.test(was) ? c.hard : null;
      if (!want) continue;
      const idx = N.indexOf(want); if (idx < 0) throw new Error('name not in table: ' + want);
      ue.writeUInt32LE(idx, p); ue.writeUInt32LE(0, p + 4);
    }
  }
  const last = ANCHOR + (first + weekly.length) * WEEK;
  return { uasset: t.uasset, uexp: ue, rows: weekly.length, until: new Date(last).toISOString().slice(0, 10) };
}

// Returns the pak (Buffer) or throws.
function build(gameDir, now = Date.now(), gameRoot) {
  const t = find(gameDir, ASSET); if (!t) throw new Error('Trials schedule not found in the game files');
  const r = patch(t, rotationFor(gameRoot), now);
  const base = path.posix.basename(ASSET), dir = path.posix.dirname(ASSET).replace(/^Archon\/Content\//, '') + '/';
  return makePak([[base + '.uasset', r.uasset], [base + '.uexp', r.uexp]], '../../../Archon/Content/' + dir);
}
module.exports = { build, patch };
