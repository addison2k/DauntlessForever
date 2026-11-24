// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// backup.js (renderer) - DF-BACKUP (Nov 24): Settings > "Back up and restore". The work is done in main/backup.js;
// this file only sends what the player ticked and typed, and never gets a secret back.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.backupCreate) return;
  const $ = (id) => document.getElementById(id);
  const t = window.t || ((s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : String(s)));
  const tm = window.tm || ((s) => (s == null ? '' : String(s)));
  let onOk = null;

  function msg(text, isErr) { const m = $('bak-msg'); m.textContent = text || ''; m.className = 'action-note' + (isErr ? ' err' : ''); }
  function open(title, text, okLabel, okFn) {
    $('bak-title').textContent = title; $('bak-text').textContent = text || ''; $('bak-body').textContent = ''; msg('');
    const ok = $('bak-ok'); ok.hidden = !okLabel; ok.textContent = okLabel || ''; ok.disabled = false; onOk = okFn || null;
    const d = $('dlg-bak'); if (!d.open) d.showModal();
  }
  function close() { const d = $('dlg-bak'); if (d.open) d.close(); onOk = null; try { L.backupDrop(); } catch {} }
  function check(label, on) {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!on;
    const s = document.createElement('span'); s.textContent = label;
    const l = document.createElement('label'); l.className = 'bak-check'; l.append(c, s);
    return { l, c };
  }
  function passBox(label) {
    const wrap = document.createElement('div');
    const l = document.createElement('label'); l.className = 'report-label'; l.textContent = label;
    const line = document.createElement('div'); line.className = 'fr-line';
    const input = document.createElement('input'); input.type = 'password'; input.className = 'fr-input'; input.maxLength = 100; input.autocomplete = 'off'; input.spellcheck = false;
    line.append(input); wrap.append(l, line);
    return { wrap, input };
  }
  function para(text) { const p = document.createElement('p'); p.className = 'setting-sub'; p.style.wordBreak = 'normal'; p.textContent = text; return p; }
  function why(r) {
    const M = {
      'need-ack': 'Tick the box, or type a passphrase.',
      'short-pass': 'The passphrase needs 8 characters or more.',
      'too-big': 'The saves are too big for one backup file.',
      write: 'The file could not be written. Is the stick full or write-protected?',
      'not-backup': 'That file is not a Dauntless Forever backup.',
      damaged: 'That backup is damaged. Nothing was changed.',
      'wrong-pass': 'That passphrase is not right. Nothing was changed.',
      busy: 'Close the game and stop hosting first.',
      nothing: 'Pick the backup file again.',
    };
    const c = r && r.code;
    return c && M[c] ? t(M[c]) : (tm(r && r.error) || t('That did not work.'));
  }

  // ------------------------------------------------------------------ back up
  function openMake() {
    open(t('Back up my saves'), t('This makes one file with your saves from every installed version, your saved builds and your chats. Keep it on a USB stick or copy it to another PC.'), t('Make the backup'), make);
    const inc = check(t('Include my account (name, friends and Infinite character)'), true);
    const warn = para(t('With your account inside, this file is a key to your account and your Infinite character. Never send it to anyone.'));
    const pw = passBox(t('Passphrase for the account part (8 characters or more)'));
    const ack = check(t('No passphrase: I understand that anyone who gets this file can take my account'), false);
    const sync = () => { const on = inc.c.checked; warn.hidden = pw.wrap.hidden = !on; ack.l.hidden = !on || !!pw.input.value; };
    inc.c.onchange = sync; pw.input.oninput = sync; sync();
    $('bak-body').append(inc.l, warn, pw.wrap, ack.l);
    async function make() {
      const id = inc.c.checked, p = id ? pw.input.value : '';
      if (id && !p && !ack.c.checked) return msg(why({ code: 'need-ack' }), true);
      if (id && p && p.length < 8) return msg(why({ code: 'short-pass' }), true);
      $('bak-ok').disabled = true; msg(t('Working...'));
      let r = null; try { r = await L.backupCreate({ identity: id, passphrase: p, unprotectedOk: ack.c.checked }); } catch {}
      $('bak-ok').disabled = false;
      if (r && r.ok) {
        const how = r.identity === 'protected' ? t('yes, protected by your passphrase') : r.identity === 'open' ? t('yes, NOT protected') : t('no');
        open(t('Back up my saves'), '');
        msg(t('Backup saved: {file} ({n} files). Account inside: {how}.', { file: r.file, n: r.files, how }) + (r.skippedId === 'moved' ? ' ' + t('The account was left out because this launcher was moved to another PC.') : ''));
      } else if (r && r.code === 'cancelled') msg('');
      else msg(why(r), true);
    }
  }

  // ------------------------------------------------------------------ restore
  async function openRestore() {
    let r = null; try { r = await L.backupPick(); } catch {}
    if (!r || !r.ok) { if (r && r.code === 'cancelled') return; open(t('Restore from a backup'), ''); msg(why(r), true); return; }
    let d = r.made; try { d = new Date(r.made).toLocaleString(); } catch {}
    open(t('Restore from a backup'), t('Backup from {date}, made by launcher {ver}.', { date: d, ver: r.launcher || '?' }), t('Restore'), go);
    const body = $('bak-body');
    for (const v of r.versions) body.append(para(v.here ? t('{name}: {n} files', { name: v.name, n: v.files }) : t('{name}: {n} files (not installed on this PC, skipped)', { name: v.name, n: v.files })));
    let inc = null, pw = null;
    if (r.identity !== 'none') {
      inc = check(t('Also restore the account in this backup: {name}', { name: r.identityName || '?' }), true);
      body.append(inc.l);
      if (r.identity === 'protected') { pw = passBox(t('Passphrase of the backup')); body.append(pw.wrap); inc.c.onchange = () => { pw.wrap.hidden = !inc.c.checked; }; }
    }
    body.append(para(t('Everything that gets replaced is copied first to the folder backup\\before-restore in the launcher data. Nothing is deleted.')));
    async function go() {
      const id = !!(inc && inc.c.checked);
      if (id && r.current && !r.same) {
        const yes = await confirm(t('Restore this backup?'), t('This PC is {old}. The backup is {new}. The friends list and the Infinite character of {old} stay behind and are not merged.', { old: r.current, new: r.identityName || '?' }));
        if (!yes) return;
      }
      $('bak-ok').disabled = true; msg(t('Working...'));
      let a = null; try { a = await L.backupRestore({ identity: id, passphrase: pw ? pw.input.value : '' }); } catch {}
      if (!a || !a.ok) { $('bak-ok').disabled = false; msg(why(a), true); return; }
      const ID = {
        rotated: 'The account is back, and every other PC that had it is signed out.',
        kept: 'The account is back. The server could not give it a fresh key, so use this account on one PC at a time.',
        dead: 'The account in this backup was moved to another PC after the backup was made, so it was not restored. Use Get my account back.',
        'other-service': 'The account in this backup is for another server, so it was not restored.',
      };
      open(t('Restore from a backup'), '');
      msg(t('Restored {n} files.', { n: a.files }) + (ID[a.identity] ? ' ' + t(ID[a.identity]) : ''), a.identity === 'dead' || a.identity === 'other-service');
      if (a.name) { const el = $('set-name'); if (el) el.textContent = a.name; }
      try { if (typeof fillAccount === 'function') fillAccount(); } catch {}
    }
  }

  function init() {
    if (!$('set-bak-row') || !$('dlg-bak')) return;
    $('set-bak-make').onclick = openMake;
    $('set-bak-restore').onclick = openRestore;
    $('bak-cancel').onclick = close;
    $('bak-ok').onclick = () => { if (onOk) onOk(); };
    $('dlg-bak').addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
