// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// progression162.ts — shared progression config for 1.6.2
// Merges vendor/progression_config.json (1.4.4 ids) with vendor/progression_config_162.json
// (ExperienceTrack_* ids) so both /progression/config and /progression/:userId serve the same tracks.
import fs from "fs";
import path from "path";
import baseConfig from "./vendor/progression_config.json";
import { logger } from "./logger";
import { GrantItems, GrantMasteryRewards } from "./mastery-rewards";
import { ActivePassId, AddHuntPassXp, HuntPassPath, HuntPassTrack, RecordHuntPassPost } from "./huntpass162";
import { Rules, ScaleXp } from "./rules162";


export type ProgressionPath = {
    progression_id: string;
    requirements?: { rank_id: number; xp_required: number }[];
    [key: string]: any;
};

// Looked up at runtime so the metagame still builds without it (tsc doesn't copy unreferenced json to dist)
const CONFIG_162_CANDIDATES = [
    path.join(__dirname, "vendor", "progression_config_162.json"),
    path.join(process.cwd(), "src", "vendor", "progression_config_162.json"),
];
const CONFIG_162_PATH = CONFIG_162_CANDIDATES.find(p => fs.existsSync(p)) ?? CONFIG_162_CANDIDATES[1];
const POST_LOG_PATH = process.env.PROGRESSION_POST_LOG ?? path.join(process.cwd(), "progression_posts.jsonl");

// unlock_all: every track reported at max rank (default, same idea as upstream stub)
// zero:       every track reported at rank 0 (useful to see what the client asks for)
// real:       ExperienceTrack_Weapon_* use saved Weapon Skill XP earned from hunts,
//             MasteryTrack_* use saved mastery points the game server grants;
//             the active Hunt Pass (huntpass162.ts) uses its own saved pass XP;
//             every other track (old seasons) stays at max rank like unlock_all
export const PROGRESSION_MODE = (process.env.PROGRESSION_MODE ?? "unlock_all").toLowerCase();

const UNLOCK_PROGRESS = 99999999;

function Load162Paths(): ProgressionPath[] {
    if (!fs.existsSync(CONFIG_162_PATH)) {
        logger.warn(`progression_config_162.json not found at ${CONFIG_162_PATH}; serving 1.4.4 tracks only`);
        return [];
    }
    try {
        // Accept UTF-8 with/without BOM and UTF-16LE (PowerShell's ">" writes UTF-16)
        const buf = fs.readFileSync(CONFIG_162_PATH);
        const text = (buf[0] === 0xFF && buf[1] === 0xFE) ? buf.toString("utf16le") : buf.toString("utf8");
        const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
        return (parsed.payload?.paths ?? parsed.paths ?? []) as ProgressionPath[];
    } catch (e) {
        logger.error(e, "Failed to parse progression_config_162.json");
        return [];
    }
}

const basePaths = (baseConfig as any).payload.paths as ProgressionPath[];
const paths162 = Load162Paths();

// 1.6.2 entries win over 1.4.4 entries with the same id; the custom Hunt Pass (huntpass162.ts) wins over both
const merged = new Map<string, ProgressionPath>();
for (const p of [...basePaths, ...paths162]) merged.set(p.progression_id, p);
merged.set(HuntPassPath.progression_id, HuntPassPath);

// [reforge] The 1.6.2 config gives every PrestigeTrack_Weapon_* only rank 0, so the reforge badge under the weapon
// level could never show more than 0 whatever we stored. One rank per reforge (1 progress each), up to
// PRESTIGE_MAX_RANK (default 100), so progress 2 = rank 2.
const PRESTIGE_MAX_RANK = Math.max(1, Math.min(1000, Math.floor(Number(process.env.PRESTIGE_MAX_RANK ?? 100)) || 100));
for (const [id, p] of merged) {
    if (!id.startsWith("PrestigeTrack_")) continue;
    const requirements = [{ rank_id: 0, xp_required: 0 }];
    for (let r = 1; r <= PRESTIGE_MAX_RANK; r++) requirements.push({ rank_id: r, xp_required: 1 });
    merged.set(id, { ...p, requirements });
}

export const MergedPaths: ProgressionPath[] = [...merged.values()];

export function GetMergedProgressionConfig() {
    return { ...(baseConfig as any), payload: { ...(baseConfig as any).payload, paths: MergedPaths } };
}

function MaxRank(p: ProgressionPath) {
    return p.requirements?.length ? Math.max(...p.requirements.map(r => r.rank_id)) : 0;
}

function TotalXp(p: ProgressionPath) {
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
const WEAPON_ALIASES: Record<string, string> = {
    Axe: "Axe", GA: "Axe",
    CB: "ChainBlades", ChainBlades: "ChainBlades", Chainblades: "ChainBlades",
    Hammer: "Hammer", IH: "Hammer",
    Pike: "Spear", Spear: "Spear", WarPike: "Spear", MS: "Spear",
    Repeater: "Repeaters", Repeaters: "Repeaters", DP: "Repeaters",
    Sword: "Sword", EB: "Sword",
    Strikers: "Strikers", Striker: "Strikers", AetherStrikers: "Strikers", AC: "Strikers",
};

type ObjectiveState = { progress: number; completed_count: number };
type ProgressionState = {
    objectives: Record<string, ObjectiveState>;
    // older fields, kept only so old files still load
    weapon_xp?: Record<string, number>;
    tracks?: Record<string, number>;
    recent?: unknown[];
};

// Serve saved objective progress instead of "everything complete". Off by default: other unlocks may read objectives.
export const REAL_OBJECTIVES = (process.env.REAL_OBJECTIVES ?? "0") === "1";

const warnedWeapons = new Set<string>();
function WeaponName(token: string): string | null {
    const name = WEAPON_ALIASES[token] ?? null;
    if (!name && !warnedWeapons.has(token)) {
        warnedWeapons.add(token);
        logger.warn(`Progression: unknown weapon name "${token}" in objective ids; add it to WEAPON_ALIASES`);
    }
    return name;
}

function StatePath(accountId: string) {
    return path.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.json`);
}

function LoadState(accountId: string): ProgressionState {
    try {
        const raw = fs.readFileSync(StatePath(accountId), "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        return { objectives: parsed.objectives ?? {} };
    } catch {
        return { objectives: {} };
    }
}

function SaveState(accountId: string, state: ProgressionState) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = StatePath(accountId);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ objectives: state.objectives }, null, 2));
    fs.renameSync(file + ".tmp", file);
}

// Weapon Skill XP per ExperienceTrack_Weapon_* and mastery points per MasteryTrack_*, from the saved objectives
// ---------- XP granted directly by the game server (POST /progression/:userId/:trackId/:amount) ----------
// Bounty rewards ("Weapon Skill XP") and similar grants arrive as e.g.
//   POST /progression/<uid>/ExperienceTrack_Weapon_ChainBlades/200  +  POST /progression/<uid>/ExperienceTrack_PlayerLevel/200
// They are kept in <UID>.bonus.json (separate from objectives, so PROGRESSION_REBUILD doesn't lose them) and added on
// top of the objective-derived totals. ExperienceTrack_PlayerLevel / MasteryTrack_PlayerLevel grants are ignored:
// both are sums of the per-weapon tracks, so counting them too would double every grant.
// reforgedXp: weapon XP taken off a weapon by a reforge (Sparkforge). It no longer counts for that weapon's level, but
//             still counts for the Slayer's Path (ExperienceTrack_PlayerLevel), so a reforge never lowers the Slayer rank.
// prestige:   reforges per weapon (PrestigeTrack_Weapon_<W>), raised by the game server's POST .../PrestigeTrack_Weapon_<W>/1.
type BonusState = { xp: Record<string, number>; backfilled?: boolean; reforgedXp?: Record<string, number>; prestige?: Record<string, number> };

function BonusPath(accountId: string) {
    return path.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.bonus.json`);
}

function LoadBonus(accountId: string): BonusState {
    try {
        const parsed = JSON.parse(fs.readFileSync(BonusPath(accountId), "utf8").replace(/^\uFEFF/, ""));
        return { xp: parsed.xp ?? {}, backfilled: parsed.backfilled, reforgedXp: parsed.reforgedXp ?? {}, prestige: parsed.prestige ?? {} };
    } catch {
        return { xp: {} };
    }
}

function SaveBonus(accountId: string, bonus: BonusState) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = BonusPath(accountId);
    fs.writeFileSync(file + ".tmp", JSON.stringify(bonus, null, 2));
    fs.renameSync(file + ".tmp", file);
}

const GRANT_LOG_PATH = process.env.PROGRESSION_GRANT_LOG ?? path.join(process.cwd(), "progression_grants.jsonl");

export function ReforgeReward(times: number) {
    const raw = (process.env.REFORGE_REWARD ?? "CURRENCY_PJM_PRESTIGE_FILLED:1").trim();
    if (!raw || /^(none|0|off)$/i.test(raw)) return [];
    const out: { catalogId: string; quantity: number }[] = [];
    for (const part of raw.split(",")) {
        const [id, n] = part.trim().split(":");
        const quantity = Math.floor(Number(n ?? 1)) * times;
        if (/^[A-Z0-9_]{3,80}$/.test(id ?? "") && quantity > 0 && quantity <= 1000) out.push({ catalogId: id, quantity });
        else logger.warn(`Progression: REFORGE_REWARD entry "${part}" ignored`);
    }
    return out;
}

// [reforge] Hearts already paid inside the game's own spark transaction (routes/inventory.ts), so the game shows
// them at once. The PrestigeTrack post that follows within a minute then doesn't pay again.
const prepaidReforges = new Map<string, number[]>();
export function NoteReforgePrepaid(accountId: string) {
    const now = Date.now();
    const list = (prepaidReforges.get(accountId) ?? []).filter(t => now - t < 60000);
    list.push(now);
    prepaidReforges.set(accountId, list);
}
function TakeReforgePrepaid(accountId: string) {
    const now = Date.now();
    const list = (prepaidReforges.get(accountId) ?? []).filter(t => now - t < 60000);
    const had = list.length > 0;
    if (had) list.shift();
    prepaidReforges.set(accountId, list);
    return had;
}

export function GrantTrackXp(accountId: string, trackId: string, amountRaw: any) {
    const amount = Math.floor(Number(amountRaw));
    try {
        fs.appendFileSync(GRANT_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, trackId, amount: amountRaw }) + "\n");
    } catch { /* logging only */ }

    if (!(amount > 0) || amount > 1000000) {
        logger.warn(`Progression: ignored grant ${trackId} ${amountRaw} for ${accountId} (bad amount)`);
        return;
    }
    // The game's own Hunt Pass XP (end of hunt, part breaks, gathering): POST /progression/<uid>/season13a/<amount>
    if (trackId === ActivePassId()) {
        if (amount > 1000) {
            logger.warn(`Progression: ignored pass grant ${trackId} +${amount} for ${accountId} (implausibly large)`);
            return;
        }
        AddHuntPassXp(accountId, amount, "game server", true);
        return;
    }
    // [reforge] Sparkforge "Reforge Weapon Skill": the game server counts one reforge with POST .../PrestigeTrack_Weapon_<W>/1
    // (right after DELETE .../ExperienceTrack_Weapon_<W>, see ResetWeaponTrack).
    if (trackId.startsWith("PrestigeTrack_Weapon_")) {
        if (amount > 10) {
            logger.warn(`Progression: ignored reforge grant ${trackId} +${amount} for ${accountId} (implausibly large)`);
            return;
        }
        // The game takes the 100 Aethersparks itself (POST /inventory) but never asks for the Aetherheart, so the
        // backend pays it here, once per reforge. REFORGE_REWARD="ID:count[,ID:count]" changes it, "none" turns it off.
        for (let i = 0; i < amount; i++) {
            if (TakeReforgePrepaid(accountId)) {
                logger.info(`Progression: reforge ${trackId} reward already paid with the spark transaction`);
                continue;
            }
            const reward = ReforgeReward(1);
            if (reward.length) GrantItems(accountId, reward, `reforge ${trackId}`);
        }
        if (PROGRESSION_MODE !== "real") return;
        const bonus = LoadBonus(accountId);
        bonus.prestige = bonus.prestige ?? {};
        bonus.prestige[trackId] = (bonus.prestige[trackId] ?? 0) + amount;
        SaveBonus(accountId, bonus);
        logger.info(`Progression: reforge ${trackId} +${amount} for ${accountId} (now ${bonus.prestige[trackId]})`);
        return;
    }
    if (trackId === "ExperienceTrack_PlayerLevel" || trackId === "MasteryTrack_PlayerLevel") {
        logger.info(`Progression: grant ${trackId} +${amount} not stored (it is the sum of the weapon tracks)`);
        return;
    }
    if (!trackId.startsWith("ExperienceTrack_Weapon_") && !trackId.startsWith("MasteryTrack_")) {
        logger.warn(`Progression: ignored grant ${trackId} +${amount} for ${accountId} (track not handled)`);
        return;
    }
    if (PROGRESSION_MODE !== "real") return;

    // [rules] Weapon XP speed (Game Rules). Mastery tracks are left alone.
    let added = amount;
    if (trackId.startsWith("ExperienceTrack_Weapon_") && Rules.weaponXp !== 1) {
        added = ScaleXp(amount, Rules.weaponXp);
        logger.info(`[rules] weapon XP x${Rules.weaponXp}: ${trackId} ${amount} -> ${added}`);
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
        logger.info(`Progression: granted ${trackId} +${added} (total ${xp}, rank ${RankForXp(trackId, xp)}); ` +
            `Weapon Skill XP ${prevTotal} -> ${total}`);
    } else {
        const pts = after.tracks[trackId] ?? 0;
        logger.info(`Progression: granted ${trackId} +${amount} (total ${pts}, rank ${RankForXp(trackId, pts)})`);
    }
    GrantMasteryRewards(accountId, after.tracks, RankForXp);
}

function DeriveTotals(state: ProgressionState, bonusXp: Record<string, number> = {}) {
    const weaponXp: Record<string, number> = {};
    const tracks: Record<string, number> = {};
    for (const [track, amount] of Object.entries(bonusXp)) {
        if (!(amount > 0)) continue;
        if (track.startsWith("ExperienceTrack_Weapon_")) {
            weaponXp[track] = (weaponXp[track] ?? 0) + amount;
        } else if (track.startsWith("MasteryTrack_")) {
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
            let track: string | null = null;
            if (weapon) track = `MasteryTrack_Weapon_${weapon}`;
            else if (id.startsWith("MasteryObjective_Behemoth_")) track = "MasteryTrack_Behemoth";
            if (track) {
                tracks[track] = (tracks[track] ?? 0) + points;
                tracks["MasteryTrack_PlayerLevel"] = (tracks["MasteryTrack_PlayerLevel"] ?? 0) + points;
            }
        }
    }
    return { weaponXp, tracks };
}

// Apply one posted objective update to the saved state; returns true if anything changed
function ApplyObjective(state: ProgressionState, id: string, value: number, completed: number) {
    const cur = state.objectives[id] ?? { progress: 0, completed_count: 0 };
    const next = { ...cur };
    if (REPEATABLE_OBJECTIVE.test(id)) {
        // [xp-fix] In 1.6.2 posts, both value and completed_count are running totals
        // (checked in progression_posts.jsonl: completed goes 0,1,1,2,2; value climbs per kill).
        // Keep the highest seen; never add each post's count, and never let a fresh session lower it.
        next.completed_count = Math.max(cur.completed_count, completed);
        next.progress = Math.max(cur.progress, value);
    } else {
        if (completed > 0) next.completed_count = 1;
        next.progress = Math.max(cur.progress, value);
    }
    if (next.progress === cur.progress && next.completed_count === cur.completed_count) return false;
    state.objectives[id] = next;
    return true;
}

export function ApplyProgressionPost(accountId: string, body: any) {
    if (PROGRESSION_MODE !== "real") return;
    const objectives: any[] = Array.isArray(body?.objectives) ? body.objectives : [];
    let weaponXpGained = 0;

    if (objectives.length) {
        const state = LoadState(accountId);
        const bonusXp = LoadBonus(accountId).xp;
        const before = DeriveTotals(state, bonusXp);
        let changed = false;

        for (const o of objectives) {
            const id = String(o?.objective_id ?? "");
            if (!id) continue;
            const value = Math.max(0, Number(o?.value ?? 0));
            const completed = Math.max(0, Number(o?.completed_count ?? 0));
            if (ApplyObjective(state, id, value, completed)) changed = true;
        }
        if (changed) {
            SaveState(accountId, state);
            // Log what actually moved
            const after = DeriveTotals(state, bonusXp);
            GrantMasteryRewards(accountId, after.tracks, RankForXp);
            for (const [track, xp] of Object.entries(after.weaponXp)) {
                const gained = xp - (before.weaponXp[track] ?? 0);
                if (gained > 0) {
                    weaponXpGained += gained;
                    logger.info(`Progression: ${track} +${gained} XP (total ${xp}, rank ${RankForXp(track, xp)})`);
                }
            }
            for (const [track, pts] of Object.entries(after.tracks)) {
                const gained = pts - (before.tracks[track] ?? 0);
                if (gained > 0) logger.info(`Progression: ${track} +${gained} (total ${pts}, rank ${RankForXp(track, pts)})`);
            }
        }
    }

    // Hunt Pass XP: posted pass progress, or this post's Weapon Skill XP as a fallback (see huntpass162.ts)
    try {
        RecordHuntPassPost(accountId, body, weaponXpGained);
    } catch (e) {
        logger.error(e, "HuntPass: failed to record progress");
    }
}

// Rebuild every player's saved objectives by replaying progression_posts.jsonl (PROGRESSION_REBUILD=1)
function RebuildFromPostLog() {
    if (!fs.existsSync(POST_LOG_PATH)) {
        logger.warn(`Progression rebuild: ${POST_LOG_PATH} not found`);
        return;
    }
    const states = new Map<string, ProgressionState>();
    let posts = 0;
    for (const line of fs.readFileSync(POST_LOG_PATH, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        const userId = String(entry?.userId ?? "");
        const objectives: any[] = Array.isArray(entry?.body?.objectives) ? entry.body.objectives : [];
        if (!userId) continue;
        const state = states.get(userId) ?? { objectives: {} };
        for (const o of objectives) {
            const id = String(o?.objective_id ?? "");
            if (id) ApplyObjective(state, id, Math.max(0, Number(o?.value ?? 0)), Math.max(0, Number(o?.completed_count ?? 0)));
        }
        states.set(userId, state);
        posts++;
    }
    for (const [userId, state] of states) {
        const file = StatePath(userId);
        if (fs.existsSync(file)) fs.copyFileSync(file, file + ".before-rebuild");
        SaveState(userId, state);
        const t = DeriveTotals(state, LoadBonus(userId).xp);
        logger.info(`Progression rebuild: ${userId} from ${posts} posts -> Slayer points ${t.tracks["MasteryTrack_PlayerLevel"] ?? 0}, ` +
            Object.entries(t.weaponXp).map(([k, v]) => `${k.replace("ExperienceTrack_Weapon_", "")} ${v} XP`).join(", "));
    }
}

// For the game server DLL: the player's saved objective progress as "id<TAB>value<TAB>completed" lines.
// Only objectives whose bars would otherwise show 0 at login: in-progress one-time objectives and the repeatable
// "Experience" ones. Falls back to the most recently saved player if the id isn't known (single-player setups).
export function ObjectivesForPriming(accountId: string) {
    let file = StatePath(accountId);
    if (!fs.existsSync(file) && fs.existsSync(STATE_DIR)) {
        // Only <UID>.json (not <UID>.rewards.json / <UID>.huntpass.json)
        const newest = fs.readdirSync(STATE_DIR).filter(f => /^[\w-]+\.json$/.test(f))
            .map(f => ({ f, t: fs.statSync(path.join(STATE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
        if (newest) file = path.join(STATE_DIR, newest.f);
    }
    let objectives: Record<string, ObjectiveState> = {};
    try { objectives = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).objectives ?? {}; } catch { /* none saved */ }
    const lines: string[] = [];
    for (const [id, o] of Object.entries(objectives)) {
        const repeatable = REPEATABLE_OBJECTIVE.test(id);
        if (repeatable ? (o.progress > 0 || o.completed_count > 0) : (o.completed_count === 0 && o.progress > 0)) {
            lines.push(`${id}\t${o.progress}\t${o.completed_count}`);
        }
    }
    logger.info(`Progression: sent ${lines.length} saved objectives to the game server for ${path.basename(file, ".json")}`);
    return lines.join("\n");
}

// [reforge] DELETE /progression/<uid>/ExperienceTrack_Weapon_<W>: the game server resets a weapon to level 1 when it is
// reforged at the Sparkforge (it has already paid the Aethersparks and given the Aetherheart through /inventory).
// The weapon's XP moves to reforgedXp: the weapon starts again at 0, the Slayer's Path keeps the XP.
// Only weapon experience tracks can be reset; anything else is refused (returns false).
export function ResetWeaponTrack(accountId: string, trackId: string): boolean {
    if (!trackId.startsWith("ExperienceTrack_Weapon_")) {
        logger.warn(`Progression: refused reset of ${trackId} for ${accountId} (only weapon tracks are reset by a reforge)`);
        return false;
    }
    if (PROGRESSION_MODE !== "real") return true;
    const bonus = LoadBonus(accountId);
    const moved = Math.max(0, bonus.xp[trackId] ?? 0);
    bonus.reforgedXp = bonus.reforgedXp ?? {};
    bonus.reforgedXp[trackId] = (bonus.reforgedXp[trackId] ?? 0) + moved;
    bonus.xp[trackId] = 0;
    SaveBonus(accountId, bonus);
    logger.info(`Progression: reforge reset ${trackId} for ${accountId}: ${moved} XP moved off the weapon (kept for the Slayer's Path)`);
    return true;
}

export function GetObjectiveProgress(accountId: string, objectiveId: string) {
    if (PROGRESSION_MODE !== "real" || !REAL_OBJECTIVES) return null;
    return LoadState(accountId).objectives[objectiveId] ?? { progress: 0, completed_count: 0 };
}

export function ListObjectiveProgress(accountId: string) {
    if (PROGRESSION_MODE !== "real" || !REAL_OBJECTIVES) return [];
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

function RankForXp(trackId: string, xp: number) {
    const p = merged.get(trackId);
    let rank = 0, needed = 0;
    for (const r of [...(p?.requirements ?? [])].sort((a, b) => a.rank_id - b.rank_id)) {
        needed += r.xp_required ?? 0;
        if (xp >= needed) rank = r.rank_id; else break;
    }
    return rank;
}

export function BuildProgressTracks(accountId: string, filter?: (p: ProgressionPath) => boolean) {
    const now = new Date().toISOString();
    const bonusState = PROGRESSION_MODE === "real" ? LoadBonus(accountId) : null;
    const totals = bonusState ? DeriveTotals(LoadState(accountId), bonusState.xp) : null;
    const reforgedTotal = bonusState ? Object.values(bonusState.reforgedXp ?? {}).reduce((sum, v) => sum + (v > 0 ? v : 0), 0) : 0;
    return MergedPaths.filter(p => (filter ? filter(p) : true)).map(p => {
        if (PROGRESSION_MODE === "real" && p.progression_id === ActivePassId()) return HuntPassTrack(accountId);
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
        const unlocked = PROGRESSION_MODE === "unlock_all" || PROGRESSION_MODE === "real";
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
export function LogProgressionPost(userId: string, body: any) {
    try {
        fs.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId, body }) + "\n");
    } catch (e) {
        logger.error(e, "Failed to write progression post log");
    }
}

if (PROGRESSION_MODE === "real" && process.env.PROGRESSION_REBUILD === "1") RebuildFromPostLog();

logger.info(`Progression: mode=${PROGRESSION_MODE}, ${MergedPaths.length} tracks (${paths162.length} from 1.6.2 config)` +
    (PROGRESSION_MODE === "real" ? `, mastery from objectives, real objectives: ${REAL_OBJECTIVES ? "on" : "off"}` : ""));
