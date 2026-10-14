// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const apikeys_1 = require("./controllers/apikeys");
const auth_1 = require("./controllers/auth");
const db_1 = require("./db");
const logger_1 = require("./logger");
const PORT = process.env.PORT;
(0, db_1.GetDb)(); // This runs migrations TODO make this more explicit
(0, apikeys_1.DrainAndRegisterAPIKeys)().then(async () => {
    await (0, auth_1.DrainAndRegisterUserAPIKeys)();
    // BIND_HOST: 127.0.0.1 normally (this PC only); the LAN test (LAN - HOST.bat) sets 0.0.0.0 so other PCs can connect.
    app_1.app.listen(Number(PORT), process.env.BIND_HOST || "127.0.0.1", (error) => {
        // Express 5 hands a failed listen (port in use or reserved) to this callback.
        if (error) { logger_1.logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
        logger_1.logger.info(`Undaunted Metagame on port ${PORT}`);
        logger_1.logger.info(`Clear Skies, Slayer.`);
    });
});
