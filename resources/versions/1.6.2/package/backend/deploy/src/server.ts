import { app } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";

const PORT = process.env.PORT;

app.listen(Number(PORT), "127.0.0.1", () => {
  Startup();

  setInterval(RunWatchdog, 60 * 1000);

  logger.info(`Undaunted DeployServer on port ${PORT}`);
  logger.info(`Clear Skies, Slayer.`);
});