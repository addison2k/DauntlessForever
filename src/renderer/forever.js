// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// forever.js (renderer) - the Forever page: Play Forever (fresh character / any toon), what this PC is doing in its
// world, the board of open worlds and hunts, and the opt-in host check. The work is done in main/forever.js.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.foreverState) return;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const t = window.t || ((s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) : String(s)));
  let S = null, noteTimer = null, boardTimer = null;
  const skipped = () => { try { return localStorage.getItem('fv-skip') === '1'; } catch { return false; } };
  const setSkipped = (v) => { try { if (v) localStorage.setItem('fv-skip', '1'); else localStorage.removeItem('fv-skip'); } catch {} };

  function note(text, isErr) {
    const n = $('fv-note'); if (!n) return;
    n.textContent = text || ''; n.className = 'action-note' + (isErr ? ' err' : '');
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => { n.textContent = ''; }, isErr ? 20000 : 7000);
  }
  const PHASE = {
    off: ['Not playing', ''], asking: ['Asking the director', 'starting'], waiting: ['Waiting for a world', 'starting'], joining: ['Joining a world', 'starting'],
    creating: ['Making your Forever character', 'starting'], needHost: ['Nobody is hosting', 'starting'], playing: ['In a world', 'running'], hosting: ['Hosting a world', 'running'], standby: ['In a world (standby)', 'running'], moving: ['Moving to the new host', 'restarting'], stopping: ['Stopping', 'stopping'],
  };
  function render() {
    if (!S) return;
    // the tab exists only when the VPS says so (forever-beta.txt there)
    const nav = document.querySelector('.nav-item[data-page="forever"]');
    if (nav) nav.hidden = !S.allowed;
    const page = $('page-forever'); if (!page || page.hidden) return;
    const on = S.phase !== 'off';
    const setting = !!(S.setup && S.setup.step);
    $('fv-missing').hidden = !(S.missing || S.stale || setting);
    $('fv-missing-title').textContent = setting ? t('Setting up Forever...') : S.missing ? t('Forever is not set up on this PC') : t('Forever has an update');
    $('fv-missing-text').textContent = setting ? t('{step}', { step: S.setup.step }) : S.missing ? t('One click builds it from your 1.14.7 install (same game folder, its own save). About a minute.') : t('The server has newer Forever files. Set up again to get them (your character is kept).');
    $('fv-setup').textContent = S.missing ? t('Set up Forever') : t('Update Forever'); $('fv-setup').disabled = setting; $('fv-setup').hidden = setting;
    if (S.setup && S.setup.error) { $('fv-missing-text').textContent = S.setup.error; }
    const [label, cls] = PHASE[S.phase] || PHASE.off;
    $('fv-state').textContent = t(label) + (S.role === 'host' && S.world ? ` (${S.world.players} ${S.world.players === 1 ? t('player') : t('players')})` : '');
    $('fv-dot').className = 'hm-dot ' + cls;
    let sub = '';
    if (S.phase === 'off') sub = t('Press Play Forever. Fresh: a new character that only plays Forever. Any toon: bring your own.');
    else if (S.phase === 'waiting') sub = S.why;
    else if (S.phase === 'creating') sub = t('The game is open on its own: create your Slayer, then close the game and Forever puts you in a world.');
    else if (S.phase === 'needHost') sub = t('No world is open and nobody who is asking has run the host check. Run it now (20 s) and host, or wait for a world.');
    else if (S.world) sub = (S.helper ? (S.ownGame ? t('This PC runs the world; your game is in it. ') : t('Host Mode: this PC runs a world for others, no game here. ')) : '') + t('{host}\'s {mode} world, {n} player(s), hunts {h}/{max} (8 per hunt)', { host: S.world.hostName || '', mode: S.world.mode || '', n: S.world.players, h: (S.world.hunts || []).length, max: S.world.maxHunts || '?' }) + (S.standbyName ? t(', standby: {name}', { name: S.standbyName }) : '');
    else if (S.helper && S.phase === 'hosting') sub = S.autoPlay ? t('Starting your world... your game opens by itself in a moment (about 30 s).') : t('Host Mode: starting a world for others (no game on this PC)');
    if (S.role === 'standby' && S.standby) sub += ' - ' + (S.standby.injected ? t('your backup copy is ready to take over') : S.standby.prewarmed ? t('your backup copy is starting') : t('getting the hunt from the host'));
    if (S.hostClosing) sub += ' - ' + t('the host is leaving in {s} s', { s: Math.ceil((S.hostClosing.inMs || 0) / 1000) });
    if (S.noStandby && (S.phase === 'playing' || S.phase === 'hosting')) sub += ' - ' + t('no standby: if the host leaves, the hunt ends. Run the host check to help.');
    $('fv-sub').textContent = sub;
    $('fv-cards').hidden = on && !(S.helper && S.phase === 'hosting'); $('fv-stop').hidden = !on;   // Host Mode: the cards stay, Play Forever joins your own world
    renderCards(stepDoneNow());
    $('fv-needhost').hidden = S.phase !== 'needHost';

    $('fv-error').textContent = S.error || ''; $('fv-error').hidden = !S.error;
    // first visit: the step card holds the check until the player has sent a score or skipped
    const sc = S.score, ck = S.check;
    const stepDone = !!(sc && sc.score) || skipped();
    $('fv-steps').hidden = stepDone || !!S.missing;

    $('fv-step-check').disabled = !!(ck && ck.running);
    $('fv-step-check').textContent = ck && ck.running ? t('Checking...') : t('Run the host check');
    $('fv-score').textContent = sc && sc.score ? t('Host score {s} / 100, {h} hunt(s) at once', { s: sc.score, h: sc.maxHunts }) + (sc.hitchAt && sc.maxHuntsChecked > sc.maxHunts ? ' ' + t('(lowered from {n}: this PC hitched with {k} hunts up; run the check again to reset)', { n: sc.maxHuntsChecked, k: sc.hitchAt }) : '') : t('Not set up to host (you can still play)');
    $('fv-check').disabled = !!(ck && ck.running);
    $('fv-check').textContent = ck && ck.running ? t('Checking...') : t('Run the host check');
    const box = stepDone ? $('fv-check-result') : $('fv-step-result'); $('fv-check-result').innerHTML = ''; $('fv-step-result').innerHTML = '';
    $('fv-again').hidden = !(ck && !ck.running);
    if (ck && !ck.running && !ck.failed) {
      const rows = [[t('CPU'), `${ck.cpu} (${ck.threads} threads)`, `${ck.parts.cpu} / 20`], [t('RAM'), `${ck.ramGB} GB`, t('{n} hunt(s) at once', { n: ck.maxHunts })],
        [t('Upload'), `${ck.upload} Mbps`, `${ck.parts.upload} / 35`], [t('Connection'), ck.bestRelay ? `${ck.bestRelay.host} ${ck.bestRelay.avg} ms, jitter ${ck.bestRelay.jitter} ms` : t('no relay replies'), `${ck.parts.connection} / 25`],
        [t('Stability'), t('assumed clean'), `${ck.parts.stability} / 20`], [t('Score'), '', `${ck.score} / 100`]];
      for (const [k, v, p] of rows) { const r = el('div', 'fv-row'); r.append(el('span', 'fv-k', k), el('span', 'fv-v', v), el('span', 'fv-p', p)); box.append(r); }
      box.append(el('p', 'small', t('These numbers stay on this PC until you press Send. Sending lets the director pick this PC to host worlds; you can take it back any time.')));
      $('fv-send').hidden = stepDone ? false : true;
      if (!stepDone) { const b = el('button', 'primary-sm', t('Send')); b.onclick = sendScore; const row = el('div', 'hm-inline'); row.append(b, el('span', 'fv-arrow', t('\u2190 Looks right? Send it'))); box.append(row); }
    } else { $('fv-send').hidden = true; if (ck && ck.failed) box.append(el('p', 'small', t('The check did not finish.'))); }
    $('fv-clear').hidden = !(sc && sc.score);

    // board
    const b = S.board, list = $('fv-board'); list.innerHTML = '';
    if (b && b.worlds && b.worlds.length) {
      // DF-FV-BOARD (Oct 25): a scrollable box, busiest worlds first (yours on top); empty worlds go into one line
      const worldsSorted = [...b.worlds].sort((x, y) => (y.you ? 1 : 0) - (x.you ? 1 : 0) || (y.players || 0) - (x.players || 0));
      const empty = worldsSorted.filter(w => !w.you && !(w.players > 0));
      for (const w of worldsSorted.filter(w => w.you || w.players > 0)) {
        const card = el('div', 'season-item fv-world');
        const head = el('div', 'fv-world-head');
        const ms = w.region && S.pings && Number.isFinite(Number(S.pings[w.region])) ? Number(S.pings[w.region]) : null;
        head.append(el('strong', '', `${w.hostName}'s ${w.mode} world`), el('span', 'pill', t('players {n}/{cap}', { n: w.players, cap: w.cap })), el('span', 'small', (w.hunts && w.maxHunts ? t('hunts {h}/{max}', { h: w.hunts.length, max: w.maxHunts }) + ' ' : '') + (w.region ? w.region.toUpperCase() : '') + (ms != null ? ` ~${ms} ms` : '')));
        card.append(head);
        if (w.names && w.names.length) card.append(el('div', 'small', t('with: {names}', { names: w.names.join(', ') })));
        const full = (w.players || 0) >= (w.cap || 8);
        // DF-FV-NOJOINBTN (Oct 25): no "Join this world" button (it confused players); Play Forever picks the world
        if (w.you) card.append(el('div', 'small', t('you are in this world')));
        else if (full) card.append(el('div', 'small', t('full')));
        const inHunts = (w.hunts || []).reduce((n, h) => n + (h.players || 0), 0), inTown = Math.max(0, (w.players || 0) - inHunts);
        const shortHunt = (h) => String(h.label || h.huntId || 'hunt').replace(/^.*\//, '').replace(/^\S*\s+/, '').replace(/^ShatteredIsles_/, '').replace(/_/g, ' ').replace(/^Island([A-Z])$/, 'Island $1') || 'hunt';
        const parts = (w.hunts || []).map(h => `${shortHunt(h)} ${h.players}/${h.cap}`);
        parts.push(t('Ramsgate {n}', { n: inTown }));
        card.append(el('div', 'small fv-hunts', parts.join('  \u00b7  ')));
        list.append(card);
      }
      if (empty.length) list.append(el('div', 'small fv-empty', t('{n} more world(s) waiting for players: {names}', { n: empty.length, names: empty.map(w => w.hostName).join(', ') })));
    } else list.append(el('p', 'small', t('No open worlds right now. Press Play Forever and one starts.')));
    $('fv-season').textContent = t('Season {s}', { s: S.season });
    // leaderboard
    const lb = S.leaderboard, lbox = $('fv-lb'); if (lbox) {
      lbox.innerHTML = '';
      if (lb && lb.rows && lb.rows.length) {
        const tbl = el('table', 'fv-lb-table'); const hr = el('tr');
        for (const h of ['#', t('Host'), t('Score'), t('Hosted'), t('Players'), t('Player-min'), t('Hunts'), t('Takeovers')]) hr.append(el('th', '', h));
        tbl.append(hr);
        for (const r of lb.rows) {
          const tr = el('tr', r.you ? 'fv-lb-you' : '');
          const hosted = r.hostMinutes >= 90 ? `${(r.hostMinutes / 60).toFixed(1)} h` : `${r.hostMinutes} min`;
          for (const v of [String(r.rank), r.name || '?', String(r.score || 0), hosted, String(r.players), String(r.playerMinutes), String(r.hunts), String(r.takeovers)]) tr.append(el('td', '', v));
          tbl.append(tr);
        }
        lbox.append(tbl);
        $('fv-lb-sub').textContent = lb.you ? t('you are #{n} of {h}', { n: lb.you.rank, h: lb.hosts }) : t('{h} host(s) this season', { h: lb.hosts });
      } else { lbox.append(el('p', 'small', t('Nobody has hosted yet this season. Run the host check and be the first.'))); $('fv-lb-sub').textContent = ''; }
    }
    $('fv-log').textContent = (S.log || []).join('\n');
  }
  function stepDoneNow() { const sc = S && S.score; return !!(sc && sc.score) || skipped(); }
  function renderCards(stepDone) {
    const c = S.cards, wrap = $('fv-cards'); if (!wrap) return;
    const fresh = c && c.fresh, own = c && c.own;
    // checklist: Forever character / host check / ready
    const list = $('fv-checklist'); list.innerHTML = '';
    const item = (ok, text) => { const r = el('div', 'fv-check-item' + (ok ? ' ok' : '')); r.append(el('span', 'fv-tick', ok ? '\u2713' : '\u25CB'), el('span', '', text)); list.append(r); };
    item(!!(fresh && fresh.exists && fresh.created), fresh && fresh.exists ? (fresh.created ? t('Forever character: {name}', { name: fresh.name }) : t('Forever character: made, create it in game on your first Play')) : t('Forever character: made on your first Play Forever'));
    item(stepDone, (S.score && S.score.score) ? t('Host check: sent (score {s})', { s: S.score.score }) : skipped() ? t('Host check: skipped') : t('Host check: not yet (above)'));
    item(!S.missing, S.missing ? t('Forever files: missing on this PC') : t('Ready to play'));
    // the two cards
    const f = $('fv-card-fresh'), a = $('fv-card-any');
    const stat = (box, k, v, hi) => { const r = el('div', 'fv-stat'); r.append(el('span', 'fv-stat-k', k), el('span', 'fv-stat-v' + (hi ? ' hi' : ''), v)); box.append(r); };
    f.innerHTML = ''; a.innerHTML = '';
    const fh = el('div', 'fv-card-head'); fh.append(el('div', 'fv-card-title', t('Forever character')), el('span', 'pill gold', t('The test - main feature')));
    f.append(fh, el('p', 'small', t('A fresh character for Season {s}. Standard rules, no item adding, kept on the server. Everyone in a Fresh world started from zero too.', { s: (c && c.season) || S.season })));
    if (fresh && fresh.exists && fresh.created) { stat(f, t('Name'), fresh.name); stat(f, t('Slayer level'), String(fresh.level)); stat(f, t('Weapons at level 20'), `${fresh.l20} / 7`); stat(f, t('Reforges'), String(fresh.reforges)); stat(f, t('Gear score'), String(fresh.score), true); }
    else if (fresh && fresh.exists) stat(f, t('Status'), t('made - not played yet'));
    else stat(f, t('Status'), fresh && fresh.error ? fresh.error : t('none yet - made when you press Play'));
    const bf = el('button', stepDone ? 'primary-sm' : 'ghost', t('Play Forever - fresh character')); bf.id = 'fv-play-fresh'; bf.disabled = !!S.missing || !!S.autoPlay || (S.phase !== 'off' && !(S.helper && S.phase === 'hosting' && !S.ownGame));   // DF-FV-AUTOPLAY: the game opens by itself
    bf.onclick = async () => { const r = await L.foreverPlay('fresh'); if (!r.ok) note(r.error, true); };
    f.append(bf);
    // Host Mode card: this PC runs a world for others and plays in it with the fresh character; the game can close and reopen
    const sc = S.score, hasScore = !!(sc && sc.score), hm = S.helper && S.phase !== 'off';
    const ah = el('div', 'fv-card-head'); ah.append(el('div', 'fv-card-title', t('Host Mode')), el('span', 'pill', hm ? t('running') : t('Help host')));
    a.append(ah, el('p', 'small', t('This PC runs a world for everyone - town and hunts - and you play in it with your Forever character. Close your game whenever you like: the world stays up until you press Stop. Needs the host check sent.')));
    stat(a, t('Host score'), hasScore ? `${sc.score} / 100` : t('not sent'));
    stat(a, t('Hunt servers at once (8 players each)'), hasScore ? String(sc.maxHunts) : '-');
    if (hm && S.world) { stat(a, t('Players in your world'), String(S.world.players), true); stat(a, t('Hunts open'), `${(S.world.hunts || []).length} / ${S.world.maxHunts || sc.maxHunts}`); }
    if (!hm) {
      // DF-ONEBUTTON (Addison, Oct 27 live): no Host Mode button: Play Forever does it all (the director makes this PC the town when it is needed). The button stays in the code, hidden.
      const bh = el('button', hasScore && stepDone ? 'primary-sm' : 'ghost', t('Host Mode - run a world')); bh.id = 'fv-play-helper'; bh.disabled = !!S.missing || !hasScore || S.phase !== 'off'; bh.hidden = true;
      bh.onclick = async () => { const r = await L.foreverPlay('helper'); if (!r.ok) note(r.error, true); };
      a.append(bh);
      if (!hasScore) a.append(el('p', 'small', t('Run the host check (above) and press Send first.')));
      else a.append(el('p', 'small', t('Press Play Forever: this PC runs the town when the director picks it, and hosts the hunts you open.')));
    } else {
      a.append(el('p', 'small', S.ownGame ? (S.away ? t('Your game is open in {host}\'s world (where the people are); your own world keeps running here.', { host: S.away.hostName || '?' }) : t('Your game is open in your world. Close it whenever you like; the world stays up.')) : (S.autoPlay ? t('Your world is starting. Your game opens in it by itself, no need to press Play again.') : t('Your world is running. Press Play Forever - fresh character: your game goes where the people are, or into your own world when that is it. The world keeps running when you close your game.'))));
    }
  }
  async function refreshBoard() { try { await L.foreverBoard(); } catch {} try { await L.foreverCards(); } catch {} try { await L.foreverLeaderboard(); } catch {} }
  async function sendScore() { const r = await L.foreverSendScore(); note(r.ok ? t('Sent. This PC can host worlds now.') : r.error, !r.ok); if (r.ok) setSkipped(false); refreshBoard(); }
  function init() {
    $('fv-stop').onclick = async () => {
      const n = S && S.world ? Number(S.world.players) || 0 : 0;
      if (S && S.role === 'host' && n > 0) {
        const ok = confirm(S.standbyName ? t('{n} player(s) are in your world. Stop hands it to the standby ({s}); everyone gets a short loading screen. Stop anyway?', { n, s: S.standbyName })
                                          : t('{n} player(s) are in your world and there is no standby: Stop ENDS the world and sends everyone to the menu. Stop anyway?', { n }));
        if (!ok) return;
      } else if (S && S.role === 'standby') {
        if (!confirm(t('You are the standby for this world. If you stop, the hunts have no backup until another PC is picked. Stop anyway?'))) return;
      }
      await L.foreverStop();
    };
    $('fv-check').onclick = async () => { await L.foreverCheck(); };
    $('fv-send').onclick = sendScore;
    $('fv-step-check').onclick = async () => { await L.foreverCheck(); };
    $('fv-again').onclick = async () => { await L.foreverCheck(); };
    $('fv-step-skip').onclick = () => { setSkipped(true); render(); };
    $('fv-setup').onclick = async () => { const r = await L.foreverSetup(); if (!r.ok) note(r.error, true); else { note(t('Forever is set up.')); refreshBoard(); } };
    $('fv-needhost-check').onclick = async () => { const r = await L.foreverCheckAndHost(); if (!r.ok && r.error) note(r.error, true); };
    $('fv-needhost-wait').onclick = async () => { await L.foreverWait(); };
    $('fv-clear').onclick = async () => { const r = await L.foreverClearScore(); note(r.ok ? t('Taken back. This PC will not host.') : r.error, !r.ok); refreshBoard(); };
    // DF-FV-MORE: the Play page's More menu, here. 1.14.7 items run the Play page's own action for 1.14.7.
    $('fv-more').onclick = (e) => { e.stopPropagation(); $('fv-more-menu').hidden = !$('fv-more-menu').hidden; };
    document.addEventListener('click', (e) => { if (!e.target.closest('#fv-more-menu') && !e.target.closest('#fv-more')) $('fv-more-menu').hidden = true; });
    $('fv-more-menu').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $('fv-more-menu').hidden = true;
      const fv = b.dataset.fv, act = b.dataset.act;
      if (fv === 'setup') { if (S && S.phase !== 'off') return note(t('Stop Forever first.'), true); note(t('Setting up Forever...')); const r = await L.foreverSetup(); if (!r.ok) note(r.error, true); else { note(t('Forever is set up.')); refreshBoard(); } return; }
      if (fv === 'folder') { const r = await L.foreverOpenFolder(); if (!r.ok) note(r.error || t('Forever is not set up yet.'), true); return; }
      if (fv === 'cleanup') { if (S && S.phase !== 'off') return note(t('Stop Forever first.'), true); note(t('Closing leftovers...')); const r = await L.foreverCleanup(); note(r.ok ? (r.closed ? t('Closed') + ' ' + r.closed + ' ' + t('leftover program(s). Try again now.') : t('Nothing was left running.')) : r.error, !r.ok); return; }
      if (act) {
        select('1.14.7');
        if (['check', 'setup', 'logs'].includes(act)) showPage('play');   // these show their progress on the Play page
        const real = document.querySelector('#more-menu [data-act="' + act + '"]'); if (real) real.click();
      }
    };
    L.onForeverUpdate((s) => { S = s; render(); });
    L.foreverState().then((s) => { S = s; render(); });
    document.addEventListener('page:shown', (e) => { if (e.detail === 'forever') { refreshBoard(); clearInterval(boardTimer); boardTimer = setInterval(refreshBoard, 15000); render(); } else { clearInterval(boardTimer); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
