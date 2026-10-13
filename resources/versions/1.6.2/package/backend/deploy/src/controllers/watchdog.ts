// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { kill } from "node:process";
import { logger } from "../logger";
import { Gameserver, Gameservers, CleanupServer } from "./gameservers";

/**
 * TODO:
 * This watchdog is SUPER basic rn, only releases resources, the server itself handles cleaning itself up
 */

function IsGameserverStillAlive(GameserverToCheck: Gameserver){
    if (!GameserverToCheck.processId) { return false; } // never started (spawn error)
    try{
        kill(GameserverToCheck.processId, 0);

        return true;
    } catch(err) {
        return false;
    }
}

export async function RunWatchdog(){
    logger.info(`Running Gameserver Watchdog!`);

    for(const Gameserver of Gameservers){
        if(!IsGameserverStillAlive(Gameserver)){
            console.log(`Cleaning up Gameserver on port ${Gameserver.port}`);

            CleanupServer(Gameserver);
        }
    }
}