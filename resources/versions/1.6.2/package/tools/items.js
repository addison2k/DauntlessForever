// Dauntless Forever - launcher tools (Inventory page helper for 1.6.2)
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Reads and changes the stacked items (currencies, tokens, materials) in this package's save, data\undaunted.db.
// Run by the launcher with the package's Node.js, from the package folder:
//   node tools\items.js list
//       -> {"ok":true,"characters":[{"id","name","items":{"CURRENCY_NOTES":3300,...}}]}
//   node tools\items.js set <characterId|*> <JSON {"CATALOG_ID": count, ...}>
//       sets each count (0 removes the item); "*" = every character. Backs the save up first.
// Refuses while the backend is running (port 61000), so a running game can't overwrite the change.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "data", "undaunted.db");
const SQLITE = path.join(ROOT, "backend", "metagame", "node_modules", "better-sqlite3");
const ID_OK = /^[A-Z0-9_]{3,80}$/;
const MAX = 99999999;
const KEEP_BACKUPS = 10;

// Your own account: the one data\player.key belongs to (same rule as tools\travel.js). While you host, the backend also
// holds an account per friend (and characters that travelled here); those are never listed or changed here.
function myAccount(db) {
    const keyFile = path.join(ROOT, "data", "player.key");
    const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
    if (!key.startsWith("UUK_")) return null;
    const hash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
    let row = null;
    try { row = db.prepare("SELECT userId FROM userapikeys WHERE keyHash = ?").get(hash); } catch {}
    if (!row) { try { row = db.prepare("SELECT userId FROM userapikeystoregister WHERE key = ?").get(key); } catch {} }
    return row ? row.userId : null;
}
function myCharacterIds(db) {
    const me = myAccount(db);
    if (!me) return null;
    return new Set(db.prepare("SELECT characterId FROM characters WHERE userId = ?").all(me).map((r) => r.characterId));
}

function out(o) { process.stdout.write(JSON.stringify(o)); }
function fail(error) { out({ ok: false, error }); process.exit(0); }

function backendUp() {
    return new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: 61000 });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(800, () => done(false));
        s.on("connect", () => done(true));
        s.on("error", () => done(false));
    });
}

function backup() {
    const dir = path.join(ROOT, "backup", "inventory");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    fs.copyFileSync(DB, path.join(dir, `undaunted.db.${stamp}`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("undaunted.db.")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}

(async () => {
    const [cmd, who, json] = process.argv.slice(2);
    if (!fs.existsSync(DB)) fail("No save yet. Press Play once and make a character first.");
    let Database;
    try { Database = require(SQLITE); } catch { fail("The server files are not set up yet. Run Set up first."); }

    if (cmd === "list") {
        const db = new Database(DB, { readonly: true, fileMustExist: true });
        try {
            const names = Object.fromEntries(db.prepare("select characterId, name from characters").all().map((r) => [r.characterId, r.name]));
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            const characters = db.prepare("select characterId, stackedItems from inventories").all().filter((r) => mine.has(r.characterId)).map((r) => {
                const items = {};
                for (const i of JSON.parse(r.stackedItems || "[]")) if (i && i.catalogId) items[i.catalogId] = Number(i.quantity) || 0;
                return { id: r.characterId, name: names[r.characterId] || "", items };
            });
            out({ ok: true, characters });
        } finally { db.close(); }
        return;
    }

    if (cmd === "set") {
        let want;
        try { want = JSON.parse(json || "{}"); } catch { fail("Bad change list."); }
        const changes = Object.entries(want).filter(([id, n]) => ID_OK.test(id) && Number.isFinite(Number(n)));
        if (!changes.length) fail("Nothing to change.");
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        backup();
        const db = new Database(DB, { fileMustExist: true });
        const result = {};
        try {
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            const rows = db.prepare("select characterId, stackedItems from inventories").all()
                .filter((r) => mine.has(r.characterId) && (who === "*" || r.characterId === who));
            if (!rows.length) fail("Character not found.");
            const upd = db.prepare("update inventories set stackedItems=? where characterId=?");
            db.transaction(() => {
                for (const r of rows) {
                    let s = JSON.parse(r.stackedItems || "[]");
                    for (const [id, raw] of changes) {
                        const n = Math.max(0, Math.min(MAX, Math.floor(Number(raw))));
                        const it = s.find((i) => i && i.catalogId === id);
                        if (n === 0) s = s.filter((i) => !(i && i.catalogId === id));
                        else if (it) it.quantity = n;
                        else s.push({ catalogId: id, quantity: n });
                        result[id] = n;
                    }
                    upd.run(JSON.stringify(s), r.characterId);
                }
            })();
        } finally { db.close(); }
        out({ ok: true, set: result });
        return;
    }
    fail("Unknown command.");
})().catch((e) => fail(String(e && e.message || e)));
