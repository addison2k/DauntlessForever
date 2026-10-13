// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HasUndauntedUserApiKey = HasUndauntedUserApiKey;
const undauntedapi_1 = require("../controllers/undauntedapi");
async function HasUndauntedUserApiKey(req, res, next) {
    const ApiKey = req.headers["x-undaunted-user-api-key"];
    if (ApiKey == undefined) {
        res.status(401);
        res.send();
        return;
    }
    ;
    const UserInfo = await (0, undauntedapi_1.GetUserInfoForApiKey)(ApiKey);
    if (UserInfo == undefined) {
        res.status(401);
        res.send();
        return;
    }
    ;
    req.UndauntedUserInfo = UserInfo;
    next();
    return;
}
