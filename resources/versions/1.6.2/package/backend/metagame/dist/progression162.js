// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REAL_OBJECTIVES = exports.MergedPaths = exports.PROGRESSION_MODE = void 0;
exports.GetMergedProgressionConfig = GetMergedProgressionConfig;
exports.ReforgeReward = ReforgeReward;
exports.NoteReforgePrepaid = NoteReforgePrepaid;
exports.GrantTrackXp = GrantTrackXp;
exports.ApplyProgressionPost = ApplyProgressionPost;
exports.ObjectivesForPriming = ObjectivesForPriming;
exports.ResetWeaponTrack = ResetWeaponTrack;
exports.GetObjectiveProgress = GetObjectiveProgress;
exports.ListObjectiveProgress = ListObjectiveProgress;
exports.BuildProgressTracks = BuildProgressTracks;
exports.LogProgressionPost = LogProgressionPost;
// progression162.ts — shared progression config for 1.6.2
// Merges vendor/progression_config.json (1.4.4 ids) with vendor/progression_config_162.json
// (ExperienceTrack_* ids) so both /progression/config and /progression/:userId serve the same tracks.
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const progression_config_json_1 = __importDefault(require("./vendor/progression_config.json"));
const logger_1 = require("./logger");
const mastery_rewards_1 = require("./mastery-rewards");
const huntpass162_1 = require("./huntpass162");
const rules162_1 = require("./rules162");
// Looked up at runtime so the metagame still builds without it (tsc doesn't copy unreferenced json to dist)
const CONFIG_162_CANDIDATES = [
    path_1.default.join(__dirname, "vendor", "progression_config_162.json"),
    path_1.default.join(process.cwd(), "src", "vendor", "progression_config_162.json"),
];
const CONFIG_162_PATH = CONFIG_162_CANDIDATES.find(p => fs_1.default.existsSync(p)) ?? CONFIG_162_CANDIDATES[1];
const POST_LOG_PATH = process.env.PROGRESSION_POST_LOG ?? path_1.default.join(process.cwd(), "progression_posts.jsonl");
// unlock_all: every track reported at max rank (default, same idea as upstream stub)
// zero:       every track reported at rank 0 (useful to see what the client asks for)
// real:       ExperienceTrack_Weapon_* use saved Weapon Skill XP earned from hunts,
//             MasteryTrack_* use saved mastery points the game server grants;
//             the active Hunt Pass (huntpass162.ts) uses its own saved pass XP;
//             every other track (old seasons) stays at max rank like unlock_all
exports.PROGRESSION_MODE = (process.env.PROGRESSION_MODE ?? "unlock_all").toLowerCase();
const UNLOCK_PROGRESS = 99999999;
function Load162Paths() {
    if (!fs_1.default.existsSync(CONFIG_162_PATH)) {
        logger_1.logger.warn(`progression_config_162.json not found at ${CONFIG_162_PATH}; serving 1.4.4 tracks only`);
        return [];
    }
    try {
        // Accept UTF-8 with/without BOM and UTF-16LE (PowerShell's ">" writes UTF-16)
        const buf = fs_1.default.readFileSync(CONFIG_162_PATH);
        const text = (buf[0] === 0xFF && buf[1] === 0xFE) ? buf.toString("utf16le") : buf.toString("utf8");
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        return (parsed.payload?.paths ?? parsed.paths ?? []);
    }
    catch (e) {
        logger_1.logger.error(e, "Failed to parse progression_config_162.json");
        return [];
    }
}
const basePaths = progression_config_json_1.default.payload.paths;
const paths162 = Load162Paths();
// 1.6.2 entries win over 1.4.4 entries with the same id; the custom Hunt Pass (huntpass162.ts) wins over both
const merged = new Map();
for (const p of [...basePaths, ...paths162])
    merged.set(p.progression_id, p);
merged.set(huntpass162_1.HuntPassPath.progression_id, huntpass162_1.HuntPassPath);
// [reforge] The 1.6.2 config gives every PrestigeTrack_Weapon_* only rank 0, so the reforge badge under the weapon
// level could never show more than 0 whatever we stored. One rank per reforge (1 progress each), up to
// PRESTIGE_MAX_RANK (default 100), so progress 2 = rank 2.
const PRESTIGE_MAX_RANK = Math.max(1, Math.min(1000, Math.floor(Number(process.env.PRESTIGE_MAX_RANK ?? 100)) || 100));
for (const [id, p] of merged) {
    if (!id.startsWith("PrestigeTrack_"))
        continue;
    const requirements = [{ rank_id: 0, xp_required: 0 }];
    for (let r = 1; r <= PRESTIGE_MAX_RANK; r++)
        requirements.push({ rank_id: r, xp_required: 1 });
    merged.set(id, { ...p, requirements });
}
exports.MergedPaths = [...merged.values()];
function GetMergedProgressionConfig() {
    return { ...progression_config_json_1.default, payload: { ...progression_config_json_1.default.payload, paths: exports.MergedPaths } };
}
function MaxRank(p) {
    return p.requirements?.length ? Math.max(...p.requirements.map(r => r.rank_id)) : 0;
}
function TotalXp(p) {
    return (p.requirements ?? []).reduce((sum, r) => sum + (r.xp_required ?? 0), 0);
}
// ---------- Real progression (PROGRESSION_MODE=real) ----------
//
// What the game server posts (worked out from progression_posts.jsonl):
//  - objectives[].value is the objective's CURRENT progress (the server loads the saved progress when you
//    join and keeps counting), and completed_count is how many completions happened in THIS update.
//    Repeatable objectives (the tiered "Experience" ones, *_XP) roll over: at 220/300 a hunt worth ~104 XP
//    posted value=24 completed=1, then value=125 completed=0.
//  - The server also re-posts one-time objectives it has already completed ("Craft X" for every owned item),
//    so one-time objectives count as completed once, no matter how often that arrives.
//  - Mastery points: one per completion (each box on a mastery card), +1 Slayer Rank each.
//  - Weapon Skill XP = the lifetime XP of that weapon's *_XP objectives (completions x tier size + current).
const STATE_DIR = process.env.PROGRESSION_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "progression");
const WEAPON_OBJECTIVE = /^MasteryObjective_Weapon_([A-Za-z]+)_/;
const XP_OBJECTIVE = /^MasteryObjective_Weapon_[A-Za-z]+_.+_XP$/;
const REPEATABLE_OBJECTIVE = /_XP$/;
// XP needed per completion of a tiered "Experience" objective (the cards show /300)
const XP_TIER_SIZE = Number(process.env.PROGRESSION_XP_TIER ?? 300);
// Weapon names used inside objective ids -> the name used in track ids
const WEAPON_ALIASES = {
    Axe: "Axe", GA: "Axe",
    CB: "ChainBlades", ChainBlades: "ChainBlades", Chainblades: "ChainBlades",
    Hammer: "Hammer", IH: "Hammer",
    Pike: "Spear", Spear: "Spear", WarPike: "Spear", MS: "Spear",
    Repeater: "Repeaters", Repeaters: "Repeaters", DP: "Repeaters",
    Sword: "Sword", EB: "Sword",
    Strikers: "Strikers", Striker: "Strikers", AetherStrikers: "Strikers", AC: "Strikers",
};
// Serve saved objective progress instead of "everything complete". Off by default: other unlocks may read objectives.
exports.REAL_OBJECTIVES = (process.env.REAL_OBJECTIVES ?? "0") === "1";
const warnedWeapons = new Set();
function WeaponName(token) {
    const name = WEAPON_ALIASES[token] ?? null;
    if (!name && !warnedWeapons.has(token)) {
        warnedWeapons.add(token);
        logger_1.logger.warn(`Progression: unknown weapon name "${token}" in objective ids; add it to WEAPON_ALIASES`);
    }
    return name;
}
function StatePath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.json`);
}
function LoadState(accountId) {
    try {
        const raw = fs_1.default.readFileSync(StatePath(accountId), "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        return { objectives: parsed.objectives ?? {} };
    }
    catch {
        return { objectives: {} };
    }
}
function SaveState(accountId, state) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const file = StatePath(accountId);
    fs_1.default.writeFileSync(file + ".tmp", JSON.stringify({ objectives: state.objectives }, null, 2));
    fs_1.default.renameSync(file + ".tmp", file);
}
function BonusPath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.bonus.json`);
}
function LoadBonus(accountId) {
    try {
        const parsed = JSON.parse(fs_1.default.readFileSync(BonusPath(accountId), "utf8").replace(/^\uFEFF/, ""));
        return { xp: parsed.xp ?? {}, backfilled: parsed.backfilled, reforgedXp: parsed.reforgedXp ?? {}, prestige: parsed.prestige ?? {} };
    }
    catch {
        return { xp: {} };
    }
}
function SaveBonus(accountId, bonus) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const file = BonusPath(accountId);
    fs_1.default.writeFileSync(file + ".tmp", JSON.stringify(bonus, null, 2));
    fs_1.default.renameSync(file + ".tmp", file);
}
const GRANT_LOG_PATH = process.env.PROGRESSION_GRANT_LOG ?? path_1.default.join(process.cwd(), "progression_grants.jsonl");
function ReforgeReward(times) {
    const raw = (process.env.REFORGE_REWARD ?? "CURRENCY_PJM_PRESTIGE_FILLED:1").trim();
    if (!raw || /^(none|0|off)$/i.test(raw))
        return [];
    const out = [];
    for (const part of raw.split(",")) {
        const [id, n] = part.trim().split(":");
        const quantity = Math.floor(Number(n ?? 1)) * times;
        if (/^[A-Z0-9_]{3,80}$/.test(id ?? "") && quantity > 0 && quantity <= 1000)
            out.push({ catalogId: id, quantity });
        else
            logger_1.logger.warn(`Progression: REFORGE_REWARD entry "${part}" ignored`);
    }
    return out;
}
// [reforge] Hearts already paid inside the game's own spark transaction (routes/inventory.ts), so the game shows
// them at once. The PrestigeTrack post that follows within a minute then doesn't pay again.
const prepaidReforges = new Map();
function NoteReforgePrepaid(accountId) {
    const now = Date.now();
    const list = (prepaidReforges.get(accountId) ?? []).filter(t => now - t < 60000);
    list.push(now);
    prepaidReforges.set(accountId, list);
}
function TakeReforgePrepaid(accountId) {
    const now = Date.now();
    const list = (prepaidReforges.get(accountId) ?? []).filter(t => now - t < 60000);
    const had = list.length > 0;
    if (had)
        list.shift();
    prepaidReforges.set(accountId, list);
    return had;
}
function GrantTrackXp(accountId, trackId, amountRaw) {
    const amount = Math.floor(Number(amountRaw));
    try {
        fs_1.default.appendFileSync(GRANT_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, trackId, amount: amountRaw }) + "\n");
    }
    catch { /* logging only */ }
    if (!(amount > 0) || amount > 1000000) {
        logger_1.logger.warn(`Progression: ignored grant ${trackId} ${amountRaw} for ${accountId} (bad amount)`);
        return;
    }
    // The game's own Hunt Pass XP (end of hunt, part breaks, gathering): POST /progression/<uid>/season13a/<amount>
    if (trackId === (0, huntpass162_1.ActivePassId)()) {
        if (amount > 1000) {
            logger_1.logger.warn(`Progression: ignored pass grant ${trackId} +${amount} for ${accountId} (implausibly large)`);
            return;
        }
        (0, huntpass162_1.AddHuntPassXp)(accountId, amount, "game server", true);
        return;
    }
    // [reforge] Sparkforge "Reforge Weapon Skill": the game server counts one reforge with POST .../PrestigeTrack_Weapon_<W>/1
    // (right after DELETE .../ExperienceTrack_Weapon_<W>, see ResetWeaponTrack).
    if (trackId.startsWith("PrestigeTrack_Weapon_")) {
        if (amount > 10) {
            logger_1.logger.warn(`Progression: ignored reforge grant ${trackId} +${amount} for ${accountId} (implausibly large)`);
            return;
        }
        // The game takes the 100 Aethersparks itself (POST /inventory) but never asks for the Aetherheart, so the
        // backend pays it here, once per reforge. REFORGE_REWARD="ID:count[,ID:count]" changes it, "none" turns it off.
        for (let i = 0; i < amount; i++) {
            if (TakeReforgePrepaid(accountId)) {
                logger_1.logger.info(`Progression: reforge ${trackId} reward already paid with the spark transaction`);
                continue;
            }
            const reward = ReforgeReward(1);
            if (reward.length)
                (0, mastery_rewards_1.GrantItems)(accountId, reward, `reforge ${trackId}`);
        }
        if (exports.PROGRESSION_MODE !== "real")
            return;
        const bonus = LoadBonus(accountId);
        bonus.prestige = bonus.prestige ?? {};
        bonus.prestige[trackId] = (bonus.prestige[trackId] ?? 0) + amount;
        SaveBonus(accountId, bonus);
        logger_1.logger.info(`Progression: reforge ${trackId} +${amount} for ${accountId} (now ${bonus.prestige[trackId]})`);
        return;
    }
    if (trackId === "ExperienceTrack_PlayerLevel" || trackId === "MasteryTrack_PlayerLevel") {
        logger_1.logger.info(`Progression: grant ${trackId} +${amount} not stored (it is the sum of the weapon tracks)`);
        return;
    }
    if (!trackId.startsWith("ExperienceTrack_Weapon_") && !trackId.startsWith("MasteryTrack_")) {
        logger_1.logger.warn(`Progression: ignored grant ${trackId} +${amount} for ${accountId} (track not handled)`);
        return;
    }
    if (exports.PROGRESSION_MODE !== "real")
        return;
    // [rules] Weapon XP speed (Game Rules). Mastery tracks are left alone.
    let added = amount;
    if (trackId.startsWith("ExperienceTrack_Weapon_") && rules162_1.Rules.weaponXp !== 1) {
        added = (0, rules162_1.ScaleXp)(amount, rules162_1.Rules.weaponXp);
        logger_1.logger.info(`[rules] weapon XP x${rules162_1.Rules.weaponXp}: ${trackId} ${amount} -> ${added}`);
    }
    const state = LoadState(accountId);
    const bonus = LoadBonus(accountId);
    const before = DeriveTotals(state, bonus.xp);
    bonus.xp[trackId] = (bonus.xp[trackId] ?? 0) + added;
    SaveBonus(accountId, bonus);
    const after = DeriveTotals(state, bonus.xp);
    if (trackId.startsWith("ExperienceTrack_Weapon_")) {
        const xp = after.weaponXp[trackId] ?? 0;
        const total = Object.values(after.weaponXp).reduce((a, v) => a + v, 0);
        const prevTotal = Object.values(before.weaponXp).reduce((a, v) => a + v, 0);
        logger_1.logger.info(`Progression: granted ${trackId} +${added} (total ${xp}, rank ${RankForXp(trackId, xp)}); ` +
            `Weapon Skill XP ${prevTotal} -> ${total}`);
    }
    else {
        const pts = after.tracks[trackId] ?? 0;
        logger_1.logger.info(`Progression: granted ${trackId} +${amount} (total ${pts}, rank ${RankForXp(trackId, pts)})`);
    }
    (0, mastery_rewards_1.GrantMasteryRewards)(accountId, after.tracks, RankForXp);
}
function DeriveTotals(state, bonusXp = {}) {
    const weaponXp = {};
    const tracks = {};
    for (const [track, amount] of Object.entries(bonusXp)) {
        if (!(amount > 0))
            continue;
        if (track.startsWith("ExperienceTrack_Weapon_")) {
            weaponXp[track] = (weaponXp[track] ?? 0) + amount;
        }
        else if (track.startsWith("MasteryTrack_")) {
            tracks[track] = (tracks[track] ?? 0) + amount;
            tracks["MasteryTrack_PlayerLevel"] = (tracks["MasteryTrack_PlayerLevel"] ?? 0) + amount;
        }
    }
    for (const [id, o] of Object.entries(state.objectives)) {
        const w = WEAPON_OBJECTIVE.exec(id);
        const weapon = w ? WeaponName(w[1]) : null;
        const repeatable = REPEATABLE_OBJECTIVE.test(id);
        // [xp-fix] Weapon Skill XP comes only from the game's direct grants (bonus.json:
        // kills, wildlife, bounties). The *_XP objectives count the same kills again,
        // so they no longer add Weapon Skill XP. They still feed mastery below.
        const points = repeatable ? o.completed_count : Math.min(1, o.completed_count);
        if (points > 0 && id.startsWith("MasteryObjective_")) {
            let track = null;
            if (weapon)
                track = `MasteryTrack_Weapon_${weapon}`;
            else if (id.startsWith("MasteryObjective_Behemoth_"))
                track = "MasteryTrack_Behemoth";
            if (track) {
                tracks[track] = (tracks[track] ?? 0) + points;
                tracks["MasteryTrack_PlayerLevel"] = (tracks["MasteryTrack_PlayerLevel"] ?? 0) + points;
            }
        }
    }
    return { weaponXp, tracks };
}
// Apply one posted objective update to the saved state; returns true if anything changed
function ApplyObjective(state, id, value, completed) {
    const cur = state.objectives[id] ?? { progress: 0, completed_count: 0 };
    const next = { ...cur };
    if (REPEATABLE_OBJECTIVE.test(id)) {
        // [xp-fix] In 1.6.2 posts, both value and completed_count are running totals
        // (checked in progression_posts.jsonl: completed goes 0,1,1,2,2; value climbs per kill).
        // Keep the highest seen; never add each post's count, and never let a fresh session lower it.
        next.completed_count = Math.max(cur.completed_count, completed);
        next.progress = Math.max(cur.progress, value);
    }
    else {
        if (completed > 0)
            next.completed_count = 1;
        next.progress = Math.max(cur.progress, value);
    }
    if (next.progress === cur.progress && next.completed_count === cur.completed_count)
        return false;
    state.objectives[id] = next;
    return true;
}
function ApplyProgressionPost(accountId, body) {
    if (exports.PROGRESSION_MODE !== "real")
        return;
    const objectives = Array.isArray(body?.objectives) ? body.objectives : [];
    let weaponXpGained = 0;
    if (objectives.length) {
        const state = LoadState(accountId);
        const bonusXp = LoadBonus(accountId).xp;
        const before = DeriveTotals(state, bonusXp);
        let changed = false;
        for (const o of objectives) {
            const id = String(o?.objective_id ?? "");
            if (!id)
                continue;
            const value = Math.max(0, Number(o?.value ?? 0));
            const completed = Math.max(0, Number(o?.completed_count ?? 0));
            if (ApplyObjective(state, id, value, completed))
                changed = true;
        }
        if (changed) {
            SaveState(accountId, state);
            // Log what actually moved
            const after = DeriveTotals(state, bonusXp);
            (0, mastery_rewards_1.GrantMasteryRewards)(accountId, after.tracks, RankForXp);
            for (const [track, xp] of Object.entries(after.weaponXp)) {
                const gained = xp - (before.weaponXp[track] ?? 0);
                if (gained > 0) {
                    weaponXpGained += gained;
                    logger_1.logger.info(`Progression: ${track} +${gained} XP (total ${xp}, rank ${RankForXp(track, xp)})`);
                }
            }
            for (const [track, pts] of Object.entries(after.tracks)) {
                const gained = pts - (before.tracks[track] ?? 0);
                if (gained > 0)
                    logger_1.logger.info(`Progression: ${track} +${gained} (total ${pts}, rank ${RankForXp(track, pts)})`);
            }
        }
    }
    // Hunt Pass XP: posted pass progress, or this post's Weapon Skill XP as a fallback (see huntpass162.ts)
    try {
        (0, huntpass162_1.RecordHuntPassPost)(accountId, body, weaponXpGained);
    }
    catch (e) {
        logger_1.logger.error(e, "HuntPass: failed to record progress");
    }
}
// Rebuild every player's saved objectives by replaying progression_posts.jsonl (PROGRESSION_REBUILD=1)
function RebuildFromPostLog() {
    if (!fs_1.default.existsSync(POST_LOG_PATH)) {
        logger_1.logger.warn(`Progression rebuild: ${POST_LOG_PATH} not found`);
        return;
    }
    const states = new Map();
    let posts = 0;
    for (const line of fs_1.default.readFileSync(POST_LOG_PATH, "utf8").split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const userId = String(entry?.userId ?? "");
        const objectives = Array.isArray(entry?.body?.objectives) ? entry.body.objectives : [];
        if (!userId)
            continue;
        const state = states.get(userId) ?? { objectives: {} };
        for (const o of objectives) {
            const id = String(o?.objective_id ?? "");
            if (id)
                ApplyObjective(state, id, Math.max(0, Number(o?.value ?? 0)), Math.max(0, Number(o?.completed_count ?? 0)));
        }
        states.set(userId, state);
        posts++;
    }
    for (const [userId, state] of states) {
        const file = StatePath(userId);
        if (fs_1.default.existsSync(file))
            fs_1.default.copyFileSync(file, file + ".before-rebuild");
        SaveState(userId, state);
        const t = DeriveTotals(state, LoadBonus(userId).xp);
        logger_1.logger.info(`Progression rebuild: ${userId} from ${posts} posts -> Slayer points ${t.tracks["MasteryTrack_PlayerLevel"] ?? 0}, ` +
            Object.entries(t.weaponXp).map(([k, v]) => `${k.replace("ExperienceTrack_Weapon_", "")} ${v} XP`).join(", "));
    }
}
// For the game server DLL: the player's saved objective progress as "id<TAB>value<TAB>completed" lines.
// Only objectives whose bars would otherwise show 0 at login: in-progress one-time objectives and the repeatable
// "Experience" ones. Falls back to the most recently saved player if the id isn't known (single-player setups).
function ObjectivesForPriming(accountId) {
    // Only ever this player's own file: an unknown id gets nothing (no fallback to another player's progress)
    const file = StatePath(accountId);
    let objectives = {};
    try {
        objectives = JSON.parse(fs_1.default.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).objectives ?? {};
    }
    catch { /* none saved */ }
    const lines = [];
    for (const [id, o] of Object.entries(objectives)) {
        const repeatable = REPEATABLE_OBJECTIVE.test(id);
        if (repeatable ? (o.progress > 0 || o.completed_count > 0) : (o.completed_count === 0 && o.progress > 0)) {
            lines.push(`${id}\t${o.progress}\t${o.completed_count}`);
        }
    }
    logger_1.logger.info(`Progression: sent ${lines.length} saved objectives to the game server for ${path_1.default.basename(file, ".json")}`);
    return lines.join("\n");
}
// [reforge] DELETE /progression/<uid>/ExperienceTrack_Weapon_<W>: the game server resets a weapon to level 1 when it is
// reforged at the Sparkforge (it has already paid the Aethersparks and given the Aetherheart through /inventory).
// The weapon's XP moves to reforgedXp: the weapon starts again at 0, the Slayer's Path keeps the XP.
// Only weapon experience tracks can be reset; anything else is refused (returns false).
function ResetWeaponTrack(accountId, trackId) {
    if (!trackId.startsWith("ExperienceTrack_Weapon_")) {
        logger_1.logger.warn(`Progression: refused reset of ${trackId} for ${accountId} (only weapon tracks are reset by a reforge)`);
        return false;
    }
    if (exports.PROGRESSION_MODE !== "real")
        return true;
    const bonus = LoadBonus(accountId);
    const moved = Math.max(0, bonus.xp[trackId] ?? 0);
    bonus.reforgedXp = bonus.reforgedXp ?? {};
    bonus.reforgedXp[trackId] = (bonus.reforgedXp[trackId] ?? 0) + moved;
    bonus.xp[trackId] = 0;
    SaveBonus(accountId, bonus);
    logger_1.logger.info(`Progression: reforge reset ${trackId} for ${accountId}: ${moved} XP moved off the weapon (kept for the Slayer's Path)`);
    return true;
}
function GetObjectiveProgress(accountId, objectiveId) {
    if (exports.PROGRESSION_MODE !== "real" || !exports.REAL_OBJECTIVES)
        return null;
    return LoadState(accountId).objectives[objectiveId] ?? { progress: 0, completed_count: 0 };
}
function ListObjectiveProgress(accountId) {
    if (exports.PROGRESSION_MODE !== "real" || !exports.REAL_OBJECTIVES)
        return [];
    const objectives = LoadState(accountId).objectives;
    return Object.entries(objectives).map(([objective_id, o]) => ({
        // Field names confirmed from the game exe: objective_id, progress, completed_count, created_date, last_modified_date
        phx_account_id: accountId,
        objective_id,
        progress: o.progress,
        completed_count: o.completed_count,
        created_date: new Date("1970-1-1").toISOString(),
        last_modified_date: new Date().toISOString(),
    }));
}
function RankForXp(trackId, xp) {
    const p = merged.get(trackId);
    let rank = 0, needed = 0;
    for (const r of [...(p?.requirements ?? [])].sort((a, b) => a.rank_id - b.rank_id)) {
        needed += r.xp_required ?? 0;
        if (xp >= needed)
            rank = r.rank_id;
        else
            break;
    }
    return rank;
}
function BuildProgressTracks(accountId, filter) {
    const now = new Date().toISOString();
    const bonusState = exports.PROGRESSION_MODE === "real" ? LoadBonus(accountId) : null;
    const totals = bonusState ? DeriveTotals(LoadState(accountId), bonusState.xp) : null;
    const reforgedTotal = bonusState ? Object.values(bonusState.reforgedXp ?? {}).reduce((sum, v) => sum + (v > 0 ? v : 0), 0) : 0;
    return exports.MergedPaths.filter(p => (filter ? filter(p) : true)).map(p => {
        if (exports.PROGRESSION_MODE === "real" && p.progression_id === (0, huntpass162_1.ActivePassId)())
            return (0, huntpass162_1.HuntPassTrack)(accountId);
        // Weapon prestige (1.6.2, weapon_prestige_track_table): starts at 0 and is only raised by prestiging a weapon
        // (a CURRENCY_PJM_PRESTIGE_EMPTY cost). Must never get the "unlocked" 99,999,999 of the old season tracks.
        if (p.progression_id.startsWith("PrestigeTrack_")) {
            const reforges = Math.min(bonusState?.prestige?.[p.progression_id] ?? 0, MaxRank(p));
            return {
                phx_account_id: accountId,
                progression_id: p.progression_id,
                progress: reforges,
                confirmed_fremium_rank: reforges,
                confirmed_premium_rank: reforges,
                confirmed_date: now,
            };
        }
        const isWeaponXp = p.progression_id.startsWith("ExperienceTrack_Weapon_");
        // Slayer's Path spine nodes cost "Weapon Skill Experience" = total weapon XP across all weapons
        const isPlayerXp = p.progression_id === "ExperienceTrack_PlayerLevel";
        if (totals && (isWeaponXp || isPlayerXp || p.progression_id.startsWith("MasteryTrack_"))) {
            const xp = isPlayerXp
                ? Object.values(totals.weaponXp).reduce((sum, v) => sum + v, 0) + reforgedTotal
                : isWeaponXp ? (totals.weaponXp[p.progression_id] ?? 0) : (totals.tracks[p.progression_id] ?? 0);
            const rank = RankForXp(p.progression_id, xp);
            return {
                phx_account_id: accountId,
                progression_id: p.progression_id,
                progress: xp,
                confirmed_fremium_rank: rank,
                confirmed_premium_rank: rank,
                confirmed_date: now,
            };
        }
        const unlocked = exports.PROGRESSION_MODE === "unlock_all" || exports.PROGRESSION_MODE === "real";
        const rank = unlocked ? MaxRank(p) : 0;
        return {
            phx_account_id: accountId,
            progression_id: p.progression_id,
            // Tracks with prestige (old season09b) get exactly their total: anything above it counts as prestige
            // levels, and 99,999,999 progress is what minted the 1,999,898 Vault Coins
            progress: unlocked ? (p.prestige ? TotalXp(p) : Math.max(TotalXp(p), UNLOCK_PROGRESS)) : 0,
            confirmed_fremium_rank: rank,
            confirmed_premium_rank: rank,
            confirmed_date: now,
        };
    });
}
// Record every progression grant the game server sends, so we can build real progression later
function LogProgressionPost(userId, body) {
    try {
        fs_1.default.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId, body }) + "\n");
    }
    catch (e) {
        logger_1.logger.error(e, "Failed to write progression post log");
    }
}
if (exports.PROGRESSION_MODE === "real" && process.env.PROGRESSION_REBUILD === "1")
    RebuildFromPostLog();
logger_1.logger.info(`Progression: mode=${exports.PROGRESSION_MODE}, ${exports.MergedPaths.length} tracks (${paths162.length} from 1.6.2 config)` +
    (exports.PROGRESSION_MODE === "real" ? `, mastery from objectives, real objectives: ${exports.REAL_OBJECTIVES ? "on" : "off"}` : ""));
