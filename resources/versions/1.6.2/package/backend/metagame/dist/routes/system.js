"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemRouter = void 0;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
const express_1 = require("express");
const logger_1 = require("../logger");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const progression162_1 = require("../progression162");
const undauntedapi_1 = require("../controllers/undauntedapi");
const huntpass162_1 = require("../huntpass162");
const bounties162_1 = require("../bounties162");
const cooldowns162_1 = require("../cooldowns162");
const escalation162_1 = require("../escalation162");
exports.systemRouter = (0, express_1.Router)();
exports.systemRouter.get("/dauntless-status", (req, res) => {
    logger_1.logger.info("Status");
    res.json({
        "show-status": true,
        "en": "Dauntless Forever!",
        "fr": "Dauntless Forever!",
        "it": "Dauntless Forever!",
        "es": "Dauntless Forever!",
        "de": "Dauntless Forever!",
        "pt": "Dauntless Forever!",
        "ru": "Dauntless Forever!",
        "ja": "Dauntless Forever!"
    });
});
exports.systemRouter.post("/heartbeat", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.userId;
    const UserMap = req.body.map;
    await (0, undauntedapi_1.UpdatePlayerActivity)(UserId, UserMap);
    res.status(200).type("text/plain").send("20000");
});
exports.systemRouter.post("/event", (req, res) => {
    res.status(200);
    res.json({});
});
exports.systemRouter.post("/account/migrate", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Account migration (stubbed)");
    res.status(200);
    res.json({
        migration_failed: false,
        migration_finished: true
    });
});
exports.systemRouter.post("/profile/update", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Leaderboard update profile (stubbed)");
    res.status(200);
    res.send();
});
exports.systemRouter.get("/vivox/login", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Vivox login (stubbed)");
    res.status(404);
    res.send();
});
exports.systemRouter.post("/motd/", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("MOTD (stubbed)");
    res.status(204);
    res.send();
});
// Entitlements the player owns: the Hunt Pass Elite gate (season13a_premium) plus any listed in huntpass_162.json
exports.systemRouter.get("/entitlementsv2", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Ent = (0, huntpass162_1.PlayerEntitlements)();
    logger_1.logger.info(`Entitlements: served ${Ent.ids.length} (${Ent.ids.join(", ")}) as "${Ent.shape}"`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: Ent.payload
    });
});
// Grant request from the game server (e.g. entitlements inside claimed rewards). Logged so we can see its format.
exports.systemRouter.post("/entitlementv2/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info(`Entitlements: grant request for ${req.params.userId}: ${JSON.stringify(req.body ?? null).slice(0, 500)}`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, huntpass162_1.PlayerEntitlements)().payload
    });
});
exports.systemRouter.get("/playertreatments/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Cohorts (stubbed)");
    res.status(200);
    res.json({
        treatments: [
            "CohortTreatment.Dojo.B"
        ]
    });
});
// Escalation progress per player and season (escalation162.ts). The game server does the arithmetic and posts the
// whole season; GET serves the stored one (level 0 for a new player). ESCALATION_MODE=stub brings back the old 99999 stub.
exports.systemRouter.get("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const SeasonId = String(req.params.escalationSeason);
    if (!(0, escalation162_1.ValidSeasonId)(SeasonId)) {
        res.status(404).send();
        return;
    }
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, escalation162_1.GetEscalation)(String(req.params.userId), SeasonId)
    });
});
exports.systemRouter.get("/eventstats/", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Event stats (stubbed)");
    res.status(200);
    res.json({
        stats: []
    });
});
exports.systemRouter.get("/progression/config", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Progression Config (stubbed)");
    res.status(200);
    res.json((0, progression162_1.GetMergedProgressionConfig)());
});
// The active Hunt Pass track id. 1.6.2 only accepts passes available in this build (season13a is the newest);
// levels, XP and rewards come from vendor/huntpass_162.json via huntpass162.ts
exports.systemRouter.get("/huntpass/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const PassId = (0, huntpass162_1.ActivePassId)();
    logger_1.logger.info(`Huntpass: ${PassId}`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: PassId
    });
});
// Cooldowns are remembered per player (cooldowns162.ts). The game keeps its bounty token cooldown here; without it
// every login looked like a new bounty season and drafted bounties were refunded and reset.
// The game reads cooldowns as a string map { id: ISO date } (it writes them as a list; see cooldowns162.ts).
// payload IS the map (upstream's stub sent payload: {}); a nested { cooldowns: {...} } can't parse as a string map.
exports.systemRouter.get("/cooldown/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, cooldowns162_1.CooldownMap)(String(req.params.userId))
    });
});
exports.systemRouter.put("/cooldown/batch/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, cooldowns162_1.ApplyCooldownBatch)(String(req.params.userId), req.body)
    });
});
// One cooldown at a time: PUT /cooldown/<uid>/<cooldown id>. The game sends this when you pick up a daily Ramsgate
// shard, often with an empty body (= started now). Without it the pickup was not saved and the shard came back.
// Fix by KombatKing (from his Consolidated Patches 0.2).
exports.systemRouter.put("/cooldown/:userId/:cooldownId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const uid = String(req.params.userId);
    const id = String(req.params.cooldownId);
    if (!/^[-A-Za-z0-9_.:{}]{1,200}$/.test(id)) { res.status(400).send(); return; }
    const b = req.body?.payload ?? req.body;
    const isEmpty = b == null || (typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 0);
    let date = new Date().toISOString();
    if (!isEmpty) {
        const v = typeof b === "string" ? b : (b?.cooldown_started_date ?? b?.cooldown_start_date ?? b?.started_date ?? b?.start_date ?? b?.date ?? b?.[id]);
        if (typeof v === "string" && Number.isFinite(Date.parse(v))) date = v; // anything else: started now
    }
    (0, cooldowns162_1.ApplyCooldownBatch)(uid, { cooldowns: [{ cooldown_id: id, cooldown_started_date: date }] });
    res.status(200);
    res.json(isEmpty ? {} : { code: null, message: "OK", payload: (0, cooldowns162_1.CooldownMap)(uid) });
});

exports.systemRouter.get("/bounty/game-data", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Bounty game data (stubbed)");
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            max_slots: 4,
            num_draft_options: 3,
            num_spicy_options: 1,
            bounty_token_id: "TOKEN_BOUNTY_DRAFT",
            premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
            num_tokens_hp_start: 4,
            num_tokens_per_day: 0,
            bounty_token_grant_hour: 0,
            history_length: 10,
            bronze_count: 9,
            silver_count: 3,
            gold_count: 1,
            new_season_reset_bounties: false,
            bounty_data: [],
            item_grant_data: [],
            token_rollover_warning_days: 1000,
            automatic_draft: false,
            automatic_claim: false,
            // Same as the bounty_game_data tuning blob (tuning162.ts): claimed bounties clear at once. Both must agree.
            delete_claimed_bounties: (process.env.BOUNTY_DELETE_CLAIMED ?? "1") === "1",
        },
    });
});
// Bounties are remembered per player (bounties162.ts); upstream's stubs saved nothing, so drafts vanished.
// Must stay below /bounty/game-data so that route isn't taken for a user id.
exports.systemRouter.get("/bounty/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, bounties162_1.GetBounties)(String(req.params.userId))
    });
});
exports.systemRouter.post("/bounty/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, bounties162_1.ApplyBountyPost)(String(req.params.userId), req.body)
    });
});
// The game server deleting bounties (claimed, with delete_claimed_bounties, or abandoned). 1.6.2 uses POST /bounty/delete/:userId.
exports.systemRouter.post("/bounty/delete/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({ code: null, message: "OK", payload: (0, bounties162_1.RemoveBounties)(String(req.params.userId), undefined, req.body) });
});
// The game server deleting bounties (claimed, with delete_claimed_bounties, or abandoned)
exports.systemRouter.delete("/bounty/:userId/:bountyId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({ code: null, message: "OK", payload: (0, bounties162_1.RemoveBounties)(String(req.params.userId), String(req.params.bountyId), req.body) });
});
exports.systemRouter.delete("/bounty/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    res.status(200);
    res.json({ code: null, message: "OK", payload: (0, bounties162_1.RemoveBounties)(String(req.params.userId), undefined, req.body) });
});
exports.systemRouter.get("/all/", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Mailbox (stubbed)");
    res.json({
        code: null,
        message: "OK",
        payload: {
            messages: []
        }
    });
});
// The game server saving a player's season (UpdateSeasonalEscalationEndpoint, the whole season as the body)
exports.systemRouter.post("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const SeasonId = String(req.params.escalationSeason);
    if ((0, escalation162_1.EscalationMode)() === "stub" || !(0, escalation162_1.ValidSeasonId)(SeasonId)) {
        res.status(404).send();
        return;
    }
    const Result = (0, escalation162_1.SaveEscalation)(String(req.params.userId), SeasonId, req.body);
    res.status(Result.status);
    res.json({ code: null, message: Result.status === 200 ? "OK" : "Refused", payload: Result.payload });
});
