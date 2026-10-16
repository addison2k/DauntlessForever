// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { travelRouter } from "./routes/travel162";
import express from "express";
import { loginRouter } from "./routes/login.js";
import { logger } from "./logger.js";
import { eosRouter } from "./routes/eos.js";
import { systemRouter } from "./routes/system.js";
import { characterRouter } from "./routes/character.js";
import { inventoryRouter } from "./routes/inventory.js";
import { storeRouter } from "./routes/store.js";
import { guildRouter } from "./routes/guild.js";
import { tuningRouter } from "./routes/tuning.js";
import { matchmakingRouter } from "./routes/matchmaking.js";
import { partyRouter } from "./routes/party.js";
import { progressionRouter } from "./routes/progression.js";
import { loadoutRouter } from "./routes/loadout.js";
import { undauntedApiRouter } from "./routes/undauntedapi.js";
import { playerJourneyRouter } from "./routes/playerjourney.js";
import { tuning162Router } from "./routes/tuning162.js";
import { factionsRouter } from "./routes/factions.js";
import { socialRouter } from "./routes/social162.js";

export const app = express();

app.use(express.json({ limit: "50mb" }));

app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.on("finish", () => logger.info(`REQ ${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
});

app.use("/", travelRouter); // your character travels with you to a friend's game
app.use("/", require("./daily-gift").router); // Daily Ramsgate Gift (daily-gift.js, by KombatKing)
app.use("/", socialRouter); // before eosRouter: account lookups for other players, friends
app.use("/", loginRouter);
app.use("/", eosRouter);
app.use("/", systemRouter);
app.use("/", characterRouter);
app.use("/", inventoryRouter);
app.use("/", storeRouter);
app.use("/", guildRouter);
app.use("/", tuningRouter);
app.use("/", matchmakingRouter);
app.use("/", partyRouter);
app.use("/", progressionRouter);
app.use("/", loadoutRouter);
app.use("/", playerJourneyRouter);
app.use("/", tuning162Router);
app.use("/", factionsRouter);
app.use("/undaunted/api", undauntedApiRouter); // Everything that I/we add to help manage undaunted that doesn't belong to the game proper belongs here

app.use((req, res) => {
    logger.warn(`Unstubbed route ${req.method} ${req.path}`)

    res.status(404);
    res.send();
});