// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// downloader.js - fetches a build from Epic's CDN with manifest.exe (meszmate/manifest, MIT, with the
// uncompressed-chunk fix from the DauntlessManifestArchive repo). Progress is parsed from its progress bar.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IS_WIN, MOCK, bundledToolsDir } = require('./paths');

const BASE_URL = 'https://epicgames-download1.akamaized.net/Builds/Org/o-krlzxj88qrtb69fredeuaf887bl5az/Jackal/default';
const TOOL_SHA256 = 'e7ad5835e927ffb0020f7b0b05cc2bdef025ce94f31984d89ec99df340f6c204';

const active = new Map(); // versionId -> child

function toolPath() { return path.join(bundledToolsDir(), 'manifest.exe'); }
function toolOk() {
  try {
    const h = crypto.createHash('sha256').update(fs.readFileSync(toolPath())).digest('hex');
    return h === TOOL_SHA256;
  } catch { return false; }
}

// onProgress({ pct, done, total, speed, eta, line }) ; resolves { code, failed, summary }
function download(v, outDir, onProgress, onLine) {
  return new Promise((resolve) => {
    if (active.has(v.id)) return resolve({ code: 1, error: 'already downloading' });
    fs.mkdirSync(outDir, { recursive: true });
    if (!IS_WIN) return mockDownload(v, onProgress, onLine, resolve);
    if (!toolOk()) return resolve({ code: 1, error: 'The download tool (tools\\manifest.exe) is missing or damaged. Reinstall the launcher.' });
    const args = ['download', v.download.manifestUrl, '--base-url', BASE_URL, '--output', outDir, '--concurrency', '16'];
    const child = spawn(toolPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active.set(v.id, child);
    let summary = '', failed = null, lastErrLine = '';
    // e.g. "Downloading  45% |████    | (994 MB/12 GB, 272 MB/s) [3s:40s]"  or  "(12/12 GB, 260 MB/s)" (unit once)
    const re = /(\d{1,3})%.*?\(([\d.]+(?:\s*[KMGT]?i?B)?)\s*\/\s*([\d.]+\s*[KMGT]?i?B)(?:,\s*([^)\]]+))?\)(?:\s*\[([^\]]*)\])?/;
    child.stderr.on('data', (d) => {
      const txt = d.toString('utf8');
      for (const piece of txt.split(/[\r\n]+/)) {
        if (!piece.trim()) continue;
        const m = re.exec(piece);
        if (m) {
          let done = m[2].trim(), total = m[3].trim();
          if (!/[A-Za-z]/.test(done)) done += ' ' + total.replace(/^[\d.]+\s*/, '');   // "12/12 GB" -> "12 GB"
          onProgress({ pct: +m[1], done, total, speed: m[4] || '', eta: prettyEta(m[5] || ''), line: piece.trim() });
        }
        else if (/^\s*Downloading\b.*%/.test(piece)) { /* a progress line in a shape we did not expect: not for the log */ }
        else { lastErrLine = piece.trim(); onLine(lastErrLine, /error|fail|denied|cannot|403|404/i.test(piece)); }
      }
    });
    child.stdout.on('data', (d) => {
      const txt = d.toString('utf8'); summary += txt;
      for (const l of txt.split(/\r?\n/)) {
        if (!l.trim()) continue;
        onLine(l.trim(), false);
        const f = /failed:\s*(\d+)/.exec(l); if (f) failed = +f[1];
      }
    });
    child.on('exit', (code) => { active.delete(v.id); resolve({ code: code == null ? 1 : code, failed, summary, lastErrLine }); });
    child.on('error', (e) => { active.delete(v.id); resolve({ code: 1, error: 'Could not start the download tool: ' + e.message }); });
  });
}

// "3s:40s" is the progress bar's "elapsed:remaining"; show only what is left, as plain words
function prettyEta(s) {
  const parts = s.split(':'); const rem = (parts[1] || parts[0] || '').trim();
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(rem.replace(/\s/g, ''));
  if (!m) return rem;
  const h = +m[1] || 0, mi = +m[2] || 0, se = +m[3] || 0;
  if (h) return `${h} h ${mi} min`; if (mi) return `${mi} min`; return `${se} s`;
}
function cancel(id) {
  const c = active.get(id);
  if (!c) return false;
  c.kill(); // partial chunks stay in <outDir>\.manifest-cache; running again resumes
  return true;
}
function isDownloading(id) { return active.has(id); }

function mockDownload(v, onProgress, onLine, resolve) {
  let pct = 0;
  onLine('(mock) manifest download ' + v.download.manifestUrl, false);
  active.set(v.id, { kill() { active.delete(v.id); } });
  const t = setInterval(() => {
    if (!active.has(v.id)) { clearInterval(t); return resolve({ code: 1, failed: null, summary: 'cancelled' }); }
    pct += 7;
    onProgress({ pct: Math.min(pct, 100), done: (v.download.downloadGB * pct / 100).toFixed(2) + ' GB', total: v.download.downloadGB + ' GB', speed: '48 MB/s', eta: Math.max(0, 100 - pct) + 's', line: '' });
    if (pct >= 100) { clearInterval(t); active.delete(v.id); onLine('Download complete in 1m2s', false); onLine('  Chunks:    1234 (skipped: 0, failed: 0)', false); resolve({ code: 0, failed: 0, summary: 'ok' }); }
  }, 400);
}

module.exports = { download, cancel, isDownloading, toolOk, BASE_URL };
