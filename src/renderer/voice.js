// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// voice.js (window) - the microphone, one WebRTC connection per person in the voice room, and the Voice card
// on the Friends page. main/voice.js decides which room we are in and carries the offers/answers.
//
//   - Who calls whom: the one with the smaller friends id makes the offer; the other answers. A launcher that
//     comes back (restart) says "hello" and the caller offers again.
//   - Offers and answers carry all their ICE candidates (we wait for gathering, at most 3 s), so one message
//     each way is enough.
//   - What is sent: a copy of the microphone track, switched on only while the push-to-talk key is held (with a
//     short tail so the last word is not cut) or, in "when I speak" mode, while the voice level is over the
//     sensitivity line. Muted = never.
'use strict';
(function () {
  const L = window.launcher;
  if (!L || !L.voiceState) return;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  let S = null;                 // state from main
  const pcs = new Map();        // peer id -> { pc, audio, analyser, level, failedAt }
  let mic = null;               // { stream, send (track), analyser, ctx }
  let micDeviceId = null;
  let ptt = false, pttTail = null, vadOpen = false, vadUntil = 0, talking = false;
  let audioCtx = null;
  const speaking = new Map();   // peer id -> bool

  const ac = () => audioCtx || (audioCtx = new AudioContext());

  // ------------------------------------------------------------------ microphone
  // Windows can sit on a microphone request (privacy settings): never wait more than 10 s
  function askMic(audio) {
    return Promise.race([navigator.mediaDevices.getUserMedia({ audio }),
      new Promise((_, no) => setTimeout(() => no(new Error('Windows did not hand over the microphone in time')), 10000))]);
  }
  let micPending = null;
  function ensureMic() {
    if (!micPending) micPending = openMic().finally(() => { micPending = null; });
    return micPending;
  }
  async function openMic() {
    const want = (S && S.settings.inputId) || '';
    if (mic && micDeviceId === want) return mic;
    stopMic();
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (want) audio.deviceId = { exact: want };
    let stream;
    try { stream = await askMic(audio); }
    catch (e) {
      if (want) { stream = await askMic({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
      else throw e;
    }
    const src = stream.getAudioTracks()[0];
    const send = src.clone();
    send.enabled = false;
    const an = ac().createAnalyser(); an.fftSize = 512;
    ac().createMediaStreamSource(new MediaStream([src])).connect(an);
    mic = { stream, src, send, analyser: an, buf: new Float32Array(an.fftSize) };
    micDeviceId = want;
    for (const p of pcs.values()) { const s = p.pc.getSenders().find(x => x.track && x.track.kind === 'audio') || p.sender; if (s) s.replaceTrack(send).catch(() => {}); }
    refreshDevices();
    return mic;
  }
  function stopMic() {
    if (!mic) return;
    try { mic.send.stop(); mic.src.stop(); mic.stream.getTracks().forEach(t => t.stop()); } catch {}
    mic = null; micDeviceId = null;
  }
  function level(an, buf) {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return Math.max(0, Math.min(100, (Math.log10(rms + 1e-6) + 3.2) * 40));   // ~0 silence, ~100 shouting
  }

  // ------------------------------------------------------------------ connections
  const iAmCaller = (peerId) => S && S.me && S.me < peerId;
  function newPc(peerId) {
    closePc(peerId);
    const pc = new RTCPeerConnection({ iceServers: (S.room && S.room.iceServers) || [] });
    const entry = { pc, audio: null, analyser: null, buf: null, failedAt: 0, sender: null, offerId: null, made: Date.now() };
    if (mic) entry.sender = pc.addTrack(mic.send, new MediaStream([mic.send]));
    else entry.sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (!entry.audio) { entry.audio = new Audio(); entry.audio.autoplay = true; }
      entry.audio.srcObject = stream;
      entry.audio.volume = volumeOf(peerId);
      entry.audio.play().catch(() => {});
      try {
        const an = ac().createAnalyser(); an.fftSize = 512;
        ac().createMediaStreamSource(stream).connect(an);
        entry.analyser = an; entry.buf = new Float32Array(an.fftSize);
      } catch {}
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'disconnected') { if (!entry.failedAt) entry.failedAt = Date.now(); }
      else entry.failedAt = 0;
      render();
    };
    pcs.set(peerId, entry);
    return entry;
  }
  function closePc(peerId) {
    const e = pcs.get(peerId); if (!e) return;
    try { e.pc.close(); } catch {}
    if (e.audio) { try { e.audio.pause(); e.audio.srcObject = null; } catch {} }
    pcs.delete(peerId); speaking.delete(peerId);
  }
  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(t); res(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const t = setTimeout(done, 3000);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
  const signal = (to, obj) => L.voiceSignal(to, JSON.stringify(obj));
  async function call(peerId) {
    const e = newPc(peerId);
    e.offerId = Math.random().toString(36).slice(2);
    try {
      await e.pc.setLocalDescription(await e.pc.createOffer());
      await gathered(e.pc);
      if (pcs.get(peerId) !== e) return;
      await signal(peerId, { t: 'offer', n: e.offerId, sdp: e.pc.localDescription.sdp });
    } catch (err) { console.warn('voice offer', err); }
  }
  async function onSignal(from, msg) {
    if (!S || !S.room) return;
    if (msg.t === 'hello') {
      // they (re)started: offer again, unless our offer to them is brand new and still on its way
      const e = pcs.get(from);
      if (iAmCaller(from) && !(e && e.pc.connectionState !== 'failed' && Date.now() - e.made < 5000)) call(from);
      return;
    }
    if (msg.t === 'offer') {
      const e = newPc(from);
      try {
        await e.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await e.pc.setLocalDescription(await e.pc.createAnswer());
        await gathered(e.pc);
        if (pcs.get(from) !== e) return;
        await signal(from, { t: 'answer', n: msg.n, sdp: e.pc.localDescription.sdp });
      } catch (err) { console.warn('voice answer', err); }
      return;
    }
    if (msg.t === 'answer') {
      const e = pcs.get(from);
      if (e && e.offerId === msg.n && e.pc.signalingState === 'have-local-offer') { try { await e.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); } catch (err) { console.warn('voice answer in', err); } }
    }
  }
  // match the connections to the people in the room
  async function syncPeers() {
    if (!S || !S.room) {
      for (const id of [...pcs.keys()]) closePc(id);
      stopMic(); return;
    }
    try { await ensureMic(); } catch (e) { setNote('Voice: no microphone (' + (e.message || e.name) + '). Check Windows Settings > Privacy > Microphone.', true); }
    const ids = new Set(S.peers.map(p => p.id));
    for (const id of [...pcs.keys()]) if (!ids.has(id)) closePc(id);
    for (const p of S.peers) {
      if (pcs.has(p.id)) continue;
      if (iAmCaller(p.id)) call(p.id);
      else { newPc(p.id); signal(p.id, { t: 'hello' }); }
    }
  }
  // a connection that stays broken is rebuilt (the caller offers again)
  setInterval(() => {
    for (const [id, e] of pcs) {
      // nothing came back for 10 s (a message lost on the way): try again
      if (!e.pc.remoteDescription && Date.now() - e.made > 10000) {
        e.made = Date.now();
        if (iAmCaller(id)) call(id); else signal(id, { t: 'hello' });
        continue;
      }
      if (e.failedAt && Date.now() - e.failedAt > 6000) {
        e.failedAt = 0;
        if (iAmCaller(id)) call(id); else signal(id, { t: 'hello' });
      }
    }
  }, 2000);

  // ------------------------------------------------------------------ talking
  function updateTalking() {
    if (!S) return;
    const c = S.settings;
    let lvl = 0;
    if (mic) lvl = level(mic.analyser, mic.buf);
    if (c.mode === 'vad') {
      const line = 100 - c.vadLevel;   // higher sensitivity = lower line
      if (lvl >= line) { vadOpen = true; vadUntil = Date.now() + 350; } else if (Date.now() > vadUntil) vadOpen = false;
    }
    const want = !!(S.room && mic && !c.muted && (c.mode === 'ptt' ? (ptt || pttTail) : vadOpen));
    if (mic && mic.send.enabled !== want) mic.send.enabled = want;
    if (want !== talking) { talking = want; render(); }
    const meter = $('vc-meter'); if (meter) meter.style.width = Math.round(lvl) + '%';
    const mark = $('vc-line'); if (mark) mark.style.left = (100 - c.vadLevel) + '%';
    let changed = false;
    for (const [id, e] of pcs) {
      const sp = !!(e.analyser && level(e.analyser, e.buf) > 45);
      if (speaking.get(id) !== sp) { speaking.set(id, sp); changed = true; }
    }
    if (changed) render();
  }
  setInterval(updateTalking, 60);
  // for troubleshooting from the developer tools: the connection state and sound level of each person
  window.voiceDebug = () => [...pcs].map(([id, e]) => ({ id, state: e.pc.connectionState, level: e.analyser ? Math.round(level(e.analyser, e.buf)) : null }));

  // ------------------------------------------------------------------ the Voice card
  function setNote(t, err) { const n = $('vc-note'); if (n) { n.textContent = t || ''; n.classList.toggle('err', !!err); } }
  const volumeOf = (id) => { const v = S && S.settings.volumes ? S.settings.volumes[id] : undefined; return v === undefined ? 1 : Math.max(0, Math.min(1, v / 100)); };
  async function refreshDevices() {
    const sel = $('vc-input'); if (!sel || !navigator.mediaDevices) return;
    let list = [];
    try { list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch {}
    const cur = (S && S.settings.inputId) || '';
    sel.textContent = '';
    sel.append(new Option('Windows default', ''));
    list.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => sel.append(new Option(d.label || ('Microphone ' + (i + 1)), d.deviceId)));
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }

  function render() {
    if (!S) return;
    const card = $('vc-card'); if (!card) return;
    card.hidden = !!S.offline;
    const c = S.settings;
    const status = $('vc-status');
    const how = c.mode === 'ptt' ? (c.pttKeyName ? `hold ${c.pttKeyName}` : 'set a push-to-talk key (gear)') : 'talks when you speak';
    const others = S.room ? S.peers.map(p => p.name) : [];
    const title = $('vc-title');
    if (title) title.textContent = S.room ? (others.length ? `Voice with ${others.join(', ')}` : 'Voice: just you so far') : 'Voice';
    if (S.room) status.textContent = c.muted ? 'Muted' : (c.mode === 'ptt' && c.pttKeyName ? `Hold ${c.pttKeyName} to talk` : how);
    else if (S.available) status.textContent = (c.auto && !S.available.public) ? 'Joining voice...' : 'Ready: open the gear to join';
    else status.textContent = 'Starts when you host or join';
    status.title = S.room ? `In voice: ${S.room.name}` : '';
    if (S.error) setNote(S.error, true);
    const micEl = $('vc-mic');
    if (micEl) { micEl.className = 'vc-mic' + (S.room ? (c.muted ? ' muted' : (talking ? ' talk' : ' live')) : ''); }
    const railV = $('fp-rail-voice'); if (railV) { railV.hidden = !S.room; railV.style.color = S.room && c.muted ? 'var(--ember)' : ''; }

    const jb = $('vc-join'); jb.hidden = !!S.room || !S.available;
    const lb = $('vc-leave'); lb.hidden = !S.room;
    const mb = $('vc-mute'); mb.hidden = !S.room; mb.textContent = c.muted ? 'Unmute' : 'Mute';
    mb.classList.toggle('on', !!c.muted);

    const list = $('vc-people');
    // leave the list alone while a volume slider in it is being dragged
    const dragging = list.contains(document.activeElement) && document.activeElement.type === 'range';
    if (!dragging) { list.textContent = ''; }
    list.hidden = !S.room;
    if (S.room && !dragging) {
      const me = el('div', 'vc-row');
      const who = el('div', 'fr-who'); who.append(el('span', 'vc-dot' + (talking ? ' talk' : '')), el('span', 'fr-name', 'You'));
      if (!mic) who.append(el('span', 'fr-status', 'no microphone'));
      me.append(who); list.append(me);
      for (const p of S.peers) {
        const e = pcs.get(p.id);
        const st = e ? e.pc.connectionState : 'new';
        const row = el('div', 'vc-row');
        const who2 = el('div', 'fr-who');
        who2.append(el('span', 'vc-dot' + (speaking.get(p.id) ? ' talk' : '')), el('span', 'fr-name', p.name));
        if (st !== 'connected') who2.append(el('span', 'fr-status', st === 'failed' || st === 'disconnected' ? 'reconnecting...' : 'connecting...'));
        const vol = el('input', 'vc-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '100';
        vol.value = String(Math.round(volumeOf(p.id) * 100)); vol.title = `${p.name}'s volume`;
        vol.oninput = () => { const ent = pcs.get(p.id); if (ent && ent.audio) ent.audio.volume = vol.value / 100; };
        vol.onchange = () => { const v = Object.assign({}, S.settings.volumes || {}); v[p.id] = Number(vol.value); L.voiceSettings({ volumes: v }); };
        row.append(who2, vol); list.append(row);
      }
      if (!S.peers.length) list.append(el('div', 'fr-empty', 'Nobody else is in voice yet.'));
    }

    // settings
    $('vc-mode-ptt').checked = c.mode === 'ptt';
    $('vc-mode-vad').checked = c.mode === 'vad';
    $('vc-key').textContent = capturing ? 'Press a key or mouse button... (Esc cancels)' : (c.pttKeyName || 'not set');
    $('vc-key').classList.toggle('waiting', capturing);
    $('vc-setkey').textContent = capturing ? 'Cancel' : (c.pttKeyName ? 'Change' : 'Set key');
    $('vc-ptt-row').classList.toggle('dim', c.mode !== 'ptt');
    $('vc-vad-row').classList.toggle('dim', c.mode !== 'vad');
    $('vc-sens').value = String(c.vadLevel);
    $('vc-auto').checked = !!c.auto;
  }

  let capturing = false;
  async function onState(s) {
    const roomChanged = !S || JSON.stringify(S.room && S.room.id) !== JSON.stringify(s.room && s.room.id);
    const inputChanged = S && S.settings.inputId !== s.settings.inputId;
    S = s;
    if (roomChanged) { for (const id of [...pcs.keys()]) closePc(id); }
    if (inputChanged && mic) { stopMic(); }
    render();                               // the bar shows the state at once; the microphone can take a moment
    try { await syncPeers(); } catch (e) { setNote('Voice: ' + (e.message || e), true); }
    for (const [id, e] of pcs) if (e.audio) e.audio.volume = volumeOf(id);
    render();
  }

  async function init() {
    $('vc-join').onclick = async () => { const r = await L.voiceJoin(); if (r && r.ok === false) setNote(r.error, true); else setNote(''); };
    $('vc-leave').onclick = async () => { await L.voiceLeave(); setNote('You left voice. Join again any time.'); };
    $('vc-mute').onclick = () => L.voiceSettings({ muted: !(S && S.settings.muted) });
    $('vc-mode-ptt').onchange = () => L.voiceSettings({ mode: 'ptt' });
    $('vc-mode-vad').onchange = () => L.voiceSettings({ mode: 'vad' });
    $('vc-sens').oninput = () => { if (S) { S.settings.vadLevel = Number($('vc-sens').value); } };
    $('vc-sens').onchange = () => L.voiceSettings({ vadLevel: Number($('vc-sens').value) });
    $('vc-auto').onchange = () => L.voiceSettings({ auto: $('vc-auto').checked });
    $('vc-input').onchange = () => L.voiceSettings({ inputId: $('vc-input').value });
    $('vc-setkey').onclick = async () => {
      if (capturing) { L.voiceCancelCapture(); return; }
      capturing = true; render(); setNote('');
      const r = await L.voiceCaptureKey();
      capturing = false;
      if (r && r.ok) setNote(`Push to talk: ${r.key}. The game still sees this key, so pick one it does not use.`);
      else if (r && r.error) setNote(r.error, true);
      render();
    };
    $('vc-clearkey').onclick = () => L.voiceSettings({ clearKey: true });
    // the gear opens the voice settings above the bar; a click anywhere else closes them (not while waiting for a key)
    const pop = $('vc-pop'), gear = $('vc-gear');
    // voice settings open in their own window over the launcher, so the friends list stays as it is
    const setPop = (open) => { if (open) { if (!pop.open) pop.showModal(); refreshDevices(); } else if (pop.open) pop.close(); gear.setAttribute('aria-expanded', String(open)); };
    gear.onclick = () => setPop(!pop.open);
    $('vc-close').onclick = () => { if (capturing) L.voiceCancelCapture(); setPop(false); };
    pop.addEventListener('cancel', (e) => { if (capturing) { e.preventDefault(); return; } gear.setAttribute('aria-expanded', 'false'); });
    pop.addEventListener('mousedown', (e) => {   // a click on the dimmed backdrop (outside the box) closes it
      if (e.target !== pop || capturing) return;
      const r = pop.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setPop(false);
    });
    L.onVoiceUpdate((s) => { onState(s); });
    L.onVoiceSignals((list) => { for (const m of list) { try { onSignal(m.from, JSON.parse(m.data)); } catch {} } });
    L.onVoicePtt((p) => {
      if (p.down) { ptt = true; clearTimeout(pttTail); pttTail = null; }
      else { ptt = false; pttTail = setTimeout(() => { pttTail = null; }, 200); }
    });
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    await onState(await L.voiceState());
    refreshDevices();
    // the browser keeps audio off until the page has been used once
    document.addEventListener('click', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); for (const e of pcs.values()) if (e.audio) e.audio.play().catch(() => {}); }, { capture: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
