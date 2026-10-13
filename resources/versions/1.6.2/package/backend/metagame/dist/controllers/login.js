// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetUsernameForUserId = GetUsernameForUserId;
const drizzle_orm_1 = require("drizzle-orm");
const db_1 = require("../db");
const schema_1 = require("../db/schema");
async function GetUsernameForUserId(userId) {
    let UserFromDb = await (0, db_1.GetDb)().query.users.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.users.userId, userId) });
    return UserFromDb.name;
}
