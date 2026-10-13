// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunWatchdog = RunWatchdog;
const node_process_1 = require("node:process");
const logger_1 = require("../logger");
const gameservers_1 = require("./gameservers");
/**
 * TODO:
 * This watchdog is SUPER basic rn, only releases resources, the server itself handles cleaning itself up
 */
function IsGameserverStillAlive(GameserverToCheck) {
    if (!GameserverToCheck.processId) { return false; } // never started (spawn error)
    try {
        (0, node_process_1.kill)(GameserverToCheck.processId, 0);
        return true;
    }
    catch (err) {
        return false;
    }
}
async function RunWatchdog() {
    logger_1.logger.info(`Running Gameserver Watchdog!`);
    for (const Gameserver of gameservers_1.Gameservers) {
        if (!IsGameserverStillAlive(Gameserver)) {
            console.log(`Cleaning up Gameserver on port ${Gameserver.port}`);
            (0, gameservers_1.CleanupServer)(Gameserver);
        }
    }
}
