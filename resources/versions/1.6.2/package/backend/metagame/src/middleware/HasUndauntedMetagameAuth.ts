// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { IsValidGameserverAPIKey } from "../controllers/apikeys";
import { JwtPayload } from "jsonwebtoken";

export async function HasUndauntedMetagameAuth(req: Request, res: Response, next: NextFunction){
    const AuthHeader = req.headers.authorization;

    const GameserverAuthHeader = req.headers["x-undaunted-gameserver-apikey"];

    if(GameserverAuthHeader !== undefined){
        const IsValid = await IsValidGameserverAPIKey(GameserverAuthHeader as string);

        if(IsValid){
            if(AuthHeader != undefined){ // Why this double-auth amalgam? Sometimes the client sends it's Bearer auth to the server, and the server makes reqs where the only userId identifying factor is that auth token. This fixes that up, so we have that context.
                const Token = AuthHeader.slice("bearer ".length);

                const Payload = ValidateMetagameJWTAndGetPayload(Token);

                (req as any).AuthData = {
                    IsGameserver: true,
                    ...(Payload as JwtPayload)
                };
            }
            else{
                (req as any).AuthData = {
                    IsGameserver: true,
                };
            }

            next();

            return;
        }
        else{
            res.status(401);
            res.send();
            logger.error(`Invalid Gameserver API Key Auth`);
            return;
        }
    }

    if(AuthHeader == undefined || (!AuthHeader?.startsWith("bearer ") && !AuthHeader?.startsWith("Bearer ") && !AuthHeader?.startsWith("BEARER "))){
        res.status(401);
        res.send();

        logger.error(`Unauthenticated ${req.method} to ${req.path} which needs Undaunted Metagame auth!`);

        return;
    }

    const Token = AuthHeader.slice("bearer ".length);

    try{
        const Payload = ValidateMetagameJWTAndGetPayload(Token);

        (req as any).AuthData = Payload;

        next();
    } catch {
        res.status(401);
        res.send();

        logger.warn("Request with bad Undaunted Metagame auth!");

        return;
    }
}
