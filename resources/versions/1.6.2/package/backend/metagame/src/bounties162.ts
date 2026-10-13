// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// bounties162.ts — remember each player's bounties (1.6.2)
//
// Upstream's /bounty/:userId routes were stubs: GET always returned no bounties and POST saved nothing, so drafted
// bounties vanished as soon as the screen reloaded. Here the state the game posts is saved per player and served back.
//
// State shape (same as the stub's reply): { bounties: [], draft_data: {...}, draft_data_daily: {...}, draft_data_weekly: {...} }
// What the game posts (from bounty_posts.jsonl):
//  - "bounties" holds ONLY the bounties that changed in this update (a newly drafted one, or one whose progress moved);
//    an empty list means "no bounty changed". Each has bounty_id, premium_bounty, slot_index, objectives, claimed, ...
//    -> merged by slot (premium and normal slots kept apart): a posted bounty replaces whatever was in its slot.
//  - draft_data / draft_data_daily / draft_data_weekly are sent whole -> replaced.
//  - anything else is only logged ("unknown format") and the saved state is left alone;
//  - every raw POST is appended to bounty_posts.jsonl (next to progression_posts.jsonl).
// Hunt Pass XP for claimed bounties: the 1.6.2 season table has ProgressionMultiplier 0 for Time Strike, so the game
// shows and pays x0. When a bounty turns claimed, its pass XP from the game's bounty_table is added here instead:
// Bronze 20, Silver 40, Gold 100 (daily/weekly challenges give none). Set BOUNTY_PASS_XP=0 to switch this off.
// State per player: <BOUNTY_STATE_DIR>\<UID>.json (default: a bounties folder next to the database). Log prefix "Bounties:".
import fs from "fs";
import path from "path";
import { logger } from "./logger";
import { AddHuntPassXp } from "./huntpass162";

const STATE_DIR = process.env.BOUNTY_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "bounties");
const POST_LOG_PATH = process.env.BOUNTY_POST_LOG ?? path.join(process.cwd(), "bounty_posts.jsonl");
const STATE_KEYS = ["bounties", "draft_data", "draft_data_daily", "draft_data_weekly"] as const;

function EmptyDraft() {
    return { current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 };
}

function EmptyState(): Record<string, any> {
    return { bounties: [], draft_data: EmptyDraft(), draft_data_daily: EmptyDraft(), draft_data_weekly: EmptyDraft() };
}

function StatePath(accountId: string) {
    return path.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.json`);
}

export function LoadBountyState(accountId: string): Record<string, any> {
    try {
        const saved = JSON.parse(fs.readFileSync(StatePath(accountId), "utf8").replace(/^\uFEFF/, ""));
        const state = { ...EmptyState(), ...saved };
        // Claimed bounties free their slot. Older saves may still hold some; the game would recreate them as new.
        if (Array.isArray(state.bounties)) state.bounties = state.bounties.filter((b: any) => !b?.claimed);
        return state;
    } catch {
        return EmptyState();
    }
}

function SaveBountyState(accountId: string, state: Record<string, any>) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = StatePath(accountId);
    fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
    fs.renameSync(file + ".tmp", file);
}

// Slot identity: premium and normal bounties may use the same slot numbers
function BountyKey(b: any) {
    if (b && b.slot_index !== undefined && b.slot_index !== null) return `${b.premium_bounty ? "premium" : "normal"}:${b.slot_index}`;
    return `id:${b?.bounty_id ?? "?"}`;
}

function ProgressText(b: any) {
    const o: any[] = Array.isArray(b?.objectives) ? b.objectives : [];
    return o.length ? ` [${o.map(x => `${x.objective_id ?? "?"} ${x.progress ?? 0}`).join(", ")}]` : "";
}

// Objective targets from the game's bounty_table (Content/Gameplay/Bounty): used to tell a claimed bounty from an
// abandoned one when the game server deletes it.
const BOUNTY_TARGETS: Record<string, number> = {
    Bounty_Bronze_ASInterrupts: 3, Bounty_Bronze_AxeInterrupts: 3, Bounty_Bronze_BreakAllPartsKill: 1,
    Bounty_Bronze_DPInterrupts: 2, Bounty_Bronze_GatherCommon: 10, Bounty_Bronze_GatherDamage: 10,
    Bounty_Bronze_GatherDefense: 10, Bounty_Bronze_GatherHealing: 10, Bounty_Bronze_GatherPylon: 10,
    Bounty_Bronze_GatherSpecial: 10, Bounty_Bronze_GatherSpeed: 10, Bounty_Bronze_GatherWeapon: 10,
    Bounty_Bronze_Gatherables: 25, Bounty_Bronze_GrenadeDamage: 8000, Bounty_Bronze_GrenadeInterrupt: 1,
    Bounty_Bronze_HammerBlastInterrupts: 2, Bounty_Bronze_HuntsASTwo: 8, Bounty_Bronze_HuntsAxeTwo: 8,
    Bounty_Bronze_HuntsChainbladesTwo: 8, Bounty_Bronze_HuntsDPTwo: 8, Bounty_Bronze_HuntsHammerTwo: 8,
    Bounty_Bronze_HuntsPikeTwo: 8, Bounty_Bronze_HuntsSwordTwo: 8, Bounty_Bronze_InterruptEnraged: 2,
    Bounty_Bronze_Interrupts: 8, Bounty_Bronze_KillASChain: 3, Bounty_Bronze_KillAxePike: 3,
    Bounty_Bronze_KillBlazeFrost: 6, Bounty_Bronze_KillBlazeWeapon: 3, Bounty_Bronze_KillChainPike: 3,
    Bounty_Bronze_KillFrostShock: 8, Bounty_Bronze_KillFrostWeapon: 3, Bounty_Bronze_KillHammerDP: 3,
    Bounty_Bronze_KillNeutralWeapon: 2, Bounty_Bronze_KillRadiant: 3, Bounty_Bronze_KillRadiantNeutral: 8,
    Bounty_Bronze_KillRadiantWeapon: 2, Bounty_Bronze_KillRage: 3, Bounty_Bronze_KillShockBlaze: 8,
    Bounty_Bronze_KillShockWeapon: 4, Bounty_Bronze_KillSwordAxe: 3, Bounty_Bronze_KillTerraShock: 8,
    Bounty_Bronze_KillTerraWeapon: 2, Bounty_Bronze_KillUmbral: 3, Bounty_Bronze_KillUmbralNeutral: 4,
    Bounty_Bronze_KillUmbralWeapon: 2, Bounty_Bronze_KillWithFriends: 2, Bounty_Bronze_LanternDamage: 15000,
    Bounty_Bronze_PartDamageEnraged: 13500, Bounty_Bronze_PartDamageReduce: 65000, Bounty_Bronze_PartsEnraged: 4,
    Bounty_Bronze_PerfectDodges: 15, Bounty_Bronze_PhysicalDodges: 10, Bounty_Bronze_PikeBlastInterrupts: 2,
    Bounty_Bronze_ProjectileDodges: 4, Bounty_Bronze_StaggerDamageEnraged: 15000,
    Bounty_Bronze_StaggerDamageReduce: 40000, Bounty_Bronze_StaggerEnraged: 1, Bounty_Bronze_SwordInterrupts: 3,
    Bounty_Bronze_WoundDamageEnraged: 1000, Bounty_Bronze_WoundDamageReduce: 5000, Bounty_Bronze_WoundEnraged: 1,
    Bounty_Gold_ASInterrupts: 5, Bounty_Gold_AxeInterrupts: 5, Bounty_Gold_BreakAllPartsKill: 2,
    Bounty_Gold_DPInterrupts: 5, Bounty_Gold_Gatherables: 140, Bounty_Gold_GrenadeDamage: 20000,
    Bounty_Gold_GrenadeInterrupts: 8, Bounty_Gold_HammerBlastInterrupts: 20, Bounty_Gold_HuntsASTwo: 12,
    Bounty_Gold_HuntsAxeTwo: 12, Bounty_Gold_HuntsChainbladesTwo: 12, Bounty_Gold_HuntsDPTwo: 12,
    Bounty_Gold_HuntsHammerTwo: 12, Bounty_Gold_HuntsPikeTwo: 12, Bounty_Gold_HuntsSwordTwo: 12,
    Bounty_Gold_InterruptEnraged: 6, Bounty_Gold_Interrupts: 20, Bounty_Gold_KillASChain: 8,
    Bounty_Gold_KillAxePike: 8, Bounty_Gold_KillBlazeFrost: 10, Bounty_Gold_KillBlazeWeapon: 8,
    Bounty_Gold_KillChainPike: 8, Bounty_Gold_KillFrostShock: 10, Bounty_Gold_KillFrostWeapon: 6,
    Bounty_Gold_KillHammerDP: 8, Bounty_Gold_KillNeutralWeapon: 6, Bounty_Gold_KillRadiant: 7,
    Bounty_Gold_KillRadiantNeutral: 10, Bounty_Gold_KillRadiantWeapon: 6, Bounty_Gold_KillRage: 4,
    Bounty_Gold_KillShockBlaze: 10, Bounty_Gold_KillShockWeapon: 6, Bounty_Gold_KillSwordAxe: 8,
    Bounty_Gold_KillTerraShock: 10, Bounty_Gold_KillTerraWeapon: 6, Bounty_Gold_KillUmbral: 7,
    Bounty_Gold_KillUmbralNeutral: 10, Bounty_Gold_KillUmbralWeapon: 6, Bounty_Gold_KillWithFriends: 2,
    Bounty_Gold_LanternDamage: 20000, Bounty_Gold_PartDamageEnraged: 75000, Bounty_Gold_PartDamageReduce: 135000,
    Bounty_Gold_PartsEnraged: 7, Bounty_Gold_PerfectDodges: 120, Bounty_Gold_PhysicalDodges: 100,
    Bounty_Gold_PikeBlastInterrupts: 20, Bounty_Gold_ProjectileDodges: 60, Bounty_Gold_StaggerDamageEnraged: 50000,
    Bounty_Gold_StaggerDamageReduce: 70000, Bounty_Gold_StaggerEnraged: 5, Bounty_Gold_SwordInterrupts: 15,
    Bounty_Gold_WoundDamageEnraged: 6000, Bounty_Gold_WoundDamageReduce: 15000, Bounty_Gold_WoundEnraged: 4,
    Bounty_Silver_ASInterrupts: 15, Bounty_Silver_AxeInterrupts: 5, Bounty_Silver_BreakAllPartsKill: 2,
    Bounty_Silver_DPInterrupts: 4, Bounty_Silver_GatherCommon: 15, Bounty_Silver_GatherDamage: 15,
    Bounty_Silver_GatherDefense: 15, Bounty_Silver_GatherHealing: 15, Bounty_Silver_GatherPylon: 15,
    Bounty_Silver_GatherSpecial: 15, Bounty_Silver_GatherSpeed: 15, Bounty_Silver_GatherWeapon: 15,
    Bounty_Silver_Gatherables: 15, Bounty_Silver_GrenadeDamage: 10000, Bounty_Silver_GrenadeInterrupt: 3,
    Bounty_Silver_HammerBlastInterrupts: 5, Bounty_Silver_HuntsASTwo: 12, Bounty_Silver_HuntsAxeTwo: 12,
    Bounty_Silver_HuntsChainbladesTwo: 12, Bounty_Silver_HuntsDPTwo: 12, Bounty_Silver_HuntsHammerTwo: 12,
    Bounty_Silver_HuntsPikeTwo: 12, Bounty_Silver_HuntsSwordTwo: 12, Bounty_Silver_InterruptEnraged: 3,
    Bounty_Silver_Interrupts: 12, Bounty_Silver_KillASChain: 6, Bounty_Silver_KillAxePike: 6,
    Bounty_Silver_KillBlazeFrost: 8, Bounty_Silver_KillBlazeWeapon: 5, Bounty_Silver_KillChainPike: 6,
    Bounty_Silver_KillFrostShock: 10, Bounty_Silver_KillFrostWeapon: 5, Bounty_Silver_KillHammerDP: 6,
    Bounty_Silver_KillNeutralWeapon: 5, Bounty_Silver_KillRadiant: 4, Bounty_Silver_KillRadiantNeutral: 10,
    Bounty_Silver_KillRadiantWeapon: 5, Bounty_Silver_KillRage: 4, Bounty_Silver_KillShockBlaze: 10,
    Bounty_Silver_KillShockWeapon: 5, Bounty_Silver_KillSwordAxe: 5, Bounty_Silver_KillTerraShock: 10,
    Bounty_Silver_KillTerraWeapon: 5, Bounty_Silver_KillUmbral: 4, Bounty_Silver_KillUmbralNeutral: 10,
    Bounty_Silver_KillUmbralWeapon: 5, Bounty_Silver_KillWithFriends: 2, Bounty_Silver_LanternDamage: 17500,
    Bounty_Silver_PartDamageEnraged: 35000, Bounty_Silver_PartDamageReduce: 120000, Bounty_Silver_PartsEnraged: 5,
    Bounty_Silver_PerfectDodges: 30, Bounty_Silver_PhysicalDodges: 20, Bounty_Silver_PikeBlastInterrupts: 5,
    Bounty_Silver_ProjectileDodges: 5, Bounty_Silver_StaggerDamageEnraged: 35000,
    Bounty_Silver_StaggerDamageReduce: 100000, Bounty_Silver_StaggerEnraged: 4, Bounty_Silver_SwordInterrupts: 5,
    Bounty_Silver_WoundDamageEnraged: 6000, Bounty_Silver_WoundDamageReduce: 5000, Bounty_Silver_WoundEnraged: 2,
};

const BOUNTY_PASS_XP = (process.env.BOUNTY_PASS_XP ?? "1") === "1";

function PassXpFor(bountyId: string) {
    if (/^Bounty_Gold_/i.test(bountyId)) return 100;
    if (/^Bounty_Silver_/i.test(bountyId)) return 40;
    if (/^Bounty_Bronze_/i.test(bountyId)) return 20;
    return 0;
}

function Summary(state: Record<string, any>) {
    const b: any[] = Array.isArray(state.bounties) ? state.bounties : [];
    const choices = Array.isArray(state.draft_data?.current_draft_choices) ? state.draft_data.current_draft_choices.length : 0;
    return `${b.length} bounties, ${choices} draft choices`;
}

// Returns the state to send back to the game
export function ApplyBountyPost(accountId: string, body: any): Record<string, any> {
    try {
        fs.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, body }) + "\n");
    } catch (e) {
        logger.error(e, "Bounties: failed to write bounty post log");
    }

    const src = body && typeof body === "object"
        ? (STATE_KEYS.some(k => k in body) ? body : (body.payload && typeof body.payload === "object" ? body.payload : null))
        : null;
    const state = LoadBountyState(accountId);

    if (!src || !STATE_KEYS.some(k => k in src)) {
        const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : typeof body;
        logger.warn(`Bounties: post from ${accountId} in unknown format (keys: ${keys || "none"}); state unchanged, see bounty_posts.jsonl`);
        return state;
    }

    // Bounties: merge the changed ones into their slots
    const posted: any[] = Array.isArray(src.bounties) ? src.bounties : [];
    const current: any[] = Array.isArray(state.bounties) ? [...state.bounties] : [];
    const claimedEcho: any[] = [];   // just-claimed bounties: sent back once so the screen clears the card, not saved
    for (const b of posted) {
        if (!b || typeof b !== "object") continue;
        const key = BountyKey(b);
        const i = current.findIndex(x => BountyKey(x) === key);
        const prev = i >= 0 ? current[i] : null;
        if (b.claimed) {
            // Claimed: free the slot. Kept, the game would recreate it on the next load as a fresh, unclaimed bounty.
            if (i >= 0) current.splice(i, 1);
            claimedEcho.push(b);
        } else if (i >= 0) current[i] = b; else current.push(b);
        // Newly claimed (not a re-post of an already claimed one): pay its Hunt Pass XP
        const wasClaimed = !!(prev && prev.claimed && prev.bounty_id === b.bounty_id);
        if (b.claimed && prev && !wasClaimed && BOUNTY_PASS_XP) {
            const xp = PassXpFor(String(b.bounty_id ?? ""));
            if (xp > 0) {
                try { AddHuntPassXp(accountId, xp, `bounty ${b.bounty_id}`); }
                catch (e) { logger.error(e, "Bounties: failed to add Hunt Pass XP"); }
            }
        }
        logger.info(`Bounties: ${b.claimed ? "claimed (slot freed)" : i >= 0 ? "updated" : "added"} ${b.bounty_id ?? "?"} in slot ${key}` +
            ProgressText(b));
    }
    state.bounties = current;

    // Draft data: sent whole, so replace
    for (const k of ["draft_data", "draft_data_daily", "draft_data_weekly"] as const) {
        if (k in src && src[k] && typeof src[k] === "object") state[k] = src[k];
    }
    SaveBountyState(accountId, state);
    logger.info(`Bounties: saved for ${accountId} (${Summary(state)})`);
    // Reply: the saved state plus this post's claimed bounties (marked claimed), so the live screen updates
    return claimedEcho.length ? { ...state, bounties: [...state.bounties, ...claimedEcho] } : state;
}

export function GetBounties(accountId: string) {
    const state = LoadBountyState(accountId);
    logger.info(`Bounties: read for ${accountId} (${Summary(state)})`);
    return state;
}

// Deleting bounties (game server): POST /bounty/delete/:userId (what 1.6.2 sends on claim with
// delete_claimed_bounties = true, and presumably on abandon), plus DELETE /bounty/:userId[/:bountyId] just in case.
// Ids come from the URL and/or the body (bounty_id / bounty_ids / bounties[].bounty_id). With deletes the game sends no
// "claimed" post, so a removed bounty whose saved progress reached its target counts as claimed (pays its Hunt Pass
// XP); otherwise it was abandoned (no pay).
export function RemoveBounties(accountId: string, urlBountyId: string | undefined, body: any): Record<string, any> {
    try {
        fs.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, delete: urlBountyId ?? null, body }) + "\n");
    } catch { /* logging only */ }
    const ids = new Set<string>();
    if (urlBountyId) ids.add(String(urlBountyId));
    const collect = (o: any) => {
        if (!o || typeof o !== "object") return;
        if (typeof o === "string") return;
        if (o.bounty_id) ids.add(String(o.bounty_id));
        for (const key of ["bounty_ids", "bountyIds", "ids"]) if (Array.isArray(o[key])) o[key].forEach((x: any) => ids.add(String(x)));
        if (Array.isArray(o.bounties)) o.bounties.forEach((b: any) => typeof b === "string" ? ids.add(b) : b?.bounty_id && ids.add(String(b.bounty_id)));
    };
    if (Array.isArray(body)) body.forEach((x: any) => typeof x === "string" ? ids.add(x) : collect(x)); else collect(body);
    if (body?.payload) collect(body.payload);

    const state = LoadBountyState(accountId);
    const kept: any[] = [];
    for (const b of state.bounties) {
        const id = String(b?.bounty_id ?? "");
        if (!ids.has(id)) { kept.push(b); continue; }
        const target = BOUNTY_TARGETS[id] ?? 0;
        const progress = Math.max(0, ...((Array.isArray(b.objectives) ? b.objectives : []).map((o: any) => Number(o?.progress ?? 0))));
        const claimed = target > 0 && progress >= target;
        logger.info(`Bounties: ${claimed ? "claimed" : "abandoned"} (deleted by game) ${id} [${progress}/${target || "?"}]`);
        if (claimed && BOUNTY_PASS_XP) {
            const xp = PassXpFor(id);
            if (xp > 0) {
                try { AddHuntPassXp(accountId, xp, `bounty ${id}`); } catch (e) { logger.error(e, "Bounties: failed to add Hunt Pass XP"); }
            }
        }
    }
    const removed = state.bounties.length - kept.length;
    state.bounties = kept;
    if (removed) SaveBountyState(accountId, state);
    logger.info(`Bounties: delete request for ${accountId} (${[...ids].join(", ") || "no ids"}): removed ${removed}`);
    return state;
}
