'use strict';
/*
  backend-setup.js - part of "1 - SETUP.bat" for the Dauntless 1.6.2 offline package.
  Run by tools\setup.ps1 as:  node backend-setup.js <game exe path> <player name>

  It is safe to run again: it only creates what is missing.
    1. backend\metagame\.env   settings + this PC's own signing keys (made once, never printed)
    2. data\gameserver.key     the key the game servers use to talk to the backend (made once)
    3. data\player.key         your account key (made once, for the player name you chose)
    4. backend\deploy\.env     settings for the program that starts the game servers (rewritten each time)
  Everything stays inside this package folder. Nothing is sent anywhere: the backend only listens on 127.0.0.1.
*/
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const META = path.join(ROOT, 'backend', 'metagame');
const DEPLOY = path.join(ROOT, 'backend', 'deploy');
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
const META_PORT = 61000;

const [gameExe, playerName] = process.argv.slice(2);
function fail(msg) { console.error('BACKEND-SETUP FAILED: ' + msg); process.exit(1); }
if (!gameExe || !fs.existsSync(gameExe)) fail('the game exe was not given or does not exist.');
for (const p of [ROOT, gameExe]) if (p.includes("'")) fail(`this folder name contains a ' character, which the backend cannot read: ${p}. Move it to a simpler folder (for example C:\\Games) and run set-up again.`);

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const q = (p) => `'${p}'`;   // single quotes: backslashes in Windows paths are kept as they are

// ---------------------------------------------------------------- 1. metagame settings
const metaEnv = path.join(META, '.env');
if (!fs.existsSync(metaEnv)) {
    const k = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const lines = [
        '# Made by 1 - SETUP.bat. The two signing keys at the bottom are private to this PC: do not share this file.',
        `PORT=${META_PORT}`,
        'AUTH_MODE=APIKEY',
        `DB_FILENAME=${q(path.join(DATA, 'undaunted.db'))}`,
        'TARGET_CHANGELIST=271281',
        `QOS_TARGET_URL=http://127.0.0.1:${META_PORT}/QoS`,
        'MATCHMAKING_MODE=DEPLOYSERVER',
        'DEPLOYSERVER_URL=127.0.0.1:61001',
        'REGISTRATION_MODE=OPEN',
        'NODE_ENV=production',
        'PROGRESSION_MODE=real',
        'PROGRESSION_XP_TIER=0',
        `PROGRESSION_GRANT_LOG=${q(path.join(DATA, 'progression_grants.jsonl'))}`,
        `PROGRESSION_POST_LOG=${q(path.join(DATA, 'progression_posts.jsonl'))}`,
        'CELL_EXCHANGE_MAX_SECONDS=420',
        'AUTH_SIGNING_PRIVKEY_B64=' + Buffer.from(k.privateKey).toString('base64'),
        'AUTH_SIGNING_PUBKEY_B64=' + Buffer.from(k.publicKey).toString('base64'),
    ];
    fs.writeFileSync(metaEnv, lines.join('\r\n') + '\r\n', 'utf8');
    console.log('Backend settings: created.');
} else {
    console.log('Backend settings: already there.');
}

// ---------------------------------------------------------------- 2+3. keys (need the metagame running once)
const gsKeyFile = path.join(DATA, 'gameserver.key');
const playerKeyFile = path.join(DATA, 'player.key');
const readKey = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '');

function ping() {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: META_PORT, path: '/dauntless-status', timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}
function post(pathName, body) {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port: META_PORT, path: pathName, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 10000 }, (res) => {
            let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s }));
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end(data);
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const needGs = !readKey(gsKeyFile);
    const needPlayer = !readKey(playerKeyFile).startsWith('UUK_');
    if (needGs || needPlayer) {
        if (await ping()) fail('something is already using port 61000 (another Dauntless backend?). Close it, or restart the PC, and run set-up again.');
        const out = fs.openSync(path.join(LOGS, 'setup_metagame.log'), 'w');
        const child = spawn(process.execPath, ['--env-file=.env', 'dist/server.js'], { cwd: META, stdio: ['ignore', out, out], windowsHide: true });
        let exited = false; child.on('exit', () => (exited = true));
        try {
            const t0 = Date.now();
            while (!(await ping())) {
                if (exited) fail('the backend stopped right away. See logs\\setup_metagame.log.');
                if (Date.now() - t0 > 30000) fail('the backend did not start within 30 seconds. See logs\\setup_metagame.log.');
                await sleep(500);
            }
            if (needGs) {
                const Database = createRequire(path.join(META, 'package.json'))('better-sqlite3');
                const db = new Database(path.join(DATA, 'undaunted.db'));
                const key = crypto.randomBytes(24).toString('hex');
                db.prepare('INSERT INTO gameserverapikeystoregister(key) VALUES (?)').run(key);
                db.close();
                fs.writeFileSync(gsKeyFile, key, 'ascii');
                console.log('Game server key: created.');
            }
            if (needPlayer) {
                const r = await post('/undaunted/api/Register', { Username: playerName || 'Slayer' });
                let uuk = '';
                try { uuk = JSON.parse(r.body).UUK || ''; } catch { /* below */ }
                if (r.status !== 200 || !uuk.startsWith('UUK_')) fail(`making your account failed (answer ${r.status}). See logs\\setup_metagame.log.`);
                fs.writeFileSync(playerKeyFile, uuk, 'ascii');
                console.log(`Account "${playerName || 'Slayer'}": created.`);
            }
        } finally {
            child.kill();
            await sleep(1000);
        }
    } else {
        console.log('Game server key and account: already there.');
    }

    // ---------------------------------------------------------------- 4. deploy server settings (rewritten: the game folder may have moved)
    const lines = [
        '# Made by 1 - SETUP.bat (rewritten each time it runs). Do not share: the last line is a private key.',
        'PORT=61001',
        'MY_IP=127.0.0.1',
        'PORT_RANGE_BEGIN=8770',
        'PORT_RANGE_END=8777',
        `GAMESERVER_BINARY_PATH=${q(gameExe)}`,
        'SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP=5',
        'NODE_ENV=production',
        'METAGAME_API_KEY=' + readKey(gsKeyFile),
    ];
    fs.writeFileSync(path.join(DEPLOY, '.env'), lines.join('\r\n') + '\r\n', 'utf8');
    console.log('Game server settings: written.');
    console.log('BACKEND-SETUP OK');
}
main().catch((e) => fail(e && e.message ? e.message : String(e)));
