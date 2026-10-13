// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// mastery-rewards.ts — grant 1.6.2 mastery rank rewards (Merits, cell cores, titles) on rank-up.
// Rewards come from the game's own Gameplay/Mastery/mastery_track_table (FModel export),
// saved as src/vendor/mastery_track_table_162.json. Ranks come from the same RankForXp the
// metagame already reports to the game, so grants line up with the in-game popups.
// Granted ranks are remembered per player in <STATE_DIR>/<uid>.rewards.json, so each rank pays once.
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { GetDb } from "./db";
import { characters } from "./db/schema";
import { RunInventoryTransaction } from "./controllers/inventory";
import { logger } from "./logger";

type Reward = { catalogId: string; quantity: number };

const TABLE_PATH = [
    path.join(__dirname, "vendor", "mastery_track_table_162.json"),
    path.join(__dirname, "..", "src", "vendor", "mastery_track_table_162.json"),
].find(p => fs.existsSync(p)) ?? path.join(__dirname, "vendor", "mastery_track_table_162.json");
const STATE_DIR = process.env.PROGRESSION_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "progression");

function LoadRewards(): Map<string, Map<number, Reward[]>> {
    const out = new Map<string, Map<number, Reward[]>>();
    try {
        const raw = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8").replace(/^\uFEFF/, ""));
        const rows = (Array.isArray(raw) ? raw[0] : raw)?.Rows ?? {};
        for (const [trackId, row] of Object.entries<any>(rows)) {
            const byRank = new Map<number, Reward[]>();
            for (const r of row.FreeRewards ?? []) {
                const items: Reward[] = (r.StackedItems ?? [])
                    .filter((i: any) => i.CatalogId && i.Quantity > 0)
                    .map((i: any) => ({ catalogId: i.CatalogId, quantity: i.Quantity }));
                if (items.length) byRank.set(r.RankId, items);
            }
            out.set(trackId, byRank);
        }
        logger.info(`MasteryRewards: loaded rewards for ${out.size} tracks`);
    } catch (e) {
        logger.warn(e, `MasteryRewards: could not load ${TABLE_PATH}; rank rewards disabled`);
    }
    return out;
}

const Rewards = LoadRewards();

function GrantedPath(accountId: string) {
    return path.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.rewards.json`);
}

function LoadGranted(accountId: string): Record<string, number> {
    try {
        return JSON.parse(fs.readFileSync(GrantedPath(accountId), "utf8").replace(/^\uFEFF/, ""));
    } catch {
        return {};
    }
}

function SaveGranted(accountId: string, granted: Record<string, number>) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = GrantedPath(accountId);
    fs.writeFileSync(file + ".tmp", JSON.stringify(granted, null, 2));
    fs.renameSync(file + ".tmp", file);
}

// One grant at a time per player, so two quick posts can't pay the same rank twice
const queues = new Map<string, Promise<void>>();

export function GrantMasteryRewards(
    accountId: string,
    trackPoints: Record<string, number>,
    rankFor: (trackId: string, xp: number) => number,
) {
    const snapshot = { ...trackPoints };
    const next = (queues.get(accountId) ?? Promise.resolve())
        .then(() => DoGrant(accountId, snapshot, rankFor))
        .catch(e => logger.error(e, "MasteryRewards: grant failed"));
    queues.set(accountId, next);
}

async function DoGrant(accountId: string, trackPoints: Record<string, number>, rankFor: (t: string, xp: number) => number) {
    if (!Rewards.size) return;

    const granted = LoadGranted(accountId);
    const newGranted = { ...granted };
    const toAdd = new Map<string, number>();
    const changes: string[] = [];

    for (const [trackId, byRank] of Rewards) {
        const rank = rankFor(trackId, trackPoints[trackId] ?? 0);
        const from = granted[trackId] ?? 0;
        if (rank <= from) continue;
        for (let r = from + 1; r <= rank; r++) {
            for (const item of byRank.get(r) ?? []) {
                toAdd.set(item.catalogId, (toAdd.get(item.catalogId) ?? 0) + item.quantity);
            }
        }
        newGranted[trackId] = rank;
        changes.push(`${trackId} ${from}->${rank}`);
    }

    if (!changes.length) return;
    if (!toAdd.size) {
        SaveGranted(accountId, newGranted);
        return;
    }

    const chars = await GetDb().query.characters.findMany({ where: eq(characters.userId, accountId) });
    if (!chars.length) {
        logger.warn(`MasteryRewards: no character for ${accountId}; will retry on next post`);
        return;
    }
    // Most recently modified character gets the rewards
    const character = [...chars].sort((a, b) => (a.lastModifiedDate < b.lastModifiedDate ? 1 : -1))[0];

    const items = [...toAdd].map(([catalogId, quantity]) => ({ catalogId, quantity }));
    const result = await RunInventoryTransaction(accountId, character.characterId, `mastery-rewards-${Date.now()}`, [], items, [], [], []);
    if (!result.success) {
        logger.error(`MasteryRewards: inventory transaction failed (${result.error}); will retry on next post`);
        return;
    }

    SaveGranted(accountId, newGranted);
    logger.info(`MasteryRewards: ${changes.join(", ")} -> ${items.map(i => `${i.catalogId} x${i.quantity}`).join(", ")}`);
}
