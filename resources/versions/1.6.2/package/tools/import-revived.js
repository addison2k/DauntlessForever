// Dauntless Forever - import a Dauntless Revived (1.4.4) character into your 1.6.2 save
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Reads a Revived undaunted.db (opened from a temporary copy, never changed) and adds that character's items to
// YOUR character in this package's save (data\undaunted.db, the account data\player.key belongs to):
//   - gear (weapons, armour, lanterns, parts, emotes, banners, flares) with its level, cells and dyes;
//   - stacked items (Rams, cells, materials, dyes, tokens, cores).
// Only items that exist in 1.6.2 are imported (tools\catalog162-ids.txt); the rest are listed in the report.
// Gear you already have is kept unless the imported copy has a higher level. Stacks are added together, except
// TOKEN_* counters and flags, which take the higher of the two.
// Not imported (yet): loadouts, mastery ranks, Hunt Pass, escalation. Your 1.6.2 name and character stay as they are.
//
//   node tools\import-revived.js check  <path to Revived undaunted.db> [--user <name>] [--root <1.6.2 folder>] [--json]
//   node tools\import-revived.js import <path to Revived undaunted.db> [--user <name>] [--force] [--json]
//
// "import" refuses while the 1.6.2 backend runs (port 61000), backs the save up first (backup\import-revived\),
// refuses to import the same Revived character twice unless --force, and writes data\import-revived-report.txt.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

// The 1.6.2 package folder: this script's parent, or --root <folder> when run from a separate download.
const ROOT = (() => { const i = process.argv.indexOf("--root"); return path.resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join(__dirname, "..")); })();
const DATA = path.join(ROOT, "data");
const TARGET = path.join(DATA, "undaunted.db");
const SQLITE = path.join(ROOT, "backend", "metagame", "node_modules", "better-sqlite3");
const IDS_FILE = path.join(__dirname, "catalog162-ids.txt");
const MARKER = path.join(DATA, "import-revived.json");
const REPORT = path.join(DATA, "import-revived-report.txt");
const MAX = 99999999;

const args = process.argv.slice(2);
const cmd = args[0], src = args[1];
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const JSON_OUT = flag("--json");

function done(obj, text) { if (JSON_OUT) process.stdout.write(JSON.stringify(obj)); else process.stdout.write(text + "\n"); process.exit(obj.ok ? 0 : 1); }
function fail(error) { done({ ok: false, error }, "STOPPED: " + error); }

function backendUp() {
    return new Promise((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: 61000 });
        const end = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(800, () => end(false)); s.on("connect", () => end(true)); s.on("error", () => end(false));
    });
}
function myAccount(db) {
    const keyFile = path.join(DATA, "player.key");
    const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
    if (!key.startsWith("UUK_")) return null;
    const hash = crypto.createHash("sha256").update(key, "utf8").digest("hex");
    let row = null;
    try { row = db.prepare("SELECT userId FROM userapikeys WHERE keyHash = ?").get(hash); } catch {}
    if (!row) { try { row = db.prepare("SELECT userId FROM userapikeystoregister WHERE key = ?").get(key); } catch {} }
    return row ? row.userId : null;
}
const parse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const levelOf = (it) => { const d = parse(it && it.itemData, null); return d && Number.isFinite(Number(d.CurrentLevel)) ? Number(d.CurrentLevel) : (it && it.itemData ? 0 : -1); };

(async () => {
    if (cmd !== "check" && cmd !== "import") fail("Use: import-revived.js check|import <path to undaunted.db>");
    if (!src || !fs.existsSync(src)) fail("That Revived save file was not found: " + (src || "(none given)"));
    if (!fs.existsSync(TARGET)) fail("No 1.6.2 save yet. Press Play in Dauntless Forever once and make your character first.");
    let Database;
    try { Database = require(SQLITE); } catch { fail("The 1.6.2 server files are not set up yet. Run Set up first."); }
    const known = new Set(fs.readFileSync(IDS_FILE, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")));

    // ---- read the Revived save from a temporary copy (with its -wal file, so the newest changes are included)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-revived-"));
    const copy = path.join(tmp, "source.db");
    fs.copyFileSync(src, copy);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, copy + ext);
    let sdb;
    try { sdb = new Database(copy, { readonly: true, fileMustExist: true }); }
    catch (e) { fail("That file is not a Dauntless save (" + e.message + ")."); }
    let users, chars;
    try {
        users = sdb.prepare("SELECT userId, name FROM users").all();
        chars = sdb.prepare("SELECT c.characterId, c.userId, c.name, i.instancedItems, i.stackedItems FROM characters c JOIN inventories i ON i.characterId = c.characterId").all();
    } catch (e) { fail("That file does not look like a Dauntless Revived save (" + e.message + ")."); }
    sdb.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (!chars.length) fail("That save has no character with items.");
    const wanted = opt("--user");
    let pick = chars;
    if (wanted) pick = chars.filter((c) => (users.find((u) => u.userId === c.userId) || {}).name === wanted || c.name === wanted);
    if (pick.length !== 1) {
        const list = chars.map((c) => `${(users.find((u) => u.userId === c.userId) || {}).name || "?"} / ${c.name}`).join(", ");
        fail(pick.length ? `That save holds ${pick.length} characters (${list}). Run again with --user <name>.` : `No character named "${wanted}" in that save. It holds: ${list}`);
    }
    const S = pick[0];
    const sInst = parse(S.instancedItems, []), sStack = parse(S.stackedItems, []);

    // ---- your 1.6.2 character
    const tdb = new Database(TARGET, { readonly: cmd === "check", fileMustExist: true });
    const me = myAccount(tdb);
    if (!me) { tdb.close(); fail("Could not tell which 1.6.2 account is yours (data\\player.key). Run Set up again."); }
    const T = tdb.prepare("SELECT c.characterId, c.name, i.instancedItems, i.stackedItems FROM characters c JOIN inventories i ON i.characterId = c.characterId WHERE c.userId = ? ORDER BY c.createdDate LIMIT 1").get(me);
    if (!T) { tdb.close(); fail("You have no 1.6.2 character yet. Press Play once, make your character, close the game, then import."); }
    const tInst = parse(T.instancedItems, []), tStack = parse(T.stackedItems, []);

    // ---- plan
    const plan = { gearNew: [], gearUpgraded: [], gearKept: [], stacks: [], skipped: [] };
    const outInst = tInst.map((x) => ({ ...x }));
    const byInstance = new Map(outInst.map((x, i) => [x.instanceId, i]));
    for (const it of sInst) {
        if (!it || !it.catalogId) continue;
        const have = byInstance.has(it.instanceId) ? outInst[byInstance.get(it.instanceId)] : null;
        if (!known.has(it.catalogId) && !(have && have.catalogId === it.catalogId) && !tInst.some((x) => x.catalogId === it.catalogId)) { plan.skipped.push(it.catalogId); continue; }
        if (have && have.catalogId === it.catalogId) {
            if (levelOf(it) > levelOf(have)) {
                const idx = byInstance.get(it.instanceId);
                outInst[idx] = { ...it, updateVersion: Math.max(Number(have.updateVersion) || 0, Number(it.updateVersion) || 0) + 1 };
                plan.gearUpgraded.push(it.catalogId);
            } else plan.gearKept.push(it.catalogId);
            continue;
        }
        const item = { ...it };
        if (have) item.instanceId = crypto.randomUUID();   // same instance id but a different item: give it its own
        if (typeof item.updateVersion !== "number") item.updateVersion = item.itemData ? 1 : 0;
        if (item.itemData == null && item.updateVersion !== 0) item.updateVersion = 0;
        byInstance.set(item.instanceId, outInst.length); outInst.push(item); plan.gearNew.push(it.catalogId);
    }
    const outStack = tStack.map((x) => ({ ...x }));
    for (const it of sStack) {
        if (!it || !it.catalogId) continue;
        const q = Math.max(0, Math.floor(Number(it.quantity) || 0));
        if (!q) continue;
        const cur = outStack.find((x) => x.catalogId === it.catalogId);
        if (!known.has(it.catalogId) && !cur) { plan.skipped.push(it.catalogId); continue; }
        const before = cur ? Number(cur.quantity) || 0 : 0;
        const after = it.catalogId.startsWith("TOKEN_") ? Math.max(before, q) : Math.min(MAX, before + q);
        if (cur) cur.quantity = after; else outStack.push({ catalogId: it.catalogId, quantity: after });
        if (after !== before) plan.stacks.push({ id: it.catalogId, before, after });
    }
    const srcUser = (users.find((u) => u.userId === S.userId) || {}).name || "";
    const summary = {
        ok: true, mode: cmd,
        from: { account: srcUser, character: S.name, gear: sInst.length, stacks: sStack.length },
        to: { character: T.name },
        gearNew: plan.gearNew.length, gearUpgraded: plan.gearUpgraded.length, gearKept: plan.gearKept.length,
        stacksChanged: plan.stacks.length, skipped: [...new Set(plan.skipped)],
        rams: (() => { const r = plan.stacks.find((s) => s.id === "CURRENCY_NOTES"); return r ? r.after - r.before : 0; })(),
    };
    const lines = [
        `From Dauntless Revived: ${srcUser} / ${S.name} (${sInst.length} gear, ${sStack.length} stacks)`,
        `Into your 1.6.2 character: ${T.name}`,
        ``,
        `  New gear:            ${plan.gearNew.length}`,
        `  Gear levelled up:    ${plan.gearUpgraded.length}  (you had it, the imported one has a higher level)`,
        `  Gear you already had: ${plan.gearKept.length}`,
        `  Stacks added to:     ${plan.stacks.length}  (Rams +${summary.rams.toLocaleString("en-US")})`,
        `  Not in 1.6.2:        ${summary.skipped.length}${summary.skipped.length ? "  (" + summary.skipped.join(", ") + ")" : ""}`,
        ``,
        `Not carried over yet: loadouts (equip your gear again in game), mastery ranks, Hunt Pass and escalation.`,
    ];

    if (cmd === "check") { tdb.close(); done(summary, lines.join("\n")); }

    // ---- import
    if (await backendUp()) { tdb.close(); fail("Dauntless is still running (or the Dauntless Revived server is). Close the game, the launcher's server window and Revived, then try again."); }
    const marker = parse(fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8") : "[]", []);
    const key = `${S.userId}/${S.characterId}`;
    if (marker.some((m) => m.source === key) && !flag("--force")) {
        tdb.close();
        fail(`This Revived character was already imported (${(marker.find((m) => m.source === key) || {}).at}). Importing again would add the Rams and stacks twice. Use --force only if that import was undone.`);
    }
    const bdir = path.join(ROOT, "backup", "import-revived");
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    tdb.close();
    fs.copyFileSync(TARGET, path.join(bdir, `undaunted.db.${stamp}`));
    const wdb = new Database(TARGET, { fileMustExist: true });
    wdb.prepare("UPDATE inventories SET instancedItems = ?, stackedItems = ? WHERE characterId = ?")
        .run(JSON.stringify(outInst), JSON.stringify(outStack), T.characterId);
    wdb.close();
    marker.push({ source: key, account: srcUser, character: S.name, into: T.characterId, at: new Date().toISOString() });
    fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2));
    const report = [
        `Dauntless Revived import, ${new Date().toString()}`, ...lines, ``,
        `Backup of your save before the import: backup\\import-revived\\undaunted.db.${stamp}`,
        `To undo: close the game, copy that file over data\\undaunted.db, and delete data\\import-revived.json.`, ``,
        `New gear: ${plan.gearNew.join(", ") || "-"}`,
        `Gear levelled up: ${plan.gearUpgraded.join(", ") || "-"}`,
        `Stacks: ${plan.stacks.map((s) => `${s.id} ${s.before}->${s.after}`).join(", ") || "-"}`,
    ];
    fs.writeFileSync(REPORT, report.join("\r\n") + "\r\n");
    done({ ...summary, backup: `backup\\import-revived\\undaunted.db.${stamp}` },
        lines.join("\n") + `\n\nDone. A backup of your save is in backup\\import-revived\\undaunted.db.${stamp}\nThe full list is in data\\import-revived-report.txt`);
})().catch((e) => fail(String(e && e.message || e)));
