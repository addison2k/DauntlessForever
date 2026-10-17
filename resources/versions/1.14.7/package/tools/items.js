// Dauntless Forever - launcher tools (Inventory page helper for 1.14.7)
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Reads and changes the stacked items (currencies, tokens, cores) in this package's save, data\state.json
// (written by backend\recorder-1147.js). Same commands and replies as the 1.6.2 helper, so the launcher's
// Inventory page works the same for both:
//   node tools\items.js list
//       -> {"ok":true,"characters":[{"id","name","items":{"CURRENCY_NOTES":1200,...}}]}
//   node tools\items.js set <characterId|*> <JSON {"CATALOG_ID": count, ...}>
//       sets each count (0 removes the item); "*" = every character. Backs the save up first.
// Refuses while the local backend is running (port 63000): it keeps the save in memory and would overwrite the change.
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STATE = path.join(ROOT, "data", "state.json");
const ID_OK = /^[A-Z0-9_]{3,80}$/;
const MAX = 99999999;
const KEEP_BACKUPS = 10;

function out(o) { process.stdout.write(JSON.stringify(o)); }
function fail(error) { out({ ok: false, error }); process.exit(0); }

function backendUp() {
    return new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: 63000 });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(800, () => done(false));
        s.on("connect", () => done(true));
        s.on("error", () => done(false));
    });
}
function readState() {
    if (!fs.existsSync(STATE)) fail("No save yet. Press Play once and make a character first.");
    try { return JSON.parse(fs.readFileSync(STATE, "utf8").replace(/^\uFEFF/, "")); }
    catch { fail("The save file could not be read (data\\state.json)."); }
}
// Every character of every player in this save, with its inventory (the recorder keys inventories by character id).
function characters(state) {
    const list = [];
    for (const p of Object.values(state.players || {})) {
        for (const ch of p.characters || []) {
            if (!ch || !ch.id) continue;
            if (!p.inventory) p.inventory = {};
            if (!p.inventory[ch.id]) p.inventory[ch.id] = { stackedItems: [], instancedItems: [] };
            if (!Array.isArray(p.inventory[ch.id].stackedItems)) p.inventory[ch.id].stackedItems = [];
            list.push({ id: ch.id, name: ch.name || "", inv: p.inventory[ch.id] });
        }
    }
    return list;
}
function backup() {
    const dir = path.join(ROOT, "backup", "inventory");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    fs.copyFileSync(STATE, path.join(dir, `state.json.${stamp}`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("state.json.")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}

(async () => {
    const [cmd, who, json] = process.argv.slice(2);

    if (cmd === "list") {
        const chars = characters(readState()).map((c) => {
            const items = {};
            for (const i of c.inv.stackedItems) if (i && i.catalogId) items[i.catalogId] = Number(i.quantity) || 0;
            return { id: c.id, name: c.name, items };
        });
        out({ ok: true, characters: chars });
        return;
    }

    if (cmd === "unlock") {
        const result = await require('./unlock1147.cjs').unlock(ROOT, who, json);
        out(result);
        return;
    }

    if (cmd === "set") {
        if (fs.existsSync(path.join(ROOT, 'data', 'inventory-unlock.lock'))) fail('An inventory unlock is running. Wait for it to finish.');
        let want;
        try { want = JSON.parse(json || "{}"); } catch { fail("Bad change list."); }
        const changes = Object.entries(want).filter(([id, n]) => ID_OK.test(id) && Number.isFinite(Number(n)));
        if (!changes.length) fail("Nothing to change.");
        if (await backendUp()) fail("Dauntless is still running. Close the game (and the launcher's server window), then try again.");
        const state = readState();
        const targets = characters(state).filter((c) => who === "*" || c.id === who);
        if (!targets.length) fail("Character not found.");
        backup();
        const result = {};
        for (const c of targets) {
            for (const [id, raw] of changes) {
                const n = Math.max(0, Math.min(MAX, Math.floor(Number(raw))));
                const st = c.inv.stackedItems;
                const i = st.findIndex((x) => x && x.catalogId === id);
                if (n === 0) { if (i >= 0) st.splice(i, 1); }
                else if (i >= 0) st[i].quantity = n;
                else st.push({ catalogId: id, quantity: n });
                result[id] = n;
            }
        }
        const tmp = STATE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, STATE);
        out({ ok: true, set: result });
        return;
    }
    fail("Unknown command.");
})().catch((e) => fail(String(e && e.message || e)));
