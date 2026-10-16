// Dauntless Forever - launcher tools (Host Mode: daily save backup for 1.6.2)
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Copies this package's save to backup\hostmode\<date-time>\: the database (with SQLite's own online backup, so it is
// safe while the server is running) and the per-player state folders next to it. Keeps the newest <keep> copies.
//   node tools\backup.js [keep]      -> {"ok":true,"dir":"...","files":N,"removed":[...]}
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const DB = path.join(DATA, "undaunted.db");
const SQLITE = path.join(ROOT, "backend", "metagame", "node_modules", "better-sqlite3");
const OUT = path.join(ROOT, "backup", "hostmode");
const STATE_DIRS = ["bounties", "cooldowns", "escalation", "factions", "loadouts", "pjm", "progression"];
const FILES = ["friends.json", "friend_accounts.json", "season.txt", "rules.txt", "city_events.txt"];

function out(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function copyDir(src, dst) {
    let n = 0;
    if (!fs.existsSync(src)) return 0;
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) n += copyDir(s, d);
        else if (e.isFile()) { fs.copyFileSync(s, d); n++; }
    }
    return n;
}

async function main() {
    const keep = Math.max(1, Math.min(60, parseInt(process.argv[2], 10) || 7));
    if (!fs.existsSync(DB)) { out({ ok: false, error: "No save yet (data\\undaunted.db is missing)." }); process.exit(2); }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(OUT, stamp);
    fs.mkdirSync(dir, { recursive: true });
    let files = 0;
    try {
        const Database = require(SQLITE);
        const db = new Database(DB, { readonly: true, fileMustExist: true });
        await db.backup(path.join(dir, "undaunted.db"));
        db.close();
        files++;
    } catch (e) {
        out({ ok: false, error: "Could not copy the database: " + e.message });
        process.exit(1);
    }
    for (const d of STATE_DIRS) files += copyDir(path.join(DATA, d), path.join(dir, d));
    for (const f of FILES) { const s = path.join(DATA, f); if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dir, f)); files++; } }
    // keep the newest <keep>
    const all = fs.readdirSync(OUT, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(e.name)).map(e => e.name).sort();
    const removed = [];
    while (all.length > keep) { const old = all.shift(); fs.rmSync(path.join(OUT, old), { recursive: true, force: true }); removed.push(old); }
    out({ ok: true, dir, files, removed });
}
main().catch((e) => { out({ ok: false, error: e.message }); process.exit(1); });
