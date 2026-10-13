// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const login_js_1 = require("./routes/login.js");
const logger_js_1 = require("./logger.js");
const eos_js_1 = require("./routes/eos.js");
const system_js_1 = require("./routes/system.js");
const character_js_1 = require("./routes/character.js");
const inventory_js_1 = require("./routes/inventory.js");
const store_js_1 = require("./routes/store.js");
const guild_js_1 = require("./routes/guild.js");
const tuning_js_1 = require("./routes/tuning.js");
const matchmaking_js_1 = require("./routes/matchmaking.js");
const party_js_1 = require("./routes/party.js");
const progression_js_1 = require("./routes/progression.js");
const loadout_js_1 = require("./routes/loadout.js");
const undauntedapi_js_1 = require("./routes/undauntedapi.js");
const playerjourney_js_1 = require("./routes/playerjourney.js");
const tuning162_js_1 = require("./routes/tuning162.js");
const factions_js_1 = require("./routes/factions.js");
exports.app = (0, express_1.default)();
exports.app.use(express_1.default.json({ limit: "50mb" }));
exports.app.use(express_1.default.urlencoded({ extended: true }));
exports.app.use((req, res, next) => {
    res.on("finish", () => logger_js_1.logger.info(`REQ ${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
});
exports.app.use("/", login_js_1.loginRouter);
exports.app.use("/", eos_js_1.eosRouter);
exports.app.use("/", system_js_1.systemRouter);
exports.app.use("/", character_js_1.characterRouter);
exports.app.use("/", inventory_js_1.inventoryRouter);
exports.app.use("/", store_js_1.storeRouter);
exports.app.use("/", guild_js_1.guildRouter);
exports.app.use("/", tuning_js_1.tuningRouter);
exports.app.use("/", matchmaking_js_1.matchmakingRouter);
exports.app.use("/", party_js_1.partyRouter);
exports.app.use("/", progression_js_1.progressionRouter);
exports.app.use("/", loadout_js_1.loadoutRouter);
exports.app.use("/", playerjourney_js_1.playerJourneyRouter);
exports.app.use("/", tuning162_js_1.tuning162Router);
exports.app.use("/", factions_js_1.factionsRouter);
exports.app.use("/undaunted/api", undauntedapi_js_1.undauntedApiRouter); // Everything that I/we add to help manage undaunted that doesn't belong to the game proper belongs here
exports.app.use((req, res) => {
    logger_js_1.logger.warn(`Unstubbed route ${req.method} ${req.path}`);
    res.status(404);
    res.send();
});
