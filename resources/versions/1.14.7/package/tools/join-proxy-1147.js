// Dauntless Forever - Dauntless 1.14.7 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// join-proxy-1147.js - runs on the FRIEND's PC while "LAN - JOIN.bat" joins a host through the relay.
// The game talks to its usual local backend addresses (127.0.0.1:63000-63027). This proxy listens there and sends
// each connection to the host's relay address, first telling the host's gateway which backend port it is for.
// Usage: node join-proxy-1147.js <relay address> <relay port> [ready file]
'use strict';
const net = require('net'), fs = require('fs');
const [, , HOST, PORT, READY] = process.argv;
const LO = 63000, HI = 63027;
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(HOST || '') || !(Number(PORT) > 0)) { console.log('usage: node join-proxy-1147.js <relay address> <relay port> [ready file]'); process.exit(2); }
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
let open = 0, failed = false;
for (let p = LO; p <= HI; p++) {
  const s = net.createServer((client) => {
    client.setNoDelay(true);
    const up = net.connect(Number(PORT), HOST);
    up.setNoDelay(true);
    const kill = () => { client.destroy(); up.destroy(); };
    up.on('error', kill); client.on('error', kill); up.on('close', kill); client.on('close', kill);
    up.on('connect', () => { up.write(`DFPORT ${p}\n`); client.pipe(up); up.pipe(client); });
  });
  s.on('error', (e) => { if (!failed) { failed = true; log(`cannot use port ${p} on this PC (${e.code || e.message}). Is Dauntless 1.14.7 still running here?`); process.exit(1); } });
  s.listen(p, '127.0.0.1', () => {
    if (++open === HI - LO + 1) {
      log(`join proxy ready: 127.0.0.1:${LO}-${HI} -> ${HOST}:${PORT}`);
      if (READY) try { fs.writeFileSync(READY, JSON.stringify({ host: HOST, port: Number(PORT), pid: process.pid })); } catch (e) {}
    }
  });
}
const bye = () => { if (READY) try { fs.unlinkSync(READY); } catch (e) {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
