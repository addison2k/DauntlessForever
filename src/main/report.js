// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// report.js - DF-REPORTS (Oct 21): More > "Send my logs". Puts one version's logs into a zip and sends it to the
// friends service with the player's name and what happened (signed like every friends request). The dashboard lists
// the reports for download.
//   In the zip: upload\client_logs.zip and server_logs.zip (made when the game closes; PC name and user name already
//   blanked), the end of every log in the version's logs folder (requests.jsonl too), the end of the launcher's own
//   log, and info.txt (versions, Windows, memory). In the text files the Windows user name and PC name are blanked.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const P = require('./paths');

const ZIP_MAX = 11 * 1024 * 1024;        // the service takes 12 MB
const INNER_ZIP_MAX = 8 * 1024 * 1024;   // client_logs.zip / server_logs.zip bigger than this are left out
const TAIL = 384 * 1024;                 // the end of each log
const TAIL_BIG = 1024 * 1024;            // requests.jsonl, launcher.log
const LOG_EXT = /\.(log|err|txt|jsonl|json)$/i;

// ---- a small zip writer (deflate), no dependencies
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function makeZip(entries) {   // [{ name, data: Buffer, mtime?: Date }]
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const stored = /\.zip$/i.test(e.name);   // a zip inside does not shrink
    const body = stored ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data), t = dosTime(e.mtime || new Date()), method = stored ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(t.time, 10); lh.writeUInt16LE(t.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(t.time, 12); ch.writeUInt16LE(t.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

// ---- reading the logs
function tail(file, max) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, max);
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); return { data: b, cut: st.size > max, mtime: st.mtime }; }
  finally { fs.closeSync(fd); }
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function blanker() {
  const words = [];
  try { const u = os.userInfo().username; if (u && u.length >= 3) words.push([u, 'USER']); } catch {}
  try { const h = os.hostname(); if (h && h.length >= 3) words.push([h, 'PC']); } catch {}
  const res = words.map(([w, to]) => [new RegExp(escRe(w), 'gi'), to]);
  return (buf) => { let s = buf.toString('utf8'); for (const [re, to] of res) s = s.replace(re, to); return Buffer.from(s, 'utf8'); };
}

function collect(v, info) {
  const blank = blanker();
  const entries = [], notes = [];
  const add = (name, data, mtime) => { entries.push({ name, data, mtime }); };
  // 1. the zips the play script made when the game closed
  for (const z of ['client_logs.zip', 'server_logs.zip']) {
    const f = path.join(v.dataDir, 'upload', z);
    try {
      const st = fs.statSync(f);
      if (st.size > INNER_ZIP_MAX) { notes.push(`${z} left out: ${Math.round(st.size / 1048576)} MB`); continue; }
      add('upload/' + z, fs.readFileSync(f), st.mtime);
    } catch { notes.push(`${z}: none yet`); }
  }
  // 2. the end of every log in the logs folder, newest first
  const dir = path.join(v.dataDir, 'logs');
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => LOG_EXT.test(n)).map(n => ({ n, f: path.join(dir, n), st: fs.statSync(path.join(dir, n)) })).filter(x => x.st.isFile() && x.st.size > 0); } catch {}
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const x of files.slice(0, 40)) {
    const big = /^requests\.jsonl$/i.test(x.n);
    try { const t = tail(x.f, big ? TAIL_BIG : TAIL); add('logs/' + x.n, blank(t.data), t.mtime); if (t.cut) notes.push(`logs/${x.n}: only the last ${Math.round((big ? TAIL_BIG : TAIL) / 1024)} KB`); } catch {}
  }
  // 2b. Forever mode lives in its own install (versions\forever): its logs and crash zips come along with a 1.14.7 report
  if (v.id === '1.14.7') {
    const fdir = path.join(P.versionsDataDir(), 'forever');
    let ff = [];
    try { ff = fs.readdirSync(path.join(fdir, 'logs')).filter(n => LOG_EXT.test(n)).map(n => ({ n, f: path.join(fdir, 'logs', n), st: fs.statSync(path.join(fdir, 'logs', n)) })).filter(x => x.st.isFile() && x.st.size > 0); } catch {}
    ff.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    for (const x of ff.slice(0, 30)) {
      const big = /^requests\.jsonl$/i.test(x.n);
      try { const t = tail(x.f, big ? TAIL_BIG : TAIL); add('forever/logs/' + x.n, blank(t.data), t.mtime); } catch {}
    }
    for (const z of ['client_logs.zip', 'server_logs.zip']) {
      const zf = path.join(fdir, 'upload', z);
      try { const st = fs.statSync(zf); if (st.size <= INNER_ZIP_MAX) add('forever/upload/' + z, fs.readFileSync(zf), st.mtime); } catch {}
    }
    if (ff.length) notes.push(`Forever mode logs included (${Math.min(30, ff.length)} files)`);
  }
  // 3. the launcher's own log
  try { const t = tail(P.launcherLog(), TAIL_BIG); add('launcher.log', blank(t.data), t.mtime); } catch {}
  // 4. info.txt
  const lines = [
    `Version: ${v.id}`, `Server files: ${info.pkg || '?'}`, `Launcher: ${info.launcher || '?'}`,
    `Windows: ${os.release()} ${os.arch()}`, `Memory: ${Math.round(os.totalmem() / 1073741824)} GB (${Math.round(os.freemem() / 1073741824)} GB free)`,
    `CPU: ${(os.cpus()[0] || {}).model || '?'} x${os.cpus().length}`, `Sent: ${new Date().toString()}`,
    '', ...notes, ...((info && info.extra) || []),   // DF-AVGUARD: antivirus and server-file lines from main.js
  ];
  entries.unshift({ name: 'info.txt', data: blank(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')), mtime: new Date() });
  // too big: drop the largest log tails until it fits (the two zips go last)
  let zip = makeZip(entries);
  while (zip.length > ZIP_MAX && entries.length > 1) {
    let i = -1, best = -1;
    entries.forEach((e, k) => { if (k && !/^upload\//.test(e.name) && e.data.length > best) { best = e.data.length; i = k; } });
    if (i < 0) i = entries.findIndex((e, k) => k && /^upload\//.test(e.name));
    if (i < 0) break;
    entries.splice(i, 1);
    zip = makeZip(entries);
  }
  return { zip, files: entries.length };
}

module.exports = { collect, makeZip };
