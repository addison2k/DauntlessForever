// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// friends.js - the Friends panel on the right: who is online and what they play, Join, friend requests, adding
// friends by name (or name#1234). It folds to a slim rail; on narrow windows it opens over the page instead of
// squeezing it. "Manage friends" switches the panel to the full list with Remove / Cancel.
// Hosting is the "Host with friends" button on the Play page (app.js reads window.dfSocial).
// Talks to main/social.js through window.launcher.social*.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.socialState) return;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const DOCK_MIN = 1240;   // narrower than this: the panel opens over the page

  let S = null;
  let versions = [];
  let manage = false;
  let folded = store.get('df-fp-folded') === '1';
  let offlineOpen = store.get('df-fp-offline') === '1';
  let noteTimer = null;
  let askStop = false;     // "Stop hosting" with players in the game: ask how first

  // notes go away by themselves: messages after 6 s, errors after 20 s (or as soon as the problem is gone)
  let shownError = '';
  function note(text, isErr, keepMs) {
    const n = $('fr-note'); n.textContent = text || ''; n.classList.toggle('err', !!isErr);
    shownError = isErr ? (text || '') : '';
    clearTimeout(noteTimer);
    const ms = keepMs || (isErr ? 20000 : 0);
    if (text && ms) noteTimer = setTimeout(() => { n.textContent = ''; shownError = ''; }, ms);
  }
  async function act(p, okText) {
    const r = await p;
    if (r && r.ok === false) note(r.error || 'That did not work.', true); else if (okText) note(okText, false, 6000);
    return r;
  }

  // ---------------------------------------------------------------- fold / drawer
  function layout() {
    const fp = $('fp');
    const docked = window.innerWidth >= DOCK_MIN;
    fp.classList.toggle('drawer', !docked);
    // on a narrow window the panel starts closed every time; on a wide one it remembers
    fp.classList.toggle('folded', docked ? folded : !drawerOpen);
  }
  let drawerOpen = false;
  function openPanel() { if (window.innerWidth >= DOCK_MIN) { folded = false; store.set('df-fp-folded', '0'); } else drawerOpen = true; layout(); L.socialRefresh(); }
  function closePanel() { if (window.innerWidth >= DOCK_MIN) { folded = true; store.set('df-fp-folded', '1'); } else drawerOpen = false; layout(); }

  // ---------------------------------------------------------------- rows
  function sub(f) {
    if (f.status === 'hosting') return f.hostMode && f.server ? `Server: ${f.server} (${f.version || ''})` : `Hosting ${f.version || ''}`.trim();
    if (f.status === 'playing') return `Playing ${f.version || ''}`.trim();
    if (f.status === 'online') return 'In the launcher';
    return 'Offline';
  }
  function friendRow(f) {
    const row = el('div', 'fp-row' + (f.status === 'offline' ? ' offline' : ''));
    const who = el('div', 'fp-who');
    who.append(el('span', 'fr-name', f.name), el('span', 'fp-sub', sub(f)));
    row.append(el('span', 'fr-dot ' + f.status), who);
    if (manage) {
      const rm = el('button', 'ghost fr-small', 'Remove');
      rm.onclick = async () => {
        if (rm.dataset.sure !== '1') { rm.dataset.sure = '1'; rm.textContent = 'Sure?'; setTimeout(() => { rm.dataset.sure = ''; rm.textContent = 'Remove'; }, 3000); return; }
        await act(L.socialRemove(f.id), `${f.name} removed.`);
      };
      row.append(rm);
    } else if (f.status === 'hosting') {
      const b = el('button', 'fp-join', 'Join');
      const have = versions.some(v => v.id === f.version && v.hasPackage);
      const busy = !!(S && (S.waiting || S.hosting));
      b.disabled = busy || !have;
      b.title = !have ? `You need Dauntless ${f.version} to join` : (S && S.hosting ? 'You are hosting your own game' : `Join ${f.name}'s ${f.version} game`);
      b.onclick = async () => { b.disabled = true; note(`Asking ${f.name} to let you in...`); await act(L.socialJoin(f.id)); };
      row.append(b);
    }
    return row;
  }
  function requestRow(p, incoming) {
    const row = el('div', 'fp-row');
    const who = el('div', 'fp-who'); who.append(el('span', 'fr-name', p.name), el('span', 'fp-sub', incoming ? 'wants to add you' : 'request sent'));
    row.append(el('span', 'fr-dot'), who);
    if (incoming) {
      const a = el('button', 'primary-sm', 'Accept'); a.onclick = () => act(L.socialAccept(p.id), `You and ${p.name} are friends now.`);
      const d = el('button', 'ghost fr-small', 'Decline'); d.onclick = () => act(L.socialRemove(p.id));
      row.append(a, d);
    } else {
      const c = el('button', 'ghost fr-small', 'Cancel'); c.onclick = () => act(L.socialRemove(p.id));
      row.append(c);
    }
    return row;
  }
  function section(title, rows, opts) {
    opts = opts || {};
    const sec = el('div', 'fp-sec' + (opts.closed ? ' closed' : ''));
    let head;
    if (opts.toggle) { head = el('button', 'fp-sec-head'); head.append(el('span', 'tri'), document.createTextNode(title)); head.onclick = opts.toggle; }
    else head = el('div', 'fp-sec-head', title);
    const body = el('div', 'fp-rows');
    if (rows.length) body.append(...rows); else if (opts.empty) body.append(el('div', 'fp-empty', opts.empty));
    sec.append(head, body);
    return sec;
  }

  // ---------------------------------------------------------------- render
  function renderMode() {
    const off = !!(S && S.offlineMode);
    $('fp').hidden = off;
    const subEl = $('brand-sub'); if (subEl) subEl.textContent = off ? 'every build, offline' : 'solo or with friends';
    const btn = $('set-offline'); if (btn) btn.textContent = off ? 'Turn off' : 'Turn on';
  }
  function render() {
    if (!S) return;
    window.dfSocial = S;
    if (typeof window.renderHostButton === 'function') { try { window.renderHostButton(); } catch {} }   // the Play page's Host button follows
    renderMode();
    if (S.offlineMode) return;
    const online = S.friends.filter(f => f.status !== 'offline');
    $('fp-online').textContent = S.signedIn && S.friends.length ? `${online.length} online` : '';
    $('fp-rail-count').textContent = online.length ? String(online.length) : '';
    $('fp-rail-req').hidden = !(S.incoming && S.incoming.length);
    // switched off for everyone in network.json (server down or being fixed): say so, nothing else to do here
    if (S.onlineOff) {
      $('fr-signup').hidden = false; $('fr-main').hidden = true;
      $('fr-signup-text').textContent = `${S.onlineOff} Solo play works as always.`;
      return;
    }
    $('fr-signup').hidden = S.signedIn;
    $('fr-main').hidden = !S.signedIn;
    if (!S.signedIn) {
      $('fr-signup-text').textContent = S.playerName
        ? (S.error ? `Could not sign in as ${S.playerName} yet: ${S.error} It tries again by itself.` : `Signing you in as ${S.playerName}...`)
        : 'Pick your player name first (Settings > Player name).';
      return;
    }
    if (S.error) { if (S.error !== shownError) note(S.error, true); }
    else if (shownError) note('');
    $('fr-me').textContent = S.name;
    $('fr-code').textContent = S.tag ? `#${S.tag}` : '';
    if (S.waiting) note(`Asking ${S.waiting.host} to let you in... their launcher answers within a few seconds.`);
    const h = $('fp-hosting');
    h.hidden = !S.hosting;
    h.textContent = '';
    h.classList.remove('warn');
    if (!S.hosting && S.relay && S.relay.ms > 150) {
      h.hidden = false;
      h.append(el('div', '', `The online server (${S.relay.name}) is far from you: ${S.relay.ms} ms. Hosting works, but friends may notice lag.`));
    }
    if (S.hosting) {
      h.append(el('div', '', S.hostPublic ? `You are hosting ${S.hosting}, open to everyone: friends and Play online players can join.`
        : `You are hosting ${S.hosting}. Friends see it here and press Join.`));
      const guests = S.guests || [];
      h.append(el('div', 'fp-guests', guests.length ? `In your game: ${guests.map(g => g.name).join(', ')}` : 'Nobody has joined yet.'));
      const btn = (cls, text, fn) => { const b = el('button', cls, text); b.onclick = async () => { b.disabled = true; await fn(); }; return b; };
      const choice = el('div', 'fp-choice');
      if (S.closingIn > 0) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', `Closing in ${S.closingIn} s. The players were told in chat, and their characters are being saved home.`));
        choice.append(btn('ghost fr-small', 'Keep playing', () => act(L.socialStopHost({ cancel: true }), 'Your game stays open.')),
          btn('ghost fr-small', 'Close now', () => act(L.socialStopHost(), 'Stopped hosting.')));
        h.append(choice);
      } else if (askStop && guests.length) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', `${guests.length === 1 ? '1 player is' : guests.length + ' players are'} in your game. Give them a minute to finish up?`));
        choice.append(btn('primary-sm', 'Close in 60 s', async () => { askStop = false; await act(L.socialStopHost({ later: 60 })); }),
          btn('ghost fr-small', 'Close now', async () => { askStop = false; await act(L.socialStopHost(), 'Stopped hosting.'); }),
          btn('ghost fr-small', 'Cancel', async () => { askStop = false; render(); }));
        h.append(choice);
      } else {
        askStop = false;
        const stop = el('button', 'ghost fr-small fp-stop', 'Stop hosting');
        stop.onclick = async () => {
          if ((S.guests || []).length) { askStop = true; render(); return; }
          stop.disabled = true; stop.textContent = 'Stopping...'; await act(L.socialStopHost(), 'Stopped hosting.');
        };
        h.append(stop);
      }
    } else askStop = false;
    // in someone's game: say whose, and pass on a host closing
    if (!S.hosting && S.inGameWith) {
      h.hidden = false;
      if (S.hostClosing) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', `${S.hostClosing.name} is closing their game in about ${S.hostClosing.inSec} s. Your character is being saved home now.`));
      } else h.append(el('div', '', `You are in ${S.inGameWith.name}'s ${S.inGameWith.version} game${S.inGameWith.public ? ' (open to everyone)' : ''}. Your character is saved home every few minutes.`));
    }

    const box = $('fp-scroll'); box.textContent = '';
    if (manage) {
      box.append(section(`Friends (${S.friends.length})`, S.friends.map(friendRow), { empty: 'No friends yet.' }));
      if (S.outgoing.length) box.append(section('Requests you sent', S.outgoing.map(p => requestRow(p, false))));
    } else {
      if (S.incoming.length) box.append(section(`Friend requests (${S.incoming.length})`, S.incoming.map(p => requestRow(p, true))));
      const off = S.friends.filter(f => f.status === 'offline');
      box.append(section(`Online (${online.length})`, online.map(friendRow),
        { empty: S.friends.length ? 'Nobody is online right now.' : 'Add a friend by their name above. They see your request when their launcher is open.' }));
      if (off.length) box.append(section(`Offline (${off.length})`, off.map(friendRow),
        { closed: !offlineOpen, toggle: () => { offlineOpen = !offlineOpen; store.set('df-fp-offline', offlineOpen ? '1' : '0'); render(); } }));
    }
    $('fp-manage').textContent = manage ? 'Back' : 'Manage friends';
  }

  async function init() {
    try { versions = await L.listVersions(); } catch { versions = []; }
    $('fr-add').onclick = async () => {
      const name = $('fr-addname').value.trim(); if (!name) { $('fr-addname').focus(); return; }
      const r = await act(L.socialAdd(name), `Friend request sent to ${name}.`);
      if (r && r.ok !== false) $('fr-addname').value = '';
    };
    $('fr-addname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fr-add').click(); });
    // one name for everything: the player-name question (player.js) changes it here and in every version
    $('fr-rename').onclick = () => { if (window.dfChangeName) window.dfChangeName(); };
    $('fp-manage').onclick = () => { manage = !manage; render(); };
    $('fp-open').onclick = () => { if ($('fp').classList.contains('folded')) openPanel(); else closePanel(); };
    $('fp-fold').onclick = closePanel;
    // the drawer closes when the page behind it is clicked
    document.addEventListener('mousedown', (e) => { if (drawerOpen && window.innerWidth < DOCK_MIN && !e.target.closest('#fp') && !e.target.closest('dialog')) { drawerOpen = false; layout(); } });
    window.addEventListener('resize', layout);
    const offBtn = $('set-offline');
    if (offBtn) offBtn.onclick = async () => { offBtn.disabled = true; S = await L.socialSetOffline(!(S && S.offlineMode)); render(); offBtn.disabled = false; };
    L.onSocialUpdate((s) => { S = s; render(); });
    layout();
    S = await L.socialState(); render();
    // installed versions change (download, set-up): Join buttons follow
    setInterval(() => { L.listVersions().then(v => { versions = v; }).catch(() => {}); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
