// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// travel.js - your own account on this PC, from the command line (run with the package's Node.js while this
// PC's backend is stopped):
//
//   node travel.js send  <host:port> <key>   take your character to a friend's game (before joining it)
//   node travel.js fetch <host:port> <key>   bring it home again, with what you earned there (after the game)
//   node travel.js autosave <host:port> <key>  while you play there: bring it home now and then (DF-ONLINE-1)
//   node travel.js backup                    keep a copy of your character in data\travel-backups (before joining)
//   node travel.js name  <name>              set your player name (the launcher keeps it the same everywhere)
//   node travel.js export <file> | import <file>
//
// Exit code 0 = done, 2 = nothing to do (no account on this PC yet, or nothing new), 1 = failed (the reason is printed),
// 3 = refused: what the host sent back looked wrong (a wiped or damaged character), so it was not brought home.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const META = path.join(ROOT, 'backend', 'metagame');
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'undaunted.db');
const out = (t) => console.log(t);
const fail = (t) => { console.log('STOPPED: ' + t); process.exit(1); };

function openDb() {
    if (!fs.existsSync(DB_FILE)) return null;
    const Database = createRequire(path.join(META, 'package.json'))('better-sqlite3');
    return new Database(DB_FILE);
}
function myAccount(db) {
    const keyFile = path.join(DATA, 'player.key');
    const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
    if (!key.startsWith('UUK_')) return null;
    const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    let row = db.prepare('SELECT userId FROM userapikeys WHERE keyHash = ?').get(hash);
    if (!row) { try { row = db.prepare('SELECT userId FROM userapikeystoregister WHERE key = ?').get(key); } catch { /* table missing */ } }
    return row ? row.userId : null;
}
function travel() { return require(path.join(META, 'dist', 'travel162.js')); }

function request(method, hostPort, apiPath, key, body) {
    const [host, port] = hostPort.split(':');
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port: Number(port) || 61000, path: apiPath, method, timeout: 60000,
            headers: Object.assign({ 'X-Undaunted-User-Api-Key': key }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let j = null; try { j = JSON.parse(text); } catch { /* below */ }
                if (res.statusCode === 200 && j) resolve(j);
                else reject(new Error((j && j.error) || (res.statusCode === 404 ? 'the host\'s server files are older and cannot take your character yet (they get it with the next update)' : `the host answered ${res.statusCode}`)));
            });
        });
        req.on('timeout', () => req.destroy(new Error('the host did not answer in time')));
        req.on('error', reject);
        req.end(data || undefined);
    });
}

async function main() {
    const [cmd, a, b] = process.argv.slice(2);
    const db = openDb();
    if (!db) { out('No account on this PC yet for this version: nothing to do.'); process.exit(2); }
    const me = myAccount(db);
    if (!me) { out('No account on this PC yet for this version: nothing to do.'); process.exit(2); }
    const dataDir = DATA;
    if (cmd === 'export') { fs.writeFileSync(a, JSON.stringify(travel().ExportAccount(db, dataDir, me))); out('Exported.'); return; }
    if (cmd === 'import') { const r = travel().ImportAccount(db, dataDir, me, JSON.parse(fs.readFileSync(a, 'utf8')), 'file'); out(`Imported ${r.characters} character(s).`); return; }
    if (cmd === 'name') {
        const name = String(a || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) fail('names are 3-16 letters, numbers or _');
        db.prepare('UPDATE users SET name = ? WHERE userId = ?').run(name, me);
        out(`Player name: ${name}`); return;
    }
    if (cmd === 'send') {
        const bundle = travel().ExportAccount(db, dataDir, me);
        if (!bundle.characters.length) { out('You have no character on this PC yet: the host makes a new one for you.'); process.exit(2); }
        const r = await request('POST', a, '/undaunted/api/travel/import', b, { bundle });
        out(`Your character came along (${r.characters} character(s)).`);
        return;
    }
    if (cmd === 'backup') {
        const t = travel();
        if (t.BackupAccount) t.BackupAccount(db, dataDir, me, 'before-join');
        out('Kept a copy of your character in data\\travel-backups.');
        return;
    }
    if (cmd === 'fetch' || cmd === 'autosave') {
        const auto = cmd === 'autosave';
        const bundle = await request('GET', a, '/undaunted/api/travel/export', b);
        if (!bundle.characters || !bundle.characters.length) { if (!auto) out('The host has no character for you: nothing to bring home.'); process.exit(2); }
        // autosave: only when something changed since the last one
        const stamp = path.join(DATA, 'travel_autosave.json');
        // (a canonical form: the same rows in another order or with keys in another order are the same character)
        const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).sort().join(',') + ']'
            : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
        const hash = crypto.createHash('sha256').update(canon([bundle.characters, bundle.tables, bundle.files])).digest('hex');
        if (auto) { let last = null; try { last = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { /* first one */ } if (last && last.hash === hash && last.host === a) process.exit(2); }
        const t = travel();
        const bad = t.CheckHomecoming ? t.CheckHomecoming(db, dataDir, me, bundle) : '';
        if (bad) { out(`Not brought home: what the host sent back looks wrong (${bad}). Your own character on this PC is unchanged.`); process.exit(3); }
        const r = t.ImportAccount(db, dataDir, me, bundle, auto ? 'autosave' : 'home');
        try { fs.writeFileSync(stamp, JSON.stringify({ hash, host: a, at: new Date().toISOString() })); } catch { /* only saves a repeat */ }
        if (auto) out(`Saved your character home (${new Date().toTimeString().slice(0, 5)}).`);
        else out(`Your character is home again, with what you earned (${r.characters} character(s)).`);
        return;
    }
    fail('usage: node travel.js send|fetch|autosave <host:port> <key> | backup | name <name> | export <file> | import <file>');
}
main().catch((e) => fail(e.message));
