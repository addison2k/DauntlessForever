// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// account.js (renderer) - DF-LINK (Nov 24): Settings > "Discord and moving PCs". Link Discord, show a move code,
// get an account back with Discord or a move code. The work is done in main/account.js; this file never sees a
// secret. The row shows only when the Friends service says it has the routes (state.link), or once this launcher
// was moved away.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.accountLink || !L.socialState) return;
  const $ = (id) => document.getElementById(id);
  const t = window.t || ((s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : String(s)));
  const tm = window.tm || ((s) => (s == null ? '' : String(s)));
  let S = null, codeTimer = null, waiting = false, onCancel = null;

  // what main/account.js answers when something did not work: { ok: false, code, triesLeft?, error? }
  function why(r) {
    const c = r && r.code;
    if (c === 'wrong') return r.triesLeft == null ? t('That name or code is not right.') : t('That name or code is not right ({n} tries left).', { n: r.triesLeft });
    const M = {
      secure: 'This network blocks the secure connection, so this cannot be done here. Try another network.',
      'no-account': 'No Dauntless Forever account is linked to that Discord account.',
      banned: 'That account cannot be moved or recovered.',
      expired: 'That code has run out, or this took too long. Start again.',
      timeout: 'That took too long. Start again.',
      'bad-verifier': 'That took too long. Start again.',
      'too-many': 'Too many tries. Wait an hour and try again.',
      locked: 'Too many wrong tries. Make a new code on the old PC.',
      'discord-not-set': 'Discord sign-in is not set up on the server yet.',
      'not-available': 'This is not available yet.',
      'bad-url': 'The server sent an address that is not Discord, so it was not opened.',
      cancelled: 'Cancelled.',
      busy: 'Close the game and stop hosting first.',
      'busy-flow': 'A Discord sign-in is already open. Finish it or press Cancel.',
      'offline-mode': 'Offline Forever mode is on (Settings). Turn it off first.',
      'not-signed-in': 'This launcher is not signed in to the friends service yet. Try again in a moment.',
      moved: 'This launcher was moved to another PC. Use Get my account back.',
      'bad-account': 'Type the account name with its number, like slayer77#1234.',
      'bad-code': 'The code is 6 digits.',
      confirm: 'The move did not finish. Nothing was changed. Try again.',
      write: 'The account files could not be written. Nothing was changed.',
      nothing: 'That took too long. Start again.',
    };
    if (c && M[c]) return t(M[c]);
    return tm(r && r.error) || t('That did not work.');
  }
  const REFUSED = 'Your Infinite character could not be stored with this account. Send your logs and it will be fixed by hand.';

  // ------------------------------------------------------------------ the Settings row
  function note(text, isErr) { const n = $('set-link-note'); if (!n) return; n.textContent = text || ''; n.className = 'setting-sub' + (isErr ? ' link-err' : ''); }
  function render() {
    const row = $('set-link-row'); if (!row) return;
    const link = S && S.link, moved = S && S.moved;
    try { const me = document.querySelector('.fp-me'); if (me) me.style.display = moved ? 'none' : ''; } catch {}   // not "Signed in as" above the moved line
    try { const sl = $('side-linked'); if (sl) { const dn = !moved && link && link.discordName; sl.hidden = !dn; sl.textContent = dn ? t('Discord: linked as {name}', { name: link.discordName }) : ''; } } catch {}
    row.hidden = !S || S.offlineMode || !(link || moved);
    if (row.hidden) return;
    const sub = $('set-link'), bd = $('set-link-discord'), bm = $('set-link-move');
    if (moved) {
      let d = ''; try { d = new Date(moved).toLocaleDateString(); } catch {}
      sub.textContent = t('This launcher was moved to another PC on {date}. Use Get my account back to use it here again.', { date: d });
      bd.hidden = !S.knownPc; bm.hidden = true;
      if (S.knownPc) { bd.textContent = t('Use it here'); sub.textContent = t('This account is in use on your other PC. Press Use it here to switch to this PC; the other PC is signed out of it.'); }   // DF-LINK2
    } else {
      bd.hidden = false; bm.hidden = false;
      bd.textContent = link.discordName ? t('Unlink') : t('Link Discord');
      sub.textContent = !link.discordName ? t('Not linked. Link Discord so a new PC or a fresh Windows gets your name, friends and Infinite character back.')
        : link.playerId ? t('Linked to {name}. After a format or on a new PC, use Get my account back and sign in with Discord.', { name: link.discordName })
          : t('Linked to {name}. Play Infinite once so your character is stored with the link.', { name: link.discordName });
    }
    const bo = $('set-link-others'); if (bo) { bo.hidden = !!moved || !(link && link.devices > 1); bo.disabled = waiting; }
    bd.disabled = bm.disabled = $('set-link-back').disabled = waiting;
  }
  async function refresh() { try { S = await L.socialState(); } catch {} render(); }

  // ------------------------------------------------------------------ one box for every step
  function box(o) {
    clearInterval(codeTimer); codeTimer = null;
    $('link-title').textContent = o.title || '';
    $('link-text').textContent = o.text || '';
    $('link-code-box').hidden = !o.code;
    $('link-form').hidden = !o.form;
    const msg = $('link-msg'); msg.textContent = o.msg || ''; msg.className = 'action-note' + (o.err ? ' err' : '');
    const b1 = $('link-b1'), ok = $('link-ok'), no = $('link-cancel');
    b1.hidden = !o.b1; if (o.b1) { b1.textContent = o.b1[0]; b1.onclick = o.b1[1]; }
    ok.hidden = !o.ok; if (o.ok) { ok.textContent = o.ok[0]; ok.onclick = o.ok[1]; ok.disabled = false; }
    no.textContent = o.cancel ? t('Cancel') : t('Close');
    onCancel = o.onCancel || null;
    const d = $('dlg-link'); if (!d.open) d.showModal();
  }
  function closeBox() { clearInterval(codeTimer); codeTimer = null; const d = $('dlg-link'); const f = onCancel; onCancel = null; if (d.open) d.close(); if (f) f(); }
  function say(title, text, isErr) { box({ title, msg: text, err: isErr }); }

  // ------------------------------------------------------------------ link and unlink
  const WRONG_BROWSER = 'Wrong browser? Copy the link and paste it into the one where you use Discord.';
  async function copyLink() {
    let r = null; try { r = await L.accountCopyUrl(); } catch {}
    const m = $('link-msg'); if (!m || !waiting) return;
    m.textContent = r && r.ok ? t('Copied. Paste it into the browser where you are signed in to Discord.') : t('The link is not ready yet. Try again in a moment.');
  }
  // DF-LINK2: a known PC takes the account back with one button, no browser
  async function useHere() {
    waiting = true; render();
    box({ title: t('Use it here'), text: t('Moving the account here...') });
    const a = await L.accountResume();
    waiting = false;
    if (a && a.ok) say(t('Use it here'), t('Done. This PC is {name} now.', { name: a.name }), false);
    else say(t('Use it here'), a && a.code === 'not-known' ? t('This PC is not known to the account any more. Use Get my account back and sign in with Discord.') : why(a), true);
    refresh(); try { if (typeof fillAccount === 'function') fillAccount(); } catch {}
  }
  async function signOutOthers() {
    const yes = await confirm(t('Sign out my other PCs?'), t('Your other PCs will have to sign in with Discord again before they can use this account.'));
    if (!yes) return;
    const r = await L.accountClearOthers();
    note(r && r.ok ? t('Your other PCs are signed out.') : why(r), !(r && r.ok));
    refresh();
  }
  async function linkDiscord() {
    if (S && S.moved && S.knownPc) return useHere();
    if (S && S.link && S.link.discordName) {
      const yes = await confirm(t('Unlink Discord?'), t('After this, a new PC or a fresh Windows cannot get this account back with Discord. You can link again at any time.'));
      if (!yes) return;
      const r = await L.accountUnlink();
      note(r && r.ok ? t('Discord is not linked any more.') : why(r), !(r && r.ok));
      return refresh();
    }
    waiting = true; render();
    box({ title: t('Link Discord'), msg: t(WRONG_BROWSER), b1: [t('Copy the link'), copyLink], text: t('Your browser is open: sign in at Discord, then come back here. Waiting...'), cancel: true, onCancel: () => { L.accountCancel(); } });
    const r = await L.accountLink();
    waiting = false; onCancel = null;
    if (r && r.ok) {
      let text = r.replaced ? t('That Discord account was linked to {old}. It is linked to this launcher now.', { old: r.replaced }) : t('Discord is linked as {name}.', { name: r.discordName });
      if (r.playerIdRefused) text += ' ' + t(REFUSED);
      say(t('Link Discord'), text, false); note('');
    } else if (r && r.code === 'cancelled') closeBox();
    else say(t('Link Discord'), why(r), true);
    refresh();
  }

  // ------------------------------------------------------------------ move to another PC (this PC shows the code)
  function openMove() {
    const name = S && S.name ? S.name : '';
    box({ title: t('Move to another PC'),
      text: t('This shows a 6-digit code for 10 minutes. Type it into the launcher on the other PC: Settings, then Get my account back. This PC stops working as {name} once the other PC has taken over. Formatting Windows? A code cannot help after that: link Discord first.', { name }),
      ok: [t('Show my code'), showCode] });
  }
  async function showCode() {
    $('link-ok').disabled = true;
    const r = await L.accountMoveCode();
    if (!r || !r.ok) { box({ title: t('Move to another PC'), msg: r && r.code === 'too-many' ? t('This account has already made 3 move codes today. Try again tomorrow.') : why(r), err: true, ok: [t('Show my code'), showCode] }); return; }
    box({ title: t('Move to another PC'), text: t('On the other PC, type this name and this code:'), code: true,
      msg: t('Never give this code to anyone. Dauntless Forever staff will never ask for it.') + (r.playerIdRefused ? ' ' + t(REFUSED) : '') });
    $('link-acct').textContent = r.account; $('link-code').textContent = r.code.slice(0, 3) + ' ' + r.code.slice(3);
    const until = Date.now() + r.expiresIn * 1000;
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $('link-left').textContent = t('{m} min {s} s left', { m: Math.floor(s / 60), s: s % 60 });
      if (s <= 0) { clearInterval(codeTimer); codeTimer = null; box({ title: t('Move to another PC'), msg: t('The code has run out. Show a new one if you still need it.'), ok: [t('Show my code'), showCode] }); }
    };
    tick(); codeTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------------------ get my account back (this PC takes over)
  function openBack() {
    box({ title: t('Get my account back'),
      text: t('Used Dauntless Forever before, on another PC or before a fresh Windows? Bring that account here: your name, your friends and your Infinite character.'),
      b1: [t('I have a move code'), codeForm], ok: [t('Sign in with Discord'), recoverDiscord] });
  }
  async function recoverDiscord() {
    waiting = true; render();
    box({ title: t('Get my account back'), msg: t(WRONG_BROWSER), b1: [t('Copy the link'), copyLink], text: t('Your browser is open: sign in at Discord, then come back here. Waiting...'), cancel: true, onCancel: () => { L.accountCancel(); } });
    const r = await L.accountRecover();
    waiting = false; onCancel = null; render();
    if (r && r.ok) return takeOver(r);
    if (r && r.code === 'cancelled') return closeBox();
    box({ title: t('Get my account back'), msg: why(r), err: true, b1: [t('I have a move code'), codeForm], ok: [t('Sign in with Discord'), recoverDiscord] });
  }
  function codeForm(keepMsg) {
    const again = typeof keepMsg === 'string' ? keepMsg : '';
    box({ title: t('Get my account back'), text: t('On the old PC: Settings, then Move to another PC, then Show my code. Type what it shows here.'), form: true, msg: again, err: !!again, ok: [t('Continue'), claim] });
    if (!again) { $('link-in-acct').value = ''; $('link-in-code').value = ''; }
    setTimeout(() => { try { $('link-in-acct').focus(); } catch {} }, 30);
  }
  async function claim() {
    $('link-ok').disabled = true;
    const r = await L.accountMoveClaim($('link-in-acct').value, $('link-in-code').value);
    if (r && r.ok) return takeOver(r);
    codeForm(why(r));
  }
  async function takeOver(r) {
    closeBox();
    const yes = r.same || !r.current
      ? await confirm(t('Use {name} on this PC?', { name: r.name }), t('{name} stops working on any other PC.', { name: r.name }))
      : await confirm(t('Replace {old} with {new} on this PC?', { old: r.current, new: r.name }),
        t('The friends list and the Infinite character of {old} stay behind and are not merged. {new} stops working on any other PC.', { old: r.current, new: r.name }));
    if (!yes) { L.accountDrop(); return; }
    box({ title: t('Get my account back'), text: t('Moving the account here...') });
    const a = await L.accountAdopt();
    if (a && a.ok) {
      say(t('Get my account back'), a.hasPlayerId ? t('Done. This PC is {name} now.', { name: a.name })
        : t('Done. This PC is {name} now. Your name and friends are back. Your Infinite character was not stored with this account: send your logs so it can be put back by hand.', { name: a.name }), false);
      const el = $('set-name'); if (el) el.textContent = a.name;
    } else say(t('Get my account back'), why(a), true);
    refresh(); try { if (typeof fillAccount === 'function') fillAccount(); } catch {}
  }

  function init() {
    if (!$('set-link-row') || !$('dlg-link')) return;
    $('set-link-discord').onclick = linkDiscord;
    $('set-link-move').onclick = openMove;
    $('set-link-back').onclick = openBack;
    { const bo = $('set-link-others'); if (bo) bo.onclick = signOutOthers; }
    $('link-cancel').onclick = closeBox;
    $('dlg-link').addEventListener('cancel', (e) => { e.preventDefault(); closeBox(); });
    $('link-in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('link-ok').hidden) { e.preventDefault(); $('link-ok').click(); } });
    L.onSocialUpdate((s) => { const ch = !S || S.moved !== s.moved || S.tag !== s.tag || S.name !== s.name; S = s; render(); if (ch) { try { if (typeof fillAccount === 'function') fillAccount(); } catch {} } });
    window.addEventListener('df-lang', render);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
