// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.progressionRouter = void 0;
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
const progression_1 = require("../controllers/progression");
const progression162_1 = require("../progression162");
exports.progressionRouter = (0, express_1.Router)();
function StatusForProgressionError(Error) {
    switch (Error) {
        case "forbidden":
            return 403;
        case "conflict":
            return 409;
        case "invalid_data":
        case "db_error":
            return 500;
    }
}
exports.progressionRouter.get("/encountered-content/:characterId/:contentType", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.params.contentType;
    logger_1.logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);
    const ContentResult = await (0, progression_1.QueryEncounteredContent)(RequestorAccountId, CharacterId, [ContentType]);
    if (!ContentResult.success) {
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }
    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});
exports.progressionRouter.post("/encountered-content/query/:characterId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types;
    logger_1.logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);
    const ContentResult = await (0, progression_1.QueryEncounteredContent)(RequestorAccountId, CharacterId, ContentTypes);
    if (!ContentResult.success) {
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }
    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});
exports.progressionRouter.post("/encountered-content/:characterId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.body.content_type;
    const ContentId = req.body.content_id;
    logger_1.logger.info(`Adding encountered content ${ContentId} for userId ${RequestorAccountId} and characterId ${CharacterId}`);
    const ContentResult = await (0, progression_1.AddEncounteredContent)(RequestorAccountId, CharacterId, ContentType, ContentId);
    if (!ContentResult.success) {
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }
    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {}
    });
});
// Local only: the game server DLL reads a player's saved objectives here when they join, so their mastery bars
// show saved progress in town instead of 0.
exports.progressionRouter.get("/internal/objectives/:userId", (req, res) => {
    const Ip = String(req.socket?.remoteAddress ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(Ip)) {
        res.status(403).send();
        return;
    }
    res.type("text/plain").send((0, progression162_1.ObjectivesForPriming)(String(req.params.userId)));
});
exports.progressionRouter.get("/progression/objectives/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    // The game server asks for a player's objectives with its own login, so use the player id in the URL
    const RequestorAccountId = req.params.userId ?? req.AuthData.userId;
    logger_1.logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            objectives: (0, progression162_1.ListObjectiveProgress)(RequestorAccountId),
            progress_tracks: (0, progression162_1.BuildProgressTracks)(RequestorAccountId, (Path) => Path.progression_id !== "season09b")
        }
    });
});
exports.progressionRouter.get("/progression/objectives/:userId/:objectiveId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const RequestorAccountId = req.AuthData.userId;
    logger_1.logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    const Saved = (0, progression162_1.GetObjectiveProgress)(req.params.userId, req.params.objectiveId);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            phx_account_id: req.params.userId,
            objective_id: req.params.objectiveId,
            progress: Saved ? Saved.progress : 9999999,
            value: Saved ? Saved.progress : 9999999,
            completed_count: Saved ? Saved.completed_count : 9999999,
            created_date: new Date("1970-1-1").toISOString(),
            last_modified_date: new Date("1970-1-1").toISOString(),
        }
    });
});
exports.progressionRouter.get("/breadcrumbs/:characterId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    logger_1.logger.info(`Requested breadcrumbs for characterId ${RequestedCharacterId}`);
    const BreadcrumbsResult = await (0, progression_1.GetBreadcrumbsForCharacterIdAndUserId)(RequestorUserId, RequestedCharacterId);
    if (!BreadcrumbsResult.success) {
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});
exports.progressionRouter.post("/breadcrumbs/:characterId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    const BreadcrumbsFromUser = req.body.breadcrumbs;
    const UpdateVersion = req.body.updateVersion;
    logger_1.logger.info(`Setting breadcrumbs for characterId ${RequestedCharacterId}`);
    const BreadcrumbsResult = await (0, progression_1.SetBreadcrumbsForCharacterIdAndUserId)(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);
    if (!BreadcrumbsResult.success) {
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});
// XP granted directly by the game server, e.g. a claimed bounty's Weapon Skill XP or the game's own Hunt Pass XP:
//   POST /progression/<uid>/ExperienceTrack_Weapon_ChainBlades/200, POST /progression/<uid>/season13a/10, ...
// The metagame always STORES the XP (GrantTrackXp in progression162.ts). The reply is chosen with GRANT_REPLY in .env:
//   "404"   (default) like before this route existed: the game server keeps its own numbers, but it treats the grant as
//           failed ("failed to update back end with XP progress"), so a claimed bounty's card only clears after a relog.
//   "track" 200 with the updated track itself as payload (progress = old + grant, ranks), which is presumably what the
//           game server expects. Test mode: if the hunt HUD shows absurd numbers again, go back to "404".
//   "ok"    200 with an empty payload (made the HUD show garbage: the server read it as progress 0).
exports.progressionRouter.post("/progression/:userId/:trackId/:amount", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const UserId = String(req.params.userId);
    const TrackId = String(req.params.trackId);
    (0, progression162_1.GrantTrackXp)(UserId, TrackId, req.params.amount);
    const Mode = (process.env.GRANT_REPLY ?? (process.env.GRANT_REPLY_OK === "1" ? "ok" : "404")).toLowerCase();
    if (Mode === "track") {
        const Track = (0, progression162_1.BuildProgressTracks)(UserId, (Path) => Path.progression_id === TrackId)[0] ?? {};
        res.status(200).json({ code: null, message: "OK", payload: Track });
        return;
    }
    if (Mode === "ok") {
        res.status(200).json({ code: null, message: "OK", payload: {} });
        return;
    }
    res.status(404).send();
});
exports.progressionRouter.post("/progression/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const RequestorAccountId = req.params.userId;
    logger_1.logger.info(`Progression set for userId ${RequestorAccountId} (mode=${progression162_1.PROGRESSION_MODE})`);
    (0, progression162_1.LogProgressionPost)(RequestorAccountId, req.body);
    (0, progression162_1.ApplyProgressionPost)(RequestorAccountId, req.body);
    // Upstream always answers 400 (with the stub, success caused an endless mastery level-up popup).
    // In real mode we answer OK with the updated state, so the game server keeps the objective progress
    // instead of logging "failed to update back end". PROGRESSION_POST_OK=0 restores the old 400.
    if (progression162_1.PROGRESSION_MODE === "real" && (process.env.PROGRESSION_POST_OK ?? "1") === "1") {
        const PostedTracks = new Set((req.body?.progress_tracks ?? []).map((t) => String(t?.progression_id)));
        const PostedObjectives = new Set((req.body?.objectives ?? []).map((o) => String(o?.objective_id)));
        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: {
                objectives: (0, progression162_1.ListObjectiveProgress)(RequestorAccountId).filter((o) => PostedObjectives.has(o.objective_id)),
                progress_tracks: (0, progression162_1.BuildProgressTracks)(RequestorAccountId, (Path) => PostedTracks.has(Path.progression_id))
            }
        });
        return;
    }
    res.status(400); // TODO: Figure out how to properly grant progression. If this returns anything other than 400, we get the infinite mastery pop issue
    res.send();
});
exports.progressionRouter.get("/progression/:userId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const RequestorAccountId = req.params.userId ?? req.AuthData.userId;
    // TODO: Impl proper progression. Right now this is the minimum to not block the Boreal crafting reqs
    logger_1.logger.info(`Progression fetched for userId ${RequestorAccountId} (mode=${progression162_1.PROGRESSION_MODE})`);
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: (0, progression162_1.BuildProgressTracks)(RequestorAccountId)
    });
});
