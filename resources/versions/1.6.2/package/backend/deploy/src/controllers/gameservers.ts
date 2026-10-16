// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
import { spawn } from "node:child_process"
import { setTimeout } from "node:timers/promises";

import crypto from "node:crypto";

import PlayerHuntTable from "../vendor/player_hunts_table.json";
import MatchmakerHuntTable from "../vendor/matchmaker_hunts_table.json";
import TrialsHardHuntTable from "../vendor/trials_hard_table.json";
import TrialsEliteHuntTable from "../vendor/trials_elite_table.json";
import { kill } from "node:process";
import { logger } from "../logger";

// Ramsgate event dressings (Springtide, Saint's Bond, each season's decorations) are feature flags the game reads
// from its map URL: ?OverridenFeaturesOn=a,b ?OverridenFeaturesOff=c. Names are the flags' class names, for example
// city_event_Springtide_bpff_C. start.ps1 sets CITY_EVENTS_ON / CITY_EVENTS_OFF from data\\city_events.txt.
// The game finds each flag by its full object path; a short name (city_event_Springtide_bpff or ..._bpff_C) is
// expanded to /Game/Features/HuntPass/<name>.<name>_C, where the city event and hunt pass flags live.
const FlagPath = (s) => {
    if (s.includes("/")) return s;
    const b = s.replace(/_C$/, "");
    return `/Game/Features/HuntPass/${b}.${b}_C`;
};
const FlagList = (v) => (v || "").split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9_\/.]+$/.test(s)).map(FlagPath).join(",");
const CITY_EVENTS_ON = FlagList(process.env.CITY_EVENTS_ON);
const CITY_EVENTS_OFF = FlagList(process.env.CITY_EVENTS_OFF);
const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent" +
    (CITY_EVENTS_ON ? `?OverridenFeaturesOn=${CITY_EVENTS_ON}` : "") + (CITY_EVENTS_OFF ? `?OverridenFeaturesOff=${CITY_EVENTS_OFF}` : "");
// Automatic holidays (the Events page default; start.ps1 sets CITY_EVENTS_AUTO=1): the holiday of the month is switched
// on in Ramsgate by tools/holiday-schedule.cjs (by KombatKing), worked out each time Ramsgate starts. Flags picked by
// hand (a season dressing) still apply. Anything wrong there: Ramsgate starts as before.
const RAMSGATE_BASE = RAMSGATE_MAP_PATH.split("?OverridenFeatures")[0];
function RamsgateMapPath(): string {
    if (process.env.CITY_EVENTS_AUTO !== "1") return RAMSGATE_MAP_PATH;
    try {
        const p: string = require(require("node:path").resolve(__dirname, "../../../../tools/holiday-schedule.cjs")).ramsgate(new Date(), CITY_EVENTS_ON, CITY_EVENTS_OFF);
        const at = p.indexOf("?");
        const url = RAMSGATE_BASE + (at < 0 ? "" : p.slice(at));
        console.log("Ramsgate (automatic holidays): " + url.replace(/\/Game\/Features\/HuntPass\//g, ""));
        return url;
    }
    catch (e: any) {
        console.error("Holiday calendar: " + (e && e.message) + "; Ramsgate without holiday");
        return RAMSGATE_MAP_PATH;
    }
}
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";
const TRIALS_MAP_PATH = "/Game/Maps/islands/arenas/arena_ramsgate_00";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    processId: number,
    startTime: Date
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];

let RamsgateServer : Gameserver;
let TrainingDojoServer : Gameserver;

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!;
// -CULTURE=en-US: the hidden server copies run on the player's PC and would take its number format.
// With a decimal comma (French, German, ...) the game's server-only code misreads numbers: parts break with
// stage NONE (no visual, no break loot, e.g. BREAK_BEAVER_BETA_TAIL_NONE). Live servers always ran in English.
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi", "-CULTURE=en-US"];
// Offline package: the backend address is handed to every server copy as its 8th argument; the server DLL
// serves all endpoint overrides from that (no Game.ini in any profile folder is needed).
const METAGAME_ADDRESS = process.env.METAGAME_ADDRESS || "127.0.0.1:61000";

const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);

function TransformExpectedPlayerArgs(ExpectedPlayers: ExpectedPlayer[]){
    let ToReturn = "";

    for(const Player of ExpectedPlayers){
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if(ToReturn.length > 0){
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }

    return ToReturn;
}

// Offline package: a server copy that dies right after it starts (missing Windows parts, exe moved, antivirus)
// must not be restarted forever. Count quick deaths; after 3 in a row stop and say so (start.ps1 reads this line).
const QuickDeaths: { [k: string]: number } = { ramsgate: 0, dojo: 0 };
function TooManyQuickDeaths(Server: Gameserver, Key: string): boolean {
    const Lived = Date.now() - new Date(Server.startTime).getTime();
    QuickDeaths[Key] = Lived < 120000 ? QuickDeaths[Key] + 1 : 0;
    if (QuickDeaths[Key] >= 3) {
        logger.error(`GAME SERVER KEEPS FAILING: the ${Key} server closed ${QuickDeaths[Key]} times right after starting. Not restarting it.`);
        return true;
    }
    return false;
}

export async function CleanupServer(ServerToShutdown: Gameserver){
    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);
    if (ServerToShutdown.isRamsgate && TooManyQuickDeaths(ServerToShutdown, "ramsgate")) { return; }
    if (ServerToShutdown.isTrainingDojo && TooManyQuickDeaths(ServerToShutdown, "dojo")) { return; }

    if(ServerToShutdown.isRamsgate){
        logger.warn("RAMSGATE HAS FALLEN! Restarting!");

        await StartServer(RamsgateMapPath(), undefined, undefined, undefined, true, false);
    }
    else if(ServerToShutdown.isTrainingDojo){
        logger.warn("Training Dojo Crashed! Restarting!");

        await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    }
    else{
        FreePorts.push(ServerToShutdown.port);
    }
}

let ServerLaunchQueue: Promise<void> = Promise.resolve();

async function StartServer(Map: string, Behemoth: string | undefined, MatchmakerHuntId: string | undefined, ExpectedPlayers: ExpectedPlayer[] | undefined, IsRamsgate: boolean, IsTrainingDojo: boolean){
    const LaunchProc = ServerLaunchQueue;

    ServerLaunchQueue = ServerLaunchQueue.catch(() => {}).then(async () => await setTimeout(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));

    await LaunchProc;
    
    let Port;

    if(IsRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(IsTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        Port = FreePorts.pop();
    }

    const Id = crypto.randomUUID();

    if(Port == undefined){
        throw new Error("No free ports left!");
    }

    const Child = spawn(GAMESERVER_BINARY_PATH, [
        METAGAME_API_KEY,
        Port.toString(),
        Map,
        Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
        MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
        ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + Port.toString(),
        METAGAME_ADDRESS,
        ...STANDARD_GAMESERVER_ARGS
    ], { windowsHide: true, stdio: "ignore" }); // offline package: server copies stay hidden

    // Without this listener a failed start (exe missing or moved, antivirus, ...) crashes the whole deploy server,
    // and the crash dump prints the arguments, which include the game server key. Log only the reason.
    Child.on("error", (e: any) => {
        logger.error(`Could not start the game server on port ${Port}: ${e && e.code ? e.code : "error"} (${GAMESERVER_BINARY_PATH})`);
    });

    Child.unref();

    // Game Rule "Unlimited Resupply Beacons" (solo play, hunts only; resupply162.js). Never stops or delays the server.
    if (!IsRamsgate && !IsTrainingDojo) require("../resupply162").Apply(Child, GAMESERVER_BINARY_PATH, Port, logger);

    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: ExpectedPlayers,
        isRamsgate: IsRamsgate,
        isTrainingDojo: IsTrainingDojo,
        processId: Child.pid ?? 0,
        startTime: new Date()
    };

    Gameservers.push(NewGameserver);

    return NewGameserver;
}

export function GetRamsgateConnectionDetails(){
    return {
        host: MY_IP,
        port: RamsgateServer.port
    };
}

export function GetTrainingDojoConnectionDetails(){
    return {
        host: MY_IP,
        port: TrainingDojoServer.port
    };
}

export async function StartupGameserverWithArgs(GameArgs: string){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GameArgs.split("?")[2].split("=")[1];

    const GameServerToReturn = await StartServer(Map, Behemoth, undefined, undefined, false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string){
    const MatchmakerHuntIDs = (PlayerHuntTable[0].Rows as any)[PlayerHuntId].MatchmakerHuntIDs;

    let MatchmakerHuntObject;

    if(MatchmakerHuntIDs.length !== 0){
        MatchmakerHuntObject = MatchmakerHuntIDs[crypto.randomInt(0, MatchmakerHuntIDs.length)];
    }

    return MatchmakerHuntObject?.RowName;
}

function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.SpecificBehemoth.BehemothAsset.AssetPathName;
}

function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    const MapList = MatchmakerHuntObject.MapList;

    return MapList[crypto.randomInt(0, MapList.length)].MapAssetName.split(".")[0];
}

function GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.GameModeOverride.replaceAll("Archon/Content", "/Game");
}

type TrialsData = {
    Behemoth: string;
    TrialsHuntId: string;
}

// Trials: this week's pair (tools/trials-schedule.cjs, fix by KombatKing), so the hunt matches what the menu
// shows. Anything it does not know falls back to the old random pick.
function ScheduledTrialsData(HuntId: string): TrialsData{
    try { return require(require('node:path').resolve(__dirname,'../../../../tools/trials-schedule.cjs')).launch(HuntId); }
    catch (e: any) {
        console.error("Trials schedule: " + (e && e.message) + "; using a random Trial");
        return RandomlyGenTrialsData(HuntId.includes("Elite"));
    }
}

function RandomlyGenTrialsData(IsElite: boolean): TrialsData{
    const RandomTrialNum = String(crypto.randomInt(1, 89)).padStart(3, "0");

    const Difficulty = IsElite ? "Elite" : "Hard";

    const TrialsHuntId = `Arena_MatchmakerHunt_${Difficulty}_${RandomTrialNum}`;

    const Row = IsElite ? (TrialsEliteHuntTable[0].Rows as any)[TrialsHuntId] : (TrialsHardHuntTable[0].Rows as any)[TrialsHuntId];

    const Behemoth = Row.SpecificBehemoth.BehemothAsset.AssetPathName;

    return {
        Behemoth: Behemoth,
        TrialsHuntId: TrialsHuntId
    };
}

// Public games (DF-ONLINE-1): the backend lets players join a hunt for HUNT_JOIN_WINDOW_SEC after it starts, so hunt
// servers then get room for HUNT_PLAYER_LIMIT players (4). Without the window, hunts start exactly as before.
const HUNT_JOIN_OPEN = (Number(process.env.HUNT_JOIN_WINDOW_SEC) || 0) > 0;
const HUNT_PLAYER_LIMIT = Math.min(8, Math.max(1, Number(process.env.HUNT_PLAYER_LIMIT) || 4));

// the metagame asks before sending a player into a hunt that started earlier: is that server still running?
export function IsServerUp(Id: string){
    const Server = Gameservers.find((S) => S.id === Id);
    if(!Server || !Server.processId) return false;
    try { process.kill(Server.processId, 0); return true; } catch { return false; }
}

export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const TrialsData = HuntId.includes("Arena") ? ScheduledTrialsData(HuntId) : undefined;
    const MatchmakerHuntId = TrialsData == undefined ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : TrialsData.TrialsHuntId;
    let BehemothPath = TrialsData == undefined ? GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId!) : TrialsData.Behemoth;
    let MapPath = TrialsData == undefined ? GetMapPathFromMatchmakerHuntId(MatchmakerHuntId!) : TRIALS_MAP_PATH;

    if(MatchmakerHuntId != undefined && !MatchmakerHuntId.includes("Arena")){
        const OverrideGameMode = GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId);

        if(OverrideGameMode != undefined && OverrideGameMode.includes("_C")){
            logger.info(`Overriding gamemode to ${OverrideGameMode}`);
            MapPath = `${MapPath}?game=${OverrideGameMode}`;
        }
    }

    if(HUNT_JOIN_OPEN){
        MapPath = `${MapPath}?MaxPlayers=${HUNT_PLAYER_LIMIT}`;
    }

    const GameServerToReturn = await StartServer(MapPath, BehemothPath, MatchmakerHuntId, ExpectedPlayers.map((PlayerId) => {
        return {
            playerUid: PlayerId,
            playerHuntId: HuntId
        };
    }), false, false);

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

export async function Startup(){
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    RamsgateServer = await StartServer(RamsgateMapPath(), undefined, undefined, undefined, true, false);

    TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
}