// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchmakingRouter = void 0;
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
const matchmaking_1 = require("../controllers/matchmaking");
exports.matchmakingRouter = (0, express_1.Router)();
const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
exports.matchmakingRouter.post("/candidate/player/register", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);
    res.status(200);
    res.json({});
});
exports.matchmakingRouter.delete("/party/member", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info(`Clear party (stubbed)`);
    res.status(200);
    res.json({});
});
exports.matchmakingRouter.get("/candidate/regions", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info(`Querying regions for QoS`);
    res.status(200);
    res.json({
        code: 200,
        message: "success",
        payload: {
            maxPingingStepTime: 3,
            pingCount: 5,
            pingFrequency: 0.25,
            regionUrls: [
                QOS_TARGET_URL
            ]
        }
    });
});
exports.matchmakingRouter.post("/key/generate", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    res.status(400);
    res.send();
});
exports.matchmakingRouter.get("/candidate/status", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.userId;
    const MatchmakingResult = await (0, matchmaking_1.CheckAndUpdateQueueStatus)(UserId);
    if (MatchmakingResult != undefined) {
        if (MatchmakingResult.Ready) {
            logger_1.logger.info(`Telling client to travel to ${MatchmakingResult.Host}:${MatchmakingResult.Port}`);
            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: 10000,
                gameMode: "ISLAND",
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                    UserId: {}
                },
                serverInfo: {
                    buildId: TARGET_CHANGELIST + "_1.6.2_shipping", // TODO: pull the end of the buildstring from somewhere nonstatic
                    gameSessionId: MatchmakingResult.CandidateId,
                    host: MatchmakingResult.Host,
                    port: MatchmakingResult.Port
                },
                status: "IN_PROGRESS",
                statusDuration: 0.0,
                statusReason: null
            });
        }
        else {
            logger_1.logger.info(`MM not ready yet!`);
            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: 10000,
                gameMode: "ISLAND",
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                    UserId: {}
                },
                status: "MATCHING",
                statusDuration: 0.0,
                statusReason: null
            });
        }
    }
    else {
        logger_1.logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);
        res.status(404);
        res.send();
    }
});
exports.matchmakingRouter.post("/candidate/join", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const UserId = req.AuthData.userId;
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;
    logger_1.logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId}`);
    // TODO: We put a LOT of faith in our authenticated users not abusing the matchmaking system right now
    // A reasonable addition would be checks on frequency of MM/server spinup
    // Best scenario is 1-1 for server session<->player and a new server cooldown
    const MatchmakingResult = await (0, matchmaking_1.HandlePlayerMatchmaking)(GameMode, GameArgs, HuntId, UserId);
    if (!MatchmakingResult) {
        res.status(400);
        res.send();
        return;
    }
    const MatchmakingEntry = await (0, matchmaking_1.CheckAndUpdateQueueStatus)(UserId);
    res.status(200);
    res.json({
        candidateId: MatchmakingEntry.CandidateId,
        gameMode: GameMode,
        huntId: HuntId,
        status: "MATCHING",
        statusReason: null
    });
});
exports.matchmakingRouter.get("/QoS", (req, res) => {
    logger_1.logger.info(`QoS Ping`);
    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
});
