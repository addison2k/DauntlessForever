"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STUB_SEASON = void 0;
exports.EscalationMode = EscalationMode;
exports.ValidSeasonId = ValidSeasonId;
exports.GetEscalation = GetEscalation;
exports.SaveEscalation = SaveEscalation;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
// escalation162.ts — remember each player's Escalation progress (1.6.2)
//
// Upstream answered GET /escalation/<season>/<uid> with a fixed stub (escalation_level 99999, next_level_xp 99999,
// nothing collected) and the save (POST, same path) fell through to 404. So every hunt server started from the fake
// maximum, every save failed ("Failed to update seasonal escalation data!") and the end-of-run rewards were worked
// out from nonsense.
//
// What the 1.6.2 exe sends and reads (FOnlineEscalationPhoenix::GetSeasonalEscalation / SetSeasonalEscalation,
// serializer at RVA 0xB70C54 / 0xB70E9A, field names checked in the exe):
//   GetSeasonalEscalationEndpoint    GET  /escalation/{season_id}/{account_id}   (client and game servers)
//   UpdateSeasonalEscalationEndpoint POST /escalation/{season_id}/{account_id}   (game server, the whole season)
//   season = { escalation_level, next_level_xp, talents_progress: [{ talent_id, rank }],
//              unlock_progress: [{ reward_id, collected }], update_version }
//   replies are wrapped { code, message, payload: <season> }.
// 1.6.2 asks for ESC_SEASON_1 .. ESC_SEASON_5 at every load. The game server does the arithmetic (XP, levels,
// talents, rewards) and posts the whole season; the backend keeps the last good one. Same contract as
// Dauntless Revived / Harmonic's 1.4.4 fork (findings/escalation.html).
//
// Save rules (a refusal answers 409 and keeps the stored season):
//  - older update_version than stored -> refused; same version and same content -> a retry, answered with the stored one;
//  - a lower level, or less XP at the same level -> refused (nothing goes down);
//  - stub guard: level >= 1000 or next_level_xp >= 99999 -> refused. That is a game server that loaded the old stub;
//    restart the game servers together with the metagame once after switching.
// Every raw POST is appended to escalation_posts.jsonl (next to bounty_posts.jsonl).
// ESCALATION_MODE=stub brings back the old stub (GET 99999, POST 404). Default: real.
// State per player: <ESCALATION_STATE_DIR>\<UID>.json  { seasons: { <season id>: <season> } }
// (default: an escalation folder next to the database). Log prefix "Escalation:".
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
const STATE_DIR = process.env.ESCALATION_STATE_DIR
    ?? path_1.default.join(path_1.default.dirname(process.env.DB_FILENAME || "./undaunted.db"), "escalation");
const POST_LOG_PATH = process.env.ESCALATION_POST_LOG ?? path_1.default.join(process.cwd(), "escalation_posts.jsonl");
function EscalationMode() {
    return (process.env.ESCALATION_MODE ?? "real").toLowerCase() === "stub" ? "stub" : "real";
}
exports.STUB_SEASON = {
    escalation_level: 99999,
    next_level_xp: 99999,
    talents_progress: [],
    unlock_progress: [],
    update_version: 1,
};
function NewSeason() {
    return { escalation_level: 0, next_level_xp: 0, talents_progress: [], unlock_progress: [], update_version: 0 };
}
function StatePath(accountId) {
    return path_1.default.join(STATE_DIR, `${accountId.replace(/[^\w-]/g, "_")}.json`);
}
function LoadState(accountId) {
    try {
        const saved = JSON.parse(fs_1.default.readFileSync(StatePath(accountId), "utf8").replace(/^\uFEFF/, ""));
        if (saved && typeof saved === "object" && saved.seasons && typeof saved.seasons === "object")
            return saved;
    }
    catch { /* new player */ }
    return { seasons: {} };
}
function SaveState(accountId, state) {
    fs_1.default.mkdirSync(STATE_DIR, { recursive: true });
    const file = StatePath(accountId);
    fs_1.default.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2));
    fs_1.default.renameSync(file + ".tmp", file);
}
function ValidSeasonId(seasonId) {
    return /^[A-Za-z0-9_]{1,64}$/.test(seasonId);
}
function Num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function Text(s) {
    if (!s)
        return "none";
    const t = Array.isArray(s.talents_progress) ? s.talents_progress.length : 0;
    const u = Array.isArray(s.unlock_progress) ? s.unlock_progress.filter((x) => x?.collected).length : 0;
    return `level ${s.escalation_level} xp ${s.next_level_xp} v${s.update_version} talents ${t} collected ${u}`;
}
// Content without the version, to tell a retry from a different save with the same version
function Content(s) {
    const { update_version, ...rest } = s ?? {};
    return JSON.stringify(rest);
}
function GetEscalation(accountId, seasonId) {
    if (EscalationMode() === "stub") {
        logger_1.logger.info(`Escalation: ${seasonId} for ${accountId} (stub)`);
        return exports.STUB_SEASON;
    }
    const stored = LoadState(accountId).seasons[seasonId];
    logger_1.logger.info(`Escalation: read ${seasonId} for ${accountId}: ${stored ? Text(stored) : "nothing stored, level 0"}`);
    return stored ?? NewSeason();
}
function SaveEscalation(accountId, seasonId, body) {
    try {
        fs_1.default.appendFileSync(POST_LOG_PATH, JSON.stringify({ t: new Date().toISOString(), userId: accountId, season: seasonId, body }) + "\n");
    }
    catch (e) {
        logger_1.logger.error(e, "Escalation: failed to write escalation post log");
    }
    const src = body && typeof body === "object" && !Array.isArray(body)
        ? ("escalation_level" in body ? body : (body.payload && typeof body.payload === "object" ? body.payload : null))
        : null;
    const state = LoadState(accountId);
    const stored = state.seasons[seasonId] ?? null;
    const keep = stored ?? NewSeason();
    if (!src) {
        const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : typeof body;
        logger_1.logger.warn(`Escalation: save of ${seasonId} for ${accountId} in unknown format (keys: ${keys || "none"}); refused, see escalation_posts.jsonl`);
        return { status: 400, payload: keep };
    }
    const level = Num(src.escalation_level), xp = Num(src.next_level_xp), version = Num(src.update_version) ?? 0;
    if (level === null || xp === null || level < 0 || xp < 0) {
        logger_1.logger.warn(`Escalation: save of ${seasonId} for ${accountId} refused: bad level/xp (${src.escalation_level}/${src.next_level_xp})`);
        return { status: 400, payload: keep };
    }
    if (level >= 1000 || xp >= 99999) {
        logger_1.logger.warn(`Escalation: save of ${seasonId} for ${accountId} refused: stub values (${Text(src)}). Restart the game servers.`);
        return { status: 409, payload: keep };
    }
    const season = {
        ...src,
        escalation_level: level,
        next_level_xp: xp,
        talents_progress: Array.isArray(src.talents_progress) ? src.talents_progress : [],
        unlock_progress: Array.isArray(src.unlock_progress) ? src.unlock_progress : [],
        update_version: version,
    };
    if (stored) {
        const sv = Num(stored.update_version) ?? 0;
        if (version < sv) {
            logger_1.logger.warn(`Escalation: save of ${seasonId} for ${accountId} refused: version ${version} older than stored ${sv}`);
            return { status: 409, payload: stored };
        }
        if (version === sv && Content(season) === Content(stored)) {
            logger_1.logger.info(`Escalation: ${seasonId} for ${accountId}: retry of version ${version}, nothing changed`);
            return { status: 200, payload: stored };
        }
        const sl = Num(stored.escalation_level) ?? 0, sx = Num(stored.next_level_xp) ?? 0;
        if (level < sl || (level === sl && xp < sx)) {
            logger_1.logger.warn(`Escalation: save of ${seasonId} for ${accountId} refused: goes down (${Text(stored)} -> ${Text(season)})`);
            return { status: 409, payload: stored };
        }
        if (version === sv)
            logger_1.logger.warn(`Escalation: ${seasonId} for ${accountId}: same version ${version} with new content, accepted`);
    }
    state.seasons[seasonId] = season;
    SaveState(accountId, state);
    logger_1.logger.info(`Escalation: saved ${seasonId} for ${accountId}: ${Text(stored)} -> ${Text(season)}`);
    return { status: 200, payload: season };
}
