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
//   node tools\items.js addcosmetic <characterId|*> <JSON ["DYE_BLUE01_DURABLE", ...]>
//       unlocks cosmetics (dyes, emotes, titles, emojis, armour and weapon skins, banner parts, flares, character
//       creator options) the way the game keeps each one: most are an unlock (a count of 1), some are one-of-a-kind
//       items. Which is which comes from tools\cosmetics-162.json. Cosmetics you already have are left as they are.
// Typing it yourself (PowerShell drops the quotes inside JSON): the list can also be plain words after the character,
//   node tools\items.js set * CURRENCY_NOTES=50000 TOKEN_BOUNTY_DRAFT=10
//   node tools\items.js addcosmetic * DYE_BLUE01_DURABLE EM_CHEER_01
//   node tools\items.js addgear * WP_IH_ROCK          ("*" = every character of yours)
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
const COSMETIC_FILE = path.join(__dirname, "cosmetics-162.json");   // {stacked: [ids], instanced: [ids]}
function cosmeticCatalog() { try { return JSON.parse(fs.readFileSync(COSMETIC_FILE, "utf8")); } catch { return null; } }
// Cosmetic format fix (by KombatKing, Inventory Editor Cosmetics 162 R1, AGPL-3.0-only): many skins, banner parts and
// flares are in gear-162.json but the game keeps them as an unlock (a stack of 1), not as a gear item. addgear, set,
// list and removegear now use the right format, and re-adding repairs the empty gear row the old editor made.
const COS = cosmeticCatalog() || { stacked: [], instanced: [] };
const stackedUnlocks = new Set(COS.stacked || []), instancedUnlocks = new Set(COS.instanced || []);
function mentioned(text, id) {
    function walk(value) {
        if (value === id) return true;
        if (Array.isArray(value)) return value.some(walk);
        if (value && typeof value === "object") return Object.values(value).some(walk);
        if (typeof value === "string" && /^[\[{]/.test(value.trim())) { try { return walk(JSON.parse(value)); } catch {} }
        return false;
    }
    // loadouts and persistent are separate JSON documents; anything unreadable counts as "in use"
    return text.some((t) => { try { return walk(JSON.parse(t || "null")); } catch { return true; } });
}
function addUnlockStack(stacks, inst, id, loadout) {
    const held = stacks.filter((x) => x && x.catalogId === id);
    if (held.some((x) => !Number.isSafeInteger(x.quantity) || x.quantity < 0)) throw Error("Invalid cosmetic quantity: " + id);
    const already = held.some((x) => x.quantity > 0);
    const next = stacks.filter((x) => !x || x.catalogId !== id); next.push({ catalogId: id, quantity: 1 });
    // Repair only the exact stateless entry the old editor made; equipped or stateful entries stay.
    const repaired = inst.filter((x) => !(x && x.catalogId === id && x.instanceId === id && x.updateVersion === 0 && x.itemData == null && !mentioned(loadout, id)));
    return { stacks: next, inst: repaired, changed: !already || held.length !== 1 || (held[0] && held[0].quantity !== 1) || repaired.length !== inst.length };
}
function loadoutOf(db, characterId) {
    const lr = db.prepare("select loadouts, persistent from loadouts where characterId = ?").get(characterId);
    return [lr && lr.loadouts || "[]", lr && lr.persistent || "{}"];
}
// The change list: one JSON argument (the launcher), or plain words (typed by hand): ID=count for set, IDs otherwise
function argList(kind) {
    const rest = process.argv.slice(4);
    const raw = rest.join(" ").trim();
    if (raw.startsWith("{") || raw.startsWith("[")) { try { return JSON.parse(raw); } catch { return null; } }
    if (kind === "set") {
        const o = {};
        for (const w of rest) { const m = /^([A-Z0-9_]{3,80})=(\d+)$/.exec(w.trim()); if (!m) return null; o[m[1]] = Number(m[2]); }
        return o;
    }
    return rest.map((w) => w.trim()).filter(Boolean);
}

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
    const [cmd, who] = process.argv.slice(2);
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
                const gear = gearIds ? JSON.parse(r.instancedItems || "[]").filter((i) => i && gearIds.has(i.catalogId) && !stackedUnlocks.has(i.catalogId)).map((i) => {
                    let level = 0; try { level = Number(JSON.parse(i.itemData || "{}").CurrentLevel) || 0; } catch {}
                    return { id: i.catalogId, instanceId: i.instanceId, level, equipped: lt.includes('"' + i.instanceId + '"') };
                }) : undefined;
                for (const i of JSON.parse(r.instancedItems || "[]")) if (i && instancedUnlocks.has(i.catalogId)) items[i.catalogId] = 1;
                // cosmetics kept as an unlock show in the gear list too, so they can be seen and removed there
                if (gear) for (const i of JSON.parse(r.stackedItems || "[]")) if (i && i.quantity > 0 && gearIds.has(i.catalogId) && stackedUnlocks.has(i.catalogId) && !gear.some((g) => g.id === i.catalogId)) gear.push({ id: i.catalogId, instanceId: i.catalogId, level: 0, equipped: lt.includes('"' + i.catalogId + '"') });
                return { id: r.characterId, name: names[r.characterId] || "", items, gear };
            });
            out({ ok: true, characters, gearCatalog: cat || undefined });
        } finally { db.close(); }
        return;
    }

    if (cmd === "set") {
        const want = argList("set");
        if (!want || typeof want !== "object" || Array.isArray(want)) fail("Bad change list. Use ID=count, for example CURRENCY_NOTES=50000.");
        const changes = Object.entries(want).filter(([id, n]) => ID_OK.test(id) && Number.isFinite(Number(n)));
        if (!changes.length) fail("Nothing to change.");
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        backup();
        const db = new Database(DB, { fileMustExist: true });
        const result = {};
        try {
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            const rows = db.prepare("select characterId, stackedItems, instancedItems from inventories").all()
                .filter((r) => mine.has(r.characterId) && (who === "*" || r.characterId === who));
            if (!rows.length) fail("Character not found.");
            const upd = db.prepare("update inventories set stackedItems=?, instancedItems=? where characterId=?");
            db.transaction(() => {
                for (const r of rows) {
                    let s = JSON.parse(r.stackedItems || "[]"), inst = JSON.parse(r.instancedItems || "[]");
                    const loadout = loadoutOf(db, r.characterId);
                    for (const [id, raw] of changes) {
                        const cos = stackedUnlocks.has(id) || instancedUnlocks.has(id);
                        const n = cos ? (Number(raw) > 0 ? 1 : 0) : Math.max(0, Math.min(MAX, Math.floor(Number(raw))));
                        if (cos && n === 0 && mentioned(loadout, id)) throw Error("Unequip the cosmetic before removing it: " + id);
                        if (instancedUnlocks.has(id)) {
                            if (n === 0) inst = inst.filter((i) => !i || i.catalogId !== id);
                            else if (!inst.some((i) => i && i.catalogId === id)) inst.push({ catalogId: id, instanceId: id, itemData: null, updateVersion: 0 });
                            result[id] = n; continue;
                        }
                        if (stackedUnlocks.has(id) && n > 0) { const p = addUnlockStack(s, inst, id, loadout); s = p.stacks; inst = p.inst; result[id] = 1; continue; }
                        const it = s.find((i) => i && i.catalogId === id);
                        if (n === 0) s = s.filter((i) => !(i && i.catalogId === id));
                        else if (it) it.quantity = n;
                        else s.push({ catalogId: id, quantity: n });
                        result[id] = n;
                    }
                    upd.run(JSON.stringify(s), JSON.stringify(inst), r.characterId);
                }
            })();
        } finally { db.close(); }
        out({ ok: true, set: result });
        return;
    }
    if (cmd === "addgear" || cmd === "removegear") {
        const list = argList("list");
        if (!Array.isArray(list) || !list.length || list.length > 500) fail("Nothing to change.");
        const cat = gearCatalog();
        if (!cat) fail("This version's server files have no gear list (tools\\gear-162.json).");
        const gearIds = new Set(cat.map((g) => g[0]));
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        const db = new Database(DB, { fileMustExist: true });
        const result = { added: [], already: [], removed: [], equipped: [], unknown: [] };
        const writes = [];
        try {
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            if (who !== "*" && !mine.has(who)) fail("Character not found.");
            if (who === "*" && cmd === "removegear") fail("Remove gear one character at a time.");
            const rows = db.prepare("select characterId, instancedItems, stackedItems from inventories").all()
                .filter((r) => mine.has(r.characterId) && (who === "*" || r.characterId === who));
            if (!rows.length) fail("Character not found.");
            for (const r of rows) {
                let inst = JSON.parse(r.instancedItems || "[]"), stacks = JSON.parse(r.stackedItems || "[]"), changed = false;
                const loadout = loadoutOf(db, r.characterId);
                if (cmd === "addgear") {
                    for (const id of list) {
                        if (typeof id !== "string" || !gearIds.has(id)) { if (!result.unknown.includes(String(id))) result.unknown.push(String(id)); continue; }
                        if (stackedUnlocks.has(id)) {   // a cosmetic the game keeps as an unlock, not a gear item
                            const p = addUnlockStack(stacks, inst, id, loadout); stacks = p.stacks; inst = p.inst;
                            (p.changed ? result.added : result.already).push(id); if (p.changed) changed = true; continue;
                        }
                        if (inst.some((i) => i && i.catalogId === id)) { result.already.push(id); continue; }
                        // Same shape as gear the game hands out: the item id doubles as the instance id; no itemData = level 0
                        const instanceId = inst.some((i) => i && i.instanceId === id) ? crypto.randomUUID() : id;
                        inst.push({ catalogId: id, updateVersion: 0, instanceId });
                        result.added.push(id); changed = true;
                    }
                } else {
                    for (const iid of list) {
                        if (stackedUnlocks.has(iid) && stacks.some((x) => x && x.catalogId === iid && x.quantity > 0)) {
                            if (mentioned(loadout, iid)) { result.equipped.push(iid); continue; }
                            stacks = stacks.filter((x) => !x || x.catalogId !== iid); result.removed.push(iid); changed = true; continue;
                        }
                        const i = inst.findIndex((x) => x && x.instanceId === iid && gearIds.has(x.catalogId));
                        if (i < 0) { result.unknown.push(String(iid)); continue; }
                        if (mentioned(loadout, iid)) { result.equipped.push(inst[i].catalogId); continue; }
                        result.removed.push(inst[i].catalogId); inst.splice(i, 1); changed = true;
                    }
                }
                if (changed) writes.push([JSON.stringify(inst), JSON.stringify(stacks), r.characterId]);
            }
        } finally { try { db.close(); } catch {} }
        if (writes.length) {
            backup();
            const w = new Database(DB, { fileMustExist: true });
            try { const u = w.prepare("update inventories set instancedItems=?, stackedItems=? where characterId=?"); w.transaction(() => { for (const x of writes) u.run(...x); })(); } finally { w.close(); }
        }
        out({ ok: true, ...result });
        return;
    }
    if (cmd === "addcosmetic") {
        const list = argList("list");
        if (!Array.isArray(list) || !list.length || list.length > 3000) fail("Nothing to change.");
        const cat = cosmeticCatalog();
        if (!cat || !Array.isArray(cat.stacked) || !Array.isArray(cat.instanced)) fail("This version's server files have no cosmetics list (tools\\cosmetics-162.json). Update the server files.");
        const stackedIds = new Set(cat.stacked), instancedIds = new Set(cat.instanced);
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        const db = new Database(DB, { fileMustExist: true });
        const result = { added: [], already: [], unknown: [] };
        const writes = [];
        try {
            const mine = myCharacterIds(db);
            if (!mine) fail("Could not tell which account is yours (data\\player.key). Run Set up again.");
            const rows = db.prepare("select characterId, stackedItems, instancedItems from inventories").all()
                .filter((r) => mine.has(r.characterId) && (who === "*" || r.characterId === who));
            if (!rows.length) fail("Character not found.");
            for (const r of rows) {
                const st = JSON.parse(r.stackedItems || "[]"), inst = JSON.parse(r.instancedItems || "[]");
                let n = 0;
                for (const id of list) {
                    if (typeof id !== "string" || (!stackedIds.has(id) && !instancedIds.has(id))) { if (!result.unknown.includes(String(id))) result.unknown.push(String(id)); continue; }
                    if (instancedIds.has(id)) {
                        if (inst.some((i) => i && i.catalogId === id)) { result.already.push(id); continue; }
                        inst.push({ catalogId: id, instanceId: inst.some((i) => i && i.instanceId === id) ? crypto.randomUUID() : id, itemData: null, updateVersion: 0 });
                    } else {
                        const p = addUnlockStack(st, inst, id, loadoutOf(db, r.characterId));
                        if (!p.changed) { result.already.push(id); continue; }
                        st.length = 0; st.push(...p.stacks); inst.length = 0; inst.push(...p.inst);
                    }
                    result.added.push(id); n++;
                }
                if (n) writes.push([JSON.stringify(st), JSON.stringify(inst), r.characterId]);
            }
        } finally { try { db.close(); } catch {} }
        if (writes.length) {
            backup();
            const w = new Database(DB, { fileMustExist: true });
            try { const u = w.prepare("update inventories set stackedItems=?, instancedItems=? where characterId=?"); w.transaction(() => { for (const x of writes) u.run(...x); })(); } finally { w.close(); }
        }
        out({ ok: true, ...result });
        return;
    }
    fail("Unknown command.");
})().catch((e) => fail(String(e && e.message || e)));
