// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { GetDb } from "./db";
import { logger } from "./logger";

const PORT = process.env.PORT;

GetDb(); // This runs migrations TODO make this more explicit

DrainAndRegisterAPIKeys().then(async () => {
  await DrainAndRegisterUserAPIKeys();
  
  // BIND_HOST: 127.0.0.1 normally (this PC only); the LAN test (LAN - HOST.bat) sets 0.0.0.0 so other PCs can connect.
  app.listen(Number(PORT), process.env.BIND_HOST || "127.0.0.1", (error?: any) => {
    // Express 5 hands a failed listen (port in use or reserved) to this callback; without this check the backend
    // logged "on port ..." and then quietly exited.
    if (error) { logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
    logger.info(`Undaunted Metagame on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });
});