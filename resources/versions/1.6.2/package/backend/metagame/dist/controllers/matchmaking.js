// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckAndUpdateQueueStatus = CheckAndUpdateQueueStatus;
exports.HandlePlayerMatchmaking = HandlePlayerMatchmaking;
const logger_1 = require("../logger");
const node_crypto_1 = __importDefault(require("node:crypto"));
const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";
let MatchmakingQueueMap = new Map(); // Key is HuntID
let MatchmakingResultMap = new Map(); // Key is PlayerID
function HuntIdRequiresMatchmaking(HuntId) {
    return !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
    //return HuntId.includes("CR19") || HuntId.includes("11A") || HuntId.includes("Story");
}
async function LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, ExpectedPlayers) {
    logger_1.logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);
    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;
    const MatchmakingResult = await fetch(URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            GameMode: GameMode,
            GameArgs: GameArgs,
            HuntId: HuntId,
            ExpectedPlayers: ExpectedPlayers
        })
    });
    if (MatchmakingResult.status === 200) {
        const MatchmakingData = await MatchmakingResult.json();
        logger_1.logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${MatchmakingData.port}`);
        return {
            succeeded: true,
            readyNow: true,
            host: MatchmakingData.host,
            port: MatchmakingData.port
        };
    }
    else {
        logger_1.logger.error(`DeployServer returned status ${MatchmakingResult.status}`);
        return {
            succeeded: false,
            readyNow: false,
            host: "",
            port: 0
        };
    }
}
async function PopQueue(HuntId) {
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);
    if (MatchmakingQueue.Resolved) {
        return;
    }
    MatchmakingQueue.Resolved = true;
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue.Players);
    for (const Player of MatchmakingQueue.Players) {
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);
        if (PlayerMatchmakingResultToUpdate != undefined) {
            PlayerMatchmakingResultToUpdate.Host = GameOnDeployServer.host;
            PlayerMatchmakingResultToUpdate.Port = GameOnDeployServer.port;
            PlayerMatchmakingResultToUpdate.Ready = true;
        }
    }
    MatchmakingQueueMap.delete(HuntId);
}
async function CheckAndUpdateQueueStatus(PlayerId) {
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);
    if (PlayerMatchmakingResult == undefined) {
        return undefined;
    }
    if (!PlayerMatchmakingResult.Ready) {
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);
        if ((new Date()).getTime() - MatchmakingQueue.LastPlayerAddedTime.getTime() > 20000) { // 20 sec
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }
    return PlayerMatchmakingResult;
}
// TODO: This can fail if the previous party is waiting for the deployserver, and a new party is joining in.
// Right now we handle this by failing all new players until the old party is cleared out
// This can be MUCH better in the future
async function QueuePlayer(HuntId, PlayerId) {
    if (MatchmakingQueueMap.get(HuntId) != undefined && !MatchmakingQueueMap.get(HuntId)?.Resolved) {
        const CurrentMMEntry = MatchmakingQueueMap.get(HuntId);
        CurrentMMEntry.Players.push(PlayerId);
        CurrentMMEntry.LastPlayerAddedTime = new Date();
        if (CurrentMMEntry.Players.length >= 4) {
            MatchmakingResultMap.set(PlayerId, {
                Ready: false,
                CandidateId: node_crypto_1.default.randomUUID(),
                HuntId: HuntId,
                Host: "",
                Port: 0
            });
            await PopQueue(HuntId);
            return true;
        }
    }
    else if (MatchmakingQueueMap.get(HuntId) != undefined) {
        return false;
    }
    else {
        MatchmakingQueueMap.set(HuntId, {
            Players: [PlayerId],
            LastPlayerAddedTime: new Date(),
            Resolved: false
        });
    }
    MatchmakingResultMap.set(PlayerId, {
        Ready: false,
        CandidateId: node_crypto_1.default.randomUUID(),
        HuntId: HuntId,
        Host: "",
        Port: 0
    });
    return true;
}
async function HandlePlayerMatchmaking(GameMode, GameArgs, HuntId, PlayerId) {
    if (MATCHMAKING_MODE === "DISABLED") {
        logger_1.logger.warn("Matchmaking is disabled, refusing MM!");
        return false;
    }
    else if (MATCHMAKING_MODE === "DEPLOYSERVER") {
        if (HuntId == undefined || HuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(HuntId)) {
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, undefined);
            MatchmakingResultMap.set(PlayerId, {
                Ready: true,
                CandidateId: node_crypto_1.default.randomUUID(),
                HuntId: HuntId,
                Host: GameOnDeployServer.host,
                Port: GameOnDeployServer.port
            });
            return true;
        }
        else {
            return await QueuePlayer(HuntId, PlayerId);
        }
    }
    else {
        logger_1.logger.fatal("Unsupported MATCHMAKING_MODE!");
        return false;
    }
}
