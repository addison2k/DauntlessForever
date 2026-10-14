// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { GetDb } from "./db";
import { logger } from "./logger";
import { AttachChat } from "./realtime/chat";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT;

GetDb(); // This runs migrations TODO make this more explicit

DrainAndRegisterAPIKeys().then(async () => {
  await DrainAndRegisterUserAPIKeys();
  
  // BIND_HOST: 127.0.0.1 normally (this PC only); the LAN test (LAN - HOST.bat) sets 0.0.0.0 so other PCs can connect.
  const HttpServer = app.listen(Number(PORT), process.env.BIND_HOST || "127.0.0.1", (error?: any) => {
    // Express 5 hands a failed listen (port in use or reserved) to this callback; without this check the backend
    // logged "on port ..." and then quietly exited.
    if (error) { logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
    logger.info(`Undaunted Metagame on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });

  // In-game text chat (XMPP over WebSocket) on this same port, so it also works through the relay.
  // CHAT=0 turns it off. realtime/: from Dauntless Revived (AGPL-3.0).
  let Chat: any;
  try { Chat = AttachChat(HttpServer); } catch (e: any) { logger.error(`chat: not started (${e && e.message})`); }
  // Dauntless Forever (DF-ONLINE-1): the launcher leaves data\announce.txt (the host closing the game, say); it is said
  // in chat to everyone here, then deleted. A file, not an address: nothing new is reachable through the relay.
  const AnnounceFile = path.join(path.dirname(process.env.DB_FILENAME || "./undaunted.db"), "announce.txt");
  setInterval(() => {
    try {
      if (!fs.existsSync(AnnounceFile)) return;
      const Text = fs.readFileSync(AnnounceFile, "utf8").trim();
      fs.rmSync(AnnounceFile, { force: true });
      if (Text && Chat && Chat.muc && typeof Chat.muc.Announce === "function") Chat.muc.Announce(Text);
    } catch { /* next time */ }
  }, 2000).unref();
});