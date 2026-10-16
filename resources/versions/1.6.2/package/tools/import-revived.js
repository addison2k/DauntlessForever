// Dauntless Forever - import a Dauntless Revived (1.4.4) character into your 1.6.2 save
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Reads a Revived undaunted.db (opened from a temporary copy, never changed), or a character file read from a Revived
// server (the "fetch" command below, or tools\revived-export), and adds that character's items to
// YOUR character in this package's save (data\undaunted.db, the account data\player.key belongs to):
//   - gear (weapons, armour, lanterns, parts, emotes, banners, flares) with its level, cells and dyes;
//   - stacked items (Rams, cells, materials, dyes, tokens, cores);
//   - quests (the SERIE_* quest series in the character's save) and tutorial flags, unless --no-quests. EXPERIMENTAL:
//     series 1.6.2 does not have yet are added; for series both have, each quest keeps the further-along progress.
// Only items that exist in 1.6.2 are imported (tools\catalog162-ids.txt); the rest are listed in the report.
// Gear you already have is kept unless the imported copy has a higher level. Stacks are added together, except
// TOKEN_* counters and flags, which take the higher of the two.
//   - weapon levels: 1.4.4 levels each weapon, 1.6.2 levels each weapon type (Weapon Skill). Per type, the highest
//     1.4.4 weapon level becomes that type's XP in data\progression\<account>.bonus.json (only ever raised).
// Not imported (yet): loadouts, mastery ranks, Hunt Pass, escalation. Your 1.6.2 name and character stay as they are.
//
//   node tools\import-revived.js check  <path to Revived undaunted.db> [--user <name>] [--root <1.6.2 folder>] [--json]
//   node tools\import-revived.js import <path to Revived undaunted.db> [--user <name>] [--force] [--json]
//   node tools\import-revived.js fetch --out <file.json> [--port 61000]
//       reads YOUR characters from a Revived server through the Revived launcher's connection (the game must be
//       running with the Revived launcher). Account keys come in on stdin, one per line; the first one the server
//       accepts is used. Only your own account is read, nothing is changed there, and no key is written anywhere.
//       The file it writes is a <source> for check / import / tutorial.
//   node tools\import-revived.js tutorial <path to Revived undaunted.db>   (only marks the tutorial as finished, if it
//       was finished in Revived; for players who imported with an older version of this tool and still get the tutorial)
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
// No duplicates (by KombatKing, All-in-One R10, AGPL-3.0-only): one-copy unlocks (lanterns, weapon mods, cosmetics; the
// list is tools\import-singletons162.json) are matched by item, not instance id, so they never come in a second time.
const singletonCatalog = require("./import-singletons162.json");
const singleInstance = new Set(singletonCatalog.instanced), singleStack = new Set(singletonCatalog.stacked);
// The 1.6.2 mission line (Hunt > Missions) with nothing started, from a 1.6.2 save; used when a character has none.
const CR20_BLANK = "{\"ID\":\"CR20_PJM_Quests\",\"EC1DAE3747C32774109D35BE0A45AC6B\":{\"Status\":0},\"92FF10A74113516A0E1BE98CF4FE17C2\":{\"Status\":0,\"BB60F69042F1165642414C81ADFC0E5C\":{\"Status\":0,\"CurrentAmount\":0}},\"59B10B8243AB597F733BD490FCD964E1\":{\"Status\":0,\"D6D8B073491028C7ED5790AE547B0C61\":{\"Status\":0,\"CurrentAmount\":0}},\"2C1D0E3E4FEFB14950A7CAB813749F80\":{\"Status\":0,\"0460F7A746A28529D46510A34B545915\":{\"Status\":0,\"CurrentAmount\":0,\"CurrentHitsAmount\":0}},\"B2294BD2453A6259AB4F4CAC7727FE89\":{\"Status\":0,\"860162EA4609C6AFC5FD3596BBA4F19F\":{\"Status\":0,\"CurrentAmount\":0}},\"8ED0B3DE4576F3948DA60E991A38F7A4\":{\"Status\":0,\"55234271482C293A940089B75D837754\":{\"Status\":0,\"CurrentAmount\":0}},\"D5B764F94F4632EBAFD20A875BB1D62B\":{\"Status\":0,\"933312C54B8A5827D812C99A19D667B4\":{\"Status\":0,\"CurrentAmount\":0}},\"1DDC8E2443858B2EAFC5098018557DF7\":{\"Status\":0,\"092D87AC43F68889F76E82B6909D8B21\":{\"Status\":0,\"CurrentAmount\":0}},\"DEA71EBF4B04EB1C8E1A4F9F1C920C25\":{\"Status\":0,\"9CC15CA6448BBEFFA90F878176D4A2D9\":{\"Status\":0,\"CurrentAmount\":0}},\"BE36FD95471366763949FAA24E2E4AB7\":{\"Status\":0,\"D627908C4A4926AD1EB10AA1D2770DAC\":{\"Status\":0,\"CurrentAmount\":0}},\"43F90C654606366BFE42E4B97EEC753C\":{\"Status\":0,\"257638E9477A827FCC37E382D7040D81\":{\"Status\":0,\"CurrentAmount\":0}},\"BE2803BD42D3AE57EB5EA6834D630DCF\":{\"Status\":0,\"2132F37A45543C7E991FBB84A4732420\":{\"Status\":0,\"CurrentAmount\":0}},\"48659E0E4C0512BC97B6EFB990CF2498\":{\"Status\":0,\"E83CE102487CF83C184A038E9AF2208C\":{\"Status\":0,\"CurrentAmount\":0,\"84789FB8482CC9B95A5E9D9B088FEB83\":{\"Status\":0,\"CurrentAmount\":0},\"048D6DB246BD2394EDBF1F8C6DE9D2CB\":{\"Status\":0,\"CurrentAmount\":0}}},\"3E578BB64D5B4485D109D9B1A8D696F7\":{\"Status\":0,\"A3AD48FF4D827FCCF42D54910EF6578A\":{\"Status\":0,\"CurrentAmount\":0}},\"F36E60BE44D86C6212D51683B34FD608\":{\"Status\":0,\"C1181F5F44BC1FD4E8387FB34E8196EC\":{\"Status\":0,\"CurrentAmount\":0}},\"0DE0F11548C8F306531323B27A0A0105\":{\"Status\":0,\"9E74A39C42ACAA64E400678FC9B18C74\":{\"Status\":0,\"CurrentAmount\":0}},\"C14153B74793C63A7E9232B3AAE127D5\":{\"Status\":0,\"1E1FF53947E8D59BE8DB1C9E5781435D\":{\"Status\":0,\"CurrentAmount\":0,\"614159134FB07F1132BBC6B31ACFFD9E\":{\"Status\":0,\"CurrentAmount\":0},\"16002FD640B7F8DBCF05ED9A80AA594B\":{\"Status\":0,\"CurrentAmount\":0},\"0DED1F5C4A035D56C8EE20BD46146E0A\":{\"Status\":0,\"CurrentAmount\":0}}},\"7CBFF50242B6FBBA5A07FC8B7A7A246E\":{\"Status\":0,\"7BA7E357478E3F0A85E353B369242115\":{\"Status\":0,\"CurrentAmount\":0}},\"89C1AD2146B362641DA6F281D8447FE8\":{\"Status\":0,\"2AD612C442E5FBDC9F3F4BB547CB3BEE\":{\"Status\":0,\"CurrentAmount\":0,\"DamageDealtToBehemothsThisHunt\":0}},\"834D348247B2C5AB14C2668DD4D5BBDC\":{\"Status\":0,\"BA49CE1B4E824E864DA2359128F1FB8F\":{\"Status\":0,\"CurrentAmount\":0},\"A04DA7254483C7FDB205E6AAD162F9C0\":{\"Status\":0,\"CurrentAmount\":0,\"DamageDealtToBehemothsThisHunt\":0}},\"FA42AFE7495BDD41D6B7A991889423AB\":{\"Status\":0,\"FC6C4D734EC1C1BCA3949087519E71E6\":{\"Status\":0,\"CurrentAmount\":0}},\"5C6AD23446C8042C0F1A05930B03537A\":{\"Status\":0,\"4876F00741F7AA4F3DC7079EE1317ADF\":{\"Status\":0,\"CurrentAmount\":0,\"DamageDealtToBehemothsThisHunt\":0}},\"E4C90B9244E8B0C82C2671AEDFCEE68B\":{\"Status\":0,\"33CECB7A43DBF80BFBB1BBADFDB14906\":{\"Status\":0,\"CurrentAmount\":0,\"DamageDealtToBehemothsThisHunt\":0}},\"2FCEEF4045C79A0558E0708ABEECE629\":{\"Status\":0,\"92DE48F142988056441F0181C7FC0771\":{\"Status\":0,\"CurrentAmount\":0}},\"E2D289B845368B5E66C7BAAEFD35D4C6\":{\"Status\":0,\"CCCDC7724F92CA16AB501F98E9FA07AA\":{\"Status\":0,\"CurrentAmount\":0}},\"01AC9C0A45A36BD513CDE984B1171552\":{\"Status\":0},\"937651B047C627CEDC4C3E80EC2F3D21\":{\"Status\":0,\"1EC8778244FEAAEBD6DE9E88A8F08520\":{\"Status\":0,\"CurrentAmount\":0,\"CurrentHitsAmount\":0}},\"988C05594F7BE3A23E5CE7B875128993\":{\"Status\":0,\"E366A890421990909B50398554DF7E18\":{\"Status\":0,\"CurrentAmount\":0,\"CurrentHitsAmount\":0},\"00A72AE64D4A551DF878EDB3A2487626\":{\"Status\":0,\"CurrentAmount\":0,\"CurrentHitsAmount\":0},\"202878764E6E689F6D6FCC8DF5C1E224\":{\"Status\":0,\"CurrentAmount\":0,\"CurrentHitsAmount\":0}},\"CDFA06D04F094EE8DB1BB985CC92938A\":{\"Status\":0,\"C2E07B51403100F319698E9404A72F43\":{\"Status\":0,\"CurrentAmount\":0},\"5BD3B24A46320DA6F1D41998B63B78F1\":{\"Status\":0,\"CurrentAmount\":0}},\"E8297BAD4716CE5827A9DA8F052A274C\":{\"Status\":0,\"8EFC335E4283030E0278419BC5C2ADAE\":{\"Status\":0,\"CurrentAmount\":0,\"1AE5E9AC4ABD2FDF82A86CA87F3DF62C\":{\"Status\":0,\"CurrentAmount\":0},\"D49777F44F8C6A51624CE086C371C0B9\":{\"Status\":0,\"CurrentAmount\":0},\"71A1CDFD45E100B58ECEE089A01A5B55\":{\"Status\":0,\"CurrentAmount\":0},\"57637D9B4D2D6D231655D898AC5956E7\":{\"Status\":0,\"CurrentAmount\":0}}},\"0A6E8C8548EE348CCB4A4498EF8F2026\":{\"Status\":0,\"F2A60EAB45DB8F91F8F262A5FE09B13E\":{\"Status\":0,\"CurrentAmount\":0}},\"843501784396841F8F2304AC89F3E49D\":{\"Status\":0,\"C2812A7C450B88F82B6F7C935DE4AC03\":{\"Status\":0,\"CurrentAmount\":0}}}";

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
// ---- fetch: read your own account from a Revived server, through the Revived launcher's relay on 127.0.0.1
function httpJson(port, method, p, headers, body) {
    return new Promise((resolve) => {
        const http = require("http");
        const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { "User-Agent": "DauntlessForever-RevivedImport", ...headers }, timeout: 60000 }, (res) => {
            const parts = []; res.on("data", (d) => parts.push(d));
            res.on("end", () => { const t = Buffer.concat(parts).toString("utf8"); resolve({ status: res.statusCode, text: t, json: parse(t, null) }); });
        });
        req.on("timeout", () => req.destroy(new Error("timed out")));
        req.on("error", (e) => resolve({ status: 0, error: e.message }));
        if (body) req.write(body);
        req.end();
    });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchFromServer() {
    const port = Number(opt("--port")) || 61000, out = opt("--out");
    if (!out) fail("Use: import-revived.js fetch --out <file.json> [--port 61000]  (account keys on stdin)");
    const ping = await httpJson(port, "GET", "/", {});
    if (!ping.status) fail("Dauntless Revived is not running. Start the game with the Dauntless Revived launcher, wait until you are in game, then try again.");
    const input = fs.readFileSync(0, "utf8");
    const keys = [...new Set((input.match(/UUK_[0-9A-Za-z_-]{16,120}/g) || []).concat(input.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_-]{8,128}$/.test(l) && !/^DRK\d$/.test(l))))].slice(0, 5);
    if (!keys.length) fail("No account key was given.");
    let tok = null;
    for (const k of keys) {
        const r = await httpJson(port, "POST", "/account/api/oauth/token", { "Content-Type": "application/x-www-form-urlencoded" },
            new URLSearchParams({ grant_type: "exchange_code", exchange_code: k, token_type: "eg1" }).toString());
        if (r.status === 200 && r.json && r.json.access_token && r.json.account_id) { tok = r.json; break; }
        if (r.status === 429) fail("The Revived server says too many logins. Wait ten minutes and try again.");
        await pause(400);
    }
    if (!tok) fail(keys.length > 1 ? "The Revived server did not accept any of your saved account keys. Paste the key for the server you play on." : "The Revived server did not accept that key. Check it is the key for the server you play on.");
    const uid = String(tok.account_id), auth = { Authorization: "bearer " + tok.access_token };
    const get = async (p) => { await pause(400); const r = await httpJson(port, "GET", p, auth); return r.status === 200 ? r.json : null; };
    const chars = await get("/character");
    if (!Array.isArray(chars) || !chars.length) fail("The Revived server has no characters for this account.");
    const exp = { format: "dauntless-forever-revived-export", version: 2, source: "Dauntless Revived (1.4.4) server", exportedAt: new Date().toISOString(),
        accountId: uid, progression: await get(`/progression/${encodeURIComponent(uid)}`), objectives: await get(`/progression/objectives/${encodeURIComponent(uid)}`), characters: [] };
    for (const c of chars) {
        const cid = String(c.id);
        exp.characters.push({ character: c, inventory: await get(`/inventory/${encodeURIComponent(uid)}/${encodeURIComponent(cid)}`), loadouts: await get(`/loadout/${encodeURIComponent(uid)}/${encodeURIComponent(cid)}/all`) });
    }
    const n = exp.characters.reduce((a, e) => a + (e.inventory ? (e.inventory.instancedItems || []).length + (e.inventory.stackedItems || []).length : 0), 0);
    if (!n) fail("The Revived server answered, but sent no inventory. Try again in a minute.");
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(exp, null, 1));
    done({ ok: true, mode: "fetch", file: path.resolve(out), characters: chars.map((c) => c.name), entries: n },
        `Read from the Revived server: ${chars.map((c) => c.name).join(", ")} (${n} inventory entries).\nSaved to ${path.resolve(out)}`);
}
// ---- the source: a Revived undaunted.db, or a character file from "fetch" / tools\revived-export
function loadSource(file, Database) {
    const head = fs.readFileSync(file).subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("{")) {
        const e = parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""), null);
        if (!e || e.format !== "dauntless-forever-revived-export" || !Array.isArray(e.characters)) fail("That file is not a Dauntless Revived character file.");
        const uid = String(e.accountId || "");
        const users = [{ userId: uid, name: e.accountName || "" }];
        const asText = (v, d) => (typeof v === "string" ? v : JSON.stringify(v == null ? d : v));
        const chars = e.characters.filter((x) => x && x.character && x.inventory).map((x) => ({
            characterId: String(x.character.id), userId: String(x.character.accountId || uid), name: x.character.name,
            data: asText(x.character.data, {}), instancedItems: asText(x.inventory.instancedItems, []), stackedItems: asText(x.inventory.stackedItems, []),
        }));
        return { users, chars, kind: "file" };
    }
    // a database: read it from a temporary copy (with its -wal file, so the newest changes are included)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "df-revived-"));
    const copy = path.join(tmp, "source.db");
    fs.copyFileSync(file, copy);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    let sdb;
    try { sdb = new Database(copy, { readonly: true, fileMustExist: true }); }
    catch (e) { fail("That file is not a Dauntless save (" + e.message + ")."); }
    let users, chars;
    try {
        users = sdb.prepare("SELECT userId, name FROM users").all();
        chars = sdb.prepare("SELECT c.characterId, c.userId, c.name, c.data, i.instancedItems, i.stackedItems FROM characters c JOIN inventories i ON i.characterId = c.characterId").all();
    } catch (e) { fail("That file does not look like a Dauntless Revived save (" + e.message + ")."); }
    sdb.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    return { users, chars, kind: "db" };
}
// ---- weapon levels. 1.4.4: a level on each weapon (itemData.CurrentLevel, CurrentXP). 1.6.2: one Weapon Skill level
// per weapon type, kept as XP in data\progression\<account>.bonus.json (xp.ExperienceTrack_Weapon_<Type>).
const WEAPON_TYPES = { AC: "Strikers", CB: "ChainBlades", DP: "Repeaters", EB: "Sword", GA: "Axe", IH: "Hammer", MS: "Spear" };
const LEVEL_STEPS = [300, 400, 600, 1000, 1400, 1800, 2300, 2800, 3300, 3800, 4200, 4600, 4900, 5100, 5300, 5500, 5600, 5700, 5800];
const xpForLevel = (l) => LEVEL_STEPS.slice(0, Math.max(0, Math.min(20, l) - 1)).reduce((a, b) => a + b, 0);
const levelForXp = (x) => { let l = 1, t = 0; for (const st of LEVEL_STEPS) { if (x >= t + st) { t += st; l++; } else break; } return l; };
function weaponPlan(sInst, accountId) {
    const best = {};
    for (const it of sInst) {
        const m = it && /^WP_([A-Z]+)_/.exec(it.catalogId || ""); const type = m && WEAPON_TYPES[m[1]];
        if (!type) continue;
        const d = parse(it.itemData, null); if (!d) continue;
        const lvl = Math.max(1, Math.min(20, Math.floor(Number(d.CurrentLevel) || 0)));
        const xp = xpForLevel(lvl) + (lvl < 20 ? Math.min(Math.max(0, Math.floor(Number(d.CurrentXP) || 0)), LEVEL_STEPS[lvl - 1] - 1) : 0);
        if (!best[type] || xp > best[type].xp) best[type] = { lvl, xp };
    }
    const file = path.join(DATA, "progression", `${String(accountId).replace(/[^\w-]/g, "_")}.bonus.json`);
    const bonus = parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "", null) || {};
    const out = { ...bonus, xp: { ...(bonus.xp || {}) } };
    const changes = [];
    for (const [type, b] of Object.entries(best)) {
        const k = `ExperienceTrack_Weapon_${type}`;
        const have = Number(out.xp[k]) || 0, reforged = Number((bonus.reforgedXp || {})[k]) || 0;
        const counted = Math.max(0, have - reforged);
        if (b.xp > counted) { out.xp[k] = b.xp + reforged; changes.push({ type, from: levelForXp(counted), to: b.lvl }); }
    }
    return { file, out, changes, line: changes.length ? changes.map((c) => `${c.type} ${c.from}->${c.to}`).join(", ") : (Object.keys(best).length ? "already as high as in Revived" : "none found") };
}
function writeBonus(w, stamp) {
    if (!w.changes.length) return null;
    const bd = path.join(ROOT, "backup", "import-revived"); fs.mkdirSync(bd, { recursive: true });
    let backup = null;
    if (fs.existsSync(w.file)) { backup = path.join(bd, `${path.basename(w.file)}.${stamp}`); fs.copyFileSync(w.file, backup); }
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    fs.writeFileSync(w.file, JSON.stringify(w.out, null, 2));
    return backup;
}
const levelOf = (it) => { const d = parse(it && it.itemData, null); return d && Number.isFinite(Number(d.CurrentLevel)) ? Number(d.CurrentLevel) : (it && it.itemData ? 0 : -1); };

(async () => {
    if (cmd === "fetch") return fetchFromServer();
    if (!["check", "import", "tutorial"].includes(cmd)) fail("Use: import-revived.js check|import|tutorial <path to undaunted.db or character file> | fetch --out <file>");
    if (!src || !fs.existsSync(src)) fail("That Revived save file was not found: " + (src || "(none given)"));
    if (!fs.existsSync(TARGET)) fail("No 1.6.2 save yet. Press Play in Dauntless Forever once and make your character first.");
    let Database;
    try { Database = require(SQLITE); } catch { fail("The 1.6.2 server files are not set up yet. Run Set up first."); }
    const known = new Set(fs.readFileSync(IDS_FILE, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#")));

    const { users, chars, kind: srcKind } = loadSource(src, Database);
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
    const T = tdb.prepare("SELECT c.characterId, c.name, c.data, c.updateVersion, i.instancedItems, i.stackedItems FROM characters c JOIN inventories i ON i.characterId = c.characterId WHERE c.userId = ? ORDER BY c.createdDate LIMIT 1").get(me);
    if (!T) { tdb.close(); fail("You have no 1.6.2 character yet. Press Play once, make your character, close the game, then import."); }
    const tInst = parse(T.instancedItems, []), tStack = parse(T.stackedItems, []);
    const weapons = weaponPlan(sInst, me);

    // ---- plan
    const plan = { gearNew: [], gearUpgraded: [], gearKept: [], stacks: [], skipped: [] };
    const outInst = tInst.map((x) => ({ ...x }));
    const byInstance = new Map(outInst.map((x, i) => [x.instanceId, i]));
    for (const it of sInst) {
        if (!it || !it.catalogId) continue;
        const ownedSingleton = singleInstance.has(it.catalogId) ? outInst.find(x => x.catalogId === it.catalogId) : null;
        const have = ownedSingleton || (byInstance.has(it.instanceId) ? outInst[byInstance.get(it.instanceId)] : null);
        if (!known.has(it.catalogId) && !(have && have.catalogId === it.catalogId) && !tInst.some((x) => x.catalogId === it.catalogId)) { plan.skipped.push(it.catalogId); continue; }
        if (have && have.catalogId === it.catalogId) {
            if (levelOf(it) > levelOf(have)) {
                const idx = outInst.indexOf(have);
                outInst[idx] = { ...it, instanceId: have.instanceId, updateVersion: Math.max(Number(have.updateVersion) || 0, Number(it.updateVersion) || 0) + 1 };
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
        const after = singleStack.has(it.catalogId) ? (before > 0 ? before : 1)
            : it.catalogId.startsWith("TOKEN_") ? Math.max(before, q) : Math.min(MAX, before + q);
        if (cur) cur.quantity = after; else outStack.push({ catalogId: it.catalogId, quantity: after });
        if (after !== before) plan.stacks.push({ id: it.catalogId, before, after });
    }
    // ---- quests: SERIE_<series> entries hold a JSON string {ID, Status, <questGuid>: {Status, <stepGuid>: {Status, CurrentAmount, ...}}}
    // Status: 0 not started, 1 active, 2 step done, 3 quest done. Merge = keep the higher Status / amounts at every level.
    const quests = { added: [], merged: [], flags: 0 };
    const tData = parse(T.data, {}), sData = parse(S.data, {});
    const mergeNode = (a, b) => {
        if (!a || typeof a !== "object") return b;
        if (!b || typeof b !== "object") return a;
        const out = { ...a };
        for (const [k, v] of Object.entries(b)) {
            if (v && typeof v === "object") out[k] = mergeNode(a[k], v);
            else if (typeof v === "number" && /^(Status|CurrentAmount)$/.test(k)) out[k] = Math.max(Number(a[k]) || 0, v);
            else if (!(k in a)) out[k] = v;
        }
        return out;
    };
    if (!flag("--no-quests")) {
        for (const [k, v] of Object.entries(sData)) {
            if (!k.startsWith("SERIE_") || typeof v !== "string") continue;
            const sv = parse(v, null); if (!sv || typeof sv !== "object") continue;
            if (!(k in tData)) { tData[k] = v; quests.added.push(k.slice(6)); continue; }
            const tv = parse(tData[k], null); if (!tv || typeof tv !== "object") continue;
            const m = mergeNode(tv, sv);
            if (!("Status" in tv)) delete m.Status;   // 1.6.2 series have no top-level Status; do not add 1.4.4's
            const merged = JSON.stringify(m);
            if (merged !== tData[k]) { tData[k] = merged; quests.merged.push(k.slice(6)); }
        }
        // Tutorial and one-time flags (CharacterFlagData {"Flags":[{FlagKey, FlagValue}]}): add the ones 1.6.2 lacks
        const sf = parse(sData.CharacterFlagData, null), tf = parse(tData.CharacterFlagData, { Flags: [] });
        if (sf && Array.isArray(sf.Flags) && tf && Array.isArray(tf.Flags)) {
            const have = new Set(tf.Flags.map((f) => f && f.FlagKey));
            for (const f of sf.Flags) if (f && f.FlagKey && !have.has(f.FlagKey)) { tf.Flags.push(f); quests.flags++; }
            if (quests.flags) tData.CharacterFlagData = JSON.stringify(tf);
        }
    }
    // ---- tutorial: 1.6.2 plays the opening tutorial until the character has HasFinishedTutorial "true" and
    // PlayerAccountProgressStep "FinishedSecondHunt". A character made just for the import often quit before that.
    const tut = {};
    if (String(sData.HasFinishedTutorial).toLowerCase() === "true" && String(tData.HasFinishedTutorial).toLowerCase() !== "true") tut.HasFinishedTutorial = "true";
    if (sData.PlayerAccountProgressStep === "FinishedSecondHunt" && tData.PlayerAccountProgressStep !== "FinishedSecondHunt") tut.PlayerAccountProgressStep = "FinishedSecondHunt";
    {   // login flags such as WatchedNewRamsgateCinematic
        const sl = parse(sData.LoginFlagData, null), tl = parse(tData.LoginFlagData, { Flags: [] });
        if (sl && Array.isArray(sl.Flags) && tl && Array.isArray(tl.Flags)) {
            const have = new Set(tl.Flags.map((f) => f && f.FlagKey)); let n = 0;
            for (const f of sl.Flags) if (f && f.FlagKey && !have.has(f.FlagKey)) { tl.Flags.push(f); n++; }
            if (n) tut.LoginFlagData = JSON.stringify(tl);
        }
    }
    // 1.6.2 missions (Hunt > Missions) are the cr20_pjm_quests line. Its first mission is finished by the tutorial;
    // when the tutorial is skipped it stays at Status 2 with nothing active, so the Missions list is empty.
    // Finish it and make the second mission active, as the game does at the end of the tutorial.
    // Also remove a top-level Status that an earlier version of this tool copied into 1.6.2's own series.
    const fixMissions = (data) => {
        const out = {};
        const done = String((tut.HasFinishedTutorial || data.HasFinishedTutorial)).toLowerCase() === "true";
        let m = parse(data.SERIE_cr20_pjm_quests, null);
        // A character that quit early in the tutorial has no mission line at all: start it from a blank copy
        if (done && !m) { m = JSON.parse(CR20_BLANK); out.SERIE_cr20_pjm_quests = JSON.stringify(m); }
        const Q1 = "EC1DAE3747C32774109D35BE0A45AC6B", Q2 = "92FF10A74113516A0E1BE98CF4FE17C2";
        // Also when the first mission is already done (the game may finish it on login) but no mission is active.
        const anyActive = m && Object.values(m).some((q) => q && typeof q === "object" && (Number(q.Status) === 1 || Number(q.Status) === 2));
        const q2Idle = m && m[Q2] && typeof m[Q2] === "object" && !(Number(m[Q2].Status) > 0);
        if (done && m && m[Q1] && typeof m[Q1] === "object" && (Number(m[Q1].Status) < 3 || (q2Idle && !anyActive))) {
            m[Q1].Status = 3;
            if (q2Idle) {
                m[Q2].Status = 1;
                for (const [k, v] of Object.entries(m[Q2])) if (v && typeof v === "object" && !(Number(v.Status) > 0)) v.Status = 1;
            }
            delete m.Status;
            out.SERIE_cr20_pjm_quests = JSON.stringify(m);
        }
        for (const k of ["SERIE_cr20_pjm_quests", "SERIE_season_09b", "SERIE_archon_tutorial_test"]) {
            const v = parse(out[k] || data[k], null);
            if (v && typeof v === "object" && "Status" in v) { delete v.Status; out[k] = JSON.stringify(v); }
        }
        return out;
    };
    Object.assign(tut, fixMissions({ ...tData }));
    const tutChanged = Object.keys(tut).length > 0;
    Object.assign(tData, tut);
    const questsChanged = quests.added.length + quests.merged.length + quests.flags > 0 || tutChanged;
    const srcUser = (users.find((u) => u.userId === S.userId) || {}).name || "";
    const summary = {
        ok: true, mode: cmd,
        from: { account: srcUser, character: S.name, gear: sInst.length, stacks: sStack.length },
        to: { character: T.name },
        gearNew: plan.gearNew.length, gearUpgraded: plan.gearUpgraded.length, gearKept: plan.gearKept.length,
        stacksChanged: plan.stacks.length, skipped: [...new Set(plan.skipped)],
        tutorialMarked: tutChanged, weaponLevels: weapons.changes, questsAdded: quests.added, questsMerged: quests.merged, flagsAdded: quests.flags,
        rams: (() => { const r = plan.stacks.find((s) => s.id === "CURRENCY_NOTES"); return r ? r.after - r.before : 0; })(),
    };
    const lines = [
        `From Dauntless Revived${srcKind === "file" ? " (server)" : ""}: ${srcUser ? srcUser + " / " : ""}${S.name} (${sInst.length} gear, ${sStack.length} stacks)`,
        `Into your 1.6.2 character: ${T.name}`,
        ``,
        `  New gear:            ${plan.gearNew.length}`,
        `  Gear levelled up:    ${plan.gearUpgraded.length}  (you had it, the imported one has a higher level)`,
        `  Gear you already had: ${plan.gearKept.length}`,
        `  Stacks added to:     ${plan.stacks.length}  (Rams +${summary.rams.toLocaleString("en-US")})`,
        `  Not in 1.6.2:        ${summary.skipped.length}${summary.skipped.length ? "  (" + summary.skipped.join(", ") + ")" : ""}`,
        ``,
        `  Quest lines added:   ${quests.added.length}${quests.added.length ? "  (" + quests.added.join(", ") + ")" : ""}`,
        `  Quest lines merged:  ${quests.merged.length}${quests.merged.length ? "  (" + quests.merged.join(", ") + ")" : ""}  (experimental)`,
        `  Tutorial flags:      +${quests.flags}`,
        `  First mission:       ${tut.SERIE_cr20_pjm_quests ? "fixed (finished, next mission active)" : "ok"}`,
        `  Weapon levels:       ${weapons.line}`,
        `  Tutorial finished:   ${tut.HasFinishedTutorial || tut.PlayerAccountProgressStep ? "yes (marked as done, as in Revived)" : String(tData.HasFinishedTutorial).toLowerCase() === "true" ? "already done" : "no (not finished in Revived either)"}`,
        ``,
        `Not carried over yet: loadouts (equip your gear again in game), mastery ranks, Hunt Pass and escalation.`,
    ];

    if (cmd === "check") { tdb.close(); done(summary, lines.join("\n")); }

    // ---- tutorial only: mark the tutorial done, nothing else (safe to run after an earlier import)
    // one line for support: where the 1.6.2 mission line stands
    const missionLine = (data) => {
        const m = parse(data.SERIE_cr20_pjm_quests, null);
        const others = `Other quest lines: ${Object.keys(data).filter((k) => k.startsWith("SERIE_")).map((k) => k.slice(6)).join(", ") || "-"}`;
        if (!m) return `Missions: no mission line in this save yet. Tutorial: ${data.HasFinishedTutorial || "-"} / ${data.PlayerAccountProgressStep || "-"}. ` + others;
        const q = Object.entries(m).filter(([, v]) => v && typeof v === "object");
        const n = (st) => q.filter(([, v]) => Number(v.Status) === st).length;
        return `Missions: ${n(3)} done, ${n(1)} active, ${n(2)} waiting, ${n(0)} not started (of ${q.length}). Tutorial: ${data.HasFinishedTutorial || "-"} / ${data.PlayerAccountProgressStep || "-"}. ` + others;
    };
    if (cmd === "tutorial") {
        // recompute against the save as it is (not the in-memory quest merge above)
        const only = parse(T.data, {});
        for (const k of ["HasFinishedTutorial", "PlayerAccountProgressStep", "LoginFlagData"]) if (k in tut) only[k] = tut[k];
        const fx = fixMissions(only); Object.assign(only, fx);
        const changedKeys = Object.keys(only).filter((k) => only[k] !== parse(T.data, {})[k]);
        if (!changedKeys.length && !weapons.changes.length) { tdb.close(); done({ ok: true, mode: cmd, changed: false }, String(tData.HasFinishedTutorial).toLowerCase() === "true" ? "Your 1.6.2 character already has the tutorial and first mission done, and its weapon levels are as high as in Revived. Nothing changed.\n" + missionLine(only) : "The tutorial was not finished in Revived either, so nothing was changed. Weapon levels: " + weapons.line + "."); }
        if (await backendUp()) { tdb.close(); fail("Dauntless is still running (or the Dauntless Revived server is). Close the game, the launcher's server window and Revived, then try again."); }
        const bd = path.join(ROOT, "backup", "import-revived"); fs.mkdirSync(bd, { recursive: true });
        const st = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        tdb.close();
        fs.copyFileSync(TARGET, path.join(bd, `undaunted.db.${st}`));
        if (changedKeys.length) {
            const w = new Database(TARGET, { fileMustExist: true });
            w.prepare("UPDATE characters SET data = ?, updateVersion = ?, lastModifiedDate = ? WHERE characterId = ?")
                .run(JSON.stringify(only), (Number(T.updateVersion) || 0) + 1, new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), T.characterId);
            w.close();
        }
        writeBonus(weapons, st);
        done({ ok: true, mode: cmd, changed: true, backup: `backup\\import-revived\\undaunted.db.${st}` },
            `Fixed for ${T.name}: ${[only.HasFinishedTutorial !== parse(T.data, {}).HasFinishedTutorial ? "tutorial marked as done" : "", fx.SERIE_cr20_pjm_quests ? "first mission finished and the next one made active" : "", changedKeys.some((k) => k.startsWith("SERIE_")) && !fx.SERIE_cr20_pjm_quests ? "quest lines tidied" : "", weapons.changes.length ? "weapon levels " + weapons.line : ""].filter(Boolean).join(", ") || "tutorial settings"}. A backup of your save is in backup\\import-revived\\undaunted.db.${st}\n` + missionLine(only));
    }

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
    wdb.transaction(() => {
        wdb.prepare("UPDATE inventories SET instancedItems = ?, stackedItems = ? WHERE characterId = ?")
            .run(JSON.stringify(outInst), JSON.stringify(outStack), T.characterId);
        if (questsChanged) {
            wdb.prepare("UPDATE characters SET data = ?, updateVersion = ?, lastModifiedDate = ? WHERE characterId = ?")
                .run(JSON.stringify(tData), (Number(T.updateVersion) || 0) + 1, new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), T.characterId);
        }
    })();
    wdb.close();
    const bonusBackup = writeBonus(weapons, stamp);
    marker.push({ source: key, account: srcUser, character: S.name, into: T.characterId, at: new Date().toISOString(), file: path.resolve(src), kind: srcKind });
    fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2));
    const report = [
        `Dauntless Revived import, ${new Date().toString()}`, ...lines, ``,
        `Backup of your save before the import: backup\\import-revived\\undaunted.db.${stamp}`,
        `To undo: close the game, copy that file over data\\undaunted.db, and delete data\\import-revived.json.`,
        ...(bonusBackup ? [`Weapon levels before the import: ${path.relative(ROOT, bonusBackup)} (copy it back over ${path.relative(ROOT, weapons.file)} to undo those too).`]
            : weapons.changes.length ? [`Weapon levels were new: to undo them, delete ${path.relative(ROOT, weapons.file)}.`] : []), ``,
        `New gear: ${plan.gearNew.join(", ") || "-"}`,
        `Gear levelled up: ${plan.gearUpgraded.join(", ") || "-"}`,
        `Stacks: ${plan.stacks.map((s) => `${s.id} ${s.before}->${s.after}`).join(", ") || "-"}`,
    ];
    fs.writeFileSync(REPORT, report.join("\r\n") + "\r\n");
    done({ ...summary, backup: `backup\\import-revived\\undaunted.db.${stamp}` },
        lines.join("\n") + `\n\nDone. A backup of your save is in backup\\import-revived\\undaunted.db.${stamp}\nThe full list is in data\\import-revived-report.txt`);
})().catch((e) => fail(String(e && e.message || e)));
