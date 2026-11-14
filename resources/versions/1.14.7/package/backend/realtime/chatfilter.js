// DF-CHATFILTER-1147: a word list for the in-game chat (rooms and whispers) and for player names.
// A message that matches the list is shown to its sender only ("shadowed"): nobody else gets it, and the sender
// is not told, so the list cannot be probed word by word. Three matches in ten minutes mute that player's chat
// for ten minutes (also shadowed). Every match is one log line with the player's id, never the message text.
//
// The list is plain text, one entry per line, '#' starts a comment:
//     word        matches the whole word, also written with digits or symbols for letters (w0rd, w.o.r.d, wooord)
//     *word       matches anywhere, also inside a longer word. Use only for words that are never innocent.
//     two words   a phrase: the words in that order
// Files, both optional, read again within 5 seconds of a change (no restart):
//     <backend>\realtime\chat-blocklist.default.txt   shipped with the server files
//     <data>\chat-blocklist.txt                        the server owner's own additions
//     <data>\chat-allowlist.txt                        words that must never match (one per line)
// CHAT_FILTER=off turns it off, CHAT_FILTER=log only logs (nothing is hidden), anything else: on.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '\u20ac': 'e', '\u00a3': 'l' };
const STRIKES = 3, STRIKE_WINDOW_MS = 10 * 60 * 1000, MUTE_MS = 10 * 60 * 1000;

let files = { base: path.join(__dirname, 'chat-blocklist.default.txt'), own: '', allow: '' };
let lists = { words: new Map(), anywhere: [], phrases: [], glued: [], allow: new Set(), count: 0, stamp: '' };
let lastLook = 0;
const strikes = new Map();   // uid -> { times: [], mutedUntil }

function Mode() {
  const v = (process.env.CHAT_FILTER || '').trim().toLowerCase();
  return v === 'off' || v === '0' ? 'off' : v === 'log' ? 'log' : 'on';
}
function Configure(opts) {
  if (opts && typeof opts.dataDir === 'string' && opts.dataDir) {
    files.own = path.join(opts.dataDir, 'chat-blocklist.txt');
    files.allow = path.join(opts.dataDir, 'chat-allowlist.txt');
  }
  if (opts && typeof opts.baseFile === 'string') files.base = opts.baseFile;
  lastLook = 0; lists.stamp = '';
}
// lower case, accents off, look-alike digits and symbols turned into letters
function fold(text) {
  const chars = [...String(text || '').normalize('NFKD').toLowerCase()].filter((ch) => { const c = ch.codePointAt(0); return !(c >= 0x300 && c <= 0x36f); });
  const inWord = (ch) => ch !== undefined && /[\p{L}\p{N}@$]/u.test(ch);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // '!' and '|' stand for a letter only inside a word (b!g), not at its end (big!)
    if ((ch === '!' || ch === '|') && !(inWord(chars[i - 1]) && inWord(chars[i + 1]))) { out += ' '; continue; }
    out += LEET[ch] !== undefined ? LEET[ch] : ch;
  }
  return out;
}
const squeeze = (word) => word.replace(/(.)\1+/g, '$1');            // wooord -> word
const lettersOnly = (text) => text.replace(/[^\p{L}]+/gu, '');
// A listed word as a pattern: every letter may be stretched (wooord) but never shortened, so "coon" does not
// match "con" and "nigger" does not match "Niger" or "Nigeria".
function patternOf(word) {
  let out = '';
  for (const run of word.match(/(.)\1*/gu) || []) out += run[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (run.length > 1 ? `{${run.length},}` : '+');
  return out;
}
// words of a text as typed (folded, not squeezed); runs of single letters ("w o r d", "w.o.r.d") are joined into one more word
function wordsOf(folded) {
  const parts = folded.split(/[^\p{L}]+/u).filter(Boolean);
  const out = parts.slice();
  let run = '';
  for (const p of parts.concat([''])) {
    if (p.length === 1) { run += p; continue; }
    if (run.length >= 3) out.push(run);
    run = '';
  }
  return out;
}
function stampOf(file) { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } }
function linesOf(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean); } catch { return []; }
}
function wordsOfEntry(raw) { return fold(raw).split(/[^\p{L}]+/u).filter(Boolean); }
function reload(now) {
  if (now - lastLook < 5000) return;
  lastLook = now;
  const stamp = [files.base, files.own, files.allow].map((f) => (f ? stampOf(f) : '-')).join('|');
  if (stamp === lists.stamp) return;
  const next = { words: new Map(), anywhere: [], phrases: [], glued: [], allow: new Set(), count: 0, stamp };
  const seen = new Set();
  for (const raw of [...linesOf(files.base), ...(files.own ? linesOf(files.own) : [])]) {
    const any = raw.startsWith('*');
    const ws = wordsOfEntry(any ? raw.slice(1) : raw);
    const id = (any ? '*' : '') + ws.join(' ');
    if (!ws.length || seen.has(id)) continue;
    seen.add(id); next.count++;
    if (any) { const w = ws.join(''); if (w.length >= 4) next.anywhere.push({ entry: w, re: new RegExp(patternOf(w), 'u') }); }   // short "anywhere" entries would hit innocent words
    else if (ws.length === 1) {
      const w = ws[0], key = squeeze(w);
      if (!next.words.has(key)) next.words.set(key, []);
      next.words.get(key).push({ entry: w, re: new RegExp('^' + patternOf(w) + '$', 'u') });
    }
    else next.phrases.push({ entry: ws.join(' '), res: ws.map((w) => new RegExp('^' + patternOf(w) + '$', 'u')) });
  }
  // names: listed words of 5 letters or more also match glued into a longer name; a plural of a shorter listed word
  // does not count (its singular is too short to be safe inside names: "coons" would hit "Raccoons")
  const single = new Set(); for (const hits of next.words.values()) for (const h of hits) single.add(h.entry);
  for (const w of single) {
    if (w.length < 5) continue;
    const bases = [w.endsWith('ies') ? w.slice(0, -3) + 'y' : '', w.endsWith('es') ? w.slice(0, -2) : '', w.endsWith('s') ? w.slice(0, -1) : ''].filter(Boolean);
    if (bases.some((b) => b.length < 5 && single.has(b))) continue;
    next.glued.push({ entry: w, re: new RegExp(patternOf(w), 'u') });
  }
  if (files.allow) for (const raw of linesOf(files.allow)) for (const w of wordsOfEntry(raw)) next.allow.add(squeeze(w));
  lists = next;
  try { require('../logger').logger.info(`chat: word list loaded, ${next.count} entries (${next.anywhere.length} anywhere, ${next.phrases.length} phrases), ${next.allow.size} allowed`); } catch { /* tests */ }
}
function listedWord(w) {
  const hits = lists.words.get(squeeze(w));
  if (hits) for (const h of hits) if (h.re.test(w)) return h.entry;
  return null;
}

// The list entry a text matches, or null. Never returns or logs the text itself.
function Match(text, now = Date.now()) {
  reload(now);
  if (!lists.count) return null;
  const words = wordsOf(fold(text)).filter((w) => !lists.allow.has(squeeze(w)));
  for (const w of words) {
    const hit = listedWord(w);
    if (hit) return hit;
    // plural and common endings on a listed word
    for (const end of ['s', 'z', 'es', 'ed', 'er', 'ers', 'ing', 'y']) if (w.length > end.length + 2 && w.endsWith(end)) { const base = listedWord(w.slice(0, -end.length)); if (base) return base; }
  }
  if (lists.anywhere.length) {
    const flat = lettersOnly(words.join(' '));
    for (const a of lists.anywhere) if (a.re.test(flat)) return a.entry;
  }
  for (const ph of lists.phrases) {
    for (let i = 0; i + ph.res.length <= words.length; i++) { let ok = true; for (let j = 0; j < ph.res.length; j++) if (!ph.res[j].test(words[i + j])) { ok = false; break; } if (ok) return ph.entry; }
  }
  return null;
}
// Player and character names: the same list, and single listed words of 5 letters or more also match when they are
// glued into a longer name (xXwordXx). Returns the entry or null.
function MatchName(name, now = Date.now()) {
  const hit = Match(name, now);
  if (hit) return hit;
  const flat = lettersOnly(fold(name));
  if (lists.allow.has(squeeze(flat))) return null;
  for (const g of lists.glued) if (g.re.test(flat)) return g.entry;
  return null;
}
// { hide: true|false, reason: 'word'|'muted'|null, entry }. Call once per message, after the size and rate checks.
function Check(uid, text, now = Date.now()) {
  const mode = Mode();
  if (mode === 'off') return { hide: false, reason: null, entry: null };
  let s = strikes.get(uid);
  if (s && s.mutedUntil > now) return { hide: mode === 'on', reason: 'muted', entry: null };
  const entry = Match(text, now);
  if (!entry) return { hide: false, reason: null, entry: null };
  if (!s) { s = { times: [], mutedUntil: 0 }; strikes.set(uid, s); }
  s.times = s.times.filter((t) => now - t < STRIKE_WINDOW_MS); s.times.push(now);
  let muted = false;
  if (s.times.length >= STRIKES) { s.mutedUntil = now + MUTE_MS; s.times = []; muted = true; }
  if (strikes.size > 5000) for (const [k, v] of strikes) if (v.mutedUntil < now && !v.times.some((t) => now - t < STRIKE_WINDOW_MS)) strikes.delete(k);
  return { hide: mode === 'on', reason: 'word', entry, muted };
}
function IsMuted(uid, now = Date.now()) { const s = strikes.get(uid); return !!(s && s.mutedUntil > now); }
function Unmute(uid) { strikes.delete(uid); }
function ResetForTest() { strikes.clear(); lastLook = 0; lists = { words: new Map(), anywhere: [], phrases: [], glued: [], allow: new Set(), count: 0, stamp: '' }; }

module.exports = { Configure, Check, Match, MatchName, IsMuted, Unmute, Mode, ResetForTest };
