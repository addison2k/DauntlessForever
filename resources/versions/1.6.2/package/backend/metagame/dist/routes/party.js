// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.partyRouter = void 0;
// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Party routes follow Dauntless Revived's findings (AGPL-3.0). Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice.
const express_1 = require("express");
const HasUndauntedMetagameAuth_1 = require("../middleware/HasUndauntedMetagameAuth");
const social162_1 = require("../controllers/social162");
// Every route acts as the bearer token's own account; ids in the URL or body only name the other player or the party.
exports.partyRouter = (0, express_1.Router)();
function Send(res, R) { res.status(R.Status); res.json(R.Body); }
const Player = (req) => typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
// The game's poll, about every 10 s: the caller's party (a party of one if none)
exports.partyRouter.post("/party", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(200);
        res.json({});
        return;
    }
    res.status(200);
    res.json(await (0, social162_1.PollParty)(Me));
});
exports.partyRouter.get("/party/invites", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    res.status(200);
    res.json(Me ? (0, social162_1.ListInvites)(Me) : { invitations: [] });
});
// {recipientPlayerId, partyId, buildId, featureOverrides}
exports.partyRouter.put("/party/invite", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, await (0, social162_1.InviteToParty)(Me, req.body?.recipientPlayerId));
});
exports.partyRouter.put("/party/invite/accept/:id", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, await (0, social162_1.AcceptInvite)(Me, req.params.id));
});
exports.partyRouter.delete("/party/invite", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, (0, social162_1.DeclineInvites)(Me, req.body));
});
// No body: the caller leaves their party (the game also sends this at login and character select)
exports.partyRouter.delete("/party/member", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(200);
        res.json({});
        return;
    }
    Send(res, (0, social162_1.LeaveParty)(Me));
});
exports.partyRouter.delete("/party/member/:memberId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, (0, social162_1.KickMember)(Me, req.params.memberId));
});
exports.partyRouter.put("/party/member/promote/:memberId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, (0, social162_1.PromoteMember)(Me, req.params.memberId));
});
exports.partyRouter.delete("/party/leader/:leaderId", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, (0, social162_1.EvictLeader)(Me, req.params.leaderId));
});
// {playerIds: [...]} -> {parties, invitations}
exports.partyRouter.post("/party/status", HasUndauntedMetagameAuth_1.HasUndauntedMetagameAuth, async (req, res) => {
    const Me = Player(req);
    if (!Me) {
        res.status(401);
        res.send();
        return;
    }
    Send(res, await (0, social162_1.PartiesOf)(Me, req.body?.playerIds));
});
