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

export const systemRouter = Router();

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

    res.json({
	    "show-status": true,
	    "en": "Welcome to Undaunted v0.0.5!",
	    "fr": "Welcome to Undaunted v0.0.5!",
	    "it": "Welcome to Undaunted v0.0.5!",
	    "es": "Welcome to Undaunted v0.0.5!",
	    "de": "Welcome to Undaunted v0.0.5!",
	    "pt": "Welcome to Undaunted v0.0.5!",
	    "ru": "Welcome to Undaunted v0.0.5!",
	    "ja": "Welcome to Undaunted v0.0.5!"
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

systemRouter.get("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, (req, res) => {
	const EscalationSeason = req.params.escalationSeason;

	logger.info(`Escalation Configuration for season ${EscalationSeason} (stubbed)`);

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
        	escalation_level: 99999,
        	next_level_xp: 99999,
        	talents_progress: [],
        	unlock_progress: [],
        	update_version: 1,
      	}
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
      delete_claimed_bounties: false,
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
// [esc-log] temporary: record what the game POSTs to /escalation, still answer 404 as before
systemRouter.post("/escalation/:escalationSeason/:userId", (req, res) => {
    logger.info(`[esc-log] POST ${req.params.escalationSeason} ct=${req.headers["content-type"]} len=${req.headers["content-length"]} query=${JSON.stringify(req.query)} body=${JSON.stringify(req.body)}`);
    res.status(404).end();
});
