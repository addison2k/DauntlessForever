// Dauntless Forever - launcher tools
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// check-ascii.js - run before every build: the launcher's pages must be plain ASCII. Symbols and emoji the UI font
// does not have fall back to another font (or colour emoji) and render blurry on Windows. Use inline SVG or CSS icons.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
// everything the window shows: its own pages, and the text it reads from the version packages
const files = [];
const add = (d, re) => { try { for (const n of fs.readdirSync(d)) if (re.test(n)) files.push(path.join(d, n)); } catch {} };
add(path.join(root, 'src', 'renderer'), /\.(html|js|css)$/);
for (const v of fs.readdirSync(path.join(root, 'resources', 'versions'))) {
  const vd = path.join(root, 'resources', 'versions', v);
  add(vd, /^version\.json$/);
  add(path.join(vd, 'package'), /^(events|rules|items)\.json$/);
  add(path.join(vd, 'package', 'seasons'), /\.json$/);
  add(path.join(vd, 'package', 'seasons', 'docs'), /\.md$/);
}
let bad = 0;
for (const f of files) {
  fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    const chars = [...new Set([...line].filter(c => c.charCodeAt(0) > 127))];
    if (chars.length) { bad++; console.log(`${path.relative(root, f)}:${i + 1}: ${chars.join(' ')}  (use ASCII text, or an SVG/CSS icon)`); }
  });
}
if (bad) { console.log(`STOPPED: ${bad} line(s) the launcher shows have symbol or emoji characters.`); process.exit(1); }
console.log(`Launcher text: plain ASCII in ${files.length} files, no blurry symbols.`);
