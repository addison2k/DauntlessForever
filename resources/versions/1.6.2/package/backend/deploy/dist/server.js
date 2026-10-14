// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const gameservers_1 = require("./controllers/gameservers");
const watchdog_1 = require("./controllers/watchdog");
const logger_1 = require("./logger");
const PORT = process.env.PORT;
app_1.app.listen(Number(PORT), "127.0.0.1", (error) => {
    // Express 5 hands a failed listen to this callback.
    if (error) { logger_1.logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
    (0, gameservers_1.Startup)();
    setInterval(watchdog_1.RunWatchdog, 60 * 1000);
    logger_1.logger.info(`Undaunted DeployServer on port ${PORT}`);
    logger_1.logger.info(`Clear Skies, Slayer.`);
});
