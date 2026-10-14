// Dauntless Forever - relay client (runs on the HOST PC, started by "ONLINE - HOST.bat").
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever  Licence: AGPL-3.0-only.
//
// Connects OUT to the Dauntless Forever relay on the VPS and passes players' traffic to this PC's own backend
// (TCP 127.0.0.1:61000) and game servers (UDP 127.0.0.1:8770-8777). Only outgoing connections: nothing to open
// on the router or in Windows Firewall, no administrator rights.
//
// Usage: node relay-client.js <relay host> [control port] [status file]
// Writes the status file (JSON) when connected: {"ip":"x.x.x.x","base":21000,"slot":0,"time":"..."}; deletes it on exit.
'use strict';
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');

const RELAY = process.argv[2] || process.env.RELAY_HOST;
const CONTROL_PORT = Number(process.argv[3] || process.env.RELAY_CONTROL_PORT) || 7000;
let TUNNEL_PORT = Number(process.env.RELAY_TUNNEL_PORT) || CONTROL_PORT + 1;   // the relay says which in its 'ok'
const STATUS = process.argv[4] || process.env.RELAY_STATUS_FILE || '';
const RELAY_KEY = process.env.RELAY_KEY || 'dauntless-forever';
const LOCAL_TCP = Number(process.env.LOCAL_BACKEND_PORT) || 61000;
const LOCAL_UDP_BASE = Number(process.env.LOCAL_GAME_PORT_BASE) || 8770;
const NUDP = 8;
const IDLE_MS = 3 * 60 * 1000;

if (!RELAY) { console.error('usage: node relay-client.js <relay host> [control port] [status file]'); process.exit(2); }
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const writeStatus = o => { if (STATUS) try { fs.writeFileSync(STATUS, JSON.stringify(o)); } catch {} };
const clearStatus = () => { if (STATUS) try { fs.unlinkSync(STATUS); } catch {} };
process.on('exit', clearStatus);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

let session = null;          // {token, tokenBuf, base, ip}
let ctrl = null;
let tunnel = null;
const flows = new Map();     // "idx|ip|port" -> {sock, last}
let stats = { up: 0, down: 0 };

function startTunnel() {
    if (tunnel) return;
    tunnel = dgram.createSocket('udp4');
    tunnel.on('error', e => log('tunnel error:', e.message));
    tunnel.on('message', msg => {
        if (msg[0] !== 0x01 || msg.length < 8 || !session) return;
        const idx = msg[1];
        if (idx >= NUDP) return;
        const head = msg.subarray(0, 8);
        const key = idx + '|' + head.toString('hex', 2, 8);
        let f = flows.get(key);
        if (!f) {
            // one local socket per player and port, so the game server sees each player as a separate address
            const sock = dgram.createSocket('udp4');
            const back = Buffer.from(head);           // same header for replies
            f = { sock, last: Date.now() };
            sock.on('message', reply => {
                f.last = Date.now();
                stats.up += reply.length;
                if (session) tunnel.send([back, reply], TUNNEL_PORT, RELAY);
            });
            sock.on('error', () => {});
            sock.bind(0, '127.0.0.1');
            flows.set(key, f);
        }
        f.last = Date.now();
        stats.down += msg.length - 8;
        f.sock.send(msg.subarray(8), LOCAL_UDP_BASE + idx, '127.0.0.1');
    });
    tunnel.bind(0);
}

function register() {
    if (session && tunnel) tunnel.send(Buffer.concat([Buffer.from([0x00]), session.tokenBuf]), TUNNEL_PORT, RELAY);
}

function attach(id) {
    const remote = net.connect(CONTROL_PORT, RELAY);
    const local = net.connect(LOCAL_TCP, '127.0.0.1');
    remote.setNoDelay(true); local.setNoDelay(true);
    const kill = () => { remote.destroy(); local.destroy(); };
    remote.on('error', kill); local.on('error', kill);
    remote.on('close', kill); local.on('close', kill);
    remote.write(JSON.stringify({ op: 'attach', token: session.token, id }) + '\n');
    remote.pipe(local); local.pipe(remote);
}

function connect() {
    let buf = '';
    ctrl = net.connect(CONTROL_PORT, RELAY);
    ctrl.setNoDelay(true);
    ctrl.setKeepAlive(true, 15000);
    ctrl.on('connect', () => ctrl.write(JSON.stringify({ op: 'hello', v: 1, key: RELAY_KEY }) + '\n'));
    ctrl.on('data', chunk => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            let m; try { m = JSON.parse(line); } catch { continue; }
            if (m.op === 'ok') {
                if (Number(m.tunnelPort)) TUNNEL_PORT = Number(m.tunnelPort);
                session = { token: m.token, tokenBuf: Buffer.from(m.token, 'hex'), base: m.base, ip: m.ip || RELAY, slot: m.slot };
                startTunnel();
                register();
                writeStatus({ ip: session.ip, base: session.base, slot: session.slot, time: new Date().toISOString() });
                log(`RELAY CONNECTED: players use ${session.ip}:${session.base} (slot ${session.slot})`);
            } else if (m.op === 'tcp' && session) {
                attach(m.id);
            } else if (m.op === 'pong') {
                lastPong = Date.now();
            } else if (m.op === 'error') {
                log('relay refused:', m.msg);
            }
        }
    });
    ctrl.on('error', e => log('relay connection error:', e.code || e.message));
    ctrl.on('close', () => {
        if (session) log('relay connection lost; reconnecting in 5 s (the join address may change)');
        session = null; clearStatus();
        for (const f of flows.values()) try { f.sock.close(); } catch {}
        flows.clear();
        setTimeout(connect, 5000);
    });
}

let lastPong = Date.now();
setInterval(() => {
    if (session && ctrl) { ctrl.write(JSON.stringify({ op: 'ping' }) + '\n'); register(); }
    const now = Date.now();
    for (const [k, f] of flows) if (now - f.last > IDLE_MS) { try { f.sock.close(); } catch {} flows.delete(k); }
}, 10000);
setInterval(() => {
    if (session) log(`relay: ${flows.size} game connection(s), ${(stats.down / 1e6).toFixed(1)} MB in, ${(stats.up / 1e6).toFixed(1)} MB out`);
}, 60000);

log(`Connecting to the Dauntless Forever relay at ${RELAY}:${CONTROL_PORT}...`);
connect();
