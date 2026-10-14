// Dauntless Forever - Dauntless 1.6.2 offline backend
// Copyright (C) 2026 Addison2k (port to this Dauntless build and all changes). https://github.com/addison2k/DauntlessForever
// Based on Undaunted, Copyright (C) gwog and contributors, https://github.com/SyST3MDeV/Undaunted
// Licence: AGPL-3.0-only (LICENSE-AGPL-3.0.txt). Keep this notice: the licence requires it.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Gameservers = void 0;
exports.CleanupServer = CleanupServer;
exports.GetRamsgateConnectionDetails = GetRamsgateConnectionDetails;
exports.GetTrainingDojoConnectionDetails = GetTrainingDojoConnectionDetails;
exports.StartupGameserverWithArgs = StartupGameserverWithArgs;
exports.StartupGameserverWithHuntIdAndPlayers = StartupGameserverWithHuntIdAndPlayers;
exports.Startup = Startup;
exports.IsServerUp = IsServerUp;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:timers/promises");
const node_crypto_1 = __importDefault(require("node:crypto"));
const player_hunts_table_json_1 = __importDefault(require("../vendor/player_hunts_table.json"));
const matchmaker_hunts_table_json_1 = __importDefault(require("../vendor/matchmaker_hunts_table.json"));
const trials_hard_table_json_1 = __importDefault(require("../vendor/trials_hard_table.json"));
const trials_elite_table_json_1 = __importDefault(require("../vendor/trials_elite_table.json"));
const logger_1 = require("../logger");
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
// Player limits: without ?MaxPlayers the server allows ONE player ("max player count is 1" in its log), and a second
// player who travels in times out after 2 minutes and is sent back to the menu. Ramsgate 20 like Dauntless Revived.
const CITY_PLAYER_LIMIT = Math.max(1, Number(process.env.CITY_PLAYER_LIMIT) || 20);
const DOJO_PLAYER_LIMIT = Math.max(1, Number(process.env.DOJO_PLAYER_LIMIT) || 4);
const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent" + `?MaxPlayers=${CITY_PLAYER_LIMIT}` +
    (CITY_EVENTS_ON ? `?OverridenFeaturesOn=${CITY_EVENTS_ON}` : "") + (CITY_EVENTS_OFF ? `?OverridenFeaturesOff=${CITY_EVENTS_OFF}` : "");
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent" + `?MaxPlayers=${DOJO_PLAYER_LIMIT}`;
const TRIALS_MAP_PATH = "/Game/Maps/islands/arenas/arena_ramsgate_00";
// Public games (DF-ONLINE-1): the backend lets players join a hunt for HUNT_JOIN_WINDOW_SEC after it starts, so hunt
// servers then get room for HUNT_PLAYER_LIMIT players (4). Without the window, hunts start exactly as before.
const HUNT_JOIN_OPEN = (Number(process.env.HUNT_JOIN_WINDOW_SEC) || 0) > 0;
const HUNT_PLAYER_LIMIT = Math.min(8, Math.max(1, Number(process.env.HUNT_PLAYER_LIMIT) || 4));
exports.Gameservers = [];
let FreePorts = [];
let RamsgateServer;
let TrainingDojoServer;
const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH;
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi"];
// Offline package: the backend address is handed to every server copy as its 8th argument; the server DLL
// serves all endpoint overrides from that (no Game.ini in any profile folder is needed).
const METAGAME_ADDRESS = process.env.METAGAME_ADDRESS || "127.0.0.1:61000";

const METAGAME_API_KEY = process.env.METAGAME_API_KEY;
const MY_IP = process.env.MY_IP;
// Online hosting through the Dauntless Forever relay: players reach this PC's game servers at relay ports
// (base .. base+7) instead of 8770-8777. "ONLINE - HOST.bat" sets PUBLIC_PORT_OFFSET = base - 8770. 0 otherwise.
const PUBLIC_PORT_OFFSET = Number(process.env.PUBLIC_PORT_OFFSET) || 0;
const PublicPort = (Port) => Port + PUBLIC_PORT_OFFSET;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP);
function TransformExpectedPlayerArgs(ExpectedPlayers) {
    let ToReturn = "";
    for (const Player of ExpectedPlayers) {
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }
    if (ToReturn.length > 0) {
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }
    return ToReturn;
}
// Offline package: a server copy that dies right after it starts (missing Windows parts, exe moved, antivirus)
// must not be restarted forever. Count quick deaths; after 3 in a row stop and say so (start.ps1 reads this line).
const QuickDeaths = { ramsgate: 0, dojo: 0 };
function TooManyQuickDeaths(Server, Key) {
    const Lived = Date.now() - new Date(Server.startTime).getTime();
    QuickDeaths[Key] = Lived < 120000 ? QuickDeaths[Key] + 1 : 0;
    if (QuickDeaths[Key] >= 3) {
        logger_1.logger.error(`GAME SERVER KEEPS FAILING: the ${Key} server closed ${QuickDeaths[Key]} times right after starting. Not restarting it.`);
        return true;
    }
    return false;
}
async function CleanupServer(ServerToShutdown) {
    exports.Gameservers = exports.Gameservers.filter(Server => Server !== ServerToShutdown);
    if (ServerToShutdown.isRamsgate && TooManyQuickDeaths(ServerToShutdown, "ramsgate")) { return; }
    if (ServerToShutdown.isTrainingDojo && TooManyQuickDeaths(ServerToShutdown, "dojo")) { return; }
    if (ServerToShutdown.isRamsgate) {
        logger_1.logger.warn("RAMSGATE HAS FALLEN! Restarting!");
        await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    }
    else if (ServerToShutdown.isTrainingDojo) {
        logger_1.logger.warn("Training Dojo Crashed! Restarting!");
        await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
    }
    else {
        FreePorts.push(ServerToShutdown.port);
    }
}
let ServerLaunchQueue = Promise.resolve();
async function StartServer(Map, Behemoth, MatchmakerHuntId, ExpectedPlayers, IsRamsgate, IsTrainingDojo) {
    const LaunchProc = ServerLaunchQueue;
    ServerLaunchQueue = ServerLaunchQueue.catch(() => { }).then(async () => await (0, promises_1.setTimeout)(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));
    await LaunchProc;
    let Port;
    if (IsRamsgate) {
        Port = RAMSGATE_PORT;
    }
    else if (IsTrainingDojo) {
        Port = TRAINING_DOJO_PORT;
    }
    else {
        Port = FreePorts.pop();
    }
    const Id = node_crypto_1.default.randomUUID();
    if (Port == undefined) {
        throw new Error("No free ports left!");
    }
    const Child = (0, node_child_process_1.spawn)(GAMESERVER_BINARY_PATH, [
        METAGAME_API_KEY,
        Port.toString(),
        Map,
        Behemoth != undefined ? Behemoth : "NO_BEHEMOTH",
        MatchmakerHuntId != undefined ? MatchmakerHuntId : "NO_MM_HUNTID",
        ExpectedPlayers != undefined ? TransformExpectedPlayerArgs(ExpectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + PublicPort(Port).toString(),  // the address players use for this server
        METAGAME_ADDRESS,
        ...STANDARD_GAMESERVER_ARGS
    ], { windowsHide: true, stdio: "ignore" }); // offline package: server copies stay hidden
    // Without this listener a failed start (exe missing or moved, antivirus, ...) crashes the whole deploy server,
    // and the crash dump prints the arguments, which include the game server key. Log only the reason.
    Child.on("error", (e) => {
        logger_1.logger.error(`Could not start the game server on port ${Port}: ${e && e.code ? e.code : "error"} (${GAMESERVER_BINARY_PATH})`);
    });
    Child.unref();
    const NewGameserver = {
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
    exports.Gameservers.push(NewGameserver);
    return NewGameserver;
}
function GetRamsgateConnectionDetails() {
    return {
        host: MY_IP,
        port: PublicPort(RamsgateServer.port)
    };
}
function GetTrainingDojoConnectionDetails() {
    return {
        host: MY_IP,
        port: PublicPort(TrainingDojoServer.port)
    };
}
async function StartupGameserverWithArgs(GameArgs) {
    const Map = GameArgs.split("?")[0];
    const Behemoth = GameArgs.split("?")[2].split("=")[1];
    const GameServerToReturn = await StartServer(Map, Behemoth, undefined, undefined, false, false);
    return {
        host: MY_IP,
        port: PublicPort(GameServerToReturn.port)
    };
}
function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId) {
    const MatchmakerHuntIDs = player_hunts_table_json_1.default[0].Rows[PlayerHuntId].MatchmakerHuntIDs;
    let MatchmakerHuntObject;
    if (MatchmakerHuntIDs.length !== 0) {
        MatchmakerHuntObject = MatchmakerHuntIDs[node_crypto_1.default.randomInt(0, MatchmakerHuntIDs.length)];
    }
    return MatchmakerHuntObject?.RowName;
}
function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId) {
    const MatchmakerHuntObject = matchmaker_hunts_table_json_1.default[0].Rows[MatchmakerHuntId];
    return MatchmakerHuntObject.SpecificBehemoth.BehemothAsset.AssetPathName;
}
function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId) {
    const MatchmakerHuntObject = matchmaker_hunts_table_json_1.default[0].Rows[MatchmakerHuntId];
    const MapList = MatchmakerHuntObject.MapList;
    return MapList[node_crypto_1.default.randomInt(0, MapList.length)].MapAssetName.split(".")[0];
}
function GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId) {
    const MatchmakerHuntObject = matchmaker_hunts_table_json_1.default[0].Rows[MatchmakerHuntId];
    return MatchmakerHuntObject.GameModeOverride.replaceAll("Archon/Content", "/Game");
}
function RandomlyGenTrialsData(IsElite) {
    const RandomTrialNum = String(node_crypto_1.default.randomInt(1, 89)).padStart(3, "0");
    const Difficulty = IsElite ? "Elite" : "Hard";
    const TrialsHuntId = `Arena_MatchmakerHunt_${Difficulty}_${RandomTrialNum}`;
    const Row = IsElite ? trials_elite_table_json_1.default[0].Rows[TrialsHuntId] : trials_hard_table_json_1.default[0].Rows[TrialsHuntId];
    const Behemoth = Row.SpecificBehemoth.BehemothAsset.AssetPathName;
    return {
        Behemoth: Behemoth,
        TrialsHuntId: TrialsHuntId
    };
}
async function StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers) {
    const TrialsData = HuntId.includes("Arena") ? RandomlyGenTrialsData(HuntId.includes("Elite")) : undefined;
    const MatchmakerHuntId = TrialsData == undefined ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : TrialsData.TrialsHuntId;
    let BehemothPath = TrialsData == undefined ? GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId) : TrialsData.Behemoth;
    let MapPath = TrialsData == undefined ? GetMapPathFromMatchmakerHuntId(MatchmakerHuntId) : TRIALS_MAP_PATH;
    if (MatchmakerHuntId != undefined && !MatchmakerHuntId.includes("Arena")) {
        const OverrideGameMode = GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId);
        if (OverrideGameMode != undefined && OverrideGameMode.includes("_C")) {
            logger_1.logger.info(`Overriding gamemode to ${OverrideGameMode}`);
            MapPath = `${MapPath}?game=${OverrideGameMode}`;
        }
    }
    if (HUNT_JOIN_OPEN) {
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
        port: PublicPort(GameServerToReturn.port),
        id: GameServerToReturn.id
    };
}
// the metagame asks before sending a player into a hunt that started earlier: is that server still running?
function IsServerUp(Id) {
    const Server = exports.Gameservers.find((S) => S.id === Id);
    if (!Server || !Server.processId) {
        return false;
    }
    try {
        process.kill(Server.processId, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function Startup() {
    for (let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++) {
        FreePorts.push(i);
    }
    RamsgateServer = await StartServer(RAMSGATE_MAP_PATH, undefined, undefined, undefined, true, false);
    TrainingDojoServer = await StartServer(TRAINING_DOJO_MAP_PATH, undefined, undefined, undefined, false, true);
}
