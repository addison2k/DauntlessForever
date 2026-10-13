// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { NextFunction, Request, Response } from "express";
import { GetUserInfoForApiKey, UserInfo } from "../controllers/undauntedapi";

export async function HasUndauntedUserApiKey(req: Request, res: Response, next: NextFunction){
    const ApiKey = req.headers["x-undaunted-user-api-key"] as string | undefined;

    if(ApiKey == undefined){
        res.status(401);
        res.send();
        return;
    };

    const UserInfo: UserInfo | undefined = await GetUserInfoForApiKey(ApiKey);

    if(UserInfo == undefined){
        res.status(401);
        res.send();
        return;
    };

    (req as any).UndauntedUserInfo = UserInfo;

    next();

    return;
}