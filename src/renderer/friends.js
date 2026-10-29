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
  const t = window.t || ((s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : String(s)));   // i18n.js
  const tm = window.tm || ((s) => (s == null ? '' : String(s)));

  let S = null;
  let versions = [];
  let manage = false;
  let folded = store.get('df-fp-folded') === '1';
  let offlineOpen = store.get('df-fp-offline') === '1';
  let noteTimer = null;
  let askStop = false;     // "Stop hosting" with players in the game: ask how first
  let chatWith = null;     // DF-CHAT: the friend whose conversation is on screen, or null
  let chatMsgs = [];       // DF-CHAT: messages of that conversation (from main, merged local + server)
  let chatPoll = null;     // DF-CHAT: refresh timer while the view is open

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
    if (r && r.ok === false) note(tm(r.error) || t('That did not work.'), true); else if (okText) note(okText, false, 6000);
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
    if (f.status === 'hosting') return f.hostMode && f.server ? t('Server: {name} ({version})', { name: f.server, version: f.version || '' }) : t('Hosting {version}', { version: f.version || '' }).trim();
    if (f.status === 'playing') return t('Playing {version}', { version: f.version || '' }).trim();
    if (f.status === 'online') return t('In the launcher');
    return t('Offline');
  }
  function friendRow(f) {
    const row = el('div', 'fp-row' + (f.status === 'offline' ? ' offline' : ''));
    const who = el('div', 'fp-who');
    who.append(el('span', 'fr-name', f.name), el('span', 'fp-sub', sub(f)));
    row.append(el('span', 'fr-dot ' + f.status), who);
    if (!manage && S && S.chat && S.chat.cap) {   // DF-CHAT
      const ic = el('button', 'fp-chat-ico'); ic.title = t('Message {name}', { name: f.name }); ic.setAttribute('aria-label', ic.title);
      ic.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      const n = el('span', 'n', (S.chat.unread && S.chat.unread[f.id]) ? String(S.chat.unread[f.id]) : ''); ic.append(n);
      ic.onclick = (e) => { e.stopPropagation(); openChat(f); };
      row.append(ic);
    }
    if (manage) {
      const rm = el('button', 'ghost fr-small', t('Remove'));
      rm.onclick = async () => {
        if (rm.dataset.sure !== '1') { rm.dataset.sure = '1'; rm.textContent = t('Sure?'); setTimeout(() => { rm.dataset.sure = ''; rm.textContent = t('Remove'); }, 3000); return; }
        await act(L.socialRemove(f.id), t('{name} removed.', { name: f.name }));
      };
      row.append(rm);
    } else if (f.status === 'hosting') {
      const b = el('button', 'fp-join', t('Join'));
      const have = versions.some(v => v.id === f.version && v.hasPackage);
      const busy = !!(S && (S.waiting || S.hosting));
      b.disabled = busy || !have;
      b.title = !have ? t('You need Dauntless {version} to join', { version: f.version }) : (S && S.hosting ? t('You are hosting your own game') : t('Join {name}\'s {version} game', { name: f.name, version: f.version }));
      b.onclick = async () => { b.disabled = true; note(t('Asking {name} to let you in...', { name: f.name })); await act(L.socialJoin(f.id)); };
      row.append(b);
    }
    return row;
  }
  function requestRow(p, incoming) {
    const row = el('div', 'fp-row');
    const who = el('div', 'fp-who'); who.append(el('span', 'fr-name', p.name), el('span', 'fp-sub', incoming ? t('wants to add you') : t('request sent')));
    row.append(el('span', 'fr-dot'), who);
    if (incoming) {
      const a = el('button', 'primary-sm', t('Accept')); a.onclick = () => act(L.socialAccept(p.id), t('You and {name} are friends now.', { name: p.name }));
      const d = el('button', 'ghost fr-small', t('Decline')); d.onclick = () => act(L.socialRemove(p.id));
      row.append(a, d);
    } else {
      const c = el('button', 'ghost fr-small', t('Cancel')); c.onclick = () => act(L.socialRemove(p.id));
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
    const subEl = $('brand-sub'); if (subEl) subEl.textContent = off ? t('every build, offline') : t('solo or with friends');
    const btn = $('set-offline'); if (btn) btn.textContent = off ? t('Turn off') : t('Turn on');
  }
  function render() {
    if (!S) return;
    window.dfSocial = S;
    if (typeof window.renderHostButton === 'function') { try { window.renderHostButton(); } catch {} }   // the Play page's Host button follows
    renderMode();
    if (S.offlineMode) return;
    const online = S.friends.filter(f => f.status !== 'offline');
    $('fp-online').textContent = S.signedIn && S.friends.length ? t('{n} online', { n: online.length }) : '';
    $('fp-rail-count').textContent = online.length ? String(online.length) : '';
    $('fp-rail-req').hidden = !(S.incoming && S.incoming.length);
    { const u = (S.chat && S.chat.unread) || {}; const total = Object.values(u).reduce((a, b) => a + (+b || 0), 0); const rc = $('fp-rail-chat'); rc.textContent = total ? String(total) : ''; rc.hidden = !total; }   // DF-CHAT
    if (chatWith) { const f = S.friends.find(x => x.id === chatWith.id); if (!f || !(S.chat && S.chat.cap)) closeChat(); else { chatWith = f; $('fp-chat-sub').textContent = sub(f); } }   // DF-CHAT: the friend left, or the service lost chat
    // switched off for everyone in network.json (server down or being fixed): say so, nothing else to do here
    if (S.onlineOff) {
      $('fr-signup').hidden = false; $('fr-main').hidden = true;
      $('fr-signup-text').textContent = t('{message} Solo play works as always.', { message: tm(S.onlineOff) });
      return;
    }
    $('fr-signup').hidden = S.signedIn;
    $('fr-main').hidden = !S.signedIn;
    if (!S.signedIn) {
      $('fr-signup-text').textContent = S.playerName
        ? (S.error ? t('Could not sign in as {name} yet: {error} It tries again by itself.', { name: S.playerName, error: tm(S.error) }) : t('Signing you in as {name}...', { name: S.playerName }))
        : t('Pick your player name first (Settings > Player name).');
      return;
    }
    if (S.error) { if (tm(S.error) !== shownError) note(tm(S.error), true); }
    else if (shownError) note('');
    $('fr-me').textContent = S.name;
    $('fr-code').textContent = S.tag ? `#${S.tag}` : '';
    if (S.waiting) note(t('Asking {name} to let you in... their launcher answers within a few seconds.', { name: S.waiting.host }));
    const h = $('fp-hosting');
    h.hidden = !S.hosting;
    h.textContent = '';
    h.classList.remove('warn');
    if (!S.hosting && S.relay && S.relay.ms > 150) {
      h.hidden = false;
      h.append(el('div', '', t('The online server ({name}) is far from you: {ms} ms. Hosting works, but friends may notice lag.', { name: S.relay.name, ms: S.relay.ms })));
    }
    if (S.hosting) {
      h.append(el('div', '', S.hostPublic ? t('You are hosting {version}, open to everyone: friends and Play online players can join.', { version: S.hosting })
        : t('You are hosting {version}. Friends see it here and press Join.', { version: S.hosting })));
      const guests = S.guests || [];
      h.append(el('div', 'fp-guests', guests.length ? t('In your game: {names}', { names: guests.map(g => g.name).join(', ') }) : t('Nobody has joined yet.')));
      const btn = (cls, text, fn) => { const b = el('button', cls, text); b.onclick = async () => { b.disabled = true; await fn(); }; return b; };
      const choice = el('div', 'fp-choice');
      if (S.closingIn > 0) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', t('Closing in {n} s. The players were told in chat, and their characters are being saved home.', { n: S.closingIn })));
        choice.append(btn('ghost fr-small', t('Keep playing'), () => act(L.socialStopHost({ cancel: true }), t('Your game stays open.'))),
          btn('ghost fr-small', t('Close now'), () => act(L.socialStopHost(), t('Stopped hosting.'))));
        h.append(choice);
      } else if (askStop && guests.length) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', guests.length === 1 ? t('1 player is in your game. Give them a minute to finish up?') : t('{n} players are in your game. Give them a minute to finish up?', { n: guests.length })));
        choice.append(btn('primary-sm', t('Close in 60 s'), async () => { askStop = false; await act(L.socialStopHost({ later: 60 })); }),
          btn('ghost fr-small', t('Close now'), async () => { askStop = false; await act(L.socialStopHost(), t('Stopped hosting.')); }),
          btn('ghost fr-small', t('Cancel'), async () => { askStop = false; render(); }));
        h.append(choice);
      } else {
        askStop = false;
        const stop = el('button', 'ghost fr-small fp-stop', t('Stop hosting'));
        stop.onclick = async () => {
          if ((S.guests || []).length) { askStop = true; render(); return; }
          stop.disabled = true; stop.textContent = t('Stopping...'); await act(L.socialStopHost(), t('Stopped hosting.'));
        };
        h.append(stop);
      }
    } else askStop = false;
    // in someone's game: say whose, and pass on a host closing
    if (!S.hosting && S.inGameWith) {
      h.hidden = false;
      if (S.hostClosing) {
        h.classList.add('warn');
        h.append(el('div', 'fp-closing', t('{name} is closing their game in about {n} s. Your character is being saved home now.', { name: S.hostClosing.name, n: S.hostClosing.inSec })));
      } else h.append(el('div', '', S.inGameWith.public ? t('You are in {name}\'s {version} game (open to everyone). Your character is saved home every few minutes.', { name: S.inGameWith.name, version: S.inGameWith.version })
        : t('You are in {name}\'s {version} game. Your character is saved home every few minutes.', { name: S.inGameWith.name, version: S.inGameWith.version })));
    }

    const box = $('fp-scroll'); box.textContent = '';
    if (manage) {
      box.append(section(t('Friends ({n})', { n: S.friends.length }), S.friends.map(friendRow), { empty: t('No friends yet.') }));
      if (S.outgoing.length) box.append(section(t('Requests you sent'), S.outgoing.map(p => requestRow(p, false))));
    } else {
      if (S.incoming.length) box.append(section(t('Friend requests ({n})', { n: S.incoming.length }), S.incoming.map(p => requestRow(p, true))));
      const off = S.friends.filter(f => f.status === 'offline');
      box.append(section(t('Online ({n})', { n: online.length }), online.map(friendRow),
        { empty: S.friends.length ? t('Nobody is online right now.') : t('Add a friend by their name above. They see your request when their launcher is open.') }));
      if (off.length) box.append(section(t('Offline ({n})', { n: off.length }), off.map(friendRow),
        { closed: !offlineOpen, toggle: () => { offlineOpen = !offlineOpen; store.set('df-fp-offline', offlineOpen ? '1' : '0'); render(); } }));
    }
    $('fp-manage').textContent = manage ? t('Back') : t('Manage friends');
  }

  // ---------------------------------------------------------------- DF-CHAT (Oct 29): one conversation in the panel
  function dayLabel(iso) { const d = new Date(iso); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1); const same = (a, b) => a.toDateString() === b.toDateString(); return same(d, today) ? t('Today') : same(d, y) ? t('Yesterday') : d.toLocaleDateString(); }
  function renderChat(keepScroll) {
    const log = $('fp-chat-log'); if (!chatWith) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = '';
    if (!chatMsgs.length) log.append(el('div', 'fp-chat-empty', t('No messages yet. Say hi!')));
    let lastDay = '';
    for (const m of chatMsgs) {
      const day = m.at ? dayLabel(m.at) : ''; if (day && day !== lastDay) { log.append(el('div', 'fp-msg-day', day)); lastDay = day; }
      const mine = S && m.from !== chatWith.id;
      const b = el('div', 'fp-msg' + (mine ? ' mine' : '') + (m.pending ? ' pending' : ''), m.text);
      if (m.at) b.title = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      log.append(b);
    }
    if (!keepScroll || atBottom) log.scrollTop = log.scrollHeight;
    $('fp-chat-note').textContent = chatWith.status === 'offline' ? t('{name} is offline: they see this when their launcher opens.', { name: chatWith.name }) : '';
  }
  async function refreshChat() {
    if (!chatWith) return;
    const r = await L.socialChatFetch(chatWith.id);
    if (!chatWith) return;
    if (r && r.ok) { const pend = chatMsgs.filter(m => m.pending); chatMsgs = r.messages.concat(pend.filter(p => !r.messages.some(m => m.text === p.text && m.from !== chatWith.id))); renderChat(true); }
    else if (r && r.error) { $('fp-chat-note').textContent = tm(r.error); }
  }
  async function openChat(f) {
    chatWith = f; chatMsgs = [];
    $('fr-main').classList.add('chatting'); $('fp-chat').hidden = false;
    $('fp-chat-name').textContent = f.name; $('fp-chat-sub').textContent = sub(f); $('fp-chat-log').textContent = ''; $('fp-chat-note').textContent = '';
    if (window.innerWidth >= DOCK_MIN) { if ($('fp').classList.contains('folded')) openPanel(); } else { drawerOpen = true; layout(); }
    const r = await L.socialChatOpen(f.id);
    if (!chatWith || chatWith.id !== f.id) return;
    if (r && r.ok) { chatMsgs = r.messages || []; renderChat(false); } else { renderChat(false); if (r && r.error) $('fp-chat-note').textContent = tm(r.error); }
    $('fp-chat-text').focus();
    clearInterval(chatPoll); chatPoll = setInterval(refreshChat, 2500);
  }
  function closeChat() {
    if (!chatWith) return;
    chatWith = null; chatMsgs = []; clearInterval(chatPoll); chatPoll = null;
    $('fr-main').classList.remove('chatting'); $('fp-chat').hidden = true;
    L.socialChatOpen(null).catch(() => {});
    L.socialRefresh();
  }
  async function sendChat() {
    const ta = $('fp-chat-text'), text = ta.value.trim(); if (!text || !chatWith) return;
    const btn = $('fp-chat-btn'); btn.disabled = true; ta.value = '';
    const pend = { id: 'p' + Date.now(), from: 'me', text, at: new Date().toISOString(), pending: true };
    chatMsgs.push(pend); renderChat(false);
    const r = await L.socialChatSend(chatWith.id, text);
    btn.disabled = false;
    if (r && r.ok) { pend.id = r.id; pend.at = r.at || pend.at; delete pend.pending; renderChat(true); }
    else { chatMsgs = chatMsgs.filter(m => m !== pend); ta.value = text; renderChat(true); $('fp-chat-note').textContent = tm(r && r.error) || t('Not sent.'); }
    ta.focus();
  }

  async function init() {
    try { versions = await L.listVersions(); } catch { versions = []; }
    $('fr-add').onclick = async () => {
      const name = $('fr-addname').value.trim(); if (!name) { $('fr-addname').focus(); return; }
      const r = await act(L.socialAdd(name), t('Friend request sent to {name}.', { name }));
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
    // DF-CHAT
    $('fp-chat-back').onclick = closeChat;
    $('fp-chat-btn').onclick = sendChat;
    $('fp-chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } if (e.key === 'Escape') closeChat(); });
    L.onSocialChatOpen(({ id }) => { const f = S && S.friends.find(x => x.id === id); if (f) openChat(f); });
    window.addEventListener('df-lang', () => { if (shownError && S && S.error) note(tm(S.error), true); render(); });   // Settings > Launcher language
    layout();
    S = await L.socialState(); render();
    // installed versions change (download, set-up): Join buttons follow
    setInterval(() => { L.listVersions().then(v => { versions = v; }).catch(() => {}); }, 30000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
