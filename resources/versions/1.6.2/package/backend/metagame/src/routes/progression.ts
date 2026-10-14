// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, ProgressionError, QueryEncounteredContent, SetBreadcrumbsForCharacterIdAndUserId } from "../controllers/progression";
import { ApplyProgressionPost, BuildProgressTracks, GetObjectiveProgress, GrantTrackXp, ListObjectiveProgress, LogProgressionPost, ObjectivesForPriming, PROGRESSION_MODE, ResetWeaponTrack } from "../progression162";

export const progressionRouter = Router();

function StatusForProgressionError(Error: ProgressionError){
    switch(Error){
        case "forbidden":
            return 403;
        case "conflict":
            return 409;
        case "invalid_data":
        case "db_error":
            return 500;
    }
}

progressionRouter.get("/encountered-content/:characterId/:contentType", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.params.contentType as number;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, [ContentType]);

    if(!ContentResult.success){
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

progressionRouter.post("/encountered-content/query/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, ContentTypes);

    if(!ContentResult.success){
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

progressionRouter.post("/encountered-content/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.body.content_type;
    const ContentId = req.body.content_id;

    logger.info(`Adding encountered content ${ContentId} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await AddEncounteredContent(RequestorAccountId, CharacterId, ContentType, ContentId);

    if(!ContentResult.success){
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
progressionRouter.get("/internal/objectives/:userId", (req: any, res) => {
    const Ip = String(req.socket?.remoteAddress ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(Ip)) {
        res.status(403).send();
        return;
    }
    res.type("text/plain").send(ObjectivesForPriming(String(req.params.userId)));
});

progressionRouter.get("/progression/objectives/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    // The game server asks for a player's objectives with its own login, so use the player id in the URL
    const RequestorAccountId = req.params.userId ?? req.AuthData.userId;

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            objectives: ListObjectiveProgress(RequestorAccountId),
            progress_tracks: BuildProgressTracks(RequestorAccountId, (Path) => Path.progression_id !== "season09b")
        }
    })
});

progressionRouter.get("/progression/objectives/:userId/:objectiveId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);

    const Saved = GetObjectiveProgress(req.params.userId, req.params.objectiveId);

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
    })
});

progressionRouter.get("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;

    logger.info(`Requested breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await GetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId);

    if(!BreadcrumbsResult.success){
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

progressionRouter.post("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    const BreadcrumbsFromUser = req.body.breadcrumbs;
    const UpdateVersion = req.body.updateVersion;

    logger.info(`Setting breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await SetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);

    if(!BreadcrumbsResult.success){
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
//   "track" (default since Oct 14) 200 with the updated track itself as payload (progress = old + grant, ranks).
//           Without it the game server logs "failed to update back end with XP progress" for every bounty claim.
//   "404"   like before this route existed: the game server keeps its own numbers, but it treats the grant as
//           failed ("failed to update back end with XP progress"), so a claimed bounty's card only clears after a relog.
//           If the hunt HUD ever shows absurd numbers again, set GRANT_REPLY=404.
//   "ok"    200 with an empty payload (made the HUD show garbage: the server read it as progress 0).
progressionRouter.post("/progression/:userId/:trackId/:amount", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = String(req.params.userId);
    const TrackId = String(req.params.trackId);
    GrantTrackXp(UserId, TrackId, req.params.amount);

    const Mode = (process.env.GRANT_REPLY ?? (process.env.GRANT_REPLY_OK === "1" ? "ok" : "track")).toLowerCase();
    if (Mode === "track") {
        const Track = BuildProgressTracks(UserId, (Path) => Path.progression_id === TrackId)[0] ?? {};
        res.status(200).json({ code: null, message: "OK", payload: Track });
        return;
    }
    if (Mode === "ok") {
        res.status(200).json({ code: null, message: "OK", payload: {} });
        return;
    }
    res.status(404).send();
});

// [reforge] One track, as the game reads it right after a reforge: GET /progression/<uid>/<trackId>.
// Same shape as the grant reply: 200 with the track itself as payload (404 for a track the config does not have).
progressionRouter.get("/progression/:userId/:trackId", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = String(req.params.userId);
    const TrackId = String(req.params.trackId);
    const Track = BuildProgressTracks(UserId, (Path) => Path.progression_id === TrackId)[0];
    if (Track === undefined) {
        res.status(404).send();
        return;
    }
    logger.info(`Progression: track ${TrackId} read for ${UserId} (progress ${(Track as any).progress})`);
    res.status(200).json({ code: null, message: "OK", payload: Track });
});

// [reforge] The game server resetting a weapon to level 1 (Sparkforge reforge): DELETE /progression/<uid>/ExperienceTrack_Weapon_<W>.
// Answered like a grant ("track" reply): 200 with the track as it is now (progress 0).
progressionRouter.delete("/progression/:userId/:trackId", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = String(req.params.userId);
    const TrackId = String(req.params.trackId);
    if (!ResetWeaponTrack(UserId, TrackId)) {
        res.status(400).send();
        return;
    }
    const Track = BuildProgressTracks(UserId, (Path) => Path.progression_id === TrackId)[0] ?? {};
    res.status(200).json({ code: null, message: "OK", payload: Track });
});

progressionRouter.post("/progression/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.params.userId;
    
    logger.info(`Progression set for userId ${RequestorAccountId} (mode=${PROGRESSION_MODE})`);
    LogProgressionPost(RequestorAccountId, req.body);
    ApplyProgressionPost(RequestorAccountId, req.body);

    // Upstream always answers 400 (with the stub, success caused an endless mastery level-up popup).
    // In real mode we answer OK with the updated state, so the game server keeps the objective progress
    // instead of logging "failed to update back end". PROGRESSION_POST_OK=0 restores the old 400.
    if (PROGRESSION_MODE === "real" && (process.env.PROGRESSION_POST_OK ?? "1") === "1") {
        const PostedTracks = new Set((req.body?.progress_tracks ?? []).map((t: any) => String(t?.progression_id)));
        const PostedObjectives = new Set((req.body?.objectives ?? []).map((o: any) => String(o?.objective_id)));
        res.status(200);
        res.json({
            code: null,
            message: "OK",
            payload: {
                objectives: ListObjectiveProgress(RequestorAccountId).filter((o) => PostedObjectives.has(o.objective_id)),
                progress_tracks: BuildProgressTracks(RequestorAccountId, (Path) => PostedTracks.has(Path.progression_id))
            }
        });
        return;
    }

    res.status(400); // TODO: Figure out how to properly grant progression. If this returns anything other than 400, we get the infinite mastery pop issue
    res.send();
});

progressionRouter.get("/progression/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.params.userId ?? req.AuthData.userId;

    // TODO: Impl proper progression. Right now this is the minimum to not block the Boreal crafting reqs

    logger.info(`Progression fetched for userId ${RequestorAccountId} (mode=${PROGRESSION_MODE})`);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BuildProgressTracks(RequestorAccountId)
    })
});
