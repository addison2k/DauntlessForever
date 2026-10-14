// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// travel162.ts - your character travels with you. When you join a friend's game, your launcher brings your own
// character (gear, inventory, loadouts, progression, Hunt Pass, bounties, escalation...) to the friend's backend,
// into the account it made for you there; when you close the game, it brings the character home again, with
// everything you earned.
//
// One account's state = rows in the database (characters and the per-character tables) + the per-account files
// next to it (bounties/, cooldowns/, escalation/, factions/, loadouts/, pjm/, progression/: every file whose name
// starts with the account id). A "bundle" is all of that as JSON. Importing a bundle into another account
// rewrites the account id inside it (names and contents) and replaces what that account had (kept first in
// travel-backups/, last 10 per account).
//
// Used two ways: by the metagame (routes below: the joiner's launcher calls them through the relay with its
// account key), and by tools\travel.js on the player's own PC while that backend is stopped.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const BUNDLE_VERSION = 1;
export const BUILD = "1.6.2";
const STATE_DIRS = ["bounties", "cooldowns", "escalation", "factions", "loadouts", "pjm", "progression"];
const CHAR_TABLES = ["inventories", "loadouts", "breadcrumbs", "encounteredcontent"];   // keyed by characterId
const MAX_CHARACTERS = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BACKUPS = 10;

export type Bundle = {
    v: number, build: string, accountId: string, name: string, exportedAt: string,
    characters: any[], tables: Record<string, any[]>, files: Record<string, string>
};
type Db = { prepare(sql: string): { all(...a: any[]): any[], run(...a: any[]): any, get(...a: any[]): any }, transaction<T extends (...a: any[]) => any>(fn: T): T };

const IsAccountId = (v: unknown): v is string => typeof v === "string" && /^UID-[0-9A-Za-z-]{8,64}$/.test(v);
const safeName = (uid: string) => uid.replace(/[^\w-]/g, "_");

function listStateFiles(dataDir: string, uid: string): string[] {
    const prefix = safeName(uid), out: string[] = [];
    for (const dir of STATE_DIRS) {
        const full = path.join(dataDir, dir);
        let names: string[] = [];
        try { names = fs.readdirSync(full); } catch { continue; }
        for (const n of names) {
            if (!n.startsWith(prefix)) continue;
            const p = path.join(full, n);
            try { if (fs.statSync(p).isFile()) out.push(dir + "/" + n); } catch { /* gone */ }
        }
    }
    return out;
}

export function ExportAccount(db: Db, dataDir: string, uid: string): Bundle {
    if (!IsAccountId(uid)) throw new Error("bad account id");
    const user = db.prepare("SELECT name FROM users WHERE userId = ?").get(uid);
    if (!user) throw new Error("no such account");
    const characters = db.prepare("SELECT * FROM characters WHERE userId = ?").all(uid);
    const ids = characters.map((c: any) => c.characterId);
    const tables: Record<string, any[]> = {};
    for (const t of CHAR_TABLES) {
        tables[t] = ids.length ? db.prepare(`SELECT * FROM ${t} WHERE characterId IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
    }
    const files: Record<string, string> = {};
    for (const rel of listStateFiles(dataDir, uid)) {
        const buf = fs.readFileSync(path.join(dataDir, rel));
        if (buf.length <= MAX_FILE_BYTES) files[rel] = buf.toString("base64");
    }
    return { v: BUNDLE_VERSION, build: BUILD, accountId: uid, name: user.name, exportedAt: new Date().toISOString(), characters, tables, files };
}

function checkBundle(b: any): asserts b is Bundle {
    if (!b || typeof b !== "object" || b.v !== BUNDLE_VERSION) throw new Error("not a character bundle");
    if (b.build !== BUILD) throw new Error(`this character is from Dauntless ${b.build}, not ${BUILD}`);
    if (!IsAccountId(b.accountId)) throw new Error("bad account id in the bundle");
    if (!Array.isArray(b.characters) || b.characters.length > MAX_CHARACTERS) throw new Error("bad characters in the bundle");
    if (!b.tables || typeof b.tables !== "object" || !b.files || typeof b.files !== "object") throw new Error("bad bundle");
    for (const rel of Object.keys(b.files)) {
        const [dir, name, extra] = rel.split("/");
        if (extra !== undefined || !STATE_DIRS.includes(dir) || !name || name.includes("..") || !name.startsWith(safeName(b.accountId)) || /[\\:]/.test(name)) throw new Error("bad file in the bundle: " + rel);
    }
    for (const c of b.characters) if (!c || typeof c.characterId !== "string" || !/^[\w-]{4,80}$/.test(c.characterId)) throw new Error("bad character id in the bundle");
}

// replace every mention of one account id with another (names, JSON contents, file names)
function swapId(text: string, from: string, to: string){ return from === to ? text : text.split(from).join(to); }
function swapRow(row: any, from: string, to: string){
    const out: any = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" ? swapId(v, from, to) : v;
    return out;
}

function backupDir(dataDir: string){ return path.join(dataDir, "travel-backups"); }
function keepBackup(db: Db, dataDir: string, uid: string, why: string){
    try {
        const dir = backupDir(dataDir); fs.mkdirSync(dir, { recursive: true });
        const b = ExportAccount(db, dataDir, uid);
        if (!b.characters.length && !Object.keys(b.files).length) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(path.join(dir, `${safeName(uid)}_${stamp}_${why}.json`), JSON.stringify(b));
        const mine = fs.readdirSync(dir).filter(n => n.startsWith(safeName(uid) + "_")).sort();
        for (const old of mine.slice(0, Math.max(0, mine.length - MAX_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
    } catch { /* a backup must never stop the import */ }
}


// Bringing a character home from someone else's PC (fetch / autosave, DF-ONLINE-1): refuse what looks wrong instead of
// overwriting the player's own copy with it. "" = looks fine, else why not. The player's copy stays as it was.
const MAX_QUANTITY = 1000000000;
export function CheckHomecoming(db: Db, dataDir: string, uid: string, bundle: unknown): string {
    try { checkBundle(bundle); } catch (e: any) { return e.message; }
    const b = bundle as Bundle;
    let mine: Bundle | null = null;
    try { mine = ExportAccount(db, dataDir, uid); } catch { mine = null; }
    const have = mine ? mine.characters.length : 0;
    if (b.characters.length < have) return `it has ${b.characters.length} character(s) and you have ${have} here`;
    const list = (t: unknown) => { try { const v = JSON.parse(String(t)); return Array.isArray(v) ? v : null; } catch { return null; } };
    const before = new Map<string, any>();
    for (const r of (mine ? mine.tables.inventories || [] : [])) before.set(String(r.characterId), r);
    for (const r of (b.tables.inventories || [])) {
        const inst = list(r.instancedItems), stacked = list(r.stackedItems);
        if (!inst || !stacked) return "its inventory is damaged";
        for (const s of stacked) {
            if (!s || typeof s.catalogId !== "string" || s.catalogId.length > 128) return "it has an item with a broken name";
            if (typeof s.quantity === "number" && (!Number.isInteger(s.quantity) || s.quantity < 0 || s.quantity > MAX_QUANTITY)) return `it has ${s.quantity} of ${s.catalogId}`;
        }
        const old = before.get(String(r.characterId));
        const oldInst = old ? list(old.instancedItems) : null;
        if (oldInst && oldInst.length - inst.length > 20 && inst.length < oldInst.length / 2) return `most of your gear is missing from it (${inst.length} of ${oldInst.length} items)`;
    }
    return "";
}
export function BackupAccount(db: Db, dataDir: string, uid: string, why: string){ keepBackup(db, dataDir, uid, why); }

// Replace everything account `uid` has with the bundle's character(s). Returns a short summary.
// why "autosave" (saved home every few minutes while playing): no backup each time, the one from before the game stays.
export function ImportAccount(db: Db, dataDir: string, uid: string, bundle: unknown, why = "import"){
    checkBundle(bundle);
    if (!IsAccountId(uid)) throw new Error("bad account id");
    if (!db.prepare("SELECT userId FROM users WHERE userId = ?").get(uid)) throw new Error("no such account");
    const b = bundle, from = b.accountId;
    if (why !== "autosave") keepBackup(db, dataDir, uid, why);

    // database: the account's old characters (and anything already using the incoming character ids) go
    const oldIds: string[] = db.prepare("SELECT characterId FROM characters WHERE userId = ?").all(uid).map((r: any) => r.characterId);
    const newIds = b.characters.map(c => String(c.characterId));
    const gone = [...new Set([...oldIds, ...newIds])];
    const columnsOf = (t: string) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name));
    const insert = (t: string, row: any) => {
        const cols = columnsOf(t), keys = Object.keys(row).filter(k => cols.has(k));
        if (!keys.length) return;
        db.prepare(`INSERT OR REPLACE INTO ${t} (${keys.map(k => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => row[k]));
    };
    db.transaction(() => {
        if (gone.length) {
            const marks = gone.map(() => "?").join(",");
            for (const t of CHAR_TABLES) db.prepare(`DELETE FROM ${t} WHERE characterId IN (${marks})`).run(...gone);
            db.prepare(`DELETE FROM characters WHERE characterId IN (${marks})`).run(...gone);
        }
        for (const c of b.characters) insert("characters", { ...swapRow(c, from, uid), userId: uid });
        for (const t of CHAR_TABLES) for (const r of (b.tables[t] || [])) {
            if (!newIds.includes(String(r.characterId))) continue;
            const row = swapRow(r, from, uid); if ("userId" in row) row.userId = uid;
            insert(t, row);
        }
    })();

    // files: the account's old state files go, the bundle's come in under the new id
    for (const rel of listStateFiles(dataDir, uid)) fs.rmSync(path.join(dataDir, rel), { force: true });
    let files = 0;
    for (const [rel, b64] of Object.entries(b.files)) {
        const [dir, name] = rel.split("/");
        const target = path.join(dataDir, dir, safeName(uid) + name.slice(safeName(from).length));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const raw = Buffer.from(b64, "base64");
        // text files get the id swapped inside too; anything that is not valid UTF-8 is copied as it is
        const text = raw.toString("utf8");
        const out = Buffer.from(text, "utf8").equals(raw) ? Buffer.from(swapId(text, from, uid), "utf8") : raw;
        const tmp = target + ".tmp-" + crypto.randomBytes(4).toString("hex");
        fs.writeFileSync(tmp, out); fs.renameSync(tmp, target);
        files++;
    }
    return { characters: b.characters.length, files, from, to: uid, name: b.name };
}
