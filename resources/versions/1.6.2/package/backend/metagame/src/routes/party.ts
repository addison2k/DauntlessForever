// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Party routes follow Dauntless Revived's findings (AGPL-3.0). Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice.
import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import {
    AcceptInvite, DeclineInvites, EvictLeader, InviteToParty, KickMember, LeaveParty, ListInvites, PartiesOf, PartyResult, PollParty, PromoteMember
} from "../controllers/social162";

// Every route acts as the bearer token's own account; ids in the URL or body only name the other player or the party.
export const partyRouter = Router();

function Send(res: any, R: PartyResult){ res.status(R.Status); res.json(R.Body); }
const Player = (req: any): string | undefined => typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;

// The game's poll, about every 10 s: the caller's party (a party of one if none)
partyRouter.post("/party", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Me = Player(req);
    if(!Me){ res.status(200); res.json({}); return; }
    res.status(200);
    res.json(await PollParty(Me));
});

partyRouter.get("/party/invites", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req);
    res.status(200);
    res.json(Me ? ListInvites(Me) : { invitations: [] });
});

// {recipientPlayerId, partyId, buildId, featureOverrides}
partyRouter.put("/party/invite", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, await InviteToParty(Me, req.body?.recipientPlayerId));
});

partyRouter.put("/party/invite/accept/:id", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, await AcceptInvite(Me, req.params.id));
});

partyRouter.delete("/party/invite", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, DeclineInvites(Me, req.body));
});

// No body: the caller leaves their party (the game also sends this at login and character select)
partyRouter.delete("/party/member", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(200); res.json({}); return; }
    Send(res, LeaveParty(Me));
});

partyRouter.delete("/party/member/:memberId", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, KickMember(Me, req.params.memberId));
});

partyRouter.put("/party/member/promote/:memberId", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, PromoteMember(Me, req.params.memberId));
});

partyRouter.delete("/party/leader/:leaderId", HasUndauntedMetagameAuth, (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, EvictLeader(Me, req.params.leaderId));
});

// {playerIds: [...]} -> {parties, invitations}
partyRouter.post("/party/status", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Me = Player(req); if(!Me){ res.status(401); res.send(); return; }
    Send(res, await PartiesOf(Me, req.body?.playerIds));
});
