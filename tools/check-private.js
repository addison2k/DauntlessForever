// Dauntless Forever - launcher tools
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// check-private.js - DF-PRIVATE (Oct 31): nothing that is pushed or shipped may carry a private word: tool and assistant
// names, co-author lines, the private module, DLL, data file and route names, and anything added to the list later.
// The words live ONLY in wip\private-words.txt (never committed: a public list of private names would give them away).
// Every file is read as raw bytes - images, DLLs and paks too (a text-only check once let image metadata through) - and
// UTF-16 text inside binaries is matched as well. Words shorter than 5 letters are matched as whole words in text files
// only: in compressed game data any 3 letters turn up by chance. Hidden metadata blocks in .jpg/.png files (content
// credentials, text chunks) are cut out on the spot - the picture itself is not touched - and the build stops so the
// cleaned files can be committed.
//   node tools/check-private.js                  the files that ship + every tracked file (npm run dist / dist:dir)
//   node tools/check-private.js --asar <file>    a finished app-<ver>.asar (release-launcher.ps1)
//   node tools/check-private.js --text "<text>"  release notes and the like
//   node tools/check-private.js --msg <file>     a commit message (.git/hooks/commit-msg)
//   node tools/check-private.js --push <old> <new>   every commit message and file about to be pushed (.git/hooks/pre-push)
// DF_PRIVATE_WORDS=<file> uses another list; DF_PRIVATE_SKIP=1 skips the check once when the list is missing.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const root = path.join(__dirname, '..');
const WORDS_FILE = process.env.DF_PRIVATE_WORDS || path.join(root, 'wip', 'private-words.txt');
const TEXT_EXT = /\.(js|cjs|mjs|ts|json|html?|css|md|txt|ps1|psm1|bat|cmd|sh|ini|cfg|xml|ya?ml|patch|csv|lua|svg|env)$/i;
const IMG_EXT = /\.(jpe?g|png)$/i;
const SKIP_DIR = /^(wip|dist|node_modules|_wip_launcher|_wip1147|_kit|_kit2|_to_delete)\//;
const CREDENTIALS = /c2pa|jumbf|contentauth|content credentials/i;   // what image content-credential blocks carry
const say = (t) => console.log(t);
const stop = (t) => { say('STOPPED: ' + t); process.exit(1); };

function loadWords() {
  let raw;
  try { raw = fs.readFileSync(WORDS_FILE, 'utf8'); }
  catch {
    if (process.env.DF_PRIVATE_SKIP === '1') { say('Private words: check skipped once (DF_PRIVATE_SKIP=1).'); process.exit(0); }
    stop(`the private word list (${path.relative(root, WORDS_FILE)}) is missing. Put it back - one word per line - or run once with DF_PRIVATE_SKIP=1.`);
  }
  const words = raw.replace(/^﻿/, '').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
  if (!words.length) stop('the private word list is empty.');
  return words;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchers(words) {
  const long = words.filter(w => w.length >= 5), short = words.filter(w => w.length < 5);
  const wide = (w) => [...w].map(esc).join('\\x00?');   // "abc" also as "a\0b\0c" (UTF-16 strings in DLLs and exes)
  // a word only counts where a word starts: not in the middle of a longer name (Node's own hkdfSync is not a private
  // name). The end stays open, so a private prefix (name_snapshot_, nameClient...) is still caught.
  const start = '(?<![a-z0-9]\\x00?)';
  return {
    bin: long.length ? new RegExp(long.map(w => start + wide(w)).join('|'), 'i') : null,
    text: new RegExp([...long.map(w => start + esc(w)), ...short.map(w => `${start}${esc(w)}(?![a-z0-9])`)].join('|'), 'i'),
    hash: crypto.createHash('sha1').update(words.join('\n')).digest('hex').slice(0, 12),
  };
}
// the private word found in this data ('' = clean)
function scan(buf, name, M) {
  if (TEXT_EXT.test(name)) { const m = M.text.exec(buf.toString('utf8')); if (m) return m[0]; }
  if (M.bin) { const m = M.bin.exec(buf.toString('latin1')); if (m) return m[0].replace(/\x00/g, ''); }
  return '';
}
const metaHit = (s, M) => CREDENTIALS.test(s) || (M.bin && M.bin.test(s)) || M.text.test(s);

// ---------------------------------------------------------------- image metadata (the picture data is copied byte for byte)
// JPEG: APP11 (content credentials) always goes; other metadata segments (APP1 EXIF/XMP, APP3-13, APP15, comments) go
// when they carry a private word or a credentials marker. APP0 (JFIF), APP2 (colour profile) and APP14 (Adobe) stay.
function cleanJpeg(b, M) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out = [b.subarray(0, 2)]; let i = 2, cut = 0;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break;                          // image data starts: everything from here is kept as is
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    const L = b.readUInt16BE(i + 2), seg = b.subarray(i, i + 2 + L);
    const meta = m === 0xe1 || (m >= 0xe3 && m <= 0xed) || m === 0xef || m === 0xfe;
    if (meta && (m === 0xeb || metaHit(seg.toString('latin1'), M))) cut += seg.length; else out.push(seg);
    i += 2 + L;
  }
  out.push(b.subarray(i));
  return cut ? Buffer.concat(out) : null;
}
// PNG: text chunks (tEXt, zTXt, iTXt), EXIF (eXIf) and content credentials (caBX) are metadata only: they always go.
function cleanPng(b) {
  if (b.length < 8 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const out = [b.subarray(0, 8)]; let i = 8, cut = 0;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.subarray(i + 4, i + 8).toString('latin1'), end = i + 12 + len;
    if (end > b.length) break;
    const chunk = b.subarray(i, end);
    if (/^(tEXt|zTXt|iTXt|eXIf|caBX)$/.test(type)) cut += chunk.length; else out.push(chunk);
    i = end; if (type === 'IEND') break;
  }
  if (i < b.length) out.push(b.subarray(i));
  return cut ? Buffer.concat(out) : null;
}

// ---------------------------------------------------------------- the files that ship, and every tracked file
function treeFiles() {
  const set = new Set();
  try { cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean).forEach(f => set.add(f)); } catch {}
  const walk = (rel) => {
    let ents; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const r = rel + '/' + e.name; if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(r); } else set.add(r); }
  };
  for (const d of ['src', 'resources', 'build']) walk(d);                     // electron-builder ships these (tracked or not)
  for (const f of ['package.json', 'packages.json', 'supporters.json', 'network.json']) if (fs.existsSync(path.join(root, f))) set.add(f);
  return [...set].map(f => f.replace(/\\/g, '/')).filter(f => !SKIP_DIR.test(f));
}
function checkTree() {
  const M = matchers(loadWords());
  const cacheFile = path.join(root, 'dist', '.private-check.json');           // unchanged files are not read again
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (cache._words !== M.hash) cache = {}; } catch {}
  const hits = [], cleaned = []; let n = 0;
  for (const f of treeFiles()) {
    const full = path.join(root, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const key = st.size + '|' + st.mtimeMs;
    if (cache[f] === key) continue;
    let buf = fs.readFileSync(full); n++;
    if (IMG_EXT.test(f)) {
      const c = /\.png$/i.test(f) ? cleanPng(buf) : cleanJpeg(buf, M);
      if (c) { fs.writeFileSync(full, c); cleaned.push(f); buf = c; }
    }
    const w = scan(buf, f, M);
    if (w) hits.push(`${f}: "${w}"`);
    else { const s2 = fs.statSync(full); cache[f] = s2.size + '|' + s2.mtimeMs; }
  }
  cache._words = M.hash;
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
  if (cleaned.length) say('Hidden metadata removed from: ' + cleaned.join(', ') + ' (picture unchanged).');
  if (hits.length) { hits.forEach(h => say('  ' + h)); stop(`${hits.length} file(s) contain a private word (above). Nothing was built.`); }
  if (cleaned.length) stop(`commit the cleaned image(s) with the release (git add ${cleaned.join(' ')}), then build again.`);
  say(`Private words: none in what ships (${n} file(s) read, the rest unchanged since the last check).`);
}

// ---------------------------------------------------------------- a finished update file
function checkAsar(file) {
  const M = matchers(loadWords());
  if (!fs.existsSync(file)) stop(`${file} is not there.`);
  let asar = null; try { asar = require(require.resolve('@electron/asar', { paths: [root] })); } catch {}
  const hits = [];
  if (asar) {
    for (const p of asar.listPackage(file)) {
      const rel = p.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      let buf; try { buf = asar.extractFile(file, rel); } catch { continue; }   // folders
      if (!Buffer.isBuffer(buf)) continue;
      const w = scan(buf, rel, M);
      if (w) hits.push(`${rel}: "${w}"`);
    }
  } else {
    const w = M.bin && (M.bin.exec(fs.readFileSync(file).toString('latin1')) || [''])[0].replace(/\x00/g, '');
    if (w) hits.push(`${path.basename(file)}: "${w}"`);
  }
  if (hits.length) { hits.forEach(h => say('  ' + h)); stop(`the update file contains a private word (above).`); }
  say(`Private words: none in ${path.basename(file)}.`);
}

// ---------------------------------------------------------------- text, commit messages, a push
function checkText(t, what) {
  const M = matchers(loadWords());
  const m = M.text.exec(t) || (M.bin && M.bin.exec(t));
  if (m) stop(`${what} contains the private word "${m[0].replace(/\x00/g, '')}".`);
}
function git(args, input) { return cp.execFileSync('git', args, { cwd: root, input, maxBuffer: 1 << 30 }); }
function checkPush(oldSha, newSha) {
  const M = matchers(loadWords());
  const zero = /^0+$/.test(oldSha || '');
  const range = zero ? [newSha, '--not', '--remotes'] : [`${oldSha}..${newSha}`];
  const commits = git(['rev-list', ...range]).toString().split('\n').filter(Boolean);
  const hits = [];
  for (const c of commits) {
    const msg = git(['log', '-1', '--format=%B', c]).toString();
    const m = M.text.exec(msg) || (M.bin && M.bin.exec(msg));
    if (m) hits.push(`commit ${c.slice(0, 8)} message: "${m[0]}"`);
  }
  const objs = git(['rev-list', '--objects', ...range]).toString().split('\n').map(l => l.split(' ')).filter(x => x.length >= 2 && x[0]);
  if (objs.length) {
    const out = git(['cat-file', '--batch'], objs.map(x => x[0]).join('\n') + '\n');
    let i = 0;
    for (const [, ...nameParts] of objs) {
      const nl = out.indexOf(10, i); const hdr = out.subarray(i, nl).toString().split(' ');
      const size = Number(hdr[2]) || 0; const data = out.subarray(nl + 1, nl + 1 + size); i = nl + 1 + size + 1;
      if (hdr[1] !== 'blob') continue;
      const name = nameParts.join(' ');
      const w = scan(data, name, M) || (IMG_EXT.test(name) && CREDENTIALS.test(data.toString('latin1')) ? 'image credentials block' : '');
      if (w) hits.push(`${name}: "${w}"`);
    }
  }
  if (hits.length) { hits.forEach(h => say('  ' + h)); stop(`${hits.length} private word(s) in what you are pushing (above). Nothing was pushed.`); }
  say(`Private words: none in ${commits.length} commit(s) being pushed.`);
}

const [mode, a, b] = process.argv.slice(2);
if (!mode) checkTree();
else if (mode === '--asar') checkAsar(path.resolve(a || ''));
else if (mode === '--text') { checkText(String(a || ''), 'the text'); say('Private words: none in the text.'); }
else if (mode === '--msg') checkText(fs.readFileSync(a, 'utf8').split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n'), 'the commit message');
else if (mode === '--push') checkPush(a, b);
else stop('unknown option ' + mode);
