// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { logger } from "../logger";
import crypto from "node:crypto";
import { ClearCandidate, LAST_CANDIDATE_REJOIN_MS, MarkCandidateReady, PartyForMatchmaking, SetCandidate } from "./social162";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";
// How long to wait for the deploy server to start a game server before giving up (DEPLOY_TIMEOUT_SECONDS, default 120).
// Before this, a deploy server that never answered left the player in MATCHING forever, and a failed start sent the
// player to an empty address. Now the hunt start is cancelled and the player can try again.
const DEPLOY_TIMEOUT_MS = Math.max(10, Number(process.env.DEPLOY_TIMEOUT_SECONDS ?? 120) || 120) * 1000;
const FAILED_LAUNCH = { succeeded: false, readyNow: false, host: "", port: 0, serverId: "" };

type MatchmakingQueueData = {
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean
};

type MatchmakingResult = {
    Ready: boolean,
    PartyCandidate?: boolean,   // the whole party's server (no per-hunt queue behind it)
    HuntId: string,
    CandidateId: string,
    Host: string,
    Port: number
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingResultMap: Map<string, MatchmakingResult> = new Map<string, MatchmakingResult>(); // Key is PlayerID

// ------------------------------------------------------------------ hunts that are open to join (DF-ONLINE-1)
// Dauntless Forever: a host who opens the game to everyone ("Play online" / "Allow randoms") starts the backend with
// HUNT_JOIN_WINDOW_SEC (180). For that long after a hunt starts, anyone here who queues the same hunt goes into it
// (up to HUNT_PLAYER_LIMIT players) instead of getting a hunt of their own: that is how strangers hunt together.
// Not set (friends-only hosting, solo play): nothing changes.
const HUNT_JOIN_WINDOW_MS = Math.max(0, Number(process.env.HUNT_JOIN_WINDOW_SEC) || 0) * 1000;
const HUNT_PLAYER_LIMIT = Math.min(8, Math.max(1, Number(process.env.HUNT_PLAYER_LIMIT) || 4));
const DEPLOYSERVER_ALIVE_PATH = "/api/matchmaker/alive/";
type OpenHunt = { HuntId: string, Host: string, Port: number, ServerId: string, Players: string[], OpenedAt: number };
let OpenHunts: OpenHunt[] = [];

function NoteOpenHunt(HuntId: string, Game: { succeeded: boolean, host: string, port: number, serverId?: string }, Players: string[]){
    if(HUNT_JOIN_WINDOW_MS === 0 || !Game.succeeded || !Game.serverId) return;
    const Now = Date.now();
    OpenHunts = OpenHunts.filter((H) => Now - H.OpenedAt < HUNT_JOIN_WINDOW_MS && !(H.Host === Game.host && H.Port === Game.port));
    OpenHunts.push({ HuntId, Host: Game.host, Port: Game.port, ServerId: Game.serverId, Players: [...Players], OpenedAt: Now });
}

async function ServerStillUp(ServerId: string){
    try {
        const Answer = await fetch("http://" + DEPLOYSERVER_URL + DEPLOYSERVER_ALIVE_PATH + encodeURIComponent(ServerId));
        if(Answer.status !== 200) return false;
        const Data: any = await Answer.json();
        return Data.alive === true;
    } catch { return false; }
}

async function JoinOpenHunt(HuntId: string, PlayerId: string){
    if(HUNT_JOIN_WINDOW_MS === 0) return false;
    const Now = Date.now();
    OpenHunts = OpenHunts.filter((H) => Now - H.OpenedAt < HUNT_JOIN_WINDOW_MS);
    for(const H of OpenHunts){
        if(H.HuntId !== HuntId || H.Players.includes(PlayerId) || H.Players.length >= HUNT_PLAYER_LIMIT) continue;
        if(!(await ServerStillUp(H.ServerId))){ H.OpenedAt = 0; continue; }
        H.Players.push(PlayerId);
        MatchmakingResultMap.set(PlayerId, { Ready: true, CandidateId: crypto.randomUUID(), HuntId: HuntId, Host: H.Host, Port: H.Port });
        logger.info(`mm: ${PlayerId} joins the open ${HuntId} at ${H.Host}:${H.Port} (${H.Players.length}/${HUNT_PLAYER_LIMIT}, started ${Math.round((Now - H.OpenedAt) / 1000)} s ago)`);
        return true;
    }
    return false;
}

function HuntIdRequiresMatchmaking(HuntId: string){
    return !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
    //return HuntId.includes("CR19") || HuntId.includes("11A") || HuntId.includes("Story");
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined){
    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;

    try{
        const MatchmakingResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                GameMode: GameMode,
                GameArgs: GameArgs,
                HuntId: HuntId,
                ExpectedPlayers: ExpectedPlayers!
            }),
            signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS)
        });

        if(MatchmakingResult.status !== 200){
            logger.error(`DeployServer returned status ${MatchmakingResult.status} for ${HuntId}; start cancelled`);
            return FAILED_LAUNCH;
        }

        const MatchmakingData = await MatchmakingResult.json();
        const Port = Number(MatchmakingData?.port);

        if(typeof MatchmakingData?.host !== "string" || MatchmakingData.host.trim().length === 0 || !Number.isInteger(Port) || Port < 1 || Port > 65535){
            logger.error(`DeployServer returned no usable address for ${HuntId} (${JSON.stringify(MatchmakingData).slice(0, 200)}); start cancelled`);
            return FAILED_LAUNCH;
        }

        logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${Port}`);

        return {
            succeeded: true,
            readyNow: true,
            host: MatchmakingData.host as string,
            port: Port,
            serverId: typeof MatchmakingData.id === "string" ? MatchmakingData.id : ""
        }
    }
    catch(error: any){
        const Why = error?.name === "TimeoutError" ? `no answer within ${DEPLOY_TIMEOUT_MS / 1000} s` : (error?.message ?? String(error));
        logger.error(`DeployServer request for ${HuntId} failed (${Why}); start cancelled, the player can try again`);
        return FAILED_LAUNCH;
    }
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue!.Resolved){
        return;
    }

    MatchmakingQueue!.Resolved = true;
    
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue!.Players);
    NoteOpenHunt(HuntId, GameOnDeployServer, MatchmakingQueue!.Players);

    if(!GameOnDeployServer.succeeded){
        // Forget this start for everyone in it, so their next status poll ends the search and they can retry
        for(const Player of MatchmakingQueue!.Players){
            if(MatchmakingResultMap.get(Player)?.HuntId === HuntId) MatchmakingResultMap.delete(Player);
        }
        MatchmakingQueueMap.delete(HuntId);
        return;
    }

    for(const Player of MatchmakingQueue!.Players){
        const PlayerMatchmakingResultToUpdate = MatchmakingResultMap.get(Player);

        if(PlayerMatchmakingResultToUpdate != undefined && PlayerMatchmakingResultToUpdate.HuntId === HuntId){
            PlayerMatchmakingResultToUpdate.Host = GameOnDeployServer.host;
            PlayerMatchmakingResultToUpdate.Port = GameOnDeployServer.port;
            PlayerMatchmakingResultToUpdate.Ready = true;
        }
    }

    MatchmakingQueueMap.delete(HuntId);
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const PlayerMatchmakingResult = MatchmakingResultMap.get(PlayerId);

    if(PlayerMatchmakingResult == undefined){
        return undefined;
    }

    if(!PlayerMatchmakingResult.Ready && !PlayerMatchmakingResult.PartyCandidate){
        const MatchmakingQueue = MatchmakingQueueMap.get(PlayerMatchmakingResult.HuntId);

        if(MatchmakingQueue !== undefined && (new Date()).getTime() - MatchmakingQueue.LastPlayerAddedTime.getTime() > 20000){ // 20 sec
            await PopQueue(PlayerMatchmakingResult.HuntId);
        }
    }

    return MatchmakingResultMap.get(PlayerId);   // gone if the start failed
}

// TODO: This can fail if the previous party is waiting for the deployserver, and a new party is joining in.
// Right now we handle this by failing all new players until the old party is cleared out
// This can be MUCH better in the future
async function QueuePlayer(HuntId: string, PlayerId: string){
    if(MatchmakingQueueMap.get(HuntId) != undefined && !MatchmakingQueueMap.get(HuntId)?.Resolved){
        const CurrentMMEntry = MatchmakingQueueMap.get(HuntId);

        CurrentMMEntry!.Players.push(PlayerId);
        CurrentMMEntry!.LastPlayerAddedTime = new Date();

        if(CurrentMMEntry!.Players.length >= 4){
            MatchmakingResultMap.set(PlayerId, {
                Ready: false,
                CandidateId: crypto.randomUUID(),
                HuntId: HuntId,
                Host: "",
                Port: 0
            });

            await PopQueue(HuntId);

            return MatchmakingResultMap.has(PlayerId);
        }
    }
    else if(MatchmakingQueueMap.get(HuntId) != undefined){
        return await JoinOpenHunt(HuntId, PlayerId);
    }
    else{
        if(await JoinOpenHunt(HuntId, PlayerId)){
            return true;
        }
        MatchmakingQueueMap.set(HuntId, {
            Players: [PlayerId],
            LastPlayerAddedTime: new Date(),
            Resolved: false
        });
    }

    MatchmakingResultMap.set(PlayerId, {
        Ready: false,
        CandidateId: crypto.randomUUID(),
        HuntId: HuntId,
        Host: "",
        Port: 0
    });

    return true;
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return false;
    }
    else if(MATCHMAKING_MODE === "DEPLOYSERVER"){
        const PartyHandled = await HandlePartyMatchmaking(GameMode, GameArgs, HuntId, PlayerId);

        if(PartyHandled !== "solo"){
            return PartyHandled;
        }

        if(HuntId == undefined || HuntId.trim().length == 0 || !HuntIdRequiresMatchmaking(HuntId)){
            const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, GameArgs, HuntId, undefined);

            if(!GameOnDeployServer.succeeded){
                MatchmakingResultMap.delete(PlayerId);
                return false;
            }

            MatchmakingResultMap.set(PlayerId, {
                Ready: true,
                CandidateId: crypto.randomUUID(),
                HuntId: HuntId,
                Host: GameOnDeployServer.host,
                Port: GameOnDeployServer.port
            });

            return true;
        }
        else{
            return await QueuePlayer(HuntId, PlayerId);
        }
    }
    else{
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return false;
    }
}

// ------------------------------------------------------------------ parties
// The party leader starts a hunt: the whole party gets one game server ("candidate"). The members' games
// see the candidate in their party poll (routes/party.ts) and follow it with /candidate/status or with their
// own /candidate/join for the same hunt, which is answered from the candidate (no second server).
// Returning to Ramsgate, the tutorial and anything else stays per player ("solo").
function ForgetFromSoloQueues(PlayerId: string){
    for(const [Hunt, Queue] of MatchmakingQueueMap){
        if(!Queue.Resolved && Queue.Players.includes(PlayerId)){
            Queue.Players = Queue.Players.filter((P) => P !== PlayerId);
            if(Queue.Players.length === 0) MatchmakingQueueMap.delete(Hunt);
        }
    }
}

async function HandlePartyMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string): Promise<"solo" | boolean> {
    const TheParty = PartyForMatchmaking(PlayerId);

    if(TheParty === undefined){
        return "solo";
    }

    const Mode = typeof GameMode === "string" ? GameMode : "";
    const Hunt = typeof HuntId === "string" ? HuntId : "";

    // 1.6.2: the Shattered Isles hunting grounds are GameMode SHARED (ShatteredIsles_IslandA ...), single hunts ISLAND,
    // Ramsgate CITY. The tutorial (ISLAND with game args) and the Dojo stay per player.
    const IsLeader = TheParty.LeaderId === PlayerId;
    const IsHunt = (Mode === "ISLAND" || Mode === "SHARED") && !(typeof GameArgs === "string" && GameArgs.trim().length > 0)
        && Hunt.trim().length > 0 && HuntIdRequiresMatchmaking(Hunt);
    const IsCity = Mode === "CITY";

    if(!IsHunt && !IsCity){
        return "solo";
    }

    // Following the party's hunt that is starting or running: answered from it, nothing new started
    for(const C of [TheParty.Candidate, TheParty.LastCandidate]){
        if(C === null || C.HuntId !== Hunt || !C.MemberIds.includes(PlayerId)) continue;
        if(Date.now() - (C.ReadyAt ?? C.CreatedAt) >= LAST_CANDIDATE_REJOIN_MS) continue;
        if(IsLeader && C !== TheParty.Candidate) continue;   // the leader starting the same hunt again later gets a new server

        ForgetFromSoloQueues(PlayerId);
        MatchmakingResultMap.set(PlayerId, {
            Ready: C.State === "IN_PROGRESS",
            PartyCandidate: true,
            CandidateId: C.CandidateId,
            HuntId: Hunt,
            Host: C.Host ?? "",
            Port: C.Port ?? 0
        });
        logger.info(`mm: ${PlayerId} follows party P=${TheParty.PartyId} to ${Hunt} (candidate ${C.CandidateId}, ${C.State})`);
        return true;
    }

    if(IsCity){
        // Ramsgate: everyone goes there on their own, except that the leader's "Return with Party" takes the
        // members who are on the same server as the leader (the same hunt) along.
        if(!IsLeader) return "solo";
        const LeaderWas = LastSentMap.get(PlayerId);
        const Along = TheParty.Members.filter((M) => M !== PlayerId && LeaderWas !== undefined
            && LastSentMap.get(M)?.Host === LeaderWas.Host && LastSentMap.get(M)?.Port === LeaderWas.Port);
        if(Along.length === 0) return "solo";
        return await StartPartyCandidate(TheParty, PlayerId, Mode, Hunt, [PlayerId, ...Along]);
    }

    if(!IsLeader){
        logger.warn(`mm: ${PlayerId} asked for ${Hunt} but only the party leader ${TheParty.LeaderId} starts the party's hunts`);
        return false;
    }

    return await StartPartyCandidate(TheParty, PlayerId, Mode, Hunt, [...TheParty.Members]);
}

async function StartPartyCandidate(TheParty: NonNullable<ReturnType<typeof PartyForMatchmaking>>, PlayerId: string, Mode: string, Hunt: string, Members: string[]): Promise<boolean> {
    const CandidateId = crypto.randomUUID();

    for(const Member of Members){
        ForgetFromSoloQueues(Member);
        MatchmakingResultMap.set(Member, { Ready: false, PartyCandidate: true, CandidateId, HuntId: Hunt, Host: "", Port: 0 });
    }

    SetCandidate(TheParty, { CandidateId, State: "MATCHING", GameMode: Mode, HuntId: Hunt, MemberIds: Members, CreatedAt: Date.now() });
    logger.info(`mm: party P=${TheParty.PartyId} leader ${PlayerId} starts ${Hunt} for ${Members.length} member(s), candidate ${CandidateId}`);

    // The deploy server starts a hunt/island server only for "ISLAND" (the solo queue sends "ISLAND" for SHARED too);
    // given "SHARED" it answers with Ramsgate.
    const Game = Mode === "CITY"
        ? await LaunchGameOnDeployserver("CITY", "", Hunt, undefined)
        : await LaunchGameOnDeployserver("ISLAND", "", Hunt, Members);

    if(!Game.succeeded){
        ClearCandidate(TheParty, CandidateId, "no game server could be started");
        for(const Member of Members){
            if(MatchmakingResultMap.get(Member)?.CandidateId === CandidateId) MatchmakingResultMap.delete(Member);
        }
        return false;
    }

    for(const Member of Members){
        const Entry = MatchmakingResultMap.get(Member);
        if(Entry !== undefined && Entry.CandidateId === CandidateId){
            Entry.Ready = true;
            Entry.Host = Game.host;
            Entry.Port = Game.port;
        }
    }

    MarkCandidateReady(TheParty, CandidateId, Game.host, Game.port);
    if(Mode !== "CITY") NoteOpenHunt(Hunt, Game, Members);
    logger.info(`mm: party P=${TheParty.PartyId} candidate ${CandidateId} ready at ${Game.host}:${Game.port}`);

    return true;
}

// Where each player was last sent (for "Return with Party": who is on the leader's server)
const LastSentMap = new Map<string, { Host: string, Port: number, At: number }>();

export function NoteSentTo(PlayerId: string, Host: string, Port: number){
    LastSentMap.set(PlayerId, { Host, Port, At: Date.now() });
}

// DELETE /candidate: the game cancels its matchmaking (e.g. backing out of the loading screen)
export function CancelMatchmaking(PlayerId: string){
    const Entry = MatchmakingResultMap.get(PlayerId);
    if(Entry === undefined) return;
    if(!Entry.Ready){
        ForgetFromSoloQueues(PlayerId);
        MatchmakingResultMap.delete(PlayerId);
        logger.info(`mm: ${PlayerId} cancelled matchmaking for ${Entry.HuntId}`);
    }
}

// POST /candidate/join/<candidateId>: a member's game may follow the leader's candidate by its id
export function GetEntryForCandidate(PlayerId: string, CandidateId: string){
    const Entry = MatchmakingResultMap.get(PlayerId);

    return Entry !== undefined && Entry.CandidateId === CandidateId ? Entry : undefined;
}
