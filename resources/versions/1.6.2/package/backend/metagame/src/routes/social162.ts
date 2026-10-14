// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Lookup and friends reply shapes follow Dauntless Revived's findings (AGPL-3.0, docs/findings/social.md).
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// Account lookups and friends: what the game needs to show another player (party invites, party
// members, friends) and to find a player by name (Add Friends). Mounted before the other routers.
import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import {
    AddFriend, Block, BlockList, FindAccountByName, FindUsername, FindUsernames, FriendList, IsAccountId, RemoveFriend, Unblock
} from "../controllers/social162";

export const socialRouter = Router();

const Player = (req: any): string | undefined => typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
const PublicAccount = (Id: string, Name: string) => ({ id: Id, displayName: Name, externalAuths: {} });

// ---- lookups by name / id (Epic-style)
socialRouter.get("/account/api/public/account/displayName/:displayName", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Found = await FindAccountByName(req.params.displayName);
    logger.info(`account by name by ${Player(req) ?? "?"}: ${Found ? Found.UserId : "not found"}`);
    if(!Found){ res.status(404); res.send(); return; }
    res.json(PublicAccount(Found.UserId, Found.Username));
});

socialRouter.get("/account/api/public/account/:AccId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Name = await FindUsername(req.params.AccId);
    res.json(Name !== undefined ? PublicAccount(req.params.AccId, Name) : {});
});

// Several accounts at once (?accountId=A&accountId=B): an array of the ones that exist.
// Without ?accountId the caller's own account (handled by the eos router).
socialRouter.get("/account/api/public/account", HasUndauntedMetagameAuth, async (req: any, res, next) => {
    if(req.query?.accountId === undefined) return next();
    const Asked: string[] = (Array.isArray(req.query.accountId) ? req.query.accountId : [req.query.accountId]).filter((Id: unknown) => typeof Id === "string").slice(0, 100);
    const Names = await FindUsernames(Asked);
    res.json([...new Set(Asked)].filter((Id) => Names.has(Id)).map((Id) => PublicAccount(Id, Names.get(Id)!)));
});

// Epic ids -> Phoenix ids. Here they are the same id. Reply: {"accountMappings": {<id>: {accountId, accountType}}}
socialRouter.post("/account/mapping", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Raw: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : Array.isArray(req.body) ? req.body : [];
    const Ids = [...new Set(Raw.filter((Id): Id is string => typeof Id === "string" && Id.length <= 128))].slice(0, 100);
    const Type = String(req.body?.srcAccountType ?? "epic").toLowerCase() === "phoenix" ? "epic" : "phoenix";
    const Known = await FindUsernames(Ids);
    const Map = Object.fromEntries(Ids.filter((Id) => Known.has(Id)).map((Id) => [Id, { accountId: Id, accountType: Type }]));
    logger.info(`account/mapping by ${Player(req) ?? "?"}: ${Object.keys(Map).length} of ${Ids.length} mapped`);
    res.status(200);
    res.json({ accountMappings: Map, code: "OK", message: "", payload: { accountMappings: Map } });
});

// ---- friends (read by the game at login)
socialRouter.get("/friends/api/public/friends/:id", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req);
    if(!Me || Me !== req.params.id){ res.json([]); return; }
    const All = FriendList(Me);
    const IncludePending = String(req.query?.includePending ?? "false") === "true";
    res.json(IncludePending ? All : All.filter((F) => F.status === "ACCEPTED"));
});

socialRouter.get("/friends/api/public/blocklist/:id", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req);
    res.json({ blockedUsers: Me && Me === req.params.id ? BlockList(Me) : [] });
});

socialRouter.post("/friends/api/public/friends/:me/:other", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Me = Player(req);
    if(!Me || Me !== req.params.me || !IsAccountId(req.params.other)){ res.status(403); res.send(); return; }
    res.status(await AddFriend(Me, req.params.other));
    res.send();
});

socialRouter.delete("/friends/api/public/friends/:me/:other", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req);
    if(!Me || Me !== req.params.me){ res.status(403); res.send(); return; }
    RemoveFriend(Me, req.params.other);
    res.status(204); res.send();
});

const BlockHandler = (req: any, res: any) => {
    const Me = Player(req);
    if(!Me || Me !== req.params.me || !IsAccountId(req.params.other)){ res.status(403); res.send(); return; }
    Block(Me, req.params.other);
    logger.info(`friends: ${Me} blocked ${req.params.other}`);
    res.status(204); res.send();
};
socialRouter.post("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth, BlockHandler);
socialRouter.put("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth, BlockHandler);
socialRouter.delete("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req);
    if(!Me || Me !== req.params.me){ res.status(403); res.send(); return; }
    Unblock(Me, req.params.other);
    res.status(204); res.send();
});
