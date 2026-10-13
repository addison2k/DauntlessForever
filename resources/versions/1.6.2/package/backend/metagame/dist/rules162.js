// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Rules = void 0;
exports.ScaleXp = ScaleXp;
exports.ApplyInventoryRules = ApplyInventoryRules;
//
// [rules] Game Rules: optional changes the player picks in the launcher (Game Rules page). The launcher writes
// data\rules.txt, start.ps1 turns it into these environment variables (defaults come from the package's rules.json):
//   RULE_WEAPON_XP      multiplier for Weapon Skill XP the game server grants (kills, wildlife, bounties). 1 = normal.
//   RULE_PASS_XP        multiplier for Hunt Pass XP. 1 = normal.
//   RULE_LOOT           multiplier for materials and Rams added by a hunt (pure "add" inventory transactions). 1 = normal.
//   RULE_FREE_CRAFTING  1 = crafting and upgrading keep their materials and Rams (you still need them to start).
// Every rule logs a "[rules]" line when it changes something, so a test hunt shows exactly what it did.
const logger_1 = require("./logger");
function Multiplier(name) {
    const v = Number(process.env[name] ?? 1);
    if (!Number.isFinite(v) || v <= 0)
        return 1;
    return Math.min(10, Math.max(0.1, v));
}
exports.Rules = {
    weaponXp: Multiplier("RULE_WEAPON_XP"),
    passXp: Multiplier("RULE_PASS_XP"),
    loot: Multiplier("RULE_LOOT"),
    freeCrafting: (process.env.RULE_FREE_CRAFTING ?? "0") === "1",
};
logger_1.logger.info(`[rules] Game Rules: weapon XP x${exports.Rules.weaponXp}, Hunt Pass XP x${exports.Rules.passXp}, loot x${exports.Rules.loot}, ` +
    `free crafting ${exports.Rules.freeCrafting ? "on" : "off"}`);
// Scale an XP amount. Never rounds a real grant down to 0.
function ScaleXp(amount, factor) {
    if (!(amount > 0) || factor === 1)
        return amount;
    return Math.max(1, Math.round(amount * factor));
}
// Items no rule may touch: progression tokens, Slayer's Path currencies, fusion tokens, season fragments.
function IsProtected(catalogId) {
    const id = String(catalogId ?? "");
    return id.startsWith("TOKEN_") || id.startsWith("CURRENCY_PJM") || id.startsWith("CURRENCY_TOKEN")
        || id.startsWith("CURRENCY_SEASON") || id.includes("PRESTIGE") || id === "";
}
// Changes a transaction before it is stored. Returns the catalogIds whose removal was skipped (free crafting), so the
// route can report their unchanged counts back to the game.
function ApplyInventoryRules(tx, transactionId, fromGameServer) {
    const kept = [];
    const instancedAdd = tx.instancedAdd ?? [], stackedAdd = tx.stackedAdd ?? [];
    const instancedRemove = tx.instancedRemove ?? [], stackedRemove = tx.stackedRemove ?? [];
    const instancedSave = tx.instancedSave ?? [];
    const touchesFusion = [...instancedAdd, ...instancedRemove, ...instancedSave].some((i) => i?.catalogId === "TOKEN_CELL_EXCHANGE");
    // Loot: a transaction that only ADDS stacked items (end-of-hunt rewards, gathering) gets more of them.
    if (exports.Rules.loot !== 1 && fromGameServer && stackedAdd.length > 0
        && stackedRemove.length === 0 && instancedRemove.length === 0 && instancedSave.length === 0 && !touchesFusion) {
        const changed = [];
        tx.stackedAdd = stackedAdd.map((i) => {
            const q = Number(i?.quantity);
            if (IsProtected(i?.catalogId) || !(q > 0))
                return i;
            const nq = Math.max(1, Math.round(q * exports.Rules.loot));
            if (nq !== q)
                changed.push(`${i.catalogId} ${q}->${nq}`);
            return { ...i, quantity: nq };
        });
        if (changed.length)
            logger_1.logger.info(`[rules] loot x${exports.Rules.loot} on ${transactionId}: ${changed.join(", ")}`);
    }
    // Free crafting: a transaction that spends stacked items AND creates or changes gear (craft, upgrade) keeps them.
    if (exports.Rules.freeCrafting && stackedRemove.length > 0 && (instancedAdd.length > 0 || instancedSave.length > 0) && !touchesFusion) {
        const stillRemove = [];
        for (const i of stackedRemove) {
            if (IsProtected(i?.catalogId))
                stillRemove.push(i);
            else
                kept.push(String(i.catalogId));
        }
        tx.stackedRemove = stillRemove;
        if (kept.length) {
            const made = [...instancedAdd, ...instancedSave].map((i) => i?.catalogId).filter(Boolean).join(", ");
            logger_1.logger.info(`[rules] free crafting on ${transactionId}: kept ${stackedRemove.filter((i) => kept.includes(String(i.catalogId)))
                .map((i) => `${i.catalogId} x${i.quantity}`).join(", ")} (made/changed ${made})`);
        }
    }
    // While any inventory rule is on, describe each spending transaction once, so a test shows its real shape.
    if ((exports.Rules.freeCrafting || exports.Rules.loot !== 1) && (stackedRemove.length > 0 || instancedRemove.length > 0) && !kept.length) {
        const ids = (a) => a.map((i) => `${i?.catalogId}${i?.quantity != null ? " x" + i.quantity : ""}`).join(", ") || "-";
        logger_1.logger.info(`[rules] untouched ${transactionId} (${fromGameServer ? "game server" : "client"}): ` +
            `add [${ids(instancedAdd)}] [${ids(stackedAdd)}] remove [${ids(instancedRemove)}] [${ids(stackedRemove)}] save [${ids(instancedSave)}]`);
    }
    return kept;
}
