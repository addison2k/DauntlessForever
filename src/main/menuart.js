// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
// Custom main menu background for Dauntless 1.6.2.
// The start/login screen shows the Hunt Pass season's LoginTexture (2048x1024, BC7, 12 mips). For a custom picture we
// take one season's login texture from the player's own game files (Myth & Legend, season 08a, only used there), put
// the picture into it at the same size and format, and write a small mod pak next to the game's paks. The menu
// background setting then picks season 08a. Nothing from the game is shipped with the launcher, and removing the pak
// puts everything back. Pak index/entry layout as in UE 4.25 (pak version 9, unencrypted, uncompressed entries).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PAK_MAGIC = 0x5A6F12E1;
const TEMPLATE = 'UI/Textures/HuntpassRewards/2019_Season08a/ui_background_hp08a_loginscreen'; // under Archon/Content/
const MOD_PAK = 'zzzz_DauntlessForever_MenuArt_P.pak';
const WIDTH = 2048, HEIGHT = 1024;

// ------------------------------------------------------------------ reading the game's paks
function readPakIndex(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(512, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let m = -1;
    for (let i = tail.length - 4; i >= 0; i--) if (tail.readUInt32LE(i) === PAK_MAGIC) { m = i; break; }
    if (m < 0) return null;
    const version = tail.readUInt32LE(m + 4);
    const offset = Number(tail.readBigUInt64LE(m + 8)), isz = Number(tail.readBigUInt64LE(m + 16));
    if (tail[m - 1]) return null; // encrypted index
    const idx = Buffer.alloc(isz); fs.readSync(fd, idx, 0, isz, offset);
    let p = 0;
    const fstr = () => {
      const n = idx.readInt32LE(p); p += 4;
      if (n < 0) { const s = idx.toString('utf16le', p, p - 2 * n - 2); p += -2 * n; return s; }
      const s = idx.toString('latin1', p, p + n - 1); p += n; return s;
    };
    const mount = fstr();
    const count = idx.readInt32LE(p); p += 4;
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const name = fstr();
      const e = { offset: Number(idx.readBigUInt64LE(p)), size: Number(idx.readBigUInt64LE(p + 8)), raw: Number(idx.readBigUInt64LE(p + 16)), method: idx.readUInt32LE(p + 24), blocks: [] };
      p += 28 + 20;
      if (e.method) { const nb = idx.readInt32LE(p); p += 4; for (let b = 0; b < nb; b++) { e.blocks.push([Number(idx.readBigUInt64LE(p)), Number(idx.readBigUInt64LE(p + 8))]); p += 16; } }
      e.flags = idx[p]; p += 5;
      entries.set(name, e);
    }
    return { version, mount, entries };
  } finally { fs.closeSync(fd); }
}
function readPakEntry(file, e) {
  if (e.flags & 1) throw new Error('encrypted entry');
  const fd = fs.openSync(file, 'r');
  try {
    if (!e.method) { const out = Buffer.alloc(e.size); fs.readSync(fd, out, 0, e.size, e.offset + 53); return out; }
    const parts = [];
    for (const [a, b] of e.blocks) { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, e.offset + a); parts.push(zlib.inflateSync(buf)); }
    const out = Buffer.concat(parts);
    if (out.length !== e.raw) throw new Error('size mismatch');
    return out;
  } finally { fs.closeSync(fd); }
}
// Finds the template texture (.uasset + .uexp) in the game's own paks.
function findTemplate(gameDir) {
  const paks = path.join(gameDir, 'Archon', 'Content', 'Paks');
  const want = 'Archon/Content/' + TEMPLATE;
  const files = fs.readdirSync(paks).filter(f => /^Archon_UI_\d+-WindowsClient\.pak$/i.test(f)).concat(fs.readdirSync(paks).filter(f => /\.pak$/i.test(f) && !/^Archon_UI_/i.test(f) && f !== MOD_PAK));
  for (const f of files) {
    const full = path.join(paks, f);
    let idx; try { idx = readPakIndex(full); } catch { continue; }
    if (!idx) continue;
    const mount = idx.mount.replace(/^(\.\.\/)+/, '');
    if (!want.startsWith(mount)) continue;
    const rel = want.slice(mount.length);
    const ua = idx.entries.get(rel + '.uasset'), ue = idx.entries.get(rel + '.uexp');
    if (ua && ue) return { uasset: readPakEntry(full, ua), uexp: readPakEntry(full, ue), from: f };
  }
  return null;
}

// ------------------------------------------------------------------ the texture inside the .uexp
// FTexturePlatformData (4.25, cooked): ... FString PixelFormat, int32 FirstMip, int32 NumMips, then per mip:
// int32 bCooked, uint32 BulkDataFlags, int32 ElementCount, int32 SizeOnDisk, int64 Offset, payload, int32 X, Y, Z.
function parseMips(uexp) {
  const tag = Buffer.from('PF_BC7\0', 'latin1');
  const at = uexp.indexOf(tag);
  if (at < 4 || uexp.readInt32LE(at - 4) !== 7) throw new Error('not a BC7 texture');
  let p = at + 7;
  p += 4; // first mip
  const n = uexp.readInt32LE(p); p += 4;
  if (n < 1 || n > 16) throw new Error('unexpected mip count ' + n);
  const mips = [];
  for (let i = 0; i < n; i++) {
    p += 4; // bCooked
    const flags = uexp.readUInt32LE(p); p += 4;
    if (flags & 0x2000) throw new Error('64-bit bulk data not supported');
    const count = uexp.readInt32LE(p); p += 4;
    p += 4 + 8; // size on disk, offset
    const dataAt = p; p += count;
    const x = uexp.readInt32LE(p), y = uexp.readInt32LE(p + 4); p += 12;
    const need = Math.max(1, Math.ceil(x / 4)) * Math.max(1, Math.ceil(y / 4)) * 16;
    if (count !== need) throw new Error(`mip ${i}: ${count} bytes for ${x}x${y}`);
    mips.push({ at: dataAt, size: count, x, y });
  }
  if (mips[0].x !== WIDTH || mips[0].y !== HEIGHT) throw new Error(`template is ${mips[0].x}x${mips[0].y}`);
  return mips;
}

// ------------------------------------------------------------------ BC7 (mode 6: one subset, RGBA 7.7.7.7 + p-bits, 4-bit indices)
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
function encodeBlock(px, out, o) { // px: 16 RGBA (64 bytes)
  // principal axis of the block's colours
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  let crr = 0, cgg = 0, cbb = 0, crg = 0, crb = 0, cgb = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4] - mr, g = px[i * 4 + 1] - mg, b = px[i * 4 + 2] - mb;
    crr += r * r; cgg += g * g; cbb += b * b; crg += r * g; crb += r * b; cgb += g * b;
  }
  let ax = 1, ay = 1, az = 1;
  for (let k = 0; k < 6; k++) {
    const nx = crr * ax + crg * ay + crb * az, ny = crg * ax + cgg * ay + cgb * az, nz = crb * ax + cgb * ay + cbb * az;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz); if (l < 1e-9) break;
    ax = nx / l; ay = ny / l; az = nz / l;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (px[i * 4] - mr) * ax + (px[i * 4 + 1] - mg) * ay + (px[i * 4 + 2] - mb) * az;
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const e0f = [clamp(mr + ax * lo), clamp(mg + ay * lo), clamp(mb + az * lo)];
  const e1f = [clamp(mr + ax * hi), clamp(mg + ay * hi), clamp(mb + az * hi)];
  let best = null;
  for (let p0 = 0; p0 < 2; p0++) for (let p1 = 0; p1 < 2; p1++) {
    const q = (v, p) => { let c = Math.round((v - p) / 2); return c < 0 ? 0 : c > 127 ? 127 : c; };
    const c0 = e0f.map(v => q(v, p0)), c1 = e1f.map(v => q(v, p1));
    const E0 = c0.map(c => (c << 1) | p0), E1 = c1.map(c => (c << 1) | p1);
    const pal = W4.map(w => [0, 1, 2].map(ch => ((64 - w) * E0[ch] + w * E1[ch] + 32) >> 6));
    const idx = new Array(16); let err = 0;
    for (let i = 0; i < 16; i++) {
      let bi = 0, be = Infinity;
      for (let j = 0; j < 16; j++) {
        const dr = px[i * 4] - pal[j][0], dg = px[i * 4 + 1] - pal[j][1], db = px[i * 4 + 2] - pal[j][2];
        const d = dr * dr + dg * dg + db * db; if (d < be) { be = d; bi = j; }
      }
      idx[i] = bi; err += be;
    }
    if (!best || err < best.err) best = { err, c0, c1, p0, p1, idx };
  }
  let { c0, c1, p0, p1, idx } = best;
  if (idx[0] >= 8) { [c0, c1] = [c1, c0]; [p0, p1] = [p1, p0]; idx = idx.map(v => 15 - v); } // anchor index must fit in 3 bits
  // pack 128 bits, LSB first
  const bits = []; const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1 << 6, 7);
  for (let ch = 0; ch < 3; ch++) { put(c0[ch], 7); put(c1[ch], 7); }
  put(127, 7); put(127, 7); // alpha 254 or 255 (the p-bit is shared with the colour); the picture is opaque
  put(p0, 1); put(p1, 1);
  put(idx[0], 3); for (let i = 1; i < 16; i++) put(idx[i], 4);
  for (let b = 0; b < 16; b++) { let v = 0; for (let k = 0; k < 8; k++) v |= bits[b * 8 + k] << k; out[o + b] = v; }
}
function encodeBC7(rgba, w, h) {
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const out = Buffer.alloc(bw * bh * 16); const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const sx = Math.min(w - 1, bx * 4 + x), sy = Math.min(h - 1, by * 4 + y), s = (sy * w + sx) * 4, d = (y * 4 + x) * 4;
      px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = 255;
    }
    encodeBlock(px, out, (by * bw + bx) * 16);
  }
  return out;
}
function halve(rgba, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
    const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1), y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    out[(y * nw + x) * 4 + c] = (rgba[(y0 * w + x0) * 4 + c] + rgba[(y0 * w + x1) * 4 + c] + rgba[(y1 * w + x0) * 4 + c] + rgba[(y1 * w + x1) * 4 + c] + 2) >> 2;
  }
  return { rgba: out, w: nw, h: nh };
}

// ------------------------------------------------------------------ writing the mod pak (version 9, uncompressed)
function makePak(files, mount) {
  const fstring = s => { const b = Buffer.from(s + '\0', 'latin1'); const n = Buffer.alloc(4); n.writeInt32LE(b.length); return Buffer.concat([n, b]); };
  const record = (offset, data) => {
    const b = Buffer.alloc(53);
    b.writeBigUInt64LE(BigInt(offset), 0); b.writeBigUInt64LE(BigInt(data.length), 8); b.writeBigUInt64LE(BigInt(data.length), 16);
    b.writeUInt32LE(0, 24); crypto.createHash('sha1').update(data).digest().copy(b, 28); b[48] = 0; b.writeUInt32LE(0, 49);
    return b;
  };
  const parts = [], rows = []; let off = 0;
  for (const [name, data] of files) { const r = record(off, data); parts.push(r, data); rows.push([name, r]); off += r.length + data.length; }
  const cnt = Buffer.alloc(4); cnt.writeUInt32LE(rows.length);
  const index = Buffer.concat([fstring(mount), cnt, ...rows.flatMap(([n, r]) => [fstring(n), r])]);
  const foot = Buffer.alloc(17 + 4 + 4 + 8 + 8 + 20 + 1 + 160);
  let p = 17; foot.writeUInt32LE(PAK_MAGIC, p); foot.writeUInt32LE(9, p + 4); foot.writeBigUInt64LE(BigInt(off), p + 8); foot.writeBigUInt64LE(BigInt(index.length), p + 16);
  crypto.createHash('sha1').update(index).digest().copy(foot, p + 24); foot[p + 44] = 0; foot.write('Zlib', p + 45, 'latin1');
  return Buffer.concat([...parts, index, foot]);
}

// rgba: Uint8Array of WIDTH x HEIGHT pixels (RGBA). Returns the mod pak.
function buildPak(template, rgba) {
  const uexp = Buffer.from(template.uexp);
  const mips = parseMips(uexp);
  let img = { rgba, w: WIDTH, h: HEIGHT };
  for (let i = 0; i < mips.length; i++) {
    if (i) img = halve(img.rgba, img.w, img.h);
    if (img.w !== mips[i].x || img.h !== mips[i].y) throw new Error(`mip ${i} size`);
    const data = encodeBC7(img.rgba, img.w, img.h);
    if (data.length !== mips[i].size) throw new Error(`mip ${i} length`);
    data.copy(uexp, mips[i].at);
  }
  const base = path.posix.basename(TEMPLATE), dir = path.posix.dirname(TEMPLATE) + '/';
  return makePak([[base + '.uasset', template.uasset], [base + '.uexp', uexp]], '../../../Archon/Content/' + dir);
}
function modPakPath(gameDir) { return path.join(gameDir, 'Archon', 'Content', 'Paks', MOD_PAK); }

// Picture file -> RGBA pixels at WIDTH x HEIGHT, cropped from the centre to 2:1 so nothing is stretched.
function loadPicture(nativeImage, file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error('That file could not be read as a picture (use PNG, JPG or BMP).');
  const { width, height } = img.getSize();
  if (width < 64 || height < 32) throw new Error('That picture is too small.');
  let cw = width, ch = Math.round(width / 2);
  if (ch > height) { ch = height; cw = height * 2; }
  const crop = img.crop({ x: Math.floor((width - cw) / 2), y: Math.floor((height - ch) / 2), width: cw, height: ch });
  const sized = crop.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  const bgra = sized.toBitmap(); // BGRA on Windows
  if (bgra.length !== WIDTH * HEIGHT * 4) throw new Error('The picture could not be resized.');
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
  return { rgba, preview: sized.resize({ width: 512, height: 256, quality: 'good' }).toJPEG(85) };
}

module.exports = { loadPicture, WIDTH, HEIGHT, MOD_PAK, findTemplate, parseMips, encodeBC7, buildPak, modPakPath, readPakIndex, readPakEntry };
