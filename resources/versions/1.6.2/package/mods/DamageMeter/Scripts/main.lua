-- Dauntless Forever - Dauntless 1.6.2 offline package
-- Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
-- Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
-- DamageMeter for Dauntless 1.6.2 (UE4SS Lua mod) - version 8
--
-- Source: /Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText, the game's own damage-number
-- message. Every entry names who dealt the hit (SourceActor), so the meter keeps one line per player:
-- name, weapon, core / part / stagger damage, hits.
--
-- Fights (like Details!): the first hit by anyone starts a fight; IDLE_SECONDS with no hit ends it.
--   Current      = the fight going on now; after it ends it stays frozen (DPS does not tick down) until the next
--                  fight starts, which replaces it.
--   Last fight   = the fight before Current.   Fight before = the one before that.
--   Overall      = every fight added up (time in combat only: it pauses between fights).
-- A fight's time runs from its first hit to its last hit, so DPS never drops while you wait for the fight to end.
-- Everything resets by itself when you load into another map (a new hunt), and with F6 or the window's reset.
--
-- Output: %LOCALAPPDATA%\DauntlessOffline\dmgmeter.json once a second while something changed (read by the meter
-- window), and lines in the UE4SS console when a fight ends and on F7.
-- Keys (in the game window): F7 = print current fight and overall   F6 = reset
-- Runs only in the game itself; in the hidden server copies (which also load UE4SS) it switches itself off.

local IDLE_SECONDS = 5
local KEEP_FIGHTS  = 3        -- Current, Last fight, Fight before

local WEAPONS = { [0] = "Unknown", "Hammer", "Axe", "Sword", "Chain Blades", "War Pike", "Repeaters", "Aether Strikers", "Bow" }

---------------------------------------------------------------- state
-- a segment: { players = { [key] = {name, weapon, me, core, part, stagger, hits} }, order = {keys}, first, last }
local function NewSegment() return { players = {}, order = {}, first = 0, last = 0, done = 0 } end

local Fights, Overall, InCombat, Dirty, MapName

local function Reset()
    Fights = {}                    -- oldest first; Fights[#Fights] is Current
    Overall = NewSegment()         -- Overall.done = seconds of finished fights
    InCombat = false
    Dirty = true
end
Reset()

local function Now() return os.clock() end   -- wall-clock seconds on Windows

local function FightSeconds(f) return math.max(f.last - f.first, 1) end
local function OverallSeconds()
    local t = Overall.done
    if InCombat and #Fights > 0 then t = t + FightSeconds(Fights[#Fights]) end
    return t
end

local function Num(n)
    local s = string.format("%d", math.floor((tonumber(n) or 0) + 0.5))
    return (s:reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", ""))
end

local function AddHit(seg, key, info, core, part, stagger)
    local p = seg.players[key]
    if not p then
        p = { name = info.name, weapon = 0, core = 0, part = 0, stagger = 0, hits = 0 }
        seg.players[key] = p
        seg.order[#seg.order + 1] = key
    end
    p.name, p.weapon, p.me = info.name, info.weapon, info.me
    p.core, p.part, p.stagger = p.core + core, p.part + part, p.stagger + stagger
    p.hits = p.hits + 1
end

---------------------------------------------------------------- output file
-- DF_METER_DIR: set by the start scripts (the game runs with a private settings folder, so %LOCALAPPDATA% is not the
-- real one there); the meter window (tools\meter-overlay.ps1) reads the same folder
local Dir = os.getenv("DF_METER_DIR") or (os.getenv("LOCALAPPDATA") and (os.getenv("LOCALAPPDATA") .. "\\DauntlessOffline")) or nil
local OutFile   = Dir and (Dir .. "\\dmgmeter.json")
local ResetFile = Dir and (Dir .. "\\dmgmeter.reset")
local FileOk = OutFile ~= nil

local function J(s)   -- JSON string
    s = tostring(s or "")
    s = s:gsub('[%c"\\]', function(c)
        if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
        return string.format("\\u%04x", c:byte())
    end)
    return '"' .. s .. '"'
end

local function SegmentJson(seg, seconds)
    if not seg then return "null" end
    local parts = {}
    for _, key in ipairs(seg.order) do
        local p = seg.players[key]
        parts[#parts + 1] = string.format(
            '{"name":%s,"weapon":%d,"weaponName":%s,"me":%s,"core":%.0f,"part":%.0f,"stagger":%.0f,"hits":%d,"dps":%.1f}',
            J(p.name), p.weapon, J(WEAPONS[p.weapon] or "Unknown"), p.me and "true" or "false",
            p.core, p.part, p.stagger, p.hits, seconds > 0 and p.core / seconds or 0)
    end
    return string.format('{"seconds":%.1f,"players":[%s]}', seconds, table.concat(parts, ","))
end

local function WriteFile()
    if not FileOk then return end
    local n = #Fights
    local function F(i) local f = Fights[n - i]; return SegmentJson(f, f and FightSeconds(f) or 0) end
    local json = string.format('{"v":2,"time":%d,"inCombat":%s,"map":%s,"current":%s,"last":%s,"before":%s,"overall":%s}',
        os.time(), InCombat and "true" or "false", J(MapName or ""),
        F(0), F(1), F(2), (#Overall.order > 0) and SegmentJson(Overall, OverallSeconds()) or "null")
    local f = io.open(OutFile, "w")
    if not f then
        FileOk = false
        print("[DamageMeter] cannot write " .. OutFile .. "; console only\n")
        return
    end
    f:write(json); f:close()
end

local function PrintSegment(title, seg, seconds)
    if not seg then return end
    print(string.format("[DamageMeter] %s: %.1fs\n", title, seconds))
    local list = {}
    for _, key in ipairs(seg.order) do list[#list + 1] = seg.players[key] end
    table.sort(list, function(a, b) return a.core > b.core end)
    for i, p in ipairs(list) do
        print(string.format("[DamageMeter]   %d. %s (%s): %s core | %s DPS   (%s part, %s stagger, %d hits)\n",
            i, p.name, WEAPONS[p.weapon] or "?", Num(p.core), Num(seconds > 0 and p.core / seconds or 0), Num(p.part), Num(p.stagger), p.hits))
    end
end

local function PrintTotals()
    local cur = Fights[#Fights]
    PrintSegment(InCombat and "Current fight (in combat)" or "Current fight", cur, cur and FightSeconds(cur) or 0)
    if #Fights > 1 or InCombat then PrintSegment("Overall", Overall, OverallSeconds()) end
end

---------------------------------------------------------------- who dealt the hit
local IsServerCopy = nil   -- nil = not decided yet

local function Valid(o) return o ~= nil and o:IsValid() end

-- The hidden server copies load UE4SS (and this mod) too, and they see every hit as well. Only the game itself
-- may count and write the file, or a server copy overwrites it. The game is the one copy with a LOCAL player
-- controller (on a server copy, the players' controllers belong to remote connections).
local function Live(o)   -- a real object, not a class default ("Default__...")
    if o == nil or not o:IsValid() then return false end
    local ok, n = pcall(function() return o:GetFName():ToString() end)
    return not (ok and n and n:find("^Default__"))
end

-- The game is the only copy with a local player (your screen and keyboard). The hidden server copies have none;
-- once a player joins them they only have that player's remote controller.
local function CheckServer(ctx)
    if IsServerCopy ~= nil then return IsServerCopy end
    local hasLocalPlayer, controllers, localController = false, 0, false
    pcall(function()
        for _, cls in ipairs({ "ArchonLocalPlayer", "LocalPlayer" }) do
            for _, lp in ipairs(FindAllOf(cls) or {}) do if Live(lp) then hasLocalPlayer = true end end
        end
    end)
    pcall(function()
        for _, cls in ipairs({ "player_controller_bp_C", "ArchonPlayerController", "PlayerController" }) do
            for _, pc in ipairs(FindAllOf(cls) or {}) do
                if Live(pc) then
                    controllers = controllers + 1
                    local ok, res = pcall(function() return pc:IsLocalController() end)
                    if ok and res == true then localController = true end
                end
            end
        end
    end)
    CheckCount = (CheckCount or 0) + 1
    if CheckCount == 1 or CheckCount % 30 == 0 then
        print(string.format("[DamageMeter] check %d: local player %s, controllers %d, local controller %s\n",
            CheckCount, tostring(hasLocalPlayer), controllers, tostring(localController)))
    end
    if hasLocalPlayer or localController then
        IsServerCopy = false
    elseif controllers > 0 then
        IsServerCopy = true
    else
        return true                             -- nothing to go on yet: skip this hit, ask again later
    end
    print(IsServerCopy and "[DamageMeter] this is a server copy: meter off here\n"
                       or  "[DamageMeter] this is the game: meter on, writing " .. tostring(OutFile) .. "\n")
    return IsServerCopy
end

local LocalPS = nil
local function LocalPlayerStateAddress()
    if LocalPS and Valid(LocalPS) then return LocalPS:GetAddress() end
    local ok = pcall(function()
        local pc = FindFirstOf("player_controller_bp_C")
        if Valid(pc) and Valid(pc.PlayerState) then LocalPS = pc.PlayerState end
    end)
    return (ok and LocalPS and Valid(LocalPS)) and LocalPS:GetAddress() or nil
end

-- the pawn behind a hit: the source itself, or (projectiles, buffs) its instigator or owner
local function PawnOf(src)
    if not Valid(src) then return nil end
    local ok, ps = pcall(function() return src.PlayerState end)
    if ok and Valid(ps) then return src end
    for _, field in ipairs({ "Instigator", "Owner" }) do
        local ok2, o = pcall(function() return src[field] end)
        if ok2 and Valid(o) then
            local ok3, ps2 = pcall(function() return o.PlayerState end)
            if ok3 and Valid(ps2) then return o end
        end
    end
    return nil
end

local function WeaponOf(pawn, ps)
    local ok, w = pcall(function() return pawn.Weapon.WeaponType end)
    if ok and tonumber(w) and tonumber(w) > 0 then return tonumber(w) end
    ok, w = pcall(function() return ps.Weapon end)
    if ok and tonumber(w) then return tonumber(w) end
    return 0
end

local function NameOf(ps)
    local ok, n = pcall(function() return ps:GetPlayerName():ToString() end)
    if ok and n and n ~= "" then return n end
    ok, n = pcall(function() return ps.PlayerNamePrivate:ToString() end)
    if ok and n and n ~= "" then return n end
    return "Slayer"
end

local function MapOf(obj)
    local ok, full = pcall(function() return obj:GetFullName() end)
    return ok and full and full:match("%s(/[^%.:]+)") or nil
end

---------------------------------------------------------------- the hook
local function OnEntry(e)
    local pawn = PawnOf(e.SourceActor)
    if not pawn then return end               -- not a player's hit (a behemoth hitting you, etc.)
    local ps = pawn.PlayerState
    local key = ps:GetAddress()

    local map = MapOf(pawn)
    if map and MapName and map ~= MapName then
        print("[DamageMeter] new map, everything reset\n")
        Reset()
    end
    MapName = map or MapName

    local t = Now()
    if not InCombat then                       -- a new fight: it becomes Current, the old Current becomes Last fight
        local f = NewSegment()
        f.first, f.last = t, t
        Fights[#Fights + 1] = f
        while #Fights > KEEP_FIGHTS do table.remove(Fights, 1) end
        InCombat = true
    end
    local cur = Fights[#Fights]
    cur.last = t

    local info = { name = NameOf(ps), weapon = WeaponOf(pawn, ps), me = (key == LocalPlayerStateAddress()) }
    local core, part, stagger = tonumber(e.CoreDamage) or 0, tonumber(e.PartDamage) or 0, tonumber(e.StaggerDamage) or 0
    AddHit(cur, key, info, core, part, stagger)
    AddHit(Overall, key, info, core, part, stagger)
    Dirty = true
end

local hooked, err = pcall(function()
    RegisterHook("/Script/Archon.ArchonCombatTextComponent:MulticastSendMultitypeCombatText", function(self, Entries)
        if CheckServer(self:get()) then return end
        local ok, e = pcall(function()
            Entries:get():ForEach(function(i, elem) OnEntry(elem:get()) end)
        end)
        if not ok then print("[DamageMeter] could not read a hit: " .. tostring(e) .. "\n") end
    end)
end)
print(hooked and "[DamageMeter] v8 loaded (F7 = totals, F6 = reset)\n" or ("[DamageMeter] hook failed: " .. tostring(err) .. "\n"))

---------------------------------------------------------------- once a second
LoopAsync(1000, function()
    if IsServerCopy == nil then                 -- decide as soon as there is something to go on
        -- direct call (ExecuteInGameThread needs UE4SS's EngineTick hook, which does not work here)
        pcall(function() CheckServer(nil) end)
        if IsServerCopy == false then WriteFile() end   -- the game: start with a fresh, empty meter
        return false
    end
    if IsServerCopy then return true end       -- server copy: stop the loop
    if ResetFile then
        local f = io.open(ResetFile, "r")
        if f then f:close(); os.remove(ResetFile); Reset(); print("[DamageMeter] reset (from the meter window)\n") end
    end
    if InCombat and Now() - Fights[#Fights].last >= IDLE_SECONDS then
        local cur = Fights[#Fights]
        Overall.done = Overall.done + FightSeconds(cur)
        InCombat = false
        Dirty = true
        PrintSegment("FIGHT OVER", cur, FightSeconds(cur))
    end
    if Dirty or InCombat then Dirty = false; WriteFile() end
    return false
end)

RegisterKeyBind(Key.F7, function() PrintTotals() end)
RegisterKeyBind(Key.F6, function() Reset(); WriteFile(); print("[DamageMeter] reset\n") end)
