// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { logger } from "../logger";
import { GetRamsgateConnectionDetails, GetTrainingDojoConnectionDetails, StartupGameserverWithArgs, StartupGameserverWithHuntIdAndPlayers } from "./gameservers";

export async function HandleMatchmakingRequest(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
    logger.info(`Handling matchmaking with GameMode: ${GameMode} HuntId: ${HuntId} and GameArgs: ${GameArgs} and ExpectedPlayers ${ExpectedPlayers}`);

    if(GameMode === "CITY"){
        return GetRamsgateConnectionDetails();
    }
    else if(GameMode === "SHARED"){
        if (HuntId != undefined && HuntId.trim().length > 0){
            if(HuntId == "ShatteredIsles_TrainingDojo"){
                return GetTrainingDojoConnectionDetails();
            }
        }
    }
    else if(GameMode === "ISLAND"){
        if(GameArgs != undefined && GameArgs.trim().length > 0){
            return await StartupGameserverWithArgs(GameArgs);
        }

        if(HuntId != undefined && HuntId.trim().length > 0 && ExpectedPlayers != undefined){
            return await StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers!);
        }
    }

    logger.error("Matchmaking failed, sending you to Ramsgate!");

    return GetRamsgateConnectionDetails();
}