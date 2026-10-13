// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import express from "express";
import { matchmakingRouter } from "./routes/matchmaker.js";
import { logger } from "./logger.js";

export const app = express();

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use("/api/matchmaker", matchmakingRouter);