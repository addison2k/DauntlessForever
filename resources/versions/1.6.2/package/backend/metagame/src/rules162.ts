// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// [rules] Game Rules: optional changes the player picks in the launcher (Game Rules page). The launcher writes
// data\rules.txt, start.ps1 turns it into these environment variables (defaults come from the package's rules.json):
//   RULE_WEAPON_XP      multiplier for Weapon Skill XP the game server grants (kills, wildlife, bounties). 1 = normal.
//   RULE_PASS_XP        multiplier for Hunt Pass XP. 1 = normal.
//   RULE_LOOT           multiplier for materials and Rams added by a hunt (pure "add" inventory transactions). 1 = normal.
//   RULE_FREE_CRAFTING  1 = crafting and upgrading keep their materials and Rams (you still need them to start).
// Every rule logs a "[rules]" line when it changes something, so a test hunt shows exactly what it did.
import { logger } from "./logger";

function Multiplier(name: string): number {
    const v = Number(process.env[name] ?? 1);
    if (!Number.isFinite(v) || v <= 0) return 1;
    return Math.min(10, Math.max(0.1, v));
}

export const Rules = {
    weaponXp: Multiplier("RULE_WEAPON_XP"),
    passXp: Multiplier("RULE_PASS_XP"),
    loot: Multiplier("RULE_LOOT"),
    freeCrafting: (process.env.RULE_FREE_CRAFTING ?? "0") === "1",
};

logger.info(`[rules] Game Rules: weapon XP x${Rules.weaponXp}, Hunt Pass XP x${Rules.passXp}, loot x${Rules.loot}, ` +
    `free crafting ${Rules.freeCrafting ? "on" : "off"}`);

// Scale an XP amount. Never rounds a real grant down to 0.
export function ScaleXp(amount: number, factor: number): number {
    if (!(amount > 0) || factor === 1) return amount;
    return Math.max(1, Math.round(amount * factor));
}

// Items no rule may touch: progression tokens, Slayer's Path currencies, fusion tokens, season fragments.
function IsProtected(catalogId: any): boolean {
    const id = String(catalogId ?? "");
    return id.startsWith("TOKEN_") || id.startsWith("CURRENCY_PJM") || id.startsWith("CURRENCY_TOKEN")
        || id.startsWith("CURRENCY_SEASON") || id.includes("PRESTIGE") || id === "";
}

export type InventoryRuleInput = {
    instancedAdd: any[]; stackedAdd: any[]; instancedRemove: any[]; stackedRemove: any[]; instancedSave: any[];
};

// Changes a transaction before it is stored. Returns the catalogIds whose removal was skipped (free crafting), so the
// route can report their unchanged counts back to the game.
export function ApplyInventoryRules(tx: InventoryRuleInput, transactionId: string, fromGameServer: boolean): string[] {
    const kept: string[] = [];
    const instancedAdd = tx.instancedAdd ?? [], stackedAdd = tx.stackedAdd ?? [];
    const instancedRemove = tx.instancedRemove ?? [], stackedRemove = tx.stackedRemove ?? [];
    const instancedSave = tx.instancedSave ?? [];
    const touchesFusion = [...instancedAdd, ...instancedRemove, ...instancedSave].some((i) => i?.catalogId === "TOKEN_CELL_EXCHANGE");

    // Loot: a transaction that only ADDS stacked items (end-of-hunt rewards, gathering) gets more of them.
    if (Rules.loot !== 1 && fromGameServer && stackedAdd.length > 0
        && stackedRemove.length === 0 && instancedRemove.length === 0 && instancedSave.length === 0 && !touchesFusion) {
        const changed: string[] = [];
        tx.stackedAdd = stackedAdd.map((i) => {
            const q = Number(i?.quantity);
            if (IsProtected(i?.catalogId) || !(q > 0)) return i;
            const nq = Math.max(1, Math.round(q * Rules.loot));
            if (nq !== q) changed.push(`${i.catalogId} ${q}->${nq}`);
            return { ...i, quantity: nq };
        });
        if (changed.length) logger.info(`[rules] loot x${Rules.loot} on ${transactionId}: ${changed.join(", ")}`);
    }

    // Free crafting: a transaction that spends stacked items AND creates or changes gear (craft, upgrade) keeps them.
    if (Rules.freeCrafting && stackedRemove.length > 0 && (instancedAdd.length > 0 || instancedSave.length > 0) && !touchesFusion) {
        const stillRemove: any[] = [];
        for (const i of stackedRemove) {
            if (IsProtected(i?.catalogId)) stillRemove.push(i);
            else kept.push(String(i.catalogId));
        }
        tx.stackedRemove = stillRemove;
        if (kept.length) {
            const made = [...instancedAdd, ...instancedSave].map((i) => i?.catalogId).filter(Boolean).join(", ");
            logger.info(`[rules] free crafting on ${transactionId}: kept ${stackedRemove.filter((i) => kept.includes(String(i.catalogId)))
                .map((i) => `${i.catalogId} x${i.quantity}`).join(", ")} (made/changed ${made})`);
        }
    }

    // While any inventory rule is on, describe each spending transaction once, so a test shows its real shape.
    if ((Rules.freeCrafting || Rules.loot !== 1) && (stackedRemove.length > 0 || instancedRemove.length > 0) && !kept.length) {
        const ids = (a: any[]) => a.map((i) => `${i?.catalogId}${i?.quantity != null ? " x" + i.quantity : ""}`).join(", ") || "-";
        logger.info(`[rules] untouched ${transactionId} (${fromGameServer ? "game server" : "client"}): ` +
            `add [${ids(instancedAdd)}] [${ids(stackedAdd)}] remove [${ids(instancedRemove)}] [${ids(stackedRemove)}] save [${ids(instancedSave)}]`);
    }
    return kept;
}
