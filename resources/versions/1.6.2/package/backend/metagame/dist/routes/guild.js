// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guildRouter = void 0;
const express_1 = require("express");
const logger_1 = require("../logger");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
exports.guildRouter = (0, express_1.Router)();
exports.guildRouter.get("/guild/invite/player", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Guild invites (stubbed)");
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            invites: []
        }
    });
});
exports.guildRouter.get("/guild", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    logger_1.logger.info("Current guild (stubbed)");
    res.status(204);
    res.send();
});
