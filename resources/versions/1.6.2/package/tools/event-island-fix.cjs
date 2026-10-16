// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// The Dark Harvest event hunts in 1.6.2's own hunt table point at the Springtide island description
// (MapMetaData row Spring_Event_Island_01), so the hunt shows Springtide/Easter art. This builds a small pak from the
// player's own game files with that one value changed to the normal island description (Campaign_Island_01) for the
// Dark Harvest rows. Same size, nothing else touched. Used by mod-paks.cjs; nothing from the game is shipped.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const MAGIC = 0x5A6F12E1;
const ASSET = 'Archon/Content/Gameplay/hunts/matchmaker_hunts_table';
const ROWS = ['MatchmakerHunt_Event_Dark_Harvest_01', 'MatchmakerHunt_Event_Dark_Harvest_Hard_01'];
const FROM = 'Spring_Event_Island_01', TO = 'Campaign_Island_01';
function index(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(512, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let m = -1; for (let i = tail.length - 4; i >= 0; i--) if (tail.readUInt32LE(i) === MAGIC) { m = i; break; }
    if (m < 0 || tail[m - 1]) return null;
    const off = Number(tail.readBigUInt64LE(m + 8)), isz = Number(tail.readBigUInt64LE(m + 16));
    const idx = Buffer.alloc(isz); fs.readSync(fd, idx, 0, isz, off);
    let p = 0;
    const fstr = () => { const n = idx.readInt32LE(p); p += 4; if (n < 0) { const s = idx.toString('utf16le', p, p - 2 * n - 2); p += -2 * n; return s; } const s = idx.toString('latin1', p, p + n - 1); p += n; return s; };
    const mount = fstr(), count = idx.readInt32LE(p); p += 4; const entries = new Map();
    for (let i = 0; i < count; i++) {
      const name = fstr();
      const e = { offset: Number(idx.readBigUInt64LE(p)), size: Number(idx.readBigUInt64LE(p + 8)), raw: Number(idx.readBigUInt64LE(p + 16)), method: idx.readUInt32LE(p + 24), blocks: [] };
      p += 48;
      if (e.method) { const nb = idx.readInt32LE(p); p += 4; for (let b = 0; b < nb; b++) { e.blocks.push([Number(idx.readBigUInt64LE(p)), Number(idx.readBigUInt64LE(p + 8))]); p += 16; } }
      e.flags = idx[p]; p += 5; entries.set(name, e);
    }
    return { mount, entries };
  } finally { fs.closeSync(fd); }
}
function read(file, e) {
  if (e.flags & 1) throw new Error('encrypted');
  const fd = fs.openSync(file, 'r');
  try {
    if (!e.method) { const b = Buffer.alloc(e.size); fs.readSync(fd, b, 0, e.size, e.offset + 53); return b; }
    const parts = []; for (const [a, b] of e.blocks) { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, e.offset + a); parts.push(zlib.inflateSync(buf)); }
    return Buffer.concat(parts);
  } finally { fs.closeSync(fd); }
}
function find(gameDir) {
  const dir = path.join(gameDir, 'Archon', 'Content', 'Paks');
  for (const f of fs.readdirSync(dir).filter(f => /^Archon_\d+-WindowsClient\.pak$/i.test(f))) {
    const full = path.join(dir, f); let ix; try { ix = index(full); } catch { continue; } if (!ix) continue;
    const mount = ix.mount.replace(/^(\.\.\/)+/, ''); if (!ASSET.startsWith(mount)) continue;
    const rel = ASSET.slice(mount.length), ua = ix.entries.get(rel + '.uasset'), ue = ix.entries.get(rel + '.uexp');
    if (ua && ue) return { uasset: read(full, ua), uexp: read(full, ue) };
  }
  return null;
}
// cooked 1.6.2 assets: name count/offset at 41/45 (after the folder name "None")
function names(ua) {
  let o = 28; const n = ua.readInt32LE(o); o += 4 + n + 4;
  const count = ua.readUInt32LE(o), at0 = ua.readUInt32LE(o + 4); const out = []; let at = at0;
  for (let i = 0; i < count; i++) { const l = ua.readInt32LE(at); at += 4; out.push(ua.toString('latin1', at, at + l - 1)); at += l + 4; }
  return out;
}
// Tagged properties (cooked 4.25): name, type, size, array index, type extras, has-guid byte, value.
function tagAt(ue, N, o) {
  const name = N[ue.readUInt32LE(o)]; o += 8;
  if (name === 'None') return { name, end: o };
  const type = N[ue.readUInt32LE(o)]; o += 8;
  const size = ue.readUInt32LE(o); o += 8;
  let struct = null;
  if (type === 'StructProperty') { struct = N[ue.readUInt32LE(o)]; o += 8 + 16; }
  else if (['ArrayProperty', 'SetProperty', 'ByteProperty', 'EnumProperty'].includes(type)) o += 8;
  else if (type === 'MapProperty') o += 16;
  else if (type === 'BoolProperty') o += 1;
  const guid = ue[o]; o += 1; if (guid) o += 16;
  return { name, type, struct, size, start: o, end: o + size };
}
function props(ue, N, o) { const out = []; for (;;) { const t = tagAt(ue, N, o); if (t.name === 'None') return { out, end: t.end }; out.push(t); o = t.end; } }
function patch(t) {
  const N = names(t.uasset), id = (s) => N.indexOf(s);
  const from = id(FROM), to = id(TO);
  if (from < 0 || to < 0) throw new Error('names not found');
  const ue = Buffer.from(t.uexp);
  let o = props(ue, N, 0).end;
  if (ue.readUInt32LE(o) !== 0) throw new Error('unexpected table layout'); o += 4;
  const count = ue.readUInt32LE(o); o += 4; let changed = 0;
  for (let i = 0; i < count; i++) {
    const row = N[ue.readUInt32LE(o)]; o += 8;
    const p = props(ue, N, o);
    if (ROWS.includes(row)) {
      const mm = p.out.find(x => x.name === 'MapMetaData'); if (!mm) throw new Error('no MapMetaData in ' + row);
      const rn = props(ue, N, mm.start).out.find(x => x.name === 'RowName'); if (!rn) throw new Error('no RowName in ' + row);
      if (ue.readUInt32LE(rn.start) !== from) throw new Error('unexpected value in ' + row);
      ue.writeUInt32LE(to, rn.start); changed++;
    }
    o = p.end;
  }
  if (o !== ue.length - 4) throw new Error('table not read to the end');
  return { uasset: t.uasset, uexp: ue, changed };
}
function makePak(files, mount) {
  const fstring = s => { const b = Buffer.from(s + '\0', 'latin1'); const n = Buffer.alloc(4); n.writeInt32LE(b.length); return Buffer.concat([n, b]); };
  const record = (offset, data) => { const b = Buffer.alloc(53); b.writeBigUInt64LE(BigInt(offset), 0); b.writeBigUInt64LE(BigInt(data.length), 8); b.writeBigUInt64LE(BigInt(data.length), 16); crypto.createHash('sha1').update(data).digest().copy(b, 28); return b; };
  const parts = [], rows = []; let off = 0;
  for (const [name, data] of files) { const r = record(off, data); parts.push(r, data); rows.push([name, r]); off += r.length + data.length; }
  const cnt = Buffer.alloc(4); cnt.writeUInt32LE(rows.length);
  const idx = Buffer.concat([fstring(mount), cnt, ...rows.flatMap(([n, r]) => [fstring(n), r])]);
  const foot = Buffer.alloc(17 + 44 + 1 + 160); let p = 17;
  foot.writeUInt32LE(MAGIC, p); foot.writeUInt32LE(9, p + 4); foot.writeBigUInt64LE(BigInt(off), p + 8); foot.writeBigUInt64LE(BigInt(idx.length), p + 16);
  crypto.createHash('sha1').update(idx).digest().copy(foot, p + 24); foot.write('Zlib', p + 45, 'latin1');
  return Buffer.concat([...parts, idx, foot]);
}
// Returns the pak (Buffer) or throws.
function build(gameDir) {
  const t = find(gameDir); if (!t) throw new Error('hunt table not found in the game files');
  const r = patch(t); if (r.changed !== ROWS.length) throw new Error('not all rows changed');
  const base = path.posix.basename(ASSET), dir = path.posix.dirname(ASSET).replace(/^Archon\/Content\//, '') + '/';
  return makePak([[base + '.uasset', r.uasset], [base + '.uexp', r.uexp]], '../../../Archon/Content/' + dir);
}
module.exports = { build, find, patch, names };
