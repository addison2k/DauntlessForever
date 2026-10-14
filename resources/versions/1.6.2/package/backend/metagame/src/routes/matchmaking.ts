// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { CancelMatchmaking, CheckAndUpdateQueueStatus, GetEntryForCandidate, HandlePlayerMatchmaking, NoteSentTo } from "../controllers/matchmaking";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;

matchmakingRouter.post("/candidate/player/register", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);

    res.status(200);
    res.json({});
});

// DELETE /party/member is answered by routes/party.ts (leaving a party)

matchmakingRouter.get("/candidate/regions", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`Querying regions for QoS`);

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

matchmakingRouter.post("/key/generate", HasUndauntedMetagameAuth, async (req: any, res) => {
    res.status(400);
    res.send();
});

matchmakingRouter.get("/candidate/status", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const MatchmakingResult = await CheckAndUpdateQueueStatus(UserId);

    if(MatchmakingResult != undefined){
        if(MatchmakingResult.Ready){
            logger.info(`Telling client to travel to ${MatchmakingResult.Host}:${MatchmakingResult.Port}`);
            NoteSentTo(UserId, MatchmakingResult.Host, MatchmakingResult.Port);

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
        else{
            logger.info(`MM not ready yet!`);

            res.status(200);
            res.json({
                candidateId: MatchmakingResult.CandidateId,
                candidateStatusPeriodMillis: 10000,
                gameMode: "ISLAND",
                huntId: MatchmakingResult.HuntId,
                playerStates: {
                  UserId : {}
                },
                status : "MATCHING",
                statusDuration : 0.0,
                statusReason : null
            })
        }
    }
    else{
        logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);

        res.status(404);
        res.send();
    }
});

matchmakingRouter.post("/candidate/join", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;

    logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId}`);

    // TODO: We put a LOT of faith in our authenticated users not abusing the matchmaking system right now
    // A reasonable addition would be checks on frequency of MM/server spinup
    // Best scenario is 1-1 for server session<->player and a new server cooldown

    const MatchmakingResult = await HandlePlayerMatchmaking(GameMode, GameArgs, HuntId, UserId);

    if(!MatchmakingResult){
        res.status(400);
        res.send();
        return;
    }

    const MatchmakingEntry = await CheckAndUpdateQueueStatus(UserId);

    res.status(200);
    res.json({
        candidateId: MatchmakingEntry!.CandidateId,
        gameMode: GameMode,
        huntId: HuntId,
        status: "MATCHING",
        statusReason: null
    });
});

matchmakingRouter.delete("/candidate", HasUndauntedMetagameAuth, (req: any, res) => {
    CancelMatchmaking(req.AuthData.userId);
    res.status(200);
    res.json({});
});

// A party member's game following the leader's hunt by candidate id
matchmakingRouter.post("/candidate/join/:candidateId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Entry = GetEntryForCandidate(UserId, req.params.candidateId);

    if(Entry === undefined){
        logger.info(`UserId ${UserId} asked to join candidate ${String(req.params.candidateId).slice(0, 64)}, which is not theirs`);
        res.status(404);
        res.send();
        return;
    }

    logger.info(`UserId ${UserId} follows candidate ${Entry.CandidateId} (${Entry.HuntId})`);

    res.status(200);
    res.json({
        candidateId: Entry.CandidateId,
        gameMode: "ISLAND",
        huntId: Entry.HuntId,
        status: "MATCHING",
        statusReason: null
    });
});

matchmakingRouter.get("/QoS", (req, res) => {
    logger.info(`QoS Ping`);

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})