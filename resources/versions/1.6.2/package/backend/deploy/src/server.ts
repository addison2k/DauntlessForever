// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { app } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";

const PORT = process.env.PORT;

app.listen(Number(PORT), "127.0.0.1", (error?: any) => {
  // Express 5 hands a failed listen to this callback; without this check the deploy server started game servers anyway.
  if (error) { logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
  Startup();

  setInterval(RunWatchdog, 60 * 1000);

  logger.info(`Undaunted DeployServer on port ${PORT}`);
  logger.info(`Clear Skies, Slayer.`);
});