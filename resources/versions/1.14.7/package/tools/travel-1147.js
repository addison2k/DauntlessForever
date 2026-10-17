// Dauntless Forever - Dauntless 1.14.7 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// travel-1147.js - your own 1.14.7 character goes with you to a LAN host's game and comes home afterwards.
// Same idea as 1.6.2's travel.js. Used by tools\lan-join-1147.ps1:
//   node travel-1147.js send <host address> <LAN Epic id> <package folder>   your home save -> the host (for this game)
//   node travel-1147.js home <host address> <LAN Epic id> <package folder>   the host's copy -> your home save
// The home save (data\state.json) is backed up to backup\travel\ before anything is written to it.
// Exit codes: 0 done, 2 nothing to do (no home character / host has none), 3 refused (looks wrong), 1 error.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const [, , what, host, epicId, root] = process.argv;
if (!/^(send|home)$/.test(what || '') || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host || '') || !/^[0-9a-f]{32}$/.test(epicId || '') || !root) {
  console.log('usage: node travel-1147.js send|home <host address> <LAN Epic id> <package folder>'); process.exit(1);
}
const key = crypto.createHash('sha256').update('epic:' + epicId).digest('hex').slice(0, 32);   // the key the host's backend gives this sign-in
const stateFile = path.join(root, 'data', 'state.json');
const pendingFile = path.join(root, 'data', 'travel_pending.json');

function request(method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host, port: 63000, path: '/_travel/' + key, method, timeout: 30000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('the host did not answer in time')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function readState() { return JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '')); }
function homeKey(st) { return st.lastPlayer && st.players && st.players[st.lastPlayer] ? st.lastPlayer : null; }
function backup(tag) {
  const dir = path.join(root, 'backup', 'travel');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const to = path.join(dir, `state_${stamp}_${tag}.json`);
  fs.copyFileSync(stateFile, to);
  // keep the newest 20
  const all = fs.readdirSync(dir).filter((f) => /^state_.*\.json$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 20))) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
  return to;
}
function itemCount(p) {
  let n = 0;
  for (const inv of Object.values(p.inventory || {})) if (inv) n += (inv.instancedItems || []).length + (inv.stackedItems || []).length;
  return n;
}

(async () => {
  try {
    if (!fs.existsSync(stateFile)) { console.log('No 1.14.7 character on this PC yet: you play with a new character on the host.'); process.exit(2); }
    const st = readState();
    const hk = homeKey(st);
    if (what === 'send') {
      if (!hk || !(st.players[hk].characters || []).length) { console.log('No 1.14.7 character on this PC yet: you play with a new character on the host.'); process.exit(2); }
      const me = st.players[hk];
      backup('before-join');
      const r = await request('PUT', { player: me });
      if (r.status !== 200) { console.log(`The host did not take your character (${r.status}${r.json && r.json.error ? ': ' + r.json.error : ''}). You play with the host's copy.`); process.exit(3); }
      fs.writeFileSync(pendingFile, JSON.stringify({ host, epicId, at: new Date().toISOString() }));
      console.log(`Your character${me.characters.length > 1 ? 's' : ''} went to the host (${me.characters.map((c) => c.name).join(', ')}).`);
      process.exit(0);
    }
    // home
    const r = await request('GET');
    if (r.status === 404) { console.log('The host has no character of yours to send back.'); try { fs.unlinkSync(pendingFile); } catch (e) {} process.exit(2); }
    if (r.status !== 200 || !r.json || !r.json.player) throw new Error(`the host answered ${r.status}`);
    const back = r.json.player;
    if (!hk) { console.log('This PC has no home save to bring the character into. Nothing changed.'); process.exit(3); }
    const mine = st.players[hk];
    // Sanity: never let a broken copy replace the home save.
    const problems = [];
    if (!Array.isArray(back.characters) || !back.characters.length) problems.push('no characters');
    else if (back.characters.length < (mine.characters || []).length) problems.push('fewer characters than at home');
    for (const c of back.characters || []) { try { if (c.data) JSON.parse(c.data); } catch (e) { problems.push(`character ${c.name} has broken data`); } }
    const before = itemCount(mine), after = itemCount(back);
    if (before >= 20 && after < before / 2) problems.push(`items dropped from ${before} to ${after}`);
    if (problems.length) { console.log('The copy from the host looks wrong (' + problems.join('; ') + '). Your home save was NOT changed.'); process.exit(3); }
    const saved = backup('before-home');
    const home = Object.assign({}, back, { accountId: mine.accountId, epicId: mine.epicId, username: mine.username || back.username });
    delete home.travelledIn; delete home.candidate; delete home.partyId;
    st.players[hk] = home;
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2)); fs.renameSync(tmp, stateFile);
    try { fs.unlinkSync(pendingFile); } catch (e) {}
    console.log(`Your character is home again (backup of the save before: ${path.relative(root, saved)}).`);
    process.exit(0);
  } catch (e) {
    console.log('Travel did not work: ' + e.message + (what === 'home' ? '. Your home save was NOT changed; next LAN - JOIN with this host brings it home first.' : ''));
    process.exit(1);
  }
})();
