// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetMergedProgressionConfig } from "../progression162";
import { UpdatePlayerActivity } from "../controllers/undauntedapi";
import { ActivePassId, PlayerEntitlements } from "../huntpass162";
import { ApplyBountyPost, GetBounties, RemoveBounties } from "../bounties162";
import { ApplyCooldownBatch, CooldownMap } from "../cooldowns162";
import { EscalationMode, GetEscalation, SaveEscalation, ValidSeasonId } from "../escalation162";

export const systemRouter = Router();

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

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

systemRouter.post("/heartbeat", HasUndauntedMetagameAuth, async (req: any, res) => {
	const UserId = req.AuthData.userId;

	const UserMap = req.body.map;

	await UpdatePlayerActivity(UserId, UserMap);

    res.status(200).type("text/plain").send("20000");
});

systemRouter.post("/event", (req, res) => {
    res.status(200);
    res.json({});
});

systemRouter.post("/account/migrate", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Account migration (stubbed)");

	res.status(200);
	res.json({
		migration_failed: false,
		migration_finished: true
	});
});

systemRouter.post("/profile/update", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Leaderboard update profile (stubbed)");

	res.status(200);
	res.send();
});

systemRouter.get("/vivox/login", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Vivox login (stubbed)");

	res.status(404);
	res.send();
});

systemRouter.post("/motd/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("MOTD (stubbed)");

	res.status(204);
	res.send();
});

// Entitlements the player owns: the Hunt Pass Elite gate (season13a_premium) plus any listed in huntpass_162.json
systemRouter.get("/entitlementsv2", HasUndauntedMetagameAuth, (req, res) => {
	const Ent = PlayerEntitlements();
	logger.info(`Entitlements: served ${Ent.ids.length} (${Ent.ids.join(", ")}) as "${Ent.shape}"`);

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: Ent.payload
	});
});

// Grant request from the game server (e.g. entitlements inside claimed rewards). Logged so we can see its format.
systemRouter.post("/entitlementv2/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info(`Entitlements: grant request for ${req.params.userId}: ${JSON.stringify(req.body ?? null).slice(0, 500)}`);

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: PlayerEntitlements().payload
	});
});

systemRouter.get("/playertreatments/:userId", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Cohorts (stubbed)");

	res.status(200);
	res.json({
		treatments: [
			"CohortTreatment.Dojo.B"
		]
	});
});

// Escalation progress per player and season (escalation162.ts). The game server does the arithmetic and posts the
// whole season; GET serves the stored one (level 0 for a new player). ESCALATION_MODE=stub brings back the old 99999 stub.
systemRouter.get("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const SeasonId = String(req.params.escalationSeason);
	if (!ValidSeasonId(SeasonId)) {
		res.status(404).send();
		return;
	}

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: GetEscalation(String(req.params.userId), SeasonId)
	});
});

systemRouter.get("/eventstats/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Event stats (stubbed)");

	res.status(200);
	res.json({
		stats: []
	});
});

systemRouter.get("/progression/config", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Progression Config (stubbed)");

	res.status(200);
	res.json(GetMergedProgressionConfig());
});

// The active Hunt Pass track id. 1.6.2 only accepts passes available in this build (season13a is the newest);
// levels, XP and rewards come from vendor/huntpass_162.json via huntpass162.ts
systemRouter.get("/huntpass/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const PassId = ActivePassId();
	logger.info(`Huntpass: ${PassId}`);

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
systemRouter.get("/cooldown/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: CooldownMap(String(req.params.userId))
	});
});

systemRouter.put("/cooldown/batch/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: ApplyCooldownBatch(String(req.params.userId), req.body)
	});
});

// One cooldown at a time: PUT /cooldown/<uid>/<cooldown id>. The game sends this when you pick up a daily Ramsgate
// shard, often with an empty body (= started now). Without it the pickup was not saved and the shard came back.
// Fix by KombatKing (from his Consolidated Patches 0.2).
systemRouter.put("/cooldown/:userId/:cooldownId", HasUndauntedMetagameAuth, (req: any, res) => {
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
	ApplyCooldownBatch(uid, { cooldowns: [{ cooldown_id: id, cooldown_started_date: date }] });
	res.status(200);
	res.json(isEmpty ? {} : { code: null, message: "OK", payload: CooldownMap(uid) });
});

systemRouter.get("/bounty/game-data", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info("Bounty game data (stubbed)");

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
systemRouter.get("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: GetBounties(String(req.params.userId))
	});
});

systemRouter.post("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: ApplyBountyPost(String(req.params.userId), req.body)
	});
});

// The game server deleting bounties (claimed, with delete_claimed_bounties, or abandoned). 1.6.2 uses POST /bounty/delete/:userId.
systemRouter.post("/bounty/delete/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({ code: null, message: "OK", payload: RemoveBounties(String(req.params.userId), undefined, req.body) });
});

// The game server deleting bounties (claimed, with delete_claimed_bounties, or abandoned)
systemRouter.delete("/bounty/:userId/:bountyId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({ code: null, message: "OK", payload: RemoveBounties(String(req.params.userId), String(req.params.bountyId), req.body) });
});

systemRouter.delete("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	res.status(200);
	res.json({ code: null, message: "OK", payload: RemoveBounties(String(req.params.userId), undefined, req.body) });
});

// Mailbox: a letter when a holiday starts, read/deleted state kept per account in data/mailbox (event-mail162.cjs,
// by KombatKing). Registered first, so the empty mailbox below only answers if this ever fails to load.
try { require("../../event-mail162.cjs").routes(systemRouter, HasUndauntedMetagameAuth, require("node:path").resolve(__dirname, "../../../..")); }
catch (e: any) { console.error("Event mailbox: " + (e && e.message)); }

systemRouter.get("/all/", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info("Mailbox (stubbed)");

	res.json({
		code: null,
		message: "OK",
		payload: {
			messages: []
		}
	});
});
// The game server saving a player's season (UpdateSeasonalEscalationEndpoint, the whole season as the body)
systemRouter.post("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	const SeasonId = String(req.params.escalationSeason);
	if (EscalationMode() === "stub" || !ValidSeasonId(SeasonId)) {
		res.status(404).send();
		return;
	}

	const Result = SaveEscalation(String(req.params.userId), SeasonId, req.body);
	res.status(Result.status);
	res.json({ code: null, message: Result.status === 200 ? "OK" : "Refused", payload: Result.payload });
});
