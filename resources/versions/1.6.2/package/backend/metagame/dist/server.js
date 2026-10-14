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
    const HttpServer = app_1.app.listen(Number(PORT), process.env.BIND_HOST || "127.0.0.1", (error) => {
        // Express 5 hands a failed listen (port in use or reserved) to this callback.
        if (error) { logger_1.logger.error(`Could not open port ${PORT}: ${error.code || error.message}. Another program (often another Dauntless server) is using it.`); process.exit(1); }
        logger_1.logger.info(`Undaunted Metagame on port ${PORT}`);
        logger_1.logger.info(`Clear Skies, Slayer.`);
    });
    // In-game text chat (XMPP over WebSocket) on this same port, so it also works through the relay.
    // CHAT=0 turns it off. realtime/: from Dauntless Revived (AGPL-3.0).
    let Chat;
    try { Chat = require("./realtime/chat").AttachChat(HttpServer); } catch (e) { logger_1.logger.error(`chat: not started (${e && e.message})`); }
    // Dauntless Forever (DF-ONLINE-1): the launcher leaves data\announce.txt (the host closing the game, say); it is said
    // in chat to everyone here, then deleted. A file, not an address: nothing new is reachable through the relay.
    const AnnounceFile = require("node:path").join(require("node:path").dirname(process.env.DB_FILENAME || "./undaunted.db"), "announce.txt");
    setInterval(() => {
        try {
            const fs = require("node:fs");
            if (!fs.existsSync(AnnounceFile)) return;
            const Text = fs.readFileSync(AnnounceFile, "utf8").trim();
            fs.rmSync(AnnounceFile, { force: true });
            if (Text && Chat && Chat.muc && typeof Chat.muc.Announce === "function") Chat.muc.Announce(Text);
        } catch (e) { /* next time */ }
    }, 2000).unref();
});
