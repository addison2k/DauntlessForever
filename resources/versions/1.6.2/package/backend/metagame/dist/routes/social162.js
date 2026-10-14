// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socialRouter = void 0;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Lookup and friends reply shapes follow Dauntless Revived's findings (AGPL-3.0, docs/findings/social.md).
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
//
// Account lookups and friends: what the game needs to show another player (party invites, party
// members, friends) and to find a player by name (Add Friends). Mounted before the other routers.
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const logger_1 = require("../logger");
const social162_1 = require("../controllers/social162");
exports.socialRouter = (0, express_1.Router)();
const Player = (req) => typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
const PublicAccount = (Id, Name) => ({ id: Id, displayName: Name, externalAuths: {} });
// ---- lookups by name / id (Epic-style)
exports.socialRouter.get("/account/api/public/account/displayName/:displayName", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Found = await (0, social162_1.FindAccountByName)(req.params.displayName);
    logger_1.logger.info(`account by name by ${Player(req) ?? "?"}: ${Found ? Found.UserId : "not found"}`);
    if (!Found) {
        res.status(404);
        res.send();
        return;
    }
    res.json(PublicAccount(Found.UserId, Found.Username));
});
exports.socialRouter.get("/account/api/public/account/:AccId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Name = await (0, social162_1.FindUsername)(req.params.AccId);
    res.json(Name !== undefined ? PublicAccount(req.params.AccId, Name) : {});
});
// Several accounts at once (?accountId=A&accountId=B): an array of the ones that exist.
// Without ?accountId the caller's own account (handled by the eos router).
exports.socialRouter.get("/account/api/public/account", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res, next) => {
    if (req.query?.accountId === undefined)
        return next();
    const Asked = (Array.isArray(req.query.accountId) ? req.query.accountId : [req.query.accountId]).filter((Id) => typeof Id === "string").slice(0, 100);
    const Names = await (0, social162_1.FindUsernames)(Asked);
    res.json([...new Set(Asked)].filter((Id) => Names.has(Id)).map((Id) => PublicAccount(Id, Names.get(Id))));
});
// Epic ids -> Phoenix ids. Here they are the same id. Reply: {"accountMappings": {<id>: {accountId, accountType}}}
exports.socialRouter.post("/account/mapping", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Raw = Array.isArray(req.body?.ids) ? req.body.ids : Array.isArray(req.body) ? req.body : [];
    const Ids = [...new Set(Raw.filter((Id) => typeof Id === "string" && Id.length <= 128))].slice(0, 100);
    const Type = String(req.body?.srcAccountType ?? "epic").toLowerCase() === "phoenix" ? "epic" : "phoenix";
    const Known = await (0, social162_1.FindUsernames)(Ids);
    const Map = Object.fromEntries(Ids.filter((Id) => Known.has(Id)).map((Id) => [Id, { accountId: Id, accountType: Type }]));
    logger_1.logger.info(`account/mapping by ${Player(req) ?? "?"}: ${Object.keys(Map).length} of ${Ids.length} mapped`);
    res.status(200);
    res.json({ accountMappings: Map, code: "OK", message: "", payload: { accountMappings: Map } });
});
// ---- friends (read by the game at login)
exports.socialRouter.get("/friends/api/public/friends/:id", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me || Me !== req.params.id) {
        res.json([]);
        return;
    }
    const All = (0, social162_1.FriendList)(Me);
    const IncludePending = String(req.query?.includePending ?? "false") === "true";
    res.json(IncludePending ? All : All.filter((F) => F.status === "ACCEPTED"));
});
exports.socialRouter.get("/friends/api/public/blocklist/:id", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    res.json({ blockedUsers: Me && Me === req.params.id ? (0, social162_1.BlockList)(Me) : [] });
});
exports.socialRouter.post("/friends/api/public/friends/:me/:other", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Me = Player(req);
    if (!Me || Me !== req.params.me || !(0, social162_1.IsAccountId)(req.params.other)) {
        res.status(403);
        res.send();
        return;
    }
    res.status(await (0, social162_1.AddFriend)(Me, req.params.other));
    res.send();
});
exports.socialRouter.delete("/friends/api/public/friends/:me/:other", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me || Me !== req.params.me) {
        res.status(403);
        res.send();
        return;
    }
    (0, social162_1.RemoveFriend)(Me, req.params.other);
    res.status(204);
    res.send();
});
const BlockHandler = (req, res) => {
    const Me = Player(req);
    if (!Me || Me !== req.params.me || !(0, social162_1.IsAccountId)(req.params.other)) {
        res.status(403);
        res.send();
        return;
    }
    (0, social162_1.Block)(Me, req.params.other);
    logger_1.logger.info(`friends: ${Me} blocked ${req.params.other}`);
    res.status(204);
    res.send();
};
exports.socialRouter.post("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, BlockHandler);
exports.socialRouter.put("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, BlockHandler);
exports.socialRouter.delete("/friends/api/public/blocklist/:me/:other", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me || Me !== req.params.me) {
        res.status(403);
        res.send();
        return;
    }
    (0, social162_1.Unblock)(Me, req.params.other);
    res.status(204);
    res.send();
});
