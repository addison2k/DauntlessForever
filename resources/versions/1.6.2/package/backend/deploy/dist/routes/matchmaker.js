// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchmakingRouter = void 0;
const express_1 = require("express");
const matchmaker_1 = require("../controllers/matchmaker");
const express_2 = __importDefault(require("express"));
exports.matchmakingRouter = (0, express_1.Router)();
exports.matchmakingRouter.post("/handle-matchmaking-for-player", express_2.default.json(), async (req, res) => {
    const GameMode = req.body.GameMode;
    const GameArgs = req.body.GameArgs;
    const HuntId = req.body.HuntId;
    const ExpectedPlayers = req.body.ExpectedPlayers;
    const MatchmakingResult = await (0, matchmaker_1.HandleMatchmakingRequest)(GameMode, GameArgs, HuntId, ExpectedPlayers);
    res.status(200);
    res.json(MatchmakingResult);
});
