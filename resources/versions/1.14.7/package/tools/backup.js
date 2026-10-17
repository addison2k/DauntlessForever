// Dauntless Forever - Dauntless 1.14.7 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// backup.js - Host Mode's save backup (the launcher runs it: node tools\backup.js <keep>). Copies this package's
// save (data\state.json, everyone's characters on this server) to backup\hostmode\<date-time>\ and keeps the
// newest <keep> backups. Prints one line of JSON: {ok, files, dir, removed} or {ok:false, error}. (Oct 17)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'backup', 'hostmode');
const FILES = ['data/state.json', 'data/travel_pending.json'];

try {
  const keep = Math.max(1, Math.min(60, parseInt(process.argv[2], 10) || 7));
  const t = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}_${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
  const dir = path.join(OUT, stamp);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  let files = 0;
  for (const rel of FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, 'utf8');
    if (rel.endsWith('state.json')) JSON.parse(text);   // never keep a half-written save as a "backup"
    fs.writeFileSync(path.join(dir, rel), text);
    files++;
  }
  if (!files) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('there is no save yet (data\\state.json)'); }
  const all = fs.readdirSync(OUT, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{4}-\d\d-\d\d_\d{6}$/.test(e.name)).map(e => e.name).sort();
  const removed = [];
  while (all.length > keep) { const old = all.shift(); fs.rmSync(path.join(OUT, old), { recursive: true, force: true }); removed.push(old); }
  console.log(JSON.stringify({ ok: true, files, dir: path.relative(ROOT, dir), removed }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
