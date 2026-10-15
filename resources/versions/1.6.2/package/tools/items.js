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
//   node tools\items.js addgear <characterId> <JSON ["WP_IH_ROCK", ...]>
//       adds gear (weapons, armour, lanterns, parts, accessories, banners, flares) at level 0. Only ids in
//       tools\gear-162.json (the 1.6.2 catalog); gear you already own is left as it is.
//   node tools\items.js removegear <characterId> <JSON ["<instanceId>", ...]>
//       removes gear; gear that is in one of your loadouts (equipped) is refused.
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
const GEAR_FILE = path.join(__dirname, "gear-162.json");   // [[id, name, type], ...] from the 1.6.2 catalog
function gearCatalog() { try { return JSON.parse(fs.readFileSync(GEAR_FILE, "utf8")); } catch { return null; } }

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
            const cat = gearCatalog();
            const gearIds = cat ? new Set(cat.map((g) => g[0])) : null;
            const loadoutText = Object.fromEntries(db.prepare("select characterId, loadouts, persistent from loadouts").all().map((r) => [r.characterId, String(r.loadouts || "") + String(r.persistent || "")]));
            const characters = db.prepare("select characterId, stackedItems, instancedItems from inventories").all().filter((r) => mine.has(r.characterId)).map((r) => {
                const items = {};
                for (const i of JSON.parse(r.stackedItems || "[]")) if (i && i.catalogId) items[i.catalogId] = Number(i.quantity) || 0;
                const lt = loadoutText[r.characterId] || "";
                const gear = gearIds ? JSON.parse(r.instancedItems || "[]").filter((i) => i && gearIds.has(i.catalogId)).map((i) => {
                    let level = 0; try { level = Number(JSON.parse(i.itemData || "{}").CurrentLevel) || 0; } catch {}
                    return { id: i.catalogId, instanceId: i.instanceId, level, equipped: lt.includes('"' + i.instanceId + '"') };
                }) : undefined;
                return { id: r.characterId, name: names[r.characterId] || "", items, gear };
            });
            out({ ok: true, characters, gearCatalog: cat || undefined });
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
    if (cmd === "addgear" || cmd === "removegear") {
        let list;
        try { list = JSON.parse(json || "[]"); } catch { fail("Bad gear list."); }
        if (!Array.isArray(list) || !list.length || list.length > 500) fail("Nothing to change.");
        const cat = gearCatalog();
        if (!cat) fail("This version's server files have no gear list (tools\\gear-162.json).");
        const gearIds = new Set(cat.map((g) => g[0]));
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        const db = new Database(DB, { fileMustExist: true });
        const result = { added: [], already: [], removed: [], equipped: [], unknown: [] };
        try {
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            if (!mine.has(who)) fail("Character not found.");
            const row = db.prepare("select instancedItems from inventories where characterId = ?").get(who);
            if (!row) fail("Character not found.");
            let inst = JSON.parse(row.instancedItems || "[]");
            if (cmd === "addgear") {
                for (const id of list) {
                    if (typeof id !== "string" || !gearIds.has(id)) { result.unknown.push(String(id)); continue; }
                    if (inst.some((i) => i && i.catalogId === id)) { result.already.push(id); continue; }
                    // Same shape as gear the game hands out: the item id doubles as the instance id; no itemData = level 0
                    const instanceId = inst.some((i) => i && i.instanceId === id) ? crypto.randomUUID() : id;
                    inst.push({ catalogId: id, updateVersion: 0, instanceId });
                    result.added.push(id);
                }
            } else {
                const lr = db.prepare("select loadouts, persistent from loadouts where characterId = ?").get(who);
                const lt = lr ? String(lr.loadouts || "") + String(lr.persistent || "") : "";
                for (const iid of list) {
                    const i = inst.findIndex((x) => x && x.instanceId === iid && gearIds.has(x.catalogId));
                    if (i < 0) { result.unknown.push(String(iid)); continue; }
                    if (lt.includes('"' + iid + '"')) { result.equipped.push(inst[i].catalogId); continue; }
                    result.removed.push(inst[i].catalogId); inst.splice(i, 1);
                }
            }
            if (result.added.length || result.removed.length) {
                db.close(); backup();
                const w = new Database(DB, { fileMustExist: true });
                try { w.prepare("update inventories set instancedItems=? where characterId=?").run(JSON.stringify(inst), who); } finally { w.close(); }
            }
        } finally { try { db.close(); } catch {} }
        out({ ok: true, ...result });
        return;
    }
    fail("Unknown command.");
})().catch((e) => fail(String(e && e.message || e)));
