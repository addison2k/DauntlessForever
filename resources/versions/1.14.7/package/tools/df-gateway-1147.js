// Dauntless Forever - Dauntless 1.14.7 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// df-gateway-1147.js - runs on the HOST PC while "ONLINE - HOST.bat" is open.
// The relay gives a host ONE public TCP port, but the 1.14.7 backend has 28 (63000-63027). The relay passes every
// friend's backend connection to this gateway (127.0.0.1:63099), whose first line says which backend port it is for
// ("DFPORT 63005\n", written by the friend's tools\join-proxy-1147.js); the gateway connects it there. A connection
// without that line (the game's latency ping, a browser) goes to 63000. Only 63000-63027 on this PC can be reached.
'use strict';
const net = require('net');
const LISTEN = Number(process.env.DF_GATEWAY_PORT) || 63099;
const LO = 63000, HI = 63027;
const SHIFT = Number(process.env.DF_GATEWAY_TEST_SHIFT) || 0;   // tests only: a backend on other ports (unset = 0)
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
let count = 0;
const server = net.createServer((client) => {
  client.setNoDelay(true);
  let head = Buffer.alloc(0), done = false;
  const timer = setTimeout(() => route(LO), 3000);   // nothing said in 3 s: treat as a plain connection
  function route(port, rest) {
    if (done) return; done = true; clearTimeout(timer);
    client.removeListener('data', onData);
    const up = net.connect(port + SHIFT, '127.0.0.1');
    up.setNoDelay(true);
    const kill = () => { client.destroy(); up.destroy(); };
    up.on('error', kill); client.on('error', kill); up.on('close', kill); client.on('close', kill);
    up.on('connect', () => { if (rest && rest.length) up.write(rest); client.pipe(up); up.pipe(client); });
    count++;
  }
  function onData(chunk) {
    head = Buffer.concat([head, chunk]);
    if (head.length >= 7 && head.subarray(0, 7).toString('latin1') !== 'DFPORT ') { route(LO, head); return; }
    const nl = head.indexOf(10);
    if (nl < 0) { if (head.length > 32) route(LO, head); return; }
    const port = Number(head.subarray(7, nl).toString('latin1').trim());
    if (!(port >= LO && port <= HI)) { done = true; clearTimeout(timer); client.destroy(); return; }
    route(port, head.subarray(nl + 1));
  }
  client.on('data', onData);
  client.on('error', () => {});
});
server.on('error', (e) => { log('gateway error:', e.code || e.message); process.exit(1); });
server.listen(LISTEN, '127.0.0.1', () => log(`gateway ready on 127.0.0.1:${LISTEN} -> backend ports ${LO}-${HI}`));
setInterval(() => log(`gateway: ${count} connection(s) so far`), 300000);
