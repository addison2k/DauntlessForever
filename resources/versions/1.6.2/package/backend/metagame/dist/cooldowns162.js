// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CooldownMap = CooldownMap;
exports.ApplyCooldownBatch = ApplyCooldownBatch;
// cooldowns162.ts — remember each player's cooldowns (1.6.2)
//
// Upstream's /cooldown routes were stubs: GET always returned {} and PUT /cooldown/batch saved nothing. The game keeps
// its "bounty token cooldown" there; without it every login looks like a new bounty season, so the game server refunds
// and resets all drafted bounties ("new bounty season detected", "attempting to refund %d bounties").
//
// Formats (from the 1.6.2 exe, UCooldownComponent::OnQueryCooldownDataRequestComplete in Ghidra):
//  - the game WRITES a list: PUT { cooldowns: [ { cooldown_id, cooldown_started_date } ] }
//  - the game READS a map:   GET payload { "<cooldown_id>": "<ISO date>" }  (payload itself is the map)
//    (parsed into a TMap<FString,FString>, each value parsed as a date). Answering in the write shape made every
//    cooldown "not found", so every login looked like a new bounty season and saved bounties were never restored.
// The saved state keeps the shape the game sends:
//  - top-level keys of the PUT body are merged into the saved object;
//  - array values are merged item by item using the first id-like field (cooldown_id, cooldown_key, key, id, name);
//  - GET turns the saved list into the map the game reads (CooldownMap).
// Every raw PUT is appended to cooldown_posts.jsonl. State per player: <COOLDOWN_STATE_DIR>\<UID>.json
// (default: a cooldowns folder next to the database). Log prefix "Cooldowns:".
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
const STATE_DIR = process.env.COOLDOWN_STATE_DIR ?? require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "cooldowns");
const POST_LOG_PATH = process.env.COOLDOWN_POST_LOG ?? path_1.default.join(process.cwd(), "cooldown_posts.jsonl");
const ID_FIELDS = ["cooldown_id", "cooldown_key", "key", "id", "name"];
function StatePath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.json`);
}
function LoadState(accountId) {
    try {
        const saved = JSON.parse(fs_1.default.readFileSync(StatePath(accountId), "utf8").replace(/^\uFEFF/, ""));
        return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    }
    catch {
        return {};
    }
}
function SaveState(accountId, state) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const file = StatePath(accountId);
    fs_1.default.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
    fs_1.default.renameSync(file + ".tmp", file);
}
function ItemId(item) {
    if (!item || typeof item !== "object")
        return null;
    for (const f of ID_FIELDS)
        if (item[f] !== undefined && item[f] !== null)
            return `${f}:${item[f]}`;
    return null;
}
function MergeArray(current, posted) {
    const out = [...current];
    for (const item of posted) {
        const id = ItemId(item);
        const i = id ? out.findIndex(x => ItemId(x) === id) : -1;
        if (i >= 0)
            out[i] = item;
        else
            out.push(item);
    }
    return out;
}
function Describe(state) {
    return Object.entries(state).map(([k, v]) => Array.isArray(v) ? `${k}[${v.length}]` : k).join(", ") || "empty";
}
// The map the game reads: { "<cooldown_id>": "<ISO start date>" }
function CooldownMap(accountId) {
    const state = LoadState(accountId);
    const map = {};
    for (const v of Object.values(state)) {
        if (!Array.isArray(v))
            continue;
        for (const c of v) {
            const id = c?.cooldown_id ?? c?.cooldown_key ?? c?.key ?? c?.id;
            const date = c?.cooldown_started_date ?? c?.start_date ?? c?.date;
            if (id !== undefined && date !== undefined)
                map[String(id)] = String(date);
        }
    }
    logger_1.logger.info(`Cooldowns: read for ${accountId} (${Object.keys(map).length}: ${Object.keys(map).join(", ") || "none"})`);
    return map;
}
function ApplyCooldownBatch(accountId, body) {
    try {
        fs_1.default.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, body }) + "\n");
    }
    catch (e) {
        logger_1.logger.error(e, "Cooldowns: failed to write cooldown post log");
    }
    const state = LoadState(accountId);
    let src = body;
    if (Array.isArray(src))
        src = { cooldowns: src };
    if (!src || typeof src !== "object") {
        logger_1.logger.warn(`Cooldowns: batch from ${accountId} in unknown format (${typeof body}); nothing saved`);
        return state;
    }
    for (const [k, v] of Object.entries(src)) {
        state[k] = Array.isArray(v) && Array.isArray(state[k]) ? MergeArray(state[k], v) : v;
    }
    SaveState(accountId, state);
    logger_1.logger.info(`Cooldowns: saved for ${accountId} (${Describe(state)}): ${JSON.stringify(body).slice(0, 300)}`);
    return state;
}
