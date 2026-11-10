// SPDX-License-Identifier: AGPL-3.0-only
// DF-EVENTS-1147 (Nov 9): old Ramsgate events for 1.14.7, chosen on the launcher's Events page.
// The page writes data/city_events.txt. Its on= line holds two kinds of names:
//   - feature flags (city_event_*_bpff ...): tools/server-1147.ps1 gives them to the town as ?OverridenFeaturesOn=
//     (decorations, the event stall with event Ozz, Linnea);
//   - schedule:<ID>: this module. The game turns an event's quests, island events and shop on when the seasonal
//     event schedule (/game_tuning/seasonal_event_schedule, served from the captures) says the event is running now.
//     Every quest names its event in its own EventId (EVENT_FROSTFALL, SILVER_SWORD ...). The captured schedule still
//     has the dates of the last live year, so each chosen ID gets a window around today: started yesterday, ends in 60
//     days, and an ID the capture does not have is added. Nothing chosen = the capture as it was.
// DF-EVENTS-FIXED-1147 (Nov 10): a line from=YYYY-MM-DD in city_events.txt fixes the window instead: it runs from that
//     date (00:00 UTC) for 60 days (days=N changes the length), and after the end nothing is chosen, so the quests,
//     island events and Honest Ozz's shop close by themselves. Used by Infinite (one season for everyone). Without the
//     line the window moves with today, as before (solo and LAN).
// Forever/Infinite have their own install and backend; this changes only the PC that runs this backend.
'use strict';
const fs = require('fs'), path = require('path');
const DAY = 86400000, WINDOW_DAYS = 60;
const p2 = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())}-${p2(d.getUTCHours())}.${p2(d.getUTCMinutes())}.${p2(d.getUTCSeconds())}`;
function read(dataDir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dataDir, 'city_events.txt'), 'utf8'); } catch { return { ids: [], from: null, days: WINDOW_DAYS }; }
  const ids = []; let from = null, days = WINDOW_DAYS;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const f = /^\s*from\s*=\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(line);
    if (f) { const t = Date.UTC(+f[1], +f[2] - 1, +f[3]); if (Number.isFinite(t)) from = t; continue; }
    const d = /^\s*days\s*=\s*(\d{1,3})\s*$/.exec(line);
    if (d && +d[1] > 0) { days = +d[1]; continue; }
    const m = /^\s*on\s*=\s*(.*)$/.exec(line); if (!m) continue;
    for (const part of m[1].split(',')) { const k = /^\s*schedule:([A-Za-z0-9_]{1,80})\s*$/.exec(part); if (k && !ids.includes(k[1])) ids.push(k[1]); }
  }
  return { ids, from, days };
}
// [start, end] in ms for a fixed window, or null for the moving one
function windowOf(r) { return r.from === null ? null : [r.from, r.from + r.days * DAY]; }
function chosen(dataDir, t = Date.now()) {
  const r = read(dataDir), w = windowOf(r);
  if (w && (t < w[0] || t >= w[1])) return [];
  return r.ids;
}
function create({ dataDir, now = () => new Date(), log = () => {} }) {
  return {
    chosen: () => chosen(dataDir, now().getTime()),
    schedule(reply) {
      const t = now().getTime(), r = read(dataDir), w = windowOf(r);
      const ids = chosen(dataDir, t);
      const items = reply && reply.payload && reply.payload.ScheduledItems;
      if (!ids.length || !Array.isArray(items)) return reply;
      const start = fmt(new Date(w ? w[0] : t - DAY)), end = fmt(new Date(w ? w[1] : t + WINDOW_DAYS * DAY));
      const added = [];
      for (const id of ids) {
        let e = items.find((x) => x && x.Name === id);
        if (!e) { e = { IsRepeatable: false, Name: id, RepeatableDetails: { EachDay: false, EachWeek: false }, ScheduledItems: [{ ID: id, MaxCompletionPerInterval: -1 }] }; items.push(e); added.push(id); }
        e.StartTime = start; e.EndTime = end;
      }
      log(`events1147: running now ${ids.join(', ')}${added.length ? ' (added ' + added.join(', ') + ')' : ''}, ${start} to ${end}${w ? ' (fixed)' : ''}`);
      return reply;
    },
  };
}
module.exports = { create, chosen, fmt };
