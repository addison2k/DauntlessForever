// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HandleMatchmakingRequest = HandleMatchmakingRequest;
const logger_1 = require("../logger");
const gameservers_1 = require("./gameservers");
async function HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers) {
    logger_1.logger.info(`Handling matchmaking with GameMode: ${GameMode} HuntId: ${HuntId} and GameArgs: ${GameArgs} and ExpectedPlayers ${ExpectedPlayers}`);
    if (GameMode === "CITY") {
        return (0, gameservers_1.GetRamsgateConnectionDetails)();
    }
    else if (GameMode === "SHARED") {
        if (HuntId != undefined && HuntId.trim().length > 0) {
            if (HuntId == "ShatteredIsles_TrainingDojo") {
                return (0, gameservers_1.GetTrainingDojoConnectionDetails)();
            }
        }
    }
    else if (GameMode === "ISLAND") {
        if (GameArgs != undefined && GameArgs.trim().length > 0) {
            return await (0, gameservers_1.StartupGameserverWithArgs)(GameArgs);
        }
        if (HuntId != undefined && HuntId.trim().length > 0 && ExpectedPlayers != undefined) {
            return await (0, gameservers_1.StartupGameserverWithHuntIdAndPlayers)(HuntId, ExpectedPlayers);
        }
    }
    logger_1.logger.error("Matchmaking failed, sending you to Ramsgate!");
    return (0, gameservers_1.GetRamsgateConnectionDetails)();
}
