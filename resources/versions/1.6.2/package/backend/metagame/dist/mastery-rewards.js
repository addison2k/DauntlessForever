// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GrantMasteryRewards = GrantMasteryRewards;
exports.GrantItems = GrantItems;
// mastery-rewards.ts — grant 1.6.2 mastery rank rewards (Merits, cell cores, titles) on rank-up.
// Rewards come from the game's own Gameplay/Mastery/mastery_track_table (FModel export),
// saved as src/vendor/mastery_track_table_162.json. Ranks come from the same RankForXp the
// metagame already reports to the game, so grants line up with the in-game popups.
// Granted ranks are remembered per player in <STATE_DIR>/<uid>.rewards.json, so each rank pays once.
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("./db");
const schema_1 = require("./db/schema");
const inventory_1 = require("./controllers/inventory");
const logger_1 = require("./logger");
const TABLE_PATH = [
    path_1.default.join(__dirname, "vendor", "mastery_track_table_162.json"),
    path_1.default.join(__dirname, "..", "src", "vendor", "mastery_track_table_162.json"),
].find(p => fs_1.default.existsSync(p)) ?? path_1.default.join(__dirname, "vendor", "mastery_track_table_162.json");
const STATE_DIR = process.env.PROGRESSION_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "progression");
function LoadRewards() {
    const out = new Map();
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(TABLE_PATH, "utf8").replace(/^\uFEFF/, ""));
        const rows = (Array.isArray(raw) ? raw[0] : raw)?.Rows ?? {};
        for (const [trackId, row] of Object.entries(rows)) {
            const byRank = new Map();
            for (const r of row.FreeRewards ?? []) {
                const items = (r.StackedItems ?? [])
                    .filter((i) => i.CatalogId && i.Quantity > 0)
                    .map((i) => ({ catalogId: i.CatalogId, quantity: i.Quantity }));
                if (items.length)
                    byRank.set(r.RankId, items);
            }
            out.set(trackId, byRank);
        }
        logger_1.logger.info(`MasteryRewards: loaded rewards for ${out.size} tracks`);
    }
    catch (e) {
        logger_1.logger.warn(e, `MasteryRewards: could not load ${TABLE_PATH}; rank rewards disabled`);
    }
    return out;
}
const Rewards = LoadRewards();
function GrantedPath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.rewards.json`);
}
function LoadGranted(accountId) {
    try {
        return JSON.parse(fs_1.default.readFileSync(GrantedPath(accountId), "utf8").replace(/^\uFEFF/, ""));
    }
    catch {
        return {};
    }
}
function SaveGranted(accountId, granted) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const file = GrantedPath(accountId);
    fs_1.default.writeFileSync(file + ".tmp", JSON.stringify(granted, null, 2));
    fs_1.default.renameSync(file + ".tmp", file);
}
// One grant at a time per player, so two quick posts can't pay the same rank twice
const queues = new Map();
function GrantMasteryRewards(accountId, trackPoints, rankFor) {
    const snapshot = { ...trackPoints };
    const next = (queues.get(accountId) ?? Promise.resolve())
        .then(() => DoGrant(accountId, snapshot, rankFor))
        .catch(e => logger_1.logger.error(e, "MasteryRewards: grant failed"));
    queues.set(accountId, next);
}
async function DoGrant(accountId, trackPoints, rankFor) {
    if (!Rewards.size)
        return;
    const granted = LoadGranted(accountId);
    const newGranted = { ...granted };
    const toAdd = new Map();
    const changes = [];
    for (const [trackId, byRank] of Rewards) {
        const rank = rankFor(trackId, trackPoints[trackId] ?? 0);
        const from = granted[trackId] ?? 0;
        if (rank <= from)
            continue;
        for (let r = from + 1; r <= rank; r++) {
            for (const item of byRank.get(r) ?? []) {
                toAdd.set(item.catalogId, (toAdd.get(item.catalogId) ?? 0) + item.quantity);
            }
        }
        newGranted[trackId] = rank;
        changes.push(`${trackId} ${from}->${rank}`);
    }
    if (!changes.length)
        return;
    if (!toAdd.size) {
        SaveGranted(accountId, newGranted);
        return;
    }
    const chars = await (0, db_1.GetDb)().query.characters.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.characters.userId, accountId) });
    if (!chars.length) {
        logger_1.logger.warn(`MasteryRewards: no character for ${accountId}; will retry on next post`);
        return;
    }
    // Most recently modified character gets the rewards
    const character = [...chars].sort((a, b) => (a.lastModifiedDate < b.lastModifiedDate ? 1 : -1))[0];
    const items = [...toAdd].map(([catalogId, quantity]) => ({ catalogId, quantity }));
    const result = await (0, inventory_1.RunInventoryTransaction)(accountId, character.characterId, `mastery-rewards-${Date.now()}`, [], items, [], [], []);
    if (!result.success) {
        logger_1.logger.error(`MasteryRewards: inventory transaction failed (${result.error}); will retry on next post`);
        return;
    }
    SaveGranted(accountId, newGranted);
    logger_1.logger.info(`MasteryRewards: ${changes.join(", ")} -> ${items.map(i => `${i.catalogId} x${i.quantity}`).join(", ")}`);
}
// ---------- One-off item grants (used by the Sparkforge reforge) ----------
// Same queue and same character pick as the rank rewards, so a reforge and a rank-up can't race each other.
function GrantItems(accountId, items, reason) {
    const list = items.filter(i => /^[A-Z0-9_]{3,80}$/.test(i.catalogId) && i.quantity > 0);
    if (!list.length)
        return;
    const next = (queues.get(accountId) ?? Promise.resolve())
        .then(() => DoGrantItems(accountId, list, reason))
        .catch(e => logger_1.logger.error(e, `MasteryRewards: ${reason} grant failed`));
    queues.set(accountId, next);
}
async function DoGrantItems(accountId, items, reason) {
    const chars = await (0, db_1.GetDb)().query.characters.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.characters.userId, accountId) });
    if (!chars.length) {
        logger_1.logger.warn(`MasteryRewards: no character for ${accountId}; ${reason} not paid`);
        return;
    }
    const character = [...chars].sort((a, b) => (a.lastModifiedDate < b.lastModifiedDate ? 1 : -1))[0];
    const result = await (0, inventory_1.RunInventoryTransaction)(accountId, character.characterId, `${reason.replace(/[^\w-]/g, "_")}-${Date.now()}`, [], items, [], [], []);
    if (!result.success) {
        logger_1.logger.error(`MasteryRewards: ${reason} inventory transaction failed (${result.error})`);
        return;
    }
    logger_1.logger.info(`MasteryRewards: ${reason} -> ${items.map(i => `${i.catalogId} x${i.quantity}`).join(", ")}`);
}
