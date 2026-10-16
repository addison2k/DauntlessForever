// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HuntPassPath = void 0;
exports.ActivePassId = ActivePassId;
exports.PlayerEntitlements = PlayerEntitlements;
exports.HuntPassTrack = HuntPassTrack;
exports.RecordHuntPassPost = RecordHuntPassPost;
exports.AddHuntPassXp = AddHuntPassXp;
// huntpass162.ts — your own Hunt Pass for 1.6.2 (goal 4)
//
// The 1.6.2 client (hunt_pass_season_table) only accepts passes marked available in this build; the newest real one
// is HuntPass_Season13a with progression track "season13a". The client table has NO levels or rewards of its own:
// it reads them from the "season13a" track in /progression/config. So the whole pass is defined in
// vendor/huntpass_162.json (levels, XP curve, rewards, prestige) and built into a progression track here.
//
// Pass XP:
//  - If the game server posts progress for the pass track (progress_tracks[].progression_id == pass id, as a delta
//    like the mastery tracks), that is used.
//  - Until the server has EVER posted pass XP, each hunt's gained Weapon Skill XP x weapon_xp_ratio is used instead.
//    The first real server report switches this fallback off for good, so nothing is counted twice.
// Rewards (claim_mode):
//  - "grant":  the metagame puts each level's free AND elite rewards straight into the inventory when the level is
//              reached (like mastery-rewards.ts), and reports paid levels as claimed. Items show after rejoining a server.
//  - "client": the game claims rewards itself; posted confirmed ranks are stored and served back.
//  - "auto":   levels count as claimed as soon as they are reached (nothing is paid).
//
// State per player: <PROGRESSION_STATE_DIR>\<UID>.huntpass.json  { passes: { <pass id>: { xp, confirmed_free, ... } } }
// Log prefix "HuntPass:".
//
// Seasons (the launcher's "pick a season"):
//  - HUNTPASS_SEASONS_DIR = a folder of season files (<key>.json, same format as huntpass_162.json).
//    HUNTPASS_SEASON = the key to serve (start.ps1 sets both; the key comes from data\season.txt).
//    Without a key, active.txt in that folder is read, then index.json's "default".
//    Without HUNTPASS_SEASONS_DIR the single vendor/huntpass_162.json is used, as before.
//  - Every season file keeps pass_id "season13a" (the newest pass the 1.6.2 client shows), so the screen always says
//    Time Strike; the levels and rewards are the chosen season's.
//  - Progress is saved per season under season_key (default: pass_id), in <UID>.huntpass.json -> passes[season_key].
//    Switching seasons keeps each season's XP, level and paid levels; switching back resumes where it was.
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("./db");
const schema_1 = require("./db/schema");
const inventory_1 = require("./controllers/inventory");
const logger_1 = require("./logger");
const rules162_1 = require("./rules162");
const DEFAULTS = {
    pass_id: "season13a",
    levels: 50,
    xp_per_level: 100,
    weapon_xp_ratio: 1,
    max_xp_per_post: 1000,
    premium_free: false,
    claim_mode: "grant",
    start_date: "2020-01-01T00:00:00+00:00",
    end_date: "2099-01-01T00:00:00+00:00",
    prestige: null,
    rewards: {},
    entitlements: ["season13a_premium", "exchange_slot_2", "exchange_slot_3"],
    entitlement_shape: "objects",
};
const CONFIG_CANDIDATES = [
    path_1.default.join(__dirname, "vendor", "huntpass_162.json"),
    path_1.default.join(process.cwd(), "src", "vendor", "huntpass_162.json"),
];
const STATE_DIR = process.env.PROGRESSION_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "progression");
function ReadJson(file) {
    // UTF-8 with/without BOM and UTF-16LE (PowerShell ">" writes UTF-16)
    const buf = fs_1.default.readFileSync(file);
    const text = (buf[0] === 0xFF && buf[1] === 0xFE) ? buf.toString("utf16le") : buf.toString("utf8");
    return JSON.parse(text.replace(/^\uFEFF/, ""));
}
// The active season's file from HUNTPASS_SEASONS_DIR, or null (then vendor/huntpass_162.json is used)
function SeasonFile() {
    const dir = process.env.HUNTPASS_SEASONS_DIR?.trim();
    if (!dir)
        return null;
    let key = process.env.HUNTPASS_SEASON?.trim() ?? "";
    if (!key) {
        try {
            key = fs_1.default.readFileSync(path_1.default.join(dir, "active.txt"), "utf8").replace(/^\uFEFF/, "").trim();
        }
        catch { /* none */ }
    }
    if (!key) {
        try {
            key = String(ReadJson(path_1.default.join(dir, "index.json")).default ?? "").trim();
        }
        catch { /* none */ }
    }
    if (!key || !/^[\w.-]+$/.test(key)) {
        logger_1.logger.warn(`HuntPass: HUNTPASS_SEASONS_DIR is set but no usable season key ("${key}"); using huntpass_162.json`);
        return null;
    }
    const file = path_1.default.join(dir, key.endsWith(".json") ? key : `${key}.json`);
    if (!fs_1.default.existsSync(file)) {
        logger_1.logger.warn(`HuntPass: season "${key}" not found at ${file}; using huntpass_162.json`);
        return null;
    }
    return file;
}
function LoadConfig() {
    const file = SeasonFile() ?? CONFIG_CANDIDATES.find(p => fs_1.default.existsSync(p));
    if (!file) {
        logger_1.logger.warn(`HuntPass: huntpass_162.json not found (${CONFIG_CANDIDATES.join(" | ")}); serving an empty ${DEFAULTS.pass_id} pass`);
        return { ...DEFAULTS };
    }
    try {
        const cfg = { ...DEFAULTS, ...ReadJson(file) };
        cfg.levels = Math.max(1, Math.floor(Number(cfg.levels)));
        return cfg;
    }
    catch (e) {
        logger_1.logger.error(e, `HuntPass: could not parse ${file}; serving an empty ${DEFAULTS.pass_id} pass`);
        return { ...DEFAULTS };
    }
}
const cfg = LoadConfig();
// Where this season's progress is saved (each season has its own XP, level and paid levels)
const STATE_KEY = (cfg.season_key ?? "").trim() || cfg.pass_id;
function Stacked(list) {
    return (list ?? []).map(([catalog_id, quantity], i) => ({ catalog_id, hidden: false, priority: i, quantity: Number(quantity) }));
}
function XpForLevel(level) {
    return Number(cfg.xp_curve?.[level - 1] ?? cfg.xp_per_level);
}
// The pass as a progression track, in the same shape as 1.4.4's season09b entry
function BuildPassPath() {
    const requirements = [{ rank_id: 0, xp_required: 0 }];
    const free_rewards = [];
    const premium_rewards = [];
    for (let rank = 0; rank <= cfg.levels; rank++) {
        if (rank > 0)
            requirements.push({ rank_id: rank, xp_required: XpForLevel(rank) });
        const r = cfg.rewards[String(rank)] ?? {};
        free_rewards.push({ entitlements: [], instanced_items: [], rank_id: rank, stacked_items: Stacked(r.free) });
        premium_rewards.push({ entitlements: [], instanced_items: [], rank_id: rank, stacked_items: Stacked(r.premium) });
    }
    const p = {
        end_date: cfg.end_date,
        premium_gating_entitlement: cfg.premium_free ? "" : `${cfg.pass_id}_premium`,
        progression_id: cfg.pass_id,
        progression_multiplier: 1,
        start_date: cfg.start_date,
        requirements,
        free_rewards,
        premium_rewards,
    };
    if (cfg.prestige && cfg.prestige.xp_per_level > 0) {
        p.prestige = {
            free_rewards: { stacked_items: Stacked(cfg.prestige.free) },
            premium_rewards: { stacked_items: Stacked(cfg.prestige.premium) },
            xp_per_level: cfg.prestige.xp_per_level,
        };
    }
    return p;
}
exports.HuntPassPath = BuildPassPath();
const TOTAL_XP = exports.HuntPassPath.requirements.reduce((s, r) => s + r.xp_required, 0);
function ActivePassId() {
    return cfg.pass_id;
}
// Entitlements the player owns (/entitlementsv2). The Elite row needs the pass's premium gate among them, so it is
// always added when premium is gated. The reply shape the 1.6.2 client expects isn't known yet: "objects" carries the
// id under every likely field name, "strings" is a plain list of ids, "wrapped" is { entitlements: [objects] }.
// The client logs "Player entitlements: Player <id> has <n> entitlements"; if n is 0, try the next shape.
function PlayerEntitlements() {
    const ids = new Set((cfg.entitlements ?? []).map(String).filter(Boolean));
    if (!cfg.premium_free)
        ids.add(`${cfg.pass_id}_premium`);
    const list = [...ids];
    const shape = cfg.entitlement_shape ?? "objects";
    // [ent-dates] FArchonPlayerEntitlement has Name / ActivationDateUtc / ExpirationDateUtc. An empty expiration
    // may count as expired (exchange_slot_2/3 stayed locked), so send far-future dates under every likely key.
    const activation = new Date("2020-01-01T00:00:00Z").toISOString();
    const expiration = new Date("2099-01-01T00:00:00Z").toISOString();
    const objects = list.map(id => ({
        entitlement: id, entitlement_id: id, entitlementId: id, entitlementName: id, EntitlementId: id,
        name: id, Name: id, id, quantity: 1,
        duration: 0,
        created_date: activation,
        activation_date: activation, activationDate: activation, ActivationDateUtc: activation, activation_date_utc: activation,
        start_date: activation, startDate: activation,
        expiration_date: expiration, expirationDate: expiration, ExpirationDateUtc: expiration, expiration_date_utc: expiration,
        end_date: expiration, endDate: expiration, expires_at: expiration, expiresAt: expiration,
    }));
    const payload = shape === "strings" ? list : shape === "wrapped" ? { entitlements: objects } : objects;
    return { ids: list, shape, payload };
}
// Level for an XP total (0..levels), plus prestige levels beyond the last one if the pass has prestige
function PassLevel(xp) {
    let level = 0, needed = 0;
    for (let rank = 1; rank <= cfg.levels; rank++) {
        needed += XpForLevel(rank);
        if (xp >= needed)
            level = rank;
        else
            break;
    }
    const prestigeXp = cfg.prestige?.xp_per_level ?? 0;
    const prestige = level === cfg.levels && prestigeXp > 0 ? Math.floor((xp - TOTAL_XP) / prestigeXp) : 0;
    return { level, prestige };
}
function StatePath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.huntpass.json`);
}
function LoadStateFile(accountId) {
    try {
        const parsed = ReadJson(StatePath(accountId));
        return { passes: parsed.passes ?? {} };
    }
    catch {
        return { passes: {} };
    }
}
function SaveStateFile(accountId, file) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const p = StatePath(accountId);
    fs_1.default.writeFileSync(p + ".tmp", JSON.stringify(file, null, 2));
    fs_1.default.renameSync(p + ".tmp", p);
}
function PassStateOf(file) {
    return file.passes[STATE_KEY] ?? { xp: 0, confirmed_free: 0, confirmed_premium: 0, server_reports: false };
}
// What /progression serves for the pass track
function HuntPassTrack(accountId) {
    const s = PassStateOf(LoadStateFile(accountId));
    const { level, prestige } = PassLevel(s.xp);
    const top = level + prestige;
    // grant: paid levels show as claimed; auto: everything reached shows as claimed; client: what the game claimed
    const claimed = cfg.claim_mode === "grant" ? Math.min((s.granted_level ?? 0) + (s.granted_prestige ?? 0), top)
        : cfg.claim_mode === "auto" ? top : -1;
    return {
        phx_account_id: accountId,
        progression_id: cfg.pass_id,
        progress: s.xp,
        confirmed_fremium_rank: claimed >= 0 ? claimed : Math.min(s.confirmed_free, top),
        confirmed_premium_rank: claimed >= 0 ? claimed : Math.min(s.confirmed_premium, top),
        confirmed_date: new Date().toISOString(),
    };
}
// Called for every progression post (after objectives were applied). weaponXpGained = Weapon Skill XP this post added.
function RecordHuntPassPost(accountId, body, weaponXpGained) {
    const entries = (Array.isArray(body?.progress_tracks) ? body.progress_tracks : [])
        .filter((t) => String(t?.progression_id) === cfg.pass_id);
    if (!entries.length && weaponXpGained <= 0)
        return;
    const file = LoadStateFile(accountId);
    const s = { ...PassStateOf(file) };
    const before = PassLevel(s.xp);
    let gained = 0, source = "";
    let changed = false;
    for (const t of entries) {
        logger_1.logger.info(`HuntPass: posted ${JSON.stringify(t)}`);
        const cf = t.confirmed_fremium_rank ?? t.confirmed_freemium_rank ?? t.confirmed_free_rank;
        const cp = t.confirmed_premium_rank;
        if (cf !== undefined || cp !== undefined) {
            // A claim / state echo: remember the claimed levels, don't treat its progress as new XP
            if (cf !== undefined && Number(cf) > s.confirmed_free) {
                s.confirmed_free = Number(cf);
                changed = true;
            }
            if (cp !== undefined && Number(cp) > s.confirmed_premium) {
                s.confirmed_premium = Number(cp);
                changed = true;
            }
            continue;
        }
        const p = Number(t.progress ?? 0);
        if (p > 0 && p <= cfg.max_xp_per_post) {
            gained += p;
            source = "game server";
            if (!s.server_reports) {
                s.server_reports = true;
                logger_1.logger.info(`HuntPass: game server reports pass XP; weapon XP fallback now off`);
            }
        }
        else if (p > cfg.max_xp_per_post) {
            logger_1.logger.warn(`HuntPass: ignored posted progress ${p} (above max_xp_per_post ${cfg.max_xp_per_post}; maybe a total, not a delta)`);
        }
    }
    if (!gained && !s.server_reports && weaponXpGained > 0 && cfg.weapon_xp_ratio > 0) {
        gained = Math.round(weaponXpGained * cfg.weapon_xp_ratio);
        source = `${weaponXpGained} weapon XP x ${cfg.weapon_xp_ratio}`;
    }
    if (gained > 0 && rules162_1.Rules.passXp !== 1) {
        // [rules] Hunt Pass XP speed (Game Rules)
        const scaled = (0, rules162_1.ScaleXp)(gained, rules162_1.Rules.passXp);
        logger_1.logger.info(`[rules] Hunt Pass XP x${rules162_1.Rules.passXp}: ${gained} -> ${scaled}`);
        gained = scaled;
        source += ` x${rules162_1.Rules.passXp}`;
    }
    if (gained > 0) {
        s.xp += gained;
        changed = true;
    }
    if (!changed) {
        QueueGrant(accountId);
        return;
    }
    file.passes[STATE_KEY] = s;
    SaveStateFile(accountId, file);
    const after = PassLevel(s.xp);
    if (gained > 0) {
        logger_1.logger.info(`HuntPass: ${cfg.pass_id} +${gained} XP from ${source} (total ${s.xp}, level ${after.level}` +
            (after.prestige ? ` + prestige ${after.prestige}` : "") + `)`);
    }
    if (after.level > before.level || after.prestige > before.prestige) {
        logger_1.logger.info(`HuntPass: level up ${before.level} -> ${after.level}` + (after.prestige ? ` (prestige ${after.prestige})` : ""));
    }
    QueueGrant(accountId);
}
// Pass XP from other sources the game doesn't pay itself (e.g. claimed bounties; see bounties162.ts)
// fromGameServer = the game's own pass XP; it switches the weapon-XP fallback off for good (server_reports)
function AddHuntPassXp(accountId, amount, source, fromGameServer = false) {
    let add = Math.floor(Number(amount));
    if (!(add > 0))
        return;
    if (rules162_1.Rules.passXp !== 1) {
        // [rules] Hunt Pass XP speed (Game Rules)
        const scaled = (0, rules162_1.ScaleXp)(add, rules162_1.Rules.passXp);
        logger_1.logger.info(`[rules] Hunt Pass XP x${rules162_1.Rules.passXp}: ${add} -> ${scaled}`);
        add = scaled;
        source += ` x${rules162_1.Rules.passXp}`;
    }
    const file = LoadStateFile(accountId);
    const s = { ...PassStateOf(file) };
    if (fromGameServer && !s.server_reports) {
        s.server_reports = true;
        logger_1.logger.info(`HuntPass: game server reports pass XP; weapon XP fallback now off`);
    }
    const before = PassLevel(s.xp);
    s.xp += add;
    file.passes[STATE_KEY] = s;
    SaveStateFile(accountId, file);
    const after = PassLevel(s.xp);
    logger_1.logger.info(`HuntPass: ${cfg.pass_id} +${add} XP from ${source} (total ${s.xp}, level ${after.level}` +
        (after.prestige ? ` + prestige ${after.prestige}` : "") + `)`);
    if (after.level > before.level || after.prestige > before.prestige) {
        logger_1.logger.info(`HuntPass: level up ${before.level} -> ${after.level}` + (after.prestige ? ` (prestige ${after.prestige})` : ""));
    }
    QueueGrant(accountId);
}
// ---------- claim_mode "grant": pay reached levels into the inventory ----------
// One grant at a time per player, so two quick posts can't pay the same level twice
const grantQueues = new Map();
function QueueGrant(accountId) {
    if (cfg.claim_mode !== "grant")
        return;
    const next = (grantQueues.get(accountId) ?? Promise.resolve())
        .then(() => DoGrant(accountId))
        .catch(e => logger_1.logger.error(e, "HuntPass: grant failed"));
    grantQueues.set(accountId, next);
}
function AddItems(into, list, times = 1) {
    for (const [id, qty] of list ?? []) {
        if (!id || !(Number(qty) > 0))
            continue;
        into.set(id, (into.get(id) ?? 0) + Number(qty) * times);
    }
}
async function DoGrant(accountId) {
    // Mega Hunt Pass (Expanded) (by KombatKing): its six-slot rewards and dye bundles are paid by mega400.js
    if(cfg._mega400_revision) return require("./mega400").grant({
        accountId,cfg,load:()=>LoadStateFile(accountId),state:PassStateOf,position:PassLevel,
        db:(0, db_1.GetDb)(),eq:drizzle_orm_1.eq,schema:require("./db/schema"),transaction:inventory_1.RunInventoryTransaction,logger:logger_1.logger,
        save:(file,next)=>{file.passes[STATE_KEY]=next;SaveStateFile(accountId,file);}
    });
    const s = PassStateOf(LoadStateFile(accountId));
    const { level, prestige } = PassLevel(s.xp);
    const fromLevel = s.granted_level ?? 0;
    const fromPrestige = s.granted_prestige ?? 0;
    if (level <= fromLevel && prestige <= fromPrestige)
        return;
    const toAdd = new Map();
    for (let r = fromLevel + 1; r <= level; r++) {
        const lr = cfg.rewards[String(r)] ?? {};
        AddItems(toAdd, lr.free);
        AddItems(toAdd, lr.premium);
    }
    if (prestige > fromPrestige && cfg.prestige) {
        AddItems(toAdd, cfg.prestige.free, prestige - fromPrestige);
        AddItems(toAdd, cfg.prestige.premium, prestige - fromPrestige);
    }
    const what = `levels ${fromLevel + 1}-${level}` + (prestige > fromPrestige ? `, prestige ${fromPrestige + 1}-${prestige}` : "");
    if (toAdd.size) {
        const chars = await (0, db_1.GetDb)().query.characters.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.characters.userId, accountId) });
        if (!chars.length) {
            logger_1.logger.warn(`HuntPass: no character for ${accountId}; will retry on next post`);
            return;
        }
        // Most recently modified character gets the rewards (same as mastery rewards)
        const character = [...chars].sort((a, b) => (a.lastModifiedDate < b.lastModifiedDate ? 1 : -1))[0];
        const items = [...toAdd].map(([catalogId, quantity]) => ({ catalogId, quantity }));
        const result = await (0, inventory_1.RunInventoryTransaction)(accountId, character.characterId, `huntpass-${Date.now()}`, [], items, [], [], []);
        if (!result.success) {
            // One bad item must not block the pass: retry one by one and skip the ones that fail
            logger_1.logger.warn(`HuntPass: batch grant failed (${result.error}); granting ${items.length} items one by one`);
            const failed = [];
            for (const item of items) {
                const one = await (0, inventory_1.RunInventoryTransaction)(accountId, character.characterId, `huntpass-${Date.now()}-${item.catalogId}`, [], [item], [], [], []);
                if (!one.success)
                    failed.push(`${item.catalogId} (${one.error})`);
            }
            if (failed.length === items.length) {
                logger_1.logger.error(`HuntPass: every item failed for ${what}; will retry on next post`);
                return;
            }
            if (failed.length)
                logger_1.logger.warn(`HuntPass: skipped ${failed.length} items that could not be granted: ${failed.join(", ")}`);
        }
        logger_1.logger.info(`HuntPass: granted ${what}: ${items.length} different items (` +
            items.slice(0, 6).map(i => `${i.catalogId} x${i.quantity}`).join(", ") + (items.length > 6 ? ", ..." : "") + ")");
    }
    // Re-read before saving: a progression post may have added XP while the grant was running
    const file = LoadStateFile(accountId);
    const cur = PassStateOf(file);
    file.passes[STATE_KEY] = { ...cur, granted_level: Math.max(cur.granted_level ?? 0, level), granted_prestige: Math.max(cur.granted_prestige ?? 0, prestige) };
    SaveStateFile(accountId, file);
}
logger_1.logger.info(`HuntPass: season "${cfg.season_title ?? STATE_KEY}" (saved as ${STATE_KEY}, shown as ${cfg.pass_id}), ${cfg.levels} levels, ${TOTAL_XP} XP total, ` +
    `${Object.keys(cfg.rewards).length} reward levels, prestige ${cfg.prestige?.xp_per_level ? "on" : "off"}, ` +
    `claim_mode ${cfg.claim_mode}, premium ${cfg.premium_free ? "free" : `gated (${cfg.pass_id}_premium)`}, ` +
    `entitlement shape ${cfg.entitlement_shape ?? "objects"}`);
