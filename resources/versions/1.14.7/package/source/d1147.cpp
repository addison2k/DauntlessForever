// Dauntless Forever - Dauntless 1.14.7 server loader (dxgi.dll)
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// d1147 server loader for Dauntless 1.14.7 (CL 647472, UE 4.26.2) - milestone 1: boot in server mode, open a port,
// send the world to the player.
//
// This file builds a DLL named dxgi.dll. The game loads dxgi.dll at start, so placing this one beside the exe gets
// our code in before the engine initialises. It forwards every dxgi call to the real system DLL.
//
//   - Without the environment variable D1147_SERVER=1 it does nothing else (the normal game is unaffected).
//   - With it, it switches this copy of the game into server mode and, once a world is loaded, opens a UDP
//     listening port (D1147_PORT, default 8780) and sends the world to each connected player.
//
// The approach (run the retail client as a server by driving the networking code that is still in the exe) is the
// one used by the Undaunted project (gwog and contributors, AGPL-3.0); this file is a new implementation for the
// 1.14.7 build, carrying over the fixes of the Undaunted 1.6.2 port and of the 2.1.1 loader. All addresses are
// specific to this one exe; the exe is identified before anything is changed, and each patch checks its bytes.
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
#include "minhook/MinHook.h"

// ---------------------------------------------------------------------------- dxgi forwarding
// Each export forwards to the same function in the system dxgi.dll. Version 2c-fix2 (Oct 13, 2026); 2c-fix3/2c-fix4 only add
// the server-mode sound and mouse fixes further down ("keep_quiet_and_off_the_mouse"). 2c-fix followed a
// crash at address 0 on Windows 11 25H2 (build 26200); 2c-fix2 follows its first report from that PC: the system DLL
// failed to load on the first call (error 1168, made during process start-up) and 2c-fix never tried again, so every
// graphics call answered "not available" and the game never showed. Now a failed load is retried on later calls (the
// game's own calls come long after start-up), with two fallbacks: LoadLibraryEx from System32, then a copy of the
// system DLL under another name in %TEMP% (in case Windows refuses a second module called dxgi.dll).
//   - the system DLL is loaded on the first call, not inside DllMain (LoadLibrary under the loader lock);
//   - a function the system DLL does not have (Windows changes its private exports) answers a safe "no" instead of
//     jumping to address 0: 0 for the compatibility/void ones, E_NOTIMPL (0x80004001) for the HRESULT ones;
//   - anything missing is written once to %LOCALAPPDATA%\d1147_dxgi.log so the next report names it.
// X(name, value returned when the system DLL lacks the function)
#define DXGI_EXPORTS(X) \
    X(ApplyCompatResolutionQuirking, 0) X(CompatString, 0) X(CompatValue, 0) \
    X(CreateDXGIFactory, 0x80004001) X(CreateDXGIFactory1, 0x80004001) X(CreateDXGIFactory2, 0x80004001) \
    X(DXGID3D10CreateDevice, 0x80004001) X(DXGID3D10CreateLayeredDevice, 0x80004001) X(DXGID3D10GetLayeredDeviceSize, 0) \
    X(DXGID3D10RegisterLayers, 0x80004001) X(DXGIDeclareAdapterRemovalSupport, 0x80004001) \
    X(DXGIDisableVBlankVirtualization, 0x80004001) X(DXGIDumpJournal, 0x80004001) X(DXGIGetDebugInterface1, 0x80004001) \
    X(DXGIReportAdapterConfiguration, 0x80004001) X(PIXBeginCapture, 0x80004001) X(PIXEndCapture, 0x80004001) \
    X(PIXGetCaptureState, 0) X(SetAppCompatStringPointer, 0) X(UpdateHMDEmulationStatus, 0)

static void dxgi_note(const char* text) {          // plain Win32 only: may run under the loader lock
    wchar_t path[MAX_PATH + 32];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (!n || n >= MAX_PATH) return;
    wcscat(path, L"\\d1147_dxgi.log");
    HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (f == INVALID_HANDLE_VALUE) return;
    SYSTEMTIME t; GetLocalTime(&t);
    char line[256];
    int len = snprintf(line, sizeof(line), "%04d-%02d-%02d %02d:%02d:%02d pid %lu: %s\r\n", t.wYear, t.wMonth, t.wDay, t.wHour,
                        t.wMinute, t.wSecond, (unsigned long)GetCurrentProcessId(), text);
    if (len < 0) return; if (len > (int)sizeof(line) - 1) len = (int)sizeof(line) - 1;
    DWORD w; WriteFile(f, line, (DWORD)len, &w, 0);
    CloseHandle(f);
}

extern "C" {
#define X(name, fallback) void* d1147_real_##name = 0;
DXGI_EXPORTS(X)
#undef X

static SRWLOCK g_dxgiLock = SRWLOCK_INIT;
static volatile LONG g_dxgiLoaded = 0;    // 1 once the system DLL is loaded and the pointers are filled
static LONG g_dxgiTries = 0;              // failed attempts so far (each later call retries)
static volatile DWORD g_dxgiOwner = 0;    // thread loading the system DLL right now (2c-fix5)
static volatile LONG g_dxgiReentered = 0;

static HMODULE own_module(void) {
    HMODULE m = 0;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)(void*)&own_module, &m);
    return m;
}
// A loaded module is only usable if it is not this DLL itself (asking Windows for "dxgi.dll" can hand back ours).
static HMODULE usable(HMODULE m, HMODULE self) {
    if (m && m == self) { FreeLibrary(m); return 0; }
    return m;
}
static HMODULE try_load_system_dxgi(char* how, size_t howLen, DWORD* errs) {
    HMODULE self = own_module();
    wchar_t sys[MAX_PATH + 16];
    UINT n = GetSystemDirectoryW(sys, MAX_PATH);
    if (!n || n >= MAX_PATH) { errs[0] = errs[1] = errs[2] = GetLastError(); return 0; }
    wcscat(sys, L"\\dxgi.dll");
    // 0. a DXGI of the player's choosing next to the game exe: dxgi_chain.dll (for example DXVK's dxgi.dll renamed,
    //    with its d3d11.dll beside the exe). GitHub issue #4 (Voidhydra678): Intel Arc's D3D11 driver crashes the game
    //    at start, DXVK does not. Nothing changes when the file is not there.
    {
        wchar_t chain[MAX_PATH + 32];
        DWORD cn = GetModuleFileNameW(0, chain, MAX_PATH);
        if (cn && cn < MAX_PATH) {
            wchar_t* slash = wcsrchr(chain, L'\\');
            if (slash) {
                wcscpy(slash + 1, L"dxgi_chain.dll");
                if (GetFileAttributesW(chain) != INVALID_FILE_ATTRIBUTES) {
                    SetLastError(0);
                    HMODULE c = usable(LoadLibraryExW(chain, 0, LOAD_WITH_ALTERED_SEARCH_PATH), self);
                    if (c) { snprintf(how, howLen, "dxgi_chain.dll next to the exe"); return c; }
                    errs[0] = GetLastError();
                }
            }
        }
    }
    // 1. the system DLL by its full path
    SetLastError(0);
    HMODULE m = usable(LoadLibraryExW(sys, 0, 0), self);
    if (m) { snprintf(how, howLen, "System32 path"); return m; }
    errs[0] = GetLastError();
    // 2. by name, searching System32 only
    SetLastError(0);
    m = usable(LoadLibraryExW(L"dxgi.dll", 0, LOAD_LIBRARY_SEARCH_SYSTEM32), self);
    if (m) { snprintf(how, howLen, "System32 search"); return m; }
    errs[1] = GetLastError();
    // 3. a copy under another name, so no "dxgi.dll is already loaded" rule applies
    wchar_t copy[MAX_PATH + 64];
    DWORD t = GetTempPathW(MAX_PATH, copy);
    if (!t || t >= MAX_PATH) { errs[2] = GetLastError(); return 0; }
    wcscat(copy, L"d1147_system_dxgi.dll");
    WIN32_FILE_ATTRIBUTE_DATA a, b;
    BOOL same = GetFileAttributesExW(sys, GetFileExInfoStandard, &a) && GetFileAttributesExW(copy, GetFileExInfoStandard, &b) &&
                a.nFileSizeLow == b.nFileSizeLow && a.nFileSizeHigh == b.nFileSizeHigh &&
                CompareFileTime(&a.ftLastWriteTime, &b.ftLastWriteTime) == 0;
    if (!same) CopyFileW(sys, copy, FALSE);
    SetLastError(0);
    m = usable(LoadLibraryExW(copy, 0, LOAD_WITH_ALTERED_SEARCH_PATH), self);
    if (m) { snprintf(how, howLen, "copy in TEMP"); return m; }
    errs[2] = GetLastError();
    return 0;
}

void d1147_resolve_dxgi(void) {
    if (g_dxgiLoaded) return;
    // 2c-fix5: Windows compatibility shims (apphelp/AcGenral, active when the exe has compatibility settings) call our
    // SetAppCompatStringPointer, and call it AGAIN from inside the LoadLibrary of the system dxgi.dll below, on the same
    // thread. An SRW lock cannot be taken twice by one thread, so the game froze at start-up (0% CPU, empty log).
    // A call made while this thread is already loading the system DLL now answers the fallback instead of waiting.
    if (g_dxgiOwner == GetCurrentThreadId()) {
        if (InterlockedIncrement(&g_dxgiReentered) == 1) dxgi_note("dxgi forwarding: called again while loading the system dxgi.dll (compatibility shim); answered without waiting");
        return;
    }
    AcquireSRWLockExclusive(&g_dxgiLock);
    g_dxgiOwner = GetCurrentThreadId();
    if (!g_dxgiLoaded) {
        char how[32] = "", msg[200];
        DWORD errs[3] = {0, 0, 0};
        HMODULE real = try_load_system_dxgi(how, sizeof(how), errs);
        if (!real) {
            LONG k = ++g_dxgiTries;
            if (k <= 5 || k == 20 || k == 100 || k % 1000 == 0) {
                snprintf(msg, sizeof(msg), "dxgi forwarding: attempt %ld, system dxgi.dll did not load (errors %lu / %lu / %lu); will retry on the next call",
                         (long)k, (unsigned long)errs[0], (unsigned long)errs[1], (unsigned long)errs[2]);
                dxgi_note(msg);
            }
        } else {
            if (g_dxgiTries || strcmp(how, "System32 path") != 0) {
                snprintf(msg, sizeof(msg), "dxgi forwarding: system dxgi.dll loaded on attempt %ld (%s)", (long)g_dxgiTries + 1, how);
                dxgi_note(msg);
            }
#define X(name, fallback) \
            d1147_real_##name = (void*)GetProcAddress(real, #name); \
            if (!d1147_real_##name) { snprintf(msg, sizeof(msg), "dxgi forwarding: system dxgi.dll has no %s, answering %s", #name, \
                                                (fallback) ? "E_NOTIMPL" : "0"); dxgi_note(msg); }
            DXGI_EXPORTS(X)
#undef X
            InterlockedExchange(&g_dxgiLoaded, 1);
        }
    }
    g_dxgiOwner = 0;
    ReleaseSRWLockExclusive(&g_dxgiLock);
}

// Fast path: jump straight to the system function. Until the system DLL is loaded: save the four argument registers,
// try to load it, restore them and jump. Still not loaded, or the function is missing: return the fallback value
// (the next call tries again).
#define X(name, fallback) \
    __declspec(dllexport) __attribute__((naked)) void name(void) { __asm__( \
        "movq d1147_real_" #name "(%rip), %rax\n\t" \
        "testq %rax, %rax\n\t" \
        "jnz 2f\n\t" \
        "pushq %rcx\n\t pushq %rdx\n\t pushq %r8\n\t pushq %r9\n\t" \
        "subq $40, %rsp\n\t" \
        "call d1147_resolve_dxgi\n\t" \
        "addq $40, %rsp\n\t" \
        "popq %r9\n\t popq %r8\n\t popq %rdx\n\t popq %rcx\n\t" \
        "movq d1147_real_" #name "(%rip), %rax\n\t" \
        "testq %rax, %rax\n\t" \
        "jz 3f\n" \
        "2:\n\t jmpq *%rax\n" \
        "3:\n\t movl $" #fallback ", %eax\n\t ret\n"); }
DXGI_EXPORTS(X)
#undef X
}

// ---------------------------------------------------------------------------- log
static FILE* g_log = 0;
static void logf_(const char* fmt, ...) {
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap; va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap);
    fputc('\n', g_log); fflush(g_log);
}

// ---------------------------------------------------------------------------- 1.14.7 addresses (offsets from the exe base)
// How each one was found is in the project doc "Dauntless 1.14.7 - server DLL port map".
namespace A {
    // boss health bar (client mode, Oct 19 merge from 2c-fix5 + 4c)
    const uintptr_t Part_Component       = 0x248;   // AMonsterPartActor -> its UMonsterPartComponent
    const uintptr_t PartComp_Actor       = 0x520;   // UMonsterPartComponent -> MonsterPartActor
    const uintptr_t Actor_InstComponents = 0x1F0;   // AActor InstanceComponents (TArray)
    const uintptr_t Actor_BPComponents   = 0x200;   // AActor BlueprintCreatedComponents (TArray)
    // patches
    const uintptr_t LoadMapListenCall   = 0x4272A80;  // call UWorld::Listen (stub that returns false) inside UEngine::LoadMap
    const uintptr_t RHIInitNullJump     = 0x349A7FE;  // RHIInit: "jne null RHI" after the cached -nullrhi check (DF-NULLRHI-1147)
    const uintptr_t RemoteFnDestroyedJump = 0x3FA02BB; // UNetDriver::ProcessRemoteFunction: "je continue" after the bActorIsBeingDestroyed test (DF-VFXREMOVE-1147)
    const uintptr_t PreInitA_Client     = 0x9F4F12;   // GIsClient = (target bits >> 1) & 1   (13 bytes)
    const uintptr_t PreInitA_Server     = 0x9F4F1F;   // GIsServer = target bits & 1          (12 bytes)
    const uintptr_t PreInitB_ClientImm  = 0x9F9439;   // immediate of "mov byte [GIsClient], 1"
    const uintptr_t PreInitC_ServerImm  = 0x9F95F8;   // immediate of "mov byte [GIsServer], 0"
    const uintptr_t PreInitC_Client     = 0x9F95FE;   // mov [GIsClient], r12b (r12b = 1)
    // globals
    const uintptr_t GIsClient           = 0x6E1EAD9;
    const uintptr_t GIsServer           = 0x6E1EADA;
    const uintptr_t GEngine             = 0x6FC3CE8;
    const uintptr_t GWorld              = 0x6FC7F58;
    // engine functions
    const uintptr_t GetNetMode          = 0x42CC560;  // UWorld::InternalGetNetMode: NM_Client whenever a net driver exists
    const uintptr_t ActorGetNetMode     = 0x3B61DE0;  // AActor::InternalGetNetMode: "standalone" whenever it cannot find its net driver
    const uintptr_t ActorGetNetDriver   = 0x3B5DA40;  // AActor::GetNetDriver (Undaunted: GetNetDriver_Internal)
    const uintptr_t GameEngineTick      = 0x3E10AB0;  // UGameEngine::Tick(float, bool)
    const uintptr_t FNameFromEName      = 0x2658800;  // FName::FName(EName)
    const uintptr_t CreateNamedNetDriver= 0x425FD30;  // UEngine::CreateNamedNetDriver(UWorld*, FName, FName)
    const uintptr_t NetDriverSetWorld   = 0x3FAD0B0;  // UNetDriver::SetWorld(UWorld*)
    const uintptr_t SetReplicationDriver= 0x3FACF60;  // UNetDriver::SetReplicationDriver(UReplicationDriver*)
    const uintptr_t IsLevelInitForActor = 0x3F980D0;  // UNetDriver::IsLevelInitializedForActor(const AActor*, const UNetConnection*)
    const uintptr_t IpNetDriverVTable   = 0x504E580;
    const uint32_t  EName_GameNetDriver = 0x11A;
    const uint32_t  EName_Actor         = 0x66;
    const uintptr_t AppendString        = 0x2656410;  // FName::AppendString(FString&)
    const uintptr_t ProcessEvent        = 0x2861880;  // UObject::ProcessEvent(UFunction*, void* Parms)
    const uintptr_t Struct_Super        = 0x40;       // UStruct::SuperStruct
    const uintptr_t Struct_Children     = 0x48;       // UStruct::Children (UField list)
    const uintptr_t Field_Next          = 0x28;       // UField::Next
    // replication (the engine's own "send the world to each player" loop is not in a client build)
    const uintptr_t CallPreReplication  = 0x3B510D0;  // AActor::CallPreReplication(UNetDriver*)
    const uintptr_t SendClientAdjustment= 0x40B8500;  // APlayerController::SendClientAdjustment()
    const uintptr_t CreateChannelByName = 0x3F62E90;  // UNetConnection::CreateChannelByName(const FName&, EChannelCreateFlags, int32)
    const uintptr_t SetChannelActor     = 0x3D8FB20;  // UActorChannel::SetChannelActor(AActor*, ESetChannelActorFlags)
    const uintptr_t ReplicateActor      = 0x3D8A2D0;  // UActorChannel::ReplicateActor() -> int64
    const uintptr_t WeakPtrAssign       = 0x2870E90;  // FWeakObjectPtr::operator=(const UObject*)
    const uintptr_t IsNetReady          = 0x3F71130;  // UNetConnection::IsNetReady(bool)
    // Dauntless functions
    const uintptr_t HasFinishedLoading  = 0x1CB1360;  // ArchonPlayerController::NativeHasFinishedLoading (interface this)
    const uintptr_t SetupPlayerInput    = 0x18DFEA0;  // AArchonCharacter::SetupPlayerInputComponent
    const uintptr_t BountySeasonDates   = 0x19B2970;  // UBountyComponent::GetSeasonDates(FDateTime Now, FDateTime&, FDateTime&)
    const uintptr_t WeeklySeasonDates   = 0x1A0BF90;  // UBountyComponent_Weekly::GetSeasonDates
    const uintptr_t QueryHuntPassSeason = 0x19120D0;
    const uintptr_t TuningRequest       = 0x1E0CC50;   // DF-TUNING-1147: UTuningDataProvider: fetch huntpass_xp_config, seasonal_event_schedule, island_content_config
    const uintptr_t GI_TuningProvider   = 0x7F0;       // DF-TUNING-1147: UArchonGameInstance::TuningDataProvider (SDK)
    const uintptr_t SwitchGameWindow    = 0x3E103F0;  // UGameEngine::SwitchGameWindowToUseGameViewport (needs a viewport a server does not have)
    const uintptr_t MessageDialogOpen   = 0x2615D20;  // FMessageDialog::Open(EAppMsgType, const FText&, const FText*)  // UArchonGameInstance::QueryCurrentHuntPassSeasonData(const FScriptDelegate&)
    // object layout (UObject)
    const uintptr_t Object_Flags        = 0x08;
    const uintptr_t Object_Class        = 0x10;
    const uintptr_t Object_Name         = 0x18;
    const uintptr_t Object_Outer        = 0x20;
    const uintptr_t Class_CastFlags     = 0xD0;
    const uint64_t  CastFlag_PlayerController = 0x2000000000ull;
    // AActor
    const uintptr_t Actor_Bits58        = 0x58;       // bit 1 bNetStartup, bit 5 bHidden
    const uintptr_t Actor_Bits5C        = 0x5C;       // bit 3: bActorIsBeingDestroyed
    const uintptr_t Actor_RemoteRole    = 0x5F;
    const uintptr_t Actor_NetDriverName = 0xE8;
    const uintptr_t Actor_NetDormancy   = 0xF1;       // 4 = DORM_Initial
    // [Dauntless Forever] owner-only filter (UE 4.26 AActor layout; checked at run time, see owner_check)
    const uintptr_t Actor_Owner         = 0xE0;       // AActor* Owner (just before NetDriverName 0xE8)
    const uintptr_t Actor_Instigator    = 0x118;      // APawn* Instigator
    const uint8_t   Bits58_OnlyRelevantToOwner = 0x04; // bit 2 of the 0x58 byte (bit 1 bNetStartup, bit 5 bHidden)
    const uint8_t   Bits58_AlwaysRelevant      = 0x08; // bit 3
    const uintptr_t VT_SetActorHiddenInGame = 0x308;
    // UWorld / ULevel / FWorldContext / UEngine
    const uintptr_t World_NetworkNotify = 0x28;       // FNetworkNotify sub-object of UWorld
    const uintptr_t World_NetDriver     = 0x38;
    const uintptr_t World_AuthorityGameMode = 0x118;
    const uintptr_t World_Levels        = 0x138;      // TArray<ULevel*>
    const uintptr_t World_GameInstance  = 0x180;
    const uintptr_t Level_Actors        = 0x98;       // TArray<AActor*>
    const uintptr_t Level_Bits1F4       = 0x1F4;      // bit 5: bIsVisible
    const uintptr_t Engine_WorldList    = 0xC38;      // TArray<FWorldContext*>
    const uintptr_t Context_World       = 0x280;
    const uintptr_t Context_ActiveNetDrivers = 0x220; // TArray<FNamedNetDriver> (0x10 each, driver pointer first)
    // UNetDriver / UNetConnection / UChannel
    const uintptr_t Driver_ClientConnections = 0x90;
    const uintptr_t Driver_World        = 0x140;
    const uintptr_t Driver_NetDriverName= 0x190;
    const uintptr_t Driver_Notify       = 0x208;
    const uintptr_t Driver_ReplicationFrame  = 0x2AC;
    const uintptr_t Driver_ReplicationDriver = 0x6E8;
    const uintptr_t VT_InitListen       = 0x290;      // UNetDriver::InitListen(FNetworkNotify*, FURL&, bool, FString&)
    const uintptr_t Conn_ViewTarget     = 0x90;
    const uintptr_t Conn_OwningActor    = 0x98;
    const uintptr_t Conn_State          = 0x134;      // 3 = open
    const uintptr_t Conn_ActorChannels  = 0x1378;     // TMap<TWeakObjectPtr<AActor>, UActorChannel*>
    const uintptr_t Channel_Bits        = 0x30;       // bit 1: Closing
    const uintptr_t Channel_Actor       = 0x70;
    const uintptr_t ActorChannel_Bits   = 0x90;       // bit 1: bForceCompareProperties
    // APlayerController
    const uintptr_t PC_Pawn             = 0x250;
    const uintptr_t PC_PlayerCameraManager = 0x2B8;
    const uintptr_t PC_IsLocalFlag      = 0x57C;      // bIsLocalPlayerController
    const uintptr_t PCM_ViewTargetActor = 0xE70;
}

static uintptr_t g_base = 0;
static int g_port = 8780;
template <class T> static T& at(uintptr_t addr) { return *(T*)addr; }

struct FString { wchar_t* Data; int32_t Num; int32_t Max; };
struct TArrayRaw { void** Data; int32_t Num; int32_t Max; };

// Name of an engine object as text (the small string it allocates is left to the engine).
static const char* name_of(void* obj, char* out, int n) {
    out[0] = 0;
    if (!obj) { snprintf(out, n, "(none)"); return out; }
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)((uintptr_t)obj + A::Object_Name), &s);
    if (s.Data && s.Num > 0) WideCharToMultiByte(CP_UTF8, 0, s.Data, -1, out, n, 0, 0);
    out[n - 1] = 0;
    return out;
}

// ---------------------------------------------------------------------------- crash notes
static volatile LONG g_inHandler = 0;
static int g_crashNotes = 0;
static DWORD g_gameThread = 0;
static void where(uintptr_t addr, char* out, int n) {
    HMODULE m = 0;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)addr, &m) && m) {
        if ((uintptr_t)m == g_base) { snprintf(out, n, "exe+0x%llX", (unsigned long long)(addr - g_base)); return; }
        char path[MAX_PATH]; path[0] = 0;
        GetModuleFileNameA(m, path, sizeof(path));
        const char* b = strrchr(path, '\\');
        snprintf(out, n, "%s+0x%llX", b ? b + 1 : path, (unsigned long long)(addr - (uintptr_t)m));
        return;
    }
    snprintf(out, n, "0x%llX", (unsigned long long)addr);
}
static bool readable(uintptr_t p, size_t n) {
    if (p < 0x10000) return false;
    MEMORY_BASIC_INFORMATION mbi;
    if (!VirtualQuery((void*)p, &mbi, sizeof(mbi)) || mbi.State != MEM_COMMIT) return false;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    return p + n <= (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
}

// A direct call into the game made by this loader can be fenced: if it hits a bad pointer, the handler puts the
// thread back where the fence was set up and the call reports failure.
static CONTEXT g_guardCtx;
static volatile LONG g_guardOn = 0, g_guardHit = 0;
__attribute__((noinline)) static bool guarded(void (*fn)(void*), void* arg) {
    g_guardHit = 0;
    RtlCaptureContext(&g_guardCtx);
    if (g_guardHit) { g_guardOn = 0; return false; }   // arrived here from the exception handler
    g_guardOn = 1; fn(arg); g_guardOn = 0;
    return true;
}

// Writes where a crash happened into our log, then lets the game's own crash handling carry on.
static LONG CALLBACK on_exception(EXCEPTION_POINTERS* ep) {
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    bool interesting = code == 0xC0000005 || code == 0xC000001D || code == 0xC0000094 || code == 0xC0000096 ||
                       code == 0x80000003 || code == 0xC06D007E || code == 0xC06D007F;
    if (!interesting) return EXCEPTION_CONTINUE_SEARCH;
    if (InterlockedCompareExchange(&g_inHandler, 1, 0) != 0) return EXCEPTION_CONTINUE_SEARCH;

    uintptr_t faultAt = (uintptr_t)ep->ExceptionRecord->ExceptionAddress;
    bool av = code == 0xC0000005 && ep->ExceptionRecord->NumberParameters >= 2;
    uintptr_t badAddr = av ? (uintptr_t)ep->ExceptionRecord->ExceptionInformation[1] : 0;

    uintptr_t frames[64]; int nframes = 0;
    CONTEXT c = *ep->ContextRecord;
    for (int i = 0; i < 64; i++) {
        DWORD64 imageBase = 0;
        PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry(c.Rip, &imageBase, 0);
        if (rf) {
            void* handlerData = 0; DWORD64 establisher = 0;
            RtlVirtualUnwind(0, imageBase, c.Rip, rf, &c, &handlerData, &establisher, 0);
        } else {
            if (!readable((uintptr_t)c.Rsp, 8)) break;
            c.Rip = *(DWORD64*)c.Rsp; c.Rsp += 8;
        }
        if (!c.Rip) break;
        frames[nframes++] = (uintptr_t)c.Rip;
    }

    char w[320];
    bool fenced = g_guardOn && av && GetCurrentThreadId() == g_gameThread;
    if (g_crashNotes < 4 || fenced) {
        g_crashNotes++;
        where(faultAt, w, sizeof(w));
        if (av)
            logf_("EXCEPTION 0x%08lX at %s (%s address 0x%llX) thread %lu%s", code, w,
                  ep->ExceptionRecord->ExceptionInformation[0] == 1 ? "writing" : ep->ExceptionRecord->ExceptionInformation[0] == 8 ? "executing" : "reading",
                  (unsigned long long)badAddr, GetCurrentThreadId(), GetCurrentThreadId() == g_gameThread ? " (game thread)" : "");
        else
            logf_("EXCEPTION 0x%08lX at %s thread %lu", code, w, GetCurrentThreadId());
        for (int i = 0; i < nframes && i < 40; i++) { where(frames[i], w, sizeof(w)); logf_("   called from %s", w); }
    }
    if (fenced) {
        logf_("   ... inside a fenced call made by this loader: the call is abandoned and the server carries on");
        g_guardOn = 0; g_guardHit = 1;
        *ep->ContextRecord = g_guardCtx;
        InterlockedExchange(&g_inHandler, 0);
        return EXCEPTION_CONTINUE_EXECUTION;
    }
    InterlockedExchange(&g_inHandler, 0);
    return EXCEPTION_CONTINUE_SEARCH;
}

static bool patch(uintptr_t rva, const uint8_t* expect, const uint8_t* repl, size_t n, const char* what) {
    uint8_t* p = (uint8_t*)(g_base + rva);
    if (memcmp(p, repl, n) == 0) { logf_("patch %-34s already applied", what); return true; }
    if (memcmp(p, expect, n) != 0) { logf_("patch %-34s SKIPPED: bytes at +0x%llX do not match this build", what, (unsigned long long)rva); return false; }
    DWORD old = 0;
    if (!VirtualProtect(p, n, PAGE_EXECUTE_READWRITE, &old)) { logf_("patch %-34s FAILED: VirtualProtect error %lu", what, GetLastError()); return false; }
    memcpy(p, repl, n);
    VirtualProtect(p, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), p, n);
    logf_("patch %-34s ok", what);
    return true;
}

static bool hook(uintptr_t rva, const uint8_t* expect, size_t n, void* detour, void** orig, const char* what) {
    if (expect && memcmp((void*)(g_base + rva), expect, n) != 0) { logf_("hook  %-34s SKIPPED: bytes at +0x%llX do not match", what, (unsigned long long)rva); return false; }
    MH_STATUS s = MH_CreateHook((void*)(g_base + rva), detour, orig);
    if (s == MH_OK) s = MH_EnableHook((void*)(g_base + rva));
    logf_("hook  %-34s %s", what, s == MH_OK ? "ok" : "FAILED");
    return s == MH_OK;
}

// ---------------------------------------------------------------------------- net mode
// Every question "what kind of game is this" answers "dedicated server" (1). The actor-level version answers
// "standalone" when the actor cannot find its net driver, and a player's controller that hears that once marks
// itself as the LOCAL player's for good, after which the server runs the player's client-side logic itself
// (2.1.1: a 120-second "did I finish loading" timer that dropped the player, conversations that never opened).
static int (*orig_GetNetMode)(void*) = 0;
static int hook_GetNetMode(void*) { return 1; }
static int (*orig_ActorGetNetMode)(void*) = 0;
static int hook_ActorGetNetMode(void*) { return 1; }

// ---------------------------------------------------------------------------- Undaunted 1.6.2 fixes
static void* g_driver = 0;
static void* (*orig_ActorGetNetDriver)(void*) = 0;
static void* hook_ActorGetNetDriver(void* actor) {          // an actor that cannot find its driver gets ours
    void* d = orig_ActorGetNetDriver(actor);
    return d ? d : g_driver;
}
static void (*orig_SetReplicationDriver)(void*, void*) = 0;
static void hook_SetReplicationDriver(void* driver, void*) { orig_SetReplicationDriver(driver, 0); }   // this loader replicates itself
static bool (*orig_IsLevelInitForActor)(void*, void*, void*) = 0;
static bool hook_IsLevelInitForActor(void*, void*, void*) { return true; }
static int hook_IsNetReady(void*, bool) { return 1; }       // never throttle: everything is on this PC
static void* orig_IsNetReady = 0;

static long g_forceReady = 0;
static bool (*orig_HasFinishedLoading)(void*) = 0;
static bool hook_HasFinishedLoading(void* self) {
    bool r = orig_HasFinishedLoading(self);
    if (!r && ++g_forceReady <= 5) logf_("player controller still loading on the server side: answered 'finished' (%ld)", g_forceReady);
    return true;
}
static void* orig_SetupPlayerInput = 0;
static long g_inputSkips = 0;
static void hook_SetupPlayerInput(void*, void*) {          // input bindings exist only on the player's own PC
    if (++g_inputSkips <= 3) logf_("skipped SetupPlayerInputComponent on the server");
}

// Bounty season dates. With no live season the server cannot place the bounty and challenge windows and sends the
// player back to the main menu ("ServerInitializeBounties() - failed to get season dates"). The game's own answer is
// kept whenever it has one. Base component: wide window, as in the 1.6.2 port. Weekly component: a short window around
// today, because an endless season made the weekly-challenge draft loop forever on 2.1.1.
static int64_t ue_now_ticks() {
    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;   // 100 ns since 1601-01-01
    return (int64_t)(t + 504911232000000000ull);                          // 100 ns since 0001-01-01 (FDateTime ticks)
}
static bool (*orig_BountySeasonDates)(void*, void*, int64_t*, int64_t*) = 0;
static bool hook_BountySeasonDates(void* c, void* now, int64_t* s, int64_t* e) {
    if (orig_BountySeasonDates(c, now, s, e)) return true;
    *s = 637450560000000000LL;   // 2021-01-01
    *e = 657647424000000000LL;   // 2085-01-01
    static long n = 0; if (++n <= 3) logf_("bounty season dates: no current season, using 2021-2085");
    return true;
}
static bool (*orig_WeeklySeasonDates)(void*, void*, int64_t*, int64_t*) = 0;
static bool hook_WeeklySeasonDates(void* c, void* now, int64_t* s, int64_t* e) {
    if (orig_WeeklySeasonDates(c, now, s, e)) return true;
    const int64_t day = 864000000000LL;
    int64_t t = ue_now_ticks();
    *s = t - 7 * day; *e = t + 12 * 7 * day;
    static long n = 0; if (++n <= 3) logf_("weekly bounty season dates: no current season, using last week to 12 weeks ahead");
    return true;
}

// The game window is switched over to show the game's view once the first map is up. A server copy has no view
// (no viewport client), and the switch then writes through a null pointer (crash of Oct 11, 21:49).
static void* orig_SwitchGameWindow = 0;
static void hook_SwitchGameWindow(void*) { static long n = 0; if (++n <= 2) logf_("skipped switching the game window to the game view (no view on a server)"); }

// Message boxes would wait for someone to click them (the font warnings at start-up did). On the server each one is
// written to this log and answered the way the engine answers in unattended mode.
static int (*orig_MessageDialogOpen)(int, void*, void*) = 0;
static int hook_MessageDialogOpen(int type, void*, void*) {
    static const int answer[7] = { 5 /*Ok*/, 0 /*No*/, 4 /*Cancel*/, 4, 4, 0 /*No*/, 1 /*Yes*/ };
    int a = (type >= 0 && type <= 6) ? answer[type] : 1;
    char w[96]; where((uintptr_t)__builtin_return_address(0), w, sizeof(w));
    static long n = 0; if (++n <= 20) logf_("message box (type %d) suppressed, answered %d; asked from %s", type, a, w);
    return a;
}

// ---------------------------------------------------------------------------- replication
// The same job Undaunted's Networking.cpp does for 1.4.4 / 1.6.2: every tick, for every connected player, make sure
// each networked actor has a channel and let the engine send what changed.
static void** g_consider = 0; static int g_considerCap = 0;
static uint64_t g_actorChannelName = 0;
static long g_repOpened = 0, g_repSentTick = 0, g_repFailed = 0, g_repTicks = 0;
static double g_repMsTotal = 0;
static bool g_replicate = true;
// DF-REPCAP-1147 (Nov 9): the pass served at most 8 connections (a fixed array), so in a town the 9th player onward
// never received an actor and sat on the loading screen until someone ahead of them left (EU town Nov 9: every
// replication line said 8 players while 12 to 15 were connected). The list now holds 64 (town cap 48). To keep the
// cost per tick where it was, each player's actors are sent every g_repDiv ticks, interleaved, so half the players
// go on even ticks and half on odd (30 updates a second each at 60 ticks, the engine's own default net rate).
// Moves, corrections (SendClientAdjustment) and the player's own controller still go every tick. D1147_REPDIV=1 is
// the old every-tick behaviour; the log line now shows connections total against served.
static int g_repDiv = 2;
static uint32_t g_repFrame = 0;
// [Dauntless Forever] Owner-only actors (a player's own inventory, loadout, bounties and similar) must only go to
// that player, as in 1.6.2's Networking.cpp (Oct 13): sent to everyone, they kept the second player in a server
// from ever finishing loading. Skip bOnlyRelevantToOwner && !bAlwaysRelevant actors unless the connection's
// controller or pawn is in the actor's Owner chain or is its Instigator. Env D1147_OWNER_ONLY=0 turns it off; it
// also turns itself off if a player's character is not owned by its controller (the offsets would be wrong).
static int g_ownerOnly = 1;            // 1 on, 0 off
static bool g_ownerChecked = false;
static long g_ownerSkipped = 0;
static void owner_check(void* pc, void* pawn) {
    if (g_ownerChecked || !pawn || g_ownerOnly != 1) return;
    g_ownerChecked = true;
    void* po = at<void*>((uintptr_t)pawn + A::Actor_Owner);
    if (po != pc) { g_ownerOnly = 0; logf_("owner-only filter OFF: a player's character is not owned by its controller (got %p, want %p); every actor goes to every player", po, pc); }
    else logf_("owner-only filter: check passed (character owned by its controller)");
}
static bool owner_only_skip(void* a, void* pc, void* pawn) {
    if (g_ownerOnly != 1) return false;
    uint8_t b = at<uint8_t>((uintptr_t)a + A::Actor_Bits58);
    if (!(b & A::Bits58_OnlyRelevantToOwner) || (b & A::Bits58_AlwaysRelevant)) return false;
    if (pawn && at<void*>((uintptr_t)a + A::Actor_Instigator) == pawn) return false;
    void* o = a;
    for (int i = 0; o && i < 8; i++) {
        if (o == pc || (pawn && o == pawn)) return false;
        o = at<void*>((uintptr_t)o + A::Actor_Owner);
    }
    return true;
}

// UNetConnection::FindActorChannelRef is inlined everywhere in this build: the same lookup, written out.
static void* find_actor_channel(void* conn, uint64_t weak) {
    uintptr_t m = (uintptr_t)conn + A::Conn_ActorChannels;
    if (at<int32_t>(m + 0x08) == at<int32_t>(m + 0x34)) return 0;          // no elements (all slots free)
    int32_t hashSize = at<int32_t>(m + 0x48);
    if (hashSize <= 0) return 0;
    int32_t* buckets = at<int32_t*>(m + 0x40) ? at<int32_t*>(m + 0x40) : (int32_t*)(m + 0x38);
    int64_t h = ((int64_t)(int32_t)(weak & 0xFFFFFFFF) ^ (int64_t)(int32_t)(weak >> 32)) & (hashSize - 1);
    uint8_t* data = at<uint8_t*>(m);
    int32_t idx = buckets[h];
    for (int guard = 0; idx != -1 && guard < 100000; guard++) {
        uint8_t* el = data + (int64_t)idx * 0x18;
        if (*(uint64_t*)el == weak) return *(void**)(el + 8);
        idx = *(int32_t*)(el + 0x10);
    }
    return 0;
}

// [Dauntless Forever] DF-HIDDENREL (Oct 31): hidden actors are not sent to a player until they are shown, as in the
// engine's AActor::IsNetRelevantFor (hidden, and the root component has no collision -> not relevant, unless always
// relevant or the player's own). Sending them made the player's game create Kharabak's 20 pooled, hidden beams
// (bugbear_beam_bp, owned by scissors_normal_bp); each one starts a free-standing source blast where it is created,
// and those stayed: a pulsing glow at a fixed spot until that Kharabak died (reported Oct 31, solo and Forever).
// The engine's earlier steps are kept, in its order (review by Addison2k, Oct 31): an actor with bNetUseOwnerRelevancy
// and an Owner is as relevant as its Owner, and an actor whose root is attached to a component of another actor (a
// skeletal mesh, or an actor with the same Owner) is as relevant as that actor; the hidden check is only made at the
// end of that chain. So another player's hidden, attached gear (holstered weapon, lantern) still reaches everyone.
// Only a channel that is not open yet is held back; an actor the player already has keeps being sent. Offsets are
// read from the engine's own property list and checked at start; if anything is not where expected the rule turns
// itself off (every actor goes to every player, as before). Env D1147_HIDDEN=0 turns it off.
static void* find_function(void* cls, const wchar_t* name);
static bool class_chain_has(void* cls, const wchar_t* want);
static int g_hiddenRule = 1;
static long g_hiddenSkipped = 0, g_hiddenSkippedTick = 0;   // DF-HELDCOUNT-1147 (Nov 6): per tick too; the total counts every hold on every tick, so it grew without bound
namespace HR {
    const uintptr_t Actor_RootComponent = 0x130;      // UE 4.26 AActor::RootComponent; checked: its Outer must be the actor
    const uintptr_t Struct_ChildProperties = 0x50, FField_Next = 0x20, FField_Name = 0x28, Prop_Offset = 0x4C;   // UE 4.26
    const uintptr_t BoolProp_FieldSize = 0x78, BoolProp_ByteOffset = 0x79, BoolProp_ByteMask = 0x7A;            // FBoolProperty
    const uint64_t  CastFlag_Actor = 0x1000000000ull; // CASTCLASS_AActor (the bit below CASTCLASS_APlayerController)
}
struct HrFn { void* cls; void* fn; };
static HrFn g_hrFns[512];
struct HrCall { void* obj; void* fn; uint8_t parms[16]; };
static void hr_pe(void* arg) { HrCall* c = (HrCall*)arg; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(c->obj, c->fn, c->parms); }
static bool hr_root_collides(void* a) {
    void* root = at<void*>((uintptr_t)a + HR::Actor_RootComponent);
    if (!root) return false;
    if (at<void*>((uintptr_t)root + A::Object_Outer) != a) return true;      // not where expected: treat as relevant (old behaviour)
    void* cls = at<void*>((uintptr_t)root + A::Object_Class);
    if (!cls) return true;
    void* fn = 0; uintptr_t h = ((uintptr_t)cls >> 4) & 511; int i = 0;
    for (; i < 512; i++) { HrFn& e = g_hrFns[(h + i) & 511]; if (e.cls == cls) { fn = e.fn; break; } if (!e.cls) { e.cls = cls; e.fn = fn = find_function(cls, L"IsCollisionEnabled"); break; } }
    if (i == 512) return true;
    if (!fn) return false;                                                      // a plain scene component: no collision
    HrCall c = { root, fn, { 0 } };
    if (!guarded(hr_pe, &c)) return true;
    return c.parms[0] != 0;                                                     // ECollisionEnabled: 0 = NoCollision
}
static bool hr_fname_is(void* name, const wchar_t* want) {
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))(name, &s);
    return s.Data && s.Num > 0 && wcscmp(s.Data, want) == 0;
}
static void* hr_prop(void* cls, const wchar_t* name) {                         // a property (FField) of a class or its parents
    for (int d = 0; cls && d < 32; d++, cls = at<void*>((uintptr_t)cls + A::Struct_Super))
        for (void* p = at<void*>((uintptr_t)cls + HR::Struct_ChildProperties); p; p = at<void*>((uintptr_t)p + HR::FField_Next))
            if (hr_fname_is((void*)((uintptr_t)p + HR::FField_Name), name)) return p;
    return 0;
}
static int g_hrReady = 0;                    // 0 not checked yet, 1 ready, -1 offsets not as expected (rule off)
static int g_hrOwnerRelOff = 0; static uint8_t g_hrOwnerRelMask = 0; static int g_hrAttachOff = 0;
static bool hr_ready(void* a) {
    if (g_hrReady) return g_hrReady > 0;
    void* root = at<void*>((uintptr_t)a + HR::Actor_RootComponent);
    if (!root || at<void*>((uintptr_t)root + A::Object_Outer) != a) return false;   // wait for an actor with a root component
    void* cls = at<void*>((uintptr_t)a + A::Object_Class);
    const char* why = 0;
    void* ph = hr_prop(cls, L"bHidden"), *po = hr_prop(cls, L"bNetUseOwnerRelevancy");
    void* pa = hr_prop(at<void*>((uintptr_t)root + A::Object_Class), L"AttachParent");
    if (!(at<uint64_t>((uintptr_t)cls + A::Class_CastFlags) & HR::CastFlag_Actor)) why = "the actor class flag is not where expected";
    else if (!ph || !po || !pa) why = "bHidden, bNetUseOwnerRelevancy or AttachParent not found";
    else if (at<int32_t>((uintptr_t)ph + HR::Prop_Offset) + at<uint8_t>((uintptr_t)ph + HR::BoolProp_ByteOffset) != (int)A::Actor_Bits58 ||
             at<uint8_t>((uintptr_t)ph + HR::BoolProp_ByteMask) != 0x20 || at<uint8_t>((uintptr_t)ph + HR::BoolProp_FieldSize) != 1)
        why = "bHidden is not at 0x58 bit 0x20";
    else {
        g_hrOwnerRelOff = at<int32_t>((uintptr_t)po + HR::Prop_Offset) + at<uint8_t>((uintptr_t)po + HR::BoolProp_ByteOffset);
        g_hrOwnerRelMask = at<uint8_t>((uintptr_t)po + HR::BoolProp_ByteMask);
        g_hrAttachOff = at<int32_t>((uintptr_t)pa + HR::Prop_Offset);
        if (g_hrOwnerRelOff < 0x28 || g_hrOwnerRelOff > 0x400 || !g_hrOwnerRelMask || g_hrAttachOff < 0x28 || g_hrAttachOff > 0x400) why = "offsets out of range";
    }
    g_hrReady = why ? -1 : 1;
    if (why) logf_("hidden actors: rule OFF (%s); every actor goes to every player as before", why);
    else logf_("hidden actors: bNetUseOwnerRelevancy at 0x%X bit 0x%02X, AttachParent at 0x%X", g_hrOwnerRelOff, g_hrOwnerRelMask, g_hrAttachOff);
    return g_hrReady > 0;
}
static void* hr_comp_owner(void* comp) {                                        // the actor a component belongs to (its Outer chain)
    void* o = at<void*>((uintptr_t)comp + A::Object_Outer);
    for (int i = 0; o && i < 8; i++, o = at<void*>((uintptr_t)o + A::Object_Outer)) {
        void* c = at<void*>((uintptr_t)o + A::Object_Class);
        if (c && (at<uint64_t>((uintptr_t)c + A::Class_CastFlags) & HR::CastFlag_Actor)) return o;
    }
    return 0;
}
struct HrSkel { void* cls; uint8_t skel; };
static HrSkel g_hrSkel[256];
static bool hr_is_skeletal(void* cls) {
    if (!cls) return false;
    uintptr_t h = ((uintptr_t)cls >> 4) & 255;
    for (int i = 0; i < 256; i++) { HrSkel& e = g_hrSkel[(h + i) & 255]; if (e.cls == cls) return e.skel; if (!e.cls) { e.cls = cls; e.skel = class_chain_has(cls, L"SkeletalMeshComponent") ? 1 : 0; return e.skel; } }
    return class_chain_has(cls, L"SkeletalMeshComponent");
}
// The engine's IsNetRelevantFor up to its hidden check: true = not relevant to this player because it is hidden.
// *via gets 1 when an Owner's relevance was used (bNetUseOwnerRelevancy), 2 when an attach parent's owner's was.
static bool hr_hidden_not_relevant(void* a, void* pc, void* pawn, int* via) {
    for (int d = 0; a && d < 8; d++) {
        uint8_t b = at<uint8_t>((uintptr_t)a + A::Actor_Bits58);
        if (b & A::Bits58_AlwaysRelevant) return false;
        if (pawn && (a == pawn || at<void*>((uintptr_t)a + A::Actor_Instigator) == pawn)) return false;
        void* o = a;
        for (int i = 0; o && i < 8; i++) { if (o == pc || (pawn && o == pawn)) return false; o = at<void*>((uintptr_t)o + A::Actor_Owner); }
        void* owner = at<void*>((uintptr_t)a + A::Actor_Owner);
        if (owner && (at<uint8_t>((uintptr_t)a + g_hrOwnerRelOff) & g_hrOwnerRelMask)) { *via |= 1; a = owner; continue; }
        if (b & A::Bits58_OnlyRelevantToOwner) return false;                  // owner-only actors: left to owner_only_skip
        void* root = at<void*>((uintptr_t)a + HR::Actor_RootComponent);
        if (root && at<void*>((uintptr_t)root + A::Object_Outer) == a) {
            void* parent = at<void*>((uintptr_t)root + g_hrAttachOff);
            void* po = parent ? hr_comp_owner(parent) : 0;
            if (po && po != a && (po == owner || hr_is_skeletal(at<void*>((uintptr_t)parent + A::Object_Class)))) { *via |= 2; a = po; continue; }
        }
        if (!(b & 0x20)) return false;                                         // shown
        return !hr_root_collides(a);
    }
    return false;
}
static void hr_note(const char* what, void* a, int via) {                      // one log line per class and outcome
    static void* logged[64]; static int nlogged = 0;
    void* cls = at<void*>((uintptr_t)a + A::Object_Class);
    void* key = (void*)((uintptr_t)cls ^ (uintptr_t)(uint8_t)what[0]);
    for (int i = 0; i < nlogged; i++) if (logged[i] == key) return;
    if (nlogged >= 64) return;
    logged[nlogged++] = key; char n[96];
    logf_("hidden actors %s, e.g. %s%s", what, name_of(cls, n, sizeof(n)),
          via == 1 ? " (as relevant as its owner)" : via == 2 ? " (as relevant as the actor it is attached to)" : via == 3 ? " (via its owner and an attach parent)" : "");
}
static bool hidden_skip(void* conn, void* a, void* pc, void* pawn) {
    if (!g_hiddenRule) return false;
    uint8_t b = at<uint8_t>((uintptr_t)a + A::Actor_Bits58);
    if (!(b & 0x20) || (b & A::Bits58_AlwaysRelevant)) return false;        // shown, or always relevant
    if (!hr_ready(a)) return false;
    uint64_t weak = 0;
    ((void (*)(void*, void*))(g_base + A::WeakPtrAssign))(&weak, a);
    if (find_actor_channel(conn, weak)) return false;                          // the player already has it
    int via = 0;
    if (!hr_hidden_not_relevant(a, pc, pawn, &via)) { if (via) hr_note("sent because of another actor", a, via); return false; }
    g_hiddenSkipped++; g_hiddenSkippedTick++;
    hr_note("held back until shown", a, via);
    return true;
}


// [Dauntless Forever] DF-DESTROYWATCH (Nov 2): a measurement, not a fix. Report 544 (a Chain Blades Reaper's Dance blast,
// enrage flames and a Nayzaga shockwave that never go away on a hunt server) could be the player never being told that
// the effect's actor was destroyed. The replication loop above skips an actor flagged bActorIsBeingDestroyed and leaves
// its channel to the engine. Here the first time a networked actor is seen with that flag it is remembered, and on the
// following ticks its channel on each player's connection is looked up: the log gets one line when the channel is gone
// (and after how long), or one line when it is still open after 5 s, which is the lingering case. At most 48 actors are
// watched per hunt. Env D1147_DESTROYWATCH=0 turns it off.
static int g_destroyWatch = 0;   // ship build: a measurement, off unless D1147_DESTROYWATCH=1
struct DwEntry { uint64_t weak; void* actor; char name[96]; ULONGLONG firstMs; int done; };
static DwEntry g_dw[48]; static int g_dwN = 0; static int g_dwLogged = 0;
static void dw_seen(void* a) {
    if (!g_destroyWatch || g_dwN >= 48) return;
    for (int i = 0; i < g_dwN; i++) if (g_dw[i].actor == a) return;
    DwEntry& e = g_dw[g_dwN++];
    e.actor = a; e.weak = 0; e.firstMs = GetTickCount64(); e.done = 0;
    ((void (*)(void*, void*))(g_base + A::WeakPtrAssign))(&e.weak, a);
    name_of(at<void*>((uintptr_t)a + A::Object_Class), e.name, sizeof(e.name));
    if (g_dwLogged < 60) { g_dwLogged++; logf_("destroy watch: %s is being destroyed (%p), watching its channel", e.name, a); }
}
static void dw_tick(void** ready, int nready) {
    if (!g_destroyWatch) return;
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < g_dwN; i++) {
        DwEntry& e = g_dw[i];
        if (e.done) continue;
        int open = 0;
        for (int c = 0; c < nready; c++) if (find_actor_channel(ready[c], e.weak)) open++;
        if (!open) { e.done = 1; if (g_dwLogged < 60) { g_dwLogged++; logf_("destroy watch: %s (%p): channel closed after %lu ms, the player was told", e.name, e.actor, (unsigned long)(now - e.firstMs)); } }
        else if (now - e.firstMs > 5000) { e.done = 1; if (g_dwLogged < 60) { g_dwLogged++; logf_("destroy watch: %s (%p): channel STILL OPEN after 5 s on %d player(s), the player was never told (lingering effect)", e.name, e.actor, open); } }
    }
}

static void replicate_one(void* conn, void* actor) {
    uint64_t weak = 0;
    ((void (*)(void*, void*))(g_base + A::WeakPtrAssign))(&weak, actor);
    void* ch = find_actor_channel(conn, weak);
    if (!ch) {
        uint64_t name = g_actorChannelName;
        ch = ((void* (*)(void*, uint64_t*, uint32_t, int32_t))(g_base + A::CreateChannelByName))(conn, &name, 2 /*opened locally*/, -1);
        if (!ch) { g_repFailed++; return; }
        ((void (*)(void*, void*, uint32_t))(g_base + A::SetChannelActor))(ch, actor, 0);
        g_repOpened++;
    }
    if (at<uint32_t>((uintptr_t)ch + A::Channel_Bits) & 2) return;        // closing
    if (!at<void*>((uintptr_t)ch + A::Channel_Actor)) return;
    at<uint32_t>((uintptr_t)ch + A::ActorChannel_Bits) |= 2;              // compare every property
    int64_t bits = ((int64_t (*)(void*))(g_base + A::ReplicateActor))(ch);
    if (bits > 0) g_repSentTick++;
}

static void replicate_tick(void* world, void* driver) {
    TArrayRaw& conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    if (conns.Num <= 0 || !conns.Data) return;
    void* ready[64]; int nready = 0;                                        // DF-REPCAP-1147: was 8
    for (int i = 0; i < conns.Num && nready < 64; i++) {
        void* c = conns.Data[i];
        if (!c) continue;
        if (at<uint32_t>((uintptr_t)c + A::Conn_State) != 3) continue;
        if (!at<void*>((uintptr_t)c + A::Conn_OwningActor)) continue;
        ready[nready++] = c;
    }
    if (!nready) return;

    LARGE_INTEGER t0, t1, freq; QueryPerformanceCounter(&t0);
    if (!g_actorChannelName) {
        ((void* (*)(void*, uint32_t))(g_base + A::FNameFromEName))(&g_actorChannelName, A::EName_Actor);
        g_actorChannelName &= 0xFFFFFFFFull;
    }
    at<uint32_t>((uintptr_t)driver + A::Driver_ReplicationFrame)++;
    uint64_t driverName = at<uint64_t>((uintptr_t)driver + A::Driver_NetDriverName);

    // 1. which actors are networked at all
    int n = 0;
    TArrayRaw& levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    for (int li = 0; li < levels.Num; li++) {
        void* level = levels.Data[li];
        if (!level) continue;
        if (!(at<uint8_t>((uintptr_t)level + A::Level_Bits1F4) & 0x20)) continue;      // level not visible yet
        TArrayRaw& actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; ai < actors.Num; ai++) {
            void* a = actors.Data[ai];
            if (!a) continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000) continue;  // being garbage collected
            if (at<uint8_t>((uintptr_t)a + A::Actor_Bits5C) & 0x08) {                   // being destroyed
                if (at<uint8_t>((uintptr_t)a + A::Actor_RemoteRole) != 0) dw_seen(a);     // DF-DESTROYWATCH
                continue; }
            if (at<uint8_t>((uintptr_t)a + A::Actor_RemoteRole) == 0) continue;        // not networked
            if (at<uint64_t>((uintptr_t)a + A::Actor_NetDriverName) != driverName) continue;
            if ((at<uint8_t>((uintptr_t)a + A::Actor_Bits58) & 0x02) && at<uint8_t>((uintptr_t)a + A::Actor_NetDormancy) == 4) continue; // unchanged map actor: the game already has it
            ((void (*)(void*, void*))(g_base + A::CallPreReplication))(a, driver);
            if (n >= g_considerCap) {
                int cap = g_considerCap ? g_considerCap * 2 : 4096;
                void** bigger = (void**)HeapAlloc(GetProcessHeap(), 0, sizeof(void*) * cap);
                if (!bigger) break;
                if (g_consider) { memcpy(bigger, g_consider, sizeof(void*) * n); HeapFree(GetProcessHeap(), 0, g_consider); }
                g_consider = bigger; g_considerCap = cap;
            }
            g_consider[n++] = a;
        }
    }
    g_repSentTick = 0; g_hiddenSkippedTick = 0;

    // 2. each player
    for (int ci = 0; ci < nready; ci++) {
        void* conn = ready[ci];
        void* pc = at<void*>((uintptr_t)conn + A::Conn_OwningActor);
        void* view = pc;
        void* cam = at<void*>((uintptr_t)pc + A::PC_PlayerCameraManager);
        void* pawn = at<void*>((uintptr_t)pc + A::PC_Pawn);
        if (cam && at<void*>((uintptr_t)cam + A::PCM_ViewTargetActor)) view = at<void*>((uintptr_t)cam + A::PCM_ViewTargetActor);
        else if (pawn) view = pawn;
        at<void*>((uintptr_t)conn + A::Conn_ViewTarget) = view;
        ((void (*)(void*))(g_base + A::SendClientAdjustment))(pc);
        replicate_one(conn, pc);                                             // the player's own controller first
        owner_check(pc, pawn);
        if (g_repDiv > 1 && (int)((g_repFrame + (uint32_t)ci) % (uint32_t)g_repDiv) != 0) continue;   // DF-REPCAP-1147: not this player's tick
        for (int i = 0; i < n; i++) {
            void* a = g_consider[i];
            if (a == pc) continue;
            void* cls = at<void*>((uintptr_t)a + A::Object_Class);
            if (cls && (at<uint64_t>((uintptr_t)cls + A::Class_CastFlags) & A::CastFlag_PlayerController)) continue; // other players' controllers
            if (nready > 1 && owner_only_skip(a, pc, pawn)) { g_ownerSkipped++; continue; }   // another player's own actors
            if (hidden_skip(conn, a, pc, pawn)) continue;                       // DF-HIDDENREL: hidden, not sent until shown
            replicate_one(conn, a);
        }
    }
    g_repFrame++;                                                            // DF-REPCAP-1147
    dw_tick(ready, nready);                                                  // DF-DESTROYWATCH
    QueryPerformanceCounter(&t1); QueryPerformanceFrequency(&freq);
    double ms = (double)(t1.QuadPart - t0.QuadPart) * 1000.0 / (double)freq.QuadPart;
    g_repMsTotal += ms; g_repTicks++;
    if (g_repTicks == 1 || g_repTicks == 10 || g_repTicks == 100 || g_repTicks % 600 == 0) {
        logf_("replication: %d player(s) served of %d connection(s), every %d tick(s) each, %d networked actors, %ld sent this tick, %ld channels opened so far, %ld failed, %ld owner-only skipped, %ld hidden held back this tick (%ld holds so far), this tick %.1f ms, average %.1f ms",
              nready, conns.Num, g_repDiv, n, g_repSentTick, g_repOpened, g_repFailed, g_ownerSkipped, g_hiddenSkippedTick, g_hiddenSkipped, ms, g_repMsTotal / (double)g_repTicks);
    }
}

// ---------------------------------------------------------------------------- stamina (Undaunted 1.6.2: TickStamina)
// The player character's stamina is advanced by its blueprint function TickStamina(Where, Whom); nothing calls it on a
// server copy, so stamina never refills and the player cannot sprint. Called here every tick for each player's
// character, with Where = Both (2), Whom = All (5), as Undaunted does.
static bool name_is(void* obj, const wchar_t* want) {
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)((uintptr_t)obj + A::Object_Name), &s);
    return s.Data && s.Num > 0 && wcscmp(s.Data, want) == 0;
}
static void* find_function(void* cls, const wchar_t* name) {
    for (int depth = 0; cls && depth < 32; depth++, cls = at<void*>((uintptr_t)cls + A::Struct_Super)) {
        for (void* f = at<void*>((uintptr_t)cls + A::Struct_Children); f; f = at<void*>((uintptr_t)f + A::Field_Next))
            if (name_is(f, name)) return f;
    }
    return 0;
}
static void* g_staminaClass = 0; static void* g_staminaFn = 0; static long g_staminaCalls = 0;
static bool g_stamina = true;
static void stamina_tick(void* driver) {
    TArrayRaw& conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    for (int i = 0; conns.Data && i < conns.Num && i < 8; i++) {
        void* c = conns.Data[i]; if (!c) continue;
        if (at<uint32_t>((uintptr_t)c + A::Conn_State) != 3) continue;
        void* pc = at<void*>((uintptr_t)c + A::Conn_OwningActor); if (!pc) continue;
        void* pawn = at<void*>((uintptr_t)pc + A::PC_Pawn); if (!pawn) continue;
        if (at<uint32_t>((uintptr_t)pawn + A::Object_Flags) & 0x60000000) continue;
        void* cls = at<void*>((uintptr_t)pawn + A::Object_Class);
        if (cls != g_staminaClass) {
            g_staminaClass = cls; g_staminaFn = find_function(cls, L"TickStamina");
            char a[128]; logf_("stamina: character class %s %s", name_of(cls, a, sizeof(a)), g_staminaFn ? "has TickStamina; the server ticks it" : "has NO TickStamina");
        }
        if (!g_staminaFn) continue;
        uint8_t parms[2] = { 2 /*Both*/, 5 /*All*/ };
        ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(pawn, g_staminaFn, parms);
        g_staminaCalls++;
    }
}

// ---------------------------------------------------------------------------- listening
struct FURL { FString Protocol; FString Host; int32_t Port; int32_t Valid; FString Map; FString RedirectUrl; void* OpData; int32_t OpNum; int32_t OpMax; FString Portal; };

// [Dauntless Forever] DF-MOVEDISC-1147 (Nov 3; reports 512, 515, 519, 526, 558, 572: "rubber banding", "the game
// teleports me back and I get hit", an escalation vent throwing the player to the start). On a hunt server this is
// the engine's own speed-hack correction, not lag. AGameNetworkManager compares the time a client says passed between
// its moves with the server's clock; once the gap is past 0.25 s it "resolves" it by throttling that client's moves
// and forcing position corrections for a while, which the player feels as being pulled back, and the engine log shows
// as "ServerMove: TimeStamp expired" bursts about every 15 s. Detection is left ON so reports keep saying whether the
// gap happens; resolution and the forced corrections are switched OFF on the manager the world made. Offsets come from
// this build's own property list (Dumper-7, CL 647472): UWorld::NetworkManager 0x58; on AGameNetworkManager
// bMovementTimeDiscrepancyDetection 0x2AC, bMovementTimeDiscrepancyResolution 0x2AD, MaxTimeMargin 0x2B0,
// MinTimeMargin 0x2B4, ResolutionRate 0x2B8, DriftAllowance 0x2BC, bMovementTimeDiscrepancyForceCorrectionsDuring
// Resolution 0x2C0. The class is checked by name and the values read first; if they do not look like the engine's
// (two 0/1 bytes, margins within 100 s) nothing is written. Set again if the world makes a new manager.
// D1147_MOVEDISC=0 leaves the engine as it is.
// ---------------------------------------------------------------------------- DF-BIGMOVE-1147 (Nov 7)
// The hunt server warning "UCapsuleComponent::MoveComponentImpl: Large movement was detected without the teleport flag
// set" (1000 of them in five fall reports, 657 in one) is printed by the exe's own override at +0x3CA1A60 when ONE move
// is over 5000 units (50 m, |delta|^2 > 25,000,000), has no teleport flag, and the capsule is not at the world origin;
// it then calls the normal move with the same arguments. So the warning is a symptom: something relocated a capsule
// 50 m in one step. This watch says WHO: for a player capsule moved over 50 m (teleport or not) it logs from, to,
// sweep, teleport, flags and the exe return addresses (the exe's own unwind data), so one test run names the game code
// that relocates players during a fall. Log only, nothing changed. D1147_BIGMOVE=0 off. 300 lines per server copy.
static int g_bigMove = 1;
static volatile LONG g_bigMoveN = 0, g_bigMoveAll = 0, g_bigMoveOther = 0;
static bool (*orig_CapMove)(void*, const float*, const void*, bool, void*, uint32_t, uint8_t) = 0;
static const char* name_of(void* obj, char* out, int n);
static void bigmove_note(void* comp, const float* d, bool sweep, uint32_t flags, uint8_t tp) {
    void* owner = at<void*>((uintptr_t)comp + 0x20);                     // A::Object_Outer: the actor that owns the capsule
    char on[128]; name_of(owner, on, sizeof(on));
    if (!strstr(on, "PlayerCharacter")) { InterlockedIncrement(&g_bigMoveOther); return; }
    const LONG all = InterlockedIncrement(&g_bigMoveAll);
    if (InterlockedIncrement(&g_bigMoveN) > 300) return;
    const float* from = (const float*)((uintptr_t)comp + 0x11C);          // USceneComponent::RelativeLocation (root: world)
    void* fr[12] = { 0 }; USHORT got = RtlCaptureStackBackTrace(0, 12, fr, 0);
    char stack[256]; int k = 0; stack[0] = 0;
    for (USHORT i = 0; i < got && k < (int)sizeof(stack) - 16; i++) {
        uintptr_t a = (uintptr_t)fr[i];
        if (a > g_base && a < g_base + 0x8000000) k += snprintf(stack + k, sizeof(stack) - k, " %llX", (unsigned long long)(a - g_base));
    }
    logf_("big move #%ld: %s  from %.0f %.0f %.0f  to %.0f %.0f %.0f  (%.0f m)  sweep %d  teleport %d  flags %u  callers%s",
          all, on, from[0], from[1], from[2], from[0] + d[0], from[1] + d[1], from[2] + d[2],
          sqrtf(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / 100.0f, (int)sweep, (int)tp, flags, stack);
}
// ---------------------------------------------------------------------------- DF-FALLSAFE-1147 (Nov 7, v2)
// The endless fall, caught by DF-BIGMOVE on Addison's PC (Nov 7 19:18, Radiant escalation, solo): the game's own fall
// rescue is a Blueprint on a timer (about every 4.3 s) that calls AActor::K2_TeleportTo with fixed points that have no
// floor on our servers, so the player drops 170 m and the rescue fires again, forever (25 rescues in 90 s). "I'm stuck"
// (AActor::K2_SetActorTransform) sent him to the first round's start, 745 m away, also over nothing.
// This keeps, per player, a SAFE place: where the server saw them standing (CharacterMovement MovementMode 1 Walking or
// 2 NavWalking) after 1.5 s of standing or walking without a break, taken from 1 s back, so it is never the very edge
// they stepped off and never the spot a teleport just dropped them on. When a Blueprint K2_TeleportTo or
// K2_SetActorTransform is called on a player who is more than 30 m below that place, or aimed at a point that already
// dropped a player 30 m, it goes to that place 1.5 m up instead and their fall speed is set to zero. v1 (BCBBADCB, Nov 7
// 19:32) took the last standing frame (the ledge edge) and kept the fall speed, so players slid off again.
// Players standing normally are never touched. Round changes, respawns and engine teleports do not use these two
// functions. Everything is dropped when the world changes. Every change is logged. D1147_FALLSAFE=0 turns it off.
static int g_fallSafe = 1;
struct FsSample { ULONGLONG t; float p[3]; };
struct FsPlayer { void* actor; void* cls; float safe[3]; bool has; float pend[3]; ULONGLONG pendAt; ULONGLONG walkSince; ULONGLONG quietUntil; FsSample ring[16]; int ringN; };
static FsPlayer g_fsP[32]; static int g_fsPN = 0;
struct FsKind { void* actor; void* cls; int8_t player; };
static FsKind g_fsKind[1024]; static int g_fsKindN = 0;
static float g_fsBad[16][3]; static int g_fsBadN = 0;
static void* g_fsWorld = 0;
static volatile LONG g_fsFixed = 0;
static void fs_world_check() {
    void* w = at<void*>(g_base + A::GWorld);
    if (w != g_fsWorld) { g_fsWorld = w; g_fsPN = 0; g_fsBadN = 0; memset(g_fsKind, 0, sizeof(g_fsKind)); g_fsKindN = 0; }
}
static bool fs_is_player(void* actor) {
    void* cls = at<void*>((uintptr_t)actor + A::Object_Class);
    uintptr_t h = (((uintptr_t)actor >> 4) ^ ((uintptr_t)actor >> 13)) & 1023;
    for (int i = 0; i < 1024; i++) {
        FsKind& k = g_fsKind[(h + i) & 1023];
        if (k.actor == actor && k.cls == cls) return k.player == 1;
        if (!k.actor) {
            if (g_fsKindN > 900) { memset(g_fsKind, 0, sizeof(g_fsKind)); g_fsKindN = 0; return fs_is_player(actor); }
            char nm[128]; name_of(actor, nm, sizeof(nm));
            k.actor = actor; k.cls = cls; k.player = strstr(nm, "PlayerCharacter") ? 1 : 0; g_fsKindN++;
            return k.player == 1;
        }
    }
    return false;
}
static FsPlayer* fs_player(void* actor, bool make) {
    void* cls = at<void*>((uintptr_t)actor + A::Object_Class);
    for (int i = 0; i < g_fsPN; i++) if (g_fsP[i].actor == actor && g_fsP[i].cls == cls) return &g_fsP[i];
    if (!make || g_fsPN >= 32) return 0;
    FsPlayer* q = &g_fsP[g_fsPN++]; memset(q, 0, sizeof(*q)); q->actor = actor; q->cls = cls; return q;
}
static float fs_dist2(const float* a, const float* b) { float x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; }
// after a capsule move: keep the safe place; learn teleport points that drop players
static void fs_after_move(void* comp) {
    void* actor = at<void*>((uintptr_t)comp + A::Object_Outer);
    if (!actor) return;
    fs_world_check();
    if (!fs_is_player(actor)) return;
    if (at<void*>((uintptr_t)actor + 0x290) != comp) return;              // ACharacter::CapsuleComponent: the character's own capsule
    FsPlayer* q = fs_player(actor, true); if (!q) return;
    const ULONGLONG now = GetTickCount64();
    const float* loc = (const float*)((uintptr_t)comp + 0x11C);           // USceneComponent::RelativeLocation (root: world)
    void* cmc = at<void*>((uintptr_t)actor + 0x288);                      // ACharacter::CharacterMovement
    const uint8_t mode = cmc ? at<uint8_t>((uintptr_t)cmc + 0x168) : 0;   // MovementMode: 1 Walking, 2 NavWalking, 3 Falling
    if ((mode == 1 || mode == 2) && now >= q->quietUntil) {
        if (!q->walkSince) { q->walkSince = now; q->ringN = 0; }
        if (!q->ringN || now - q->ring[(q->ringN - 1) & 15].t >= 200) { FsSample& s = q->ring[q->ringN & 15]; s.t = now; memcpy(s.p, loc, 12); q->ringN++; }
        if (now - q->walkSince >= 1500) {                                 // 1.5 s on the ground without a break: take where they were 1 s ago
            for (int i = q->ringN - 1; i >= 0 && i >= q->ringN - 16; i--) {
                const FsSample& s = q->ring[i & 15];
                if (s.t >= q->walkSince && now - s.t >= 1000) { memcpy(q->safe, s.p, 12); q->has = true; break; }
            }
        }
    } else { q->walkSince = 0; q->ringN = 0; }
    if (q->pendAt) {
        if (now - q->pendAt > 6000) q->pendAt = 0;
        else if (loc[2] < q->pend[2] - 3000.0f) {
            bool known = false; for (int i = 0; i < g_fsBadN; i++) if (fs_dist2(g_fsBad[i], q->pend) < 250000.0f) known = true;
            if (!known && g_fsBadN < 16) {
                memcpy(g_fsBad[g_fsBadN++], q->pend, 12);
                logf_("fall safe: the point %.0f %.0f %.0f has no floor on this server (a player dropped 30 m after a teleport there); teleports there now go to the player's safe place", q->pend[0], q->pend[1], q->pend[2]);
            }
            q->pendAt = 0;
        }
    }
}
// decides for one Blueprint relocation of a player: 0 = leave it, 1 = send to 'to', 2 = already there, skip it
static int fs_decide(void* actor, const float* dest, const char* how, float* to) {
    if (!g_fallSafe || !actor || !dest) return 0;
    fs_world_check();
    void* root = at<void*>((uintptr_t)actor + 0x130);                      // AActor::RootComponent
    FsPlayer* q = (root && fs_is_player(actor)) ? fs_player(actor, false) : 0;
    if (!q || !q->has) return 0;
    const float* cur = (const float*)((uintptr_t)root + 0x11C);
    if (fs_dist2(dest, cur) < 250000.0f) return 0;                        // a move under 5 m (abilities, small fixes) is never touched
    const bool fell = cur[2] < q->safe[2] - 3000.0f;
    bool bad = false; for (int i = 0; i < g_fsBadN; i++) if (fs_dist2(g_fsBad[i], dest) < 250000.0f) bad = true;
    const ULONGLONG now = GetTickCount64();
    q->quietUntil = now + 1000;                                            // the landing spot of any relocation is not a safe place by itself
    q->walkSince = 0; q->ringN = 0;
    if (!fell && !bad) { memcpy(q->pend, dest, 12); q->pendAt = now; return 0; }
    q->pendAt = 0;
    to[0] = q->safe[0]; to[1] = q->safe[1]; to[2] = q->safe[2] + 150.0f;
    char nm[128]; name_of(actor, nm, sizeof(nm));
    const LONG n = InterlockedIncrement(&g_fsFixed);
    void* cmc = at<void*>((uintptr_t)actor + 0x288);
    if (cmc) { float* v = (float*)((uintptr_t)cmc + 0xC4); v[0] = v[1] = v[2] = 0.0f; }   // UMovementComponent::Velocity: no fall speed carried over
    if (fs_dist2(to, cur) < 40000.0f) {
        if (n <= 200) logf_("fall safe #%ld: %s is already at its safe place; the %s to %.0f %.0f %.0f is skipped", n, nm, how, dest[0], dest[1], dest[2]);
        return 2;
    }
    if (n <= 200) logf_("fall safe #%ld: %s %s to %.0f %.0f %.0f goes to its safe place %.0f %.0f %.0f instead (%s; it was at %.0f %.0f %.0f)",
                        n, nm, how, dest[0], dest[1], dest[2], to[0], to[1], to[2], fell ? "it fell more than 30 m below that place" : "that point has no floor here", cur[0], cur[1], cur[2]);
    return 1;
}
static bool (*orig_K2Tele)(void*, float*, float*) = 0;
static bool hook_K2Tele(void* actor, float* dest, float* rot) {
    float to[3]; const int d = fs_decide(actor, dest, "rescue teleport", to);
    if (d == 2) return true;
    if (d == 1) { float mine[3] = { to[0], to[1], to[2] }; return orig_K2Tele(actor, mine, rot); }
    return orig_K2Tele(actor, dest, rot);
}
static bool (*orig_K2SetXform)(void*, const float*, bool, void*, bool) = 0;
static bool hook_K2SetXform(void* actor, const float* xf, bool sweep, void* hit, bool teleport) {
    float to[3]; const int d = fs_decide(actor, xf ? xf + 4 : 0, "\"I'm stuck\" move", to);   // FTransform: rotation 0x00, translation 0x10, scale 0x20
    if (d == 2) return true;
    if (d == 1) { alignas(16) float mine[12]; memcpy(mine, xf, 48); mine[4] = to[0]; mine[5] = to[1]; mine[6] = to[2]; return orig_K2SetXform(actor, mine, sweep, hit, teleport); }
    return orig_K2SetXform(actor, xf, sweep, hit, teleport);
}
static bool hook_CapMove(void* comp, const float* d, const void* rot, bool sweep, void* hit, uint32_t flags, uint8_t tp) {
    if (g_bigMove && d && comp && d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 25000000.0f) bigmove_note(comp, d, sweep, flags, tp);
    const bool r = orig_CapMove(comp, d, rot, sweep, hit, flags, tp);
    if (g_fallSafe && comp) fs_after_move(comp);
    return r;
}
// Measured on report 573 (Enryaku, Nov 3): with this on, 0 "TimeStamp expired" against 21 in his session before it,
// while detection still logged 6 times, which is the point: the engine still notices, it just stops pulling anyone back.
// The "alive" line also reports how the server's world clock ran against the wall clock since the last one
// (GetGameTimeSinceCreation on the manager against QueryPerformanceCounter), to answer why the gap builds up at all:
// a ratio under 1.00 means this server's world clock runs slow and every client looks fast to it. On report 573 it
// read 1.0002, so that PC's server kept perfect time and the drift was on the client's side.
namespace MD { const uintptr_t World_NetworkManager = 0x58, Detection = 0x2AC, Resolution = 0x2AD, MaxMargin = 0x2B0,
               MinMargin = 0x2B4, Rate = 0x2B8, Drift = 0x2BC, Force = 0x2C0; }
static int g_moveDisc = 1;
static void* g_mdApplied = 0;
static void* g_mdFn = 0;
static double g_mdWall = 0; static float g_mdGame = 0; static int g_mdClockLines = 0;
static bool call_float(void* obj, void* fn, float* out);
static void* fn_cached(void* obj, const wchar_t* name, void** cache);
static void movedisc_tick(void* world) {
    if (!g_moveDisc || !world) return;
    void* nm = at<void*>((uintptr_t)world + MD::World_NetworkManager);
    if (!nm || nm == g_mdApplied) return;
    g_mdApplied = nm;
    void* cls = at<void*>((uintptr_t)nm + A::Object_Class);
    char cn[96]; name_of(cls, cn, sizeof(cn));
    if (!cls || !class_chain_has(cls, L"GameNetworkManager")) { logf_("move checker: the world's network manager is a %s, not a GameNetworkManager; left alone", cn); return; }
    uint8_t det = at<uint8_t>((uintptr_t)nm + MD::Detection), res = at<uint8_t>((uintptr_t)nm + MD::Resolution), frc = at<uint8_t>((uintptr_t)nm + MD::Force);
    float mx = at<float>((uintptr_t)nm + MD::MaxMargin), mn = at<float>((uintptr_t)nm + MD::MinMargin), rate = at<float>((uintptr_t)nm + MD::Rate), drift = at<float>((uintptr_t)nm + MD::Drift);
    logf_("move checker as the engine made it (%s): detection %d, resolution %d, forced corrections %d, margins %.3f / %.3f s, rate %.2f, drift allowance %.3f", cn, det, res, frc, mx, mn, rate, drift);
    if (det > 1 || res > 1 || frc > 1 || !(mx > -100.0f && mx < 100.0f) || !(mn > -100.0f && mn < 100.0f)) { logf_("move checker: those values are not what the engine's layout should give; NOTHING changed (DF-MOVEDISC-1147 off for this world)"); return; }
    at<uint8_t>((uintptr_t)nm + MD::Resolution) = 0;
    at<uint8_t>((uintptr_t)nm + MD::Force) = 0;
    logf_("move checker: resolution OFF, forced corrections OFF, detection left %s (DF-MOVEDISC-1147: the engine no longer pulls players back for clock drift)", det ? "on" : "off");
    g_mdWall = 0; g_mdGame = 0; g_mdFn = 0;
}
static void movedisc_clock(void* world) {
    if (!world) return;
    void* nm = at<void*>((uintptr_t)world + MD::World_NetworkManager);
    if (!nm || nm != g_mdApplied) return;
    float game = 0;
    if (!call_float(nm, fn_cached(nm, L"GetGameTimeSinceCreation", &g_mdFn), &game)) return;
    LARGE_INTEGER t, f; QueryPerformanceCounter(&t); QueryPerformanceFrequency(&f);
    double wall = (double)t.QuadPart / (double)f.QuadPart;
    if (g_mdWall > 0 && g_mdClockLines < 200) {
        double dw = wall - g_mdWall, dg = (double)(game - g_mdGame);
        if (dw > 1.0) { g_mdClockLines++; logf_("server clock: world +%.3f s per wall +%.3f s, ratio %.4f (%s)", dg, dw, dg / dw, dg / dw < 0.995 ? "world clock SLOW: clients look fast to this server" : dg / dw > 1.005 ? "world clock FAST" : "in step"); }
    }
    g_mdWall = wall; g_mdGame = game;
}

static int g_state = 0;            // 0 waiting for a world, 1 world seen, 2 listening, 3 failed
static ULONGLONG g_worldSeenAt = 0;
static void* g_worldSeen = 0;
static int32_t g_lastConns = 0;

static void* context_of(void* engine, void* world) {
    TArrayRaw& list = at<TArrayRaw>((uintptr_t)engine + A::Engine_WorldList);
    for (int i = 0; list.Data && i < list.Num && i < 32; i++) {
        void* ctx = list.Data[i];
        if (ctx && at<void*>((uintptr_t)ctx + A::Context_World) == world) return ctx;
    }
    return 0;
}

static void do_listen(void* world) {
    void* engine = at<void*>(g_base + A::GEngine);
    logf_("listen: engine %p world %p", engine, world);
    if (!engine) { logf_("listen: no engine object"); g_state = 3; return; }

    uint64_t name = 0;
    ((void* (*)(void*, uint32_t))(g_base + A::FNameFromEName))(&name, A::EName_GameNetDriver);
    name &= 0xFFFFFFFFull;   // comparison index, number 0
    uint8_t created = ((uint8_t (*)(void*, void*, uint64_t, uint64_t))(g_base + A::CreateNamedNetDriver))(engine, world, name, name);
    logf_("listen: net driver create = %d", (int)created);

    void* ctx = context_of(engine, world);
    void* driver = 0;
    if (ctx) {
        void** arr = at<void**>((uintptr_t)ctx + A::Context_ActiveNetDrivers);
        int32_t n = at<int32_t>((uintptr_t)ctx + A::Context_ActiveNetDrivers + 8);
        logf_("listen: world context %p has %d active net driver(s)", ctx, n);
        for (int i = 0; i < n && i < 16; i++) {
            void* d = arr[i * 2];
            if (!d) continue;
            uintptr_t vt = at<uintptr_t>((uintptr_t)d) - g_base;
            char cn[128];
            logf_("listen:   driver %p class %s vtable +0x%llX%s name-id 0x%X", d, name_of(at<void*>((uintptr_t)d + A::Object_Class), cn, sizeof(cn)),
                  (unsigned long long)vt, vt == A::IpNetDriverVTable ? " (IpNetDriver)" : "", at<uint32_t>((uintptr_t)d + A::Driver_NetDriverName));
            if (at<uint32_t>((uintptr_t)d + A::Driver_NetDriverName) == (uint32_t)name) driver = d;
        }
    } else logf_("listen: no world context found for this world");
    if (!driver) { logf_("listen: no game net driver was created; stopping here"); g_state = 3; return; }

    ((void (*)(void*, void*))(g_base + A::NetDriverSetWorld))(driver, world);

    FURL url; memset(&url, 0, sizeof(url));
    url.Port = g_port; url.Valid = 1;
    FString err = { 0, 0, 0 };
    void** vt = at<void**>((uintptr_t)driver);
    bool ok = ((bool (*)(void*, void*, FURL*, bool, FString*))vt[A::VT_InitListen / 8])(driver, (void*)((uintptr_t)world + A::World_NetworkNotify), &url, false, &err);
    logf_("listen: InitListen on port %d = %d", g_port, (int)ok);
    if (err.Data && err.Num > 0) { char m[512]; WideCharToMultiByte(CP_UTF8, 0, err.Data, -1, m, sizeof(m), 0, 0); logf_("listen: engine says: %s", m); }
    if (!ok) { g_state = 3; return; }

    ((void (*)(void*, void*))(g_base + A::NetDriverSetWorld))(driver, world);
    at<void*>((uintptr_t)world + A::World_NetDriver) = driver;
    g_driver = driver;
    g_state = 2;
    logf_("replication driver object on the net driver: %p (expected: none)", at<void*>((uintptr_t)driver + A::Driver_ReplicationDriver));
    logf_("LISTENING on UDP port %d", g_port);
}

// ---------------------------------------------------------------------------- hidden players (2.1.1 lesson)
// If the server marks a connected player's character hidden (the game does that on the player's own screen while
// talking to a townsperson), the mark is sent to the player and nothing takes it back. Such requests are logged
// and not carried out; a character that ends up hidden anyway is shown again after a few seconds.
static void (*orig_SetHidden)(void*, bool) = 0;
static bool g_hideHooked = false;
static long g_hideNotes = 0, g_localFlagNotes = 0;
static bool is_player_pawn(void* actor) {
    if (!g_driver || !actor) return false;
    TArrayRaw& conns = at<TArrayRaw>((uintptr_t)g_driver + A::Driver_ClientConnections);
    for (int i = 0; conns.Data && i < conns.Num && i < 64; i++) {
        void* c = conns.Data[i]; if (!c) continue;
        void* pc = at<void*>((uintptr_t)c + A::Conn_OwningActor); if (!pc) continue;
        if (at<void*>((uintptr_t)pc + A::PC_Pawn) == actor) return true;
    }
    return false;
}
static void hook_SetHidden(void* actor, bool hide) {
    if (hide && GetCurrentThreadId() == g_gameThread && is_player_pawn(actor)) {
        char nm[128];
        if (++g_hideNotes <= 20) logf_("hide: the server was asked to HIDE the player's character '%s' - not done", name_of(actor, nm, sizeof(nm)));
        return;
    }
    orig_SetHidden(actor, hide);
}
struct HideSlot { void* pawn; bool hidden; ULONGLONG since; };
static HideSlot g_hideSlots[8];
static void player_watch(void* driver) {
    TArrayRaw& conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    ULONGLONG now = GetTickCount64();
    for (int i = 0; conns.Data && i < conns.Num && i < 8; i++) {
        void* c = conns.Data[i]; if (!c) continue;
        void* pc = at<void*>((uintptr_t)c + A::Conn_OwningActor); if (!pc) continue;
        if (at<uint8_t>((uintptr_t)pc + A::PC_IsLocalFlag)) {
            char nm[128];
            if (++g_localFlagNotes <= 10) logf_("net mode: controller '%s' had marked itself as a LOCAL player's controller; mark removed", name_of(pc, nm, sizeof(nm)));
            at<uint8_t>((uintptr_t)pc + A::PC_IsLocalFlag) = 0;
        }
        void* pawn = at<void*>((uintptr_t)pc + A::PC_Pawn);
        HideSlot& s = g_hideSlots[i];
        if (!pawn) { s.pawn = 0; continue; }
        if (at<uint32_t>((uintptr_t)pawn + A::Object_Flags) & 0x60000000) continue;
        if (!g_hideHooked) {
            g_hideHooked = true;
            uintptr_t fn = (uintptr_t)at<void**>((uintptr_t)pawn)[A::VT_SetActorHiddenInGame / 8];
            if (fn > g_base && fn < g_base + 0x5000000) {
                MH_STATUS st = MH_CreateHook((void*)fn, (void*)hook_SetHidden, (void**)&orig_SetHidden);
                if (st == MH_OK) st = MH_EnableHook((void*)fn);
                logf_("hide: watching requests to hide a player's character (function at exe+0x%llX, hook %d)", (unsigned long long)(fn - g_base), (int)st);
                if (st != MH_OK) orig_SetHidden = 0;
            }
        }
        bool hidden = (at<uint8_t>((uintptr_t)pawn + A::Actor_Bits58) & 0x20) != 0;
        char nm[128];
        if (pawn != s.pawn) { s.pawn = pawn; s.hidden = hidden; s.since = now; logf_("player's character '%s' is %s on the server", name_of(pawn, nm, sizeof(nm)), hidden ? "HIDDEN" : "visible"); continue; }
        if (hidden != s.hidden) { s.hidden = hidden; s.since = now; logf_("player's character '%s' became %s on the server", name_of(pawn, nm, sizeof(nm)), hidden ? "HIDDEN" : "visible"); }
        if (hidden && orig_SetHidden && now - s.since > 4000) { logf_("hide: still hidden after 4 seconds; showing the character again"); orig_SetHidden(pawn, false); s.since = now; }
    }
}

// ---------------------------------------------------------------------------- progression configuration (2.1.1 lesson)
// A player's progression data waits for the game-wide progression configuration, which the game asks the backend
// for from its menus; a server has no menus, so it is asked for here (twice: at listen and 20 seconds later).
static bool g_progOk = true;
static int g_progAsks = 0;
static ULONGLONG g_progAskAt = 0;
static void prog_ask(void* gi) {
    uint64_t noDelegate[2] = { 0, 0 };   // "tell nobody in particular": the game instance announces the result itself
    ((void (*)(void*, void*))(g_base + A::QueryHuntPassSeason))(gi, noDelegate);
}
static void progression_tick(void* world) {
    if (!g_progOk || g_progAsks >= 2) return;
    ULONGLONG now = GetTickCount64();
    if (g_progAsks == 1 && now - g_progAskAt < 20000) return;
    void* gi = at<void*>((uintptr_t)world + A::World_GameInstance);
    if (!gi) return;
    char a[128], b[128];
    g_progAsks++; g_progAskAt = now;
    logf_("progression: asking the backend for the progression configuration (request %d, game instance '%s' of class %s)", g_progAsks,
          name_of(gi, a, sizeof(a)), name_of(at<void*>((uintptr_t)gi + A::Object_Class), b, sizeof(b)));
    if (!guarded(prog_ask, gi)) { logf_("progression: the request could not be made; leaving progression alone"); g_progOk = false; }
}

// ---------------------------------------------------------------------------- DF-TUNING-1147 (Nov 9): the event schedule
// The game fetches three tuning files (huntpass_xp_config, seasonal_event_schedule, island_content_config) through
// UTuningDataProvider::RequestTuningData (exe+0x1E0CC50), called only from the sign-in-complete handler (exe+0x190C960:
// provider = GameInstance+0x7F0, world = GameInstance::GetWorld, third argument a zeroed 16-byte slot). A server never
// signs in, so the town never had the seasonal event schedule, and every quest with an EventId (Frostfall, the Silver
// Sword, Ramsgiving...) stayed "Unavailable" on the server even when the backend said the event was running
// (game_server_loaded_quest_status Nov 9: 17 quests available, no Frostfall). Made here like the progression request:
// at listen and 20 seconds later. D1147_TUNING=0 turns it off; it also turns itself off when the function is not where
// expected or the call faults.
static bool g_tuningOk = true;
static int g_tuningAsks = 0;
static ULONGLONG g_tuningAskAt = 0;
static void* g_tuningWorld = 0;
static void tuning_ask(void* gi) {
    void* provider = at<void*>((uintptr_t)gi + A::GI_TuningProvider);
    if (!provider) { logf_("tuning: the game instance has no tuning data provider yet"); return; }
    uint64_t slot[2] = { 0, 0 };
    ((void (*)(void*, void*, void*))(g_base + A::TuningRequest))(provider, g_tuningWorld, slot);
}
static void tuning_tick(void* world) {
    if (!g_tuningOk || g_tuningAsks >= 2) return;
    ULONGLONG now = GetTickCount64();
    if (g_tuningAsks == 1 && now - g_tuningAskAt < 20000) return;
    void* gi = at<void*>((uintptr_t)world + A::World_GameInstance);
    if (!gi) return;
    g_tuningAsks++; g_tuningAskAt = now; g_tuningWorld = world;
    logf_("tuning: asking the backend for the tuning data (event schedule, hunt pass XP, island content), request %d", g_tuningAsks);
    if (!guarded(tuning_ask, gi)) { logf_("tuning: the request faulted; leaving tuning alone"); g_tuningOk = false; }
}

static void lore_release_tick();   // DF-LOREWAIT-1147, below cw_process_event's helpers


// ---------------------------------------------------------------------------- DF-VENDOR-1147 (Nov 10): actors placed in town
// Spawns fixed actors in the town server, once per world, from <D1147_DIR>\data\vendor.txt. One actor per line:
//     <class path> <x> <y> <z> <yaw> [scale]
// e.g. the Vault interactable (World/interactable/prestige_store_bp, opens the Prestige store screen) and a standing
// slayer (Blueprints/BP_PlayerCharacter, no controller). Server-side, so they replicate to every player like any
// other actor. The spawn path is the ally chat's, proven Nov 1: StaticLoadObject for the class, then
// UGameplayStatics::BeginDeferredActorSpawnFromClass + FinishSpawningActor through ProcessEvent.
// Town only (the world's package must contain "ramsgate"). Nothing happens without the file. D1147_VENDOR=0 turns it off.
namespace VD {
    const uintptr_t StaticLoadObject = 0x2889220;
    const uintptr_t GUObjectArray    = 0x6E59EC0;
}
struct VdXform { float Q[4]; float T[3]; float Tpad; float S[3]; float Spad; };
static void* g_vdGS = 0, *g_vdBegin = 0, *g_vdFinish = 0;
static void* g_vdWorld = 0;
static bool g_vdOff = false;
static int g_vdTries = 0;
struct VdFind { void* out; };
static void vd_find_gs(void* arg) {
    VdFind* f = (VdFind*)arg;
    uintptr_t arr = g_base + VD::GUObjectArray;
    uintptr_t w = at<uintptr_t>(arr + 0x20);
    int32_t num = (int32_t)(w >> 32);
    uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    if (num <= 0 || num > 20000000 || !chunks) return;
    for (int32_t i = 0; i < num; i++) {
        uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(i >> 16)); if (!chunk) continue;
        uintptr_t o = at<uintptr_t>(chunk + 0x18 * (uintptr_t)(i & 0xFFFF)); if (!o) continue;
        if (name_is((void*)o, L"Default__GameplayStatics")) { f->out = (void*)o; return; }
    }
}
struct VdLoad { void* type; const wchar_t* path; void* out; };
static void vd_load_obj(void* arg) {
    VdLoad* l = (VdLoad*)arg;
    l->out = ((void* (*)(void*, void*, const wchar_t*, const wchar_t*, uint32_t, void*, bool, void*))(g_base + VD::StaticLoadObject))(
        l->type, 0, l->path, 0, 0, 0, true, 0);
}
struct VdSpawn { void* world; void* cls; void* ctrl; VdXform x; void* actor; void* mesh; void* ctrlNow; bool still; };
static void* g_vdDisableMove = 0, *g_vdSetRep = 0;
static void vd_do_spawn(void* arg) {
    VdSpawn* v = (VdSpawn*)arg;
    alignas(16) uint8_t b[0x60]; memset(b, 0, sizeof(b));
    *(void**)(b + 0x00) = v->world;
    *(void**)(b + 0x08) = v->cls;
    memcpy(b + 0x10, &v->x, 0x30);
    b[0x40] = 1;                                         // AlwaysSpawn
    ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(g_vdGS, g_vdBegin, b);
    void* a = *(void**)(b + 0x50);
    if (!a) return;
    if (v->ctrl) {                                       // the slayer bot's recipe: possessed on spawn, so the game sets him up
        at<uint8_t>((uintptr_t)a + 0x231) = 2;           // APawn::AutoPossessAI = Spawned
        at<void*>((uintptr_t)a + 0x238) = v->ctrl;       // APawn::AIControllerClass
    }
    alignas(16) uint8_t f[0x50]; memset(f, 0, sizeof(f));
    *(void**)(f + 0x00) = a;
    memcpy(f + 0x10, &v->x, 0x30);
    ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(g_vdGS, g_vdFinish, f);
    void* done = *(void**)(f + 0x40);
    v->actor = done ? done : a;
    // Generic NPC blueprints (farslayers, guards, orrery...) ship with bReplicates false, so players never see them.
    // AActor::SetReplicates(true) after the spawn makes the server send them like any other actor.
    if (!g_vdSetRep) g_vdSetRep = find_function(at<void*>((uintptr_t)v->actor + A::Object_Class), L"SetReplicates");
    if (g_vdSetRep) { uint8_t rp[16] = { 1 }; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(v->actor, g_vdSetRep, rp); }
    // Pawn/Character fields are only read when a controller was asked for (then the actor is a Character). Reading
    // them on a plain NPC actor (vendor_interactive_bp) read whatever sits there and crashed the town (Tressa, Nov 10).
    if (!v->ctrl) return;
    void* meshComp = at<void*>((uintptr_t)v->actor + 0x280);              // ACharacter::Mesh
    if (meshComp) v->mesh = at<void*>((uintptr_t)meshComp + 0x478);      // USkinnedMeshComponent::SkeletalMesh
    v->ctrlNow = at<void*>((uintptr_t)v->actor + 0x258);                 // APawn::Controller
    void* move = at<void*>((uintptr_t)v->actor + 0x288);                  // ACharacter::CharacterMovement
    if (move) {                                                // keep him on his spot
        if (!g_vdDisableMove) g_vdDisableMove = find_function(at<void*>((uintptr_t)move + A::Object_Class), L"DisableMovement");
        if (g_vdDisableMove) { uint8_t none[16] = { 0 }; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(move, g_vdDisableMove, none); v->still = true; }
    }
}
static void vendor_tick(void* world) {
    if (g_vdOff || world == g_vdWorld) return;
    if (GetTickCount64() - g_worldSeenAt < 8000) return;            // let the town finish loading
    g_vdWorld = world;                                              // once per world, whatever happens below
    { wchar_t e[8]; if (GetEnvironmentVariableW(L"D1147_VENDOR", e, 8) && e[0] == L'0') { g_vdOff = true; logf_("vendor: off (D1147_VENDOR=0)"); return; } }
    char pk[256]; name_of(at<void*>((uintptr_t)world + A::Object_Outer), pk, sizeof(pk));
    { char low[256]; int i = 0; for (; pk[i] && i < 255; i++) low[i] = (char)tolower((unsigned char)pk[i]); low[i] = 0;
      if (!strstr(low, "ramsgate")) return; }
    wchar_t dir[MAX_PATH] = L"."; if (!GetEnvironmentVariableW(L"D1147_DIR", dir, MAX_PATH)) wcscpy(dir, L".");
    wchar_t file[MAX_PATH + 32]; swprintf(file, MAX_PATH + 32, L"%ls\\data\\vendor.txt", dir);
    FILE* fh = _wfopen(file, L"rt, ccs=UTF-8");
    if (!fh) { logf_("vendor: no data\\vendor.txt, nothing placed"); return; }
    if (!g_vdGS) {
        VdFind vf = { 0 };
        if (!guarded(vd_find_gs, &vf) || !vf.out) { logf_("vendor: GameplayStatics not found - stopping"); fclose(fh); g_vdOff = true; return; }
        g_vdGS = vf.out;
        void* gsCls = at<void*>((uintptr_t)g_vdGS + A::Object_Class);
        g_vdBegin = find_function(gsCls, L"BeginDeferredActorSpawnFromClass");
        g_vdFinish = find_function(gsCls, L"FinishSpawningActor");
        if (!g_vdBegin || !g_vdFinish) { logf_("vendor: spawn functions missing - stopping"); fclose(fh); g_vdOff = true; return; }
    }
    void* uclass = at<void*>((uintptr_t)at<void*>((uintptr_t)g_vdGS + A::Object_Class) + A::Object_Class);   // the class of a class
    wchar_t line[512]; int n = 0;
    while (fgetws(line, 512, fh) && n < 24) {
        wchar_t path[400], cpath[400]; float x, y, z, yaw, sc = 1.0f; cpath[0] = 0;
        if (line[0] != L'/') continue;
        int got = swscanf(line, L"%399ls %f %f %f %f %f %399ls", path, &x, &y, &z, &yaw, &sc, cpath);
        if (got < 5) { logf_("vendor: skipped a line (need: path x y z yaw [scale])"); continue; }
        n++;
        VdLoad l = { uclass, path, 0 };
        if (!guarded(vd_load_obj, &l) || !l.out) { logf_("vendor: %ls did not load", path); continue; }
        VdSpawn v; memset(&v, 0, sizeof(v)); v.world = world; v.cls = l.out;
        if (got >= 7 && cpath[0] == L'/') {
            VdLoad lc = { uclass, cpath, 0 };
            if (guarded(vd_load_obj, &lc) && lc.out) v.ctrl = lc.out; else logf_("vendor: controller %ls did not load", cpath);
        }
        float h = yaw * 3.14159265f / 360.0f;
        v.x.Q[2] = sinf(h); v.x.Q[3] = cosf(h);
        v.x.T[0] = x; v.x.T[1] = y; v.x.T[2] = z;
        v.x.S[0] = v.x.S[1] = v.x.S[2] = sc;
        bool ok = guarded(vd_do_spawn, &v);
        char a[200];
        char m[200], c[200];
        logf_("vendor: %ls at %.1f %.1f %.1f yaw %.1f -> %s", path, x, y, z, yaw,
              !ok ? "CRASHED (caught)" : v.actor ? name_of(v.actor, a, sizeof(a)) : "(nothing came back)");
        if (ok && v.actor && v.ctrl)
            logf_("vendor:    mesh %s, controller %s%s", v.mesh ? name_of(v.mesh, m, sizeof(m)) : "(none)",
                  v.ctrlNow ? name_of(v.ctrlNow, c, sizeof(c)) : "(none)", v.still ? ", movement off" : "");
    }
    fclose(fh);
    if (++g_vdTries > 20) g_vdOff = true;
}

// DF-ACTWATCH-1147 (Nov 12, report 760): LOG ONLY, nothing in the game is changed. A player used Tempest as its charges
// ran out: his hunt server refused the activation (prediction key 3632 on both sides) and he reported that Tempest
// never ran out afterwards. To see what each side holds at that moment, an ability activation is written to the log
// with the ability's class, how many copies of it are running, and every Tempest effect on the player (stack count,
// prediction key, seconds left). Server copies: every refused activation and every Omnicell ("player_role") one, in
// server_<port>.log. Player's game: the same for the request it sends, the server's answer, and 1 s and 5 s after a
// refusal, in d1147_dxgi.log. Lines start "ability watch:". D1147_ACTWATCH=0 turns it off.
// Layout (CL647472 class dump): ASC.ActivatableAbilities.Items +0x4F8 (0xE0 each: Handle +0x0C, Ability +0x10,
// ActiveCount +0x28); ASC.ActiveGameplayEffects.GameplayEffects_Internal +0x998 (0x368 each: Spec.Def +0x18,
// Spec.Duration +0x68, Spec.StackCount +0x1D8, PredictionKey.Current +0x2B8).
namespace AW {
    const uintptr_t Specs = 0x4F8, SpecSize = 0xE0, SpecHandle = 0x0C, SpecAbility = 0x10, SpecActive = 0x28;
    const uintptr_t Effects = 0x998, EffSize = 0x368, EffDef = 0x18, EffDuration = 0x68, EffStack = 0x1D8, EffKey = 0x2B8;
}
static int aw_on(void) {
    static int on = -1;
    if (on < 0) { char v[8]; on = (GetEnvironmentVariableA("D1147_ACTWATCH", v, sizeof(v)) && v[0] == '0') ? 0 : 1; }
    return on;
}
static void aw_state(void* asc, uint32_t handle, char* out, int n, bool* role) {
    char an[96]; an[0] = '?'; an[1] = 0; int active = -1;
    const uintptr_t a = (uintptr_t)asc;
    uintptr_t d = at<uintptr_t>(a + AW::Specs); int sn = at<int32_t>(a + AW::Specs + 8);
    if (d && sn > 0 && sn <= 512)
        for (int i = 0; i < sn; i++) {
            const uintptr_t sp = d + (uintptr_t)i * AW::SpecSize;
            if (at<uint32_t>(sp + AW::SpecHandle) != handle) continue;
            void* ab = at<void*>(sp + AW::SpecAbility); if (ab) name_of(ab, an, sizeof(an));
            active = at<uint8_t>(sp + AW::SpecActive); break;
        }
    if (role) *role = strstr(an, "player_role") != 0;
    const char* shortAn = strncmp(an, "Default__", 9) == 0 ? an + 9 : an;
    d = at<uintptr_t>(a + AW::Effects); int en = at<int32_t>(a + AW::Effects + 8);
    int w = snprintf(out, n, "%.48s running=%d, effects=%d", shortAn, active, en);
    if (w < 0 || w >= n) return;
    int shown = 0;
    if (d && en > 0 && en <= 512)
        for (int i = 0; i < en && w < n - 64 && shown < 3; i++) {
            const uintptr_t ef = d + (uintptr_t)i * AW::EffSize;
            void* def = at<void*>(ef + AW::EffDef); if (!def) continue;
            char dn[96]; name_of(def, dn, sizeof(dn));
            if (!strstr(dn, "tempest") && !strstr(dn, "windfury")) continue;
            const char* sd = strncmp(dn, "Default__", 9) == 0 ? dn + 9 : dn;
            int k = snprintf(out + w, n - w, " [%.34s x%d key %d, %.0f s]", sd, at<int32_t>(ef + AW::EffStack), (int)at<int16_t>(ef + AW::EffKey), at<float>(ef + AW::EffDuration));
            if (k < 0 || k >= n - w) { out[w] = 0; break; }
            w += k; shown++;
        }
    if (!shown && w < n - 24) snprintf(out + w, n - w, " [no Tempest effect]");
}

#include "equipment_bridge.h"

// ---------------------------------------------------------------------------- the engine tick
// ---------------------------------------------------------------------------- DF-DOWNWATCH-1147 (Nov 13, report 800)
// Server copies only. A player knocked out on a hunt server sometimes stayed up at 0 health and kept fighting (report
// 800; the old reports 553, 554, 592). The knock-out is UArchonBleedoutComponent's work (the character's
// BleedoutComponent, +0x878): health reaches 0 -> ServerTryStartBleedout -> (unless a replacement effect takes it) the
// no-health gameplay effect is applied (handle +0x160) and CurrentBleedoutState (+0xB0) becomes Bleedout. Three parts:
//  1. Watch. For every connected player: health (AArchonCharacter::GetHealth), the bleed-out state, whether the
//     no-health effect is on, the movement mode. Written once a second while it matters (health at or under 30 %,
//     downed, or 10 s after any change), and one "ALIVE AT 0 HP" line when health is 0 or less and the player has not
//     been downed for 2 s (6 s while the game's own finishing hit is running). A character is only judged after it
//     has been seen with health above 0, so one that is still being set up after joining is left alone.
//  2. Preload. The game loads the no-health effect class in the middle of every knock-out ("Tried to knock out ... before
//     the no-health gameplay effect finished async loading") because a server started from a client build never ran the
//     preload. When a player's character is first seen its effect class is loaded with the engine's own
//     FSoftObjectPtr::LoadSynchronous (exe+0xEFAA10) and kept loaded (root flag in the engine's object list).
//  3. Safety net. At the ALIVE AT 0 HP line the game's own knock-out is run again (ServerTryStartBleedout). If the
//     player is still up 1.5 s later, the bleed-out is put on directly: the bleed-out time from the game mode, the
//     no-health effect (ApplyNoHealthGameplayEffectToSelf) when it is not on, and AuthSetBleedoutState(Bleedout).
// Every engine call is fenced. D1147_DOWNWATCH=0 turns all of it off, D1147_DOWNNET=0 the safety net only,
// D1147_DOWNPRELOAD=0 the preload only. Log lines start "down watch:".
namespace DW {
    const uintptr_t Char_Bleedout = 0x878, Char_Movement = 0x288, Move_Mode = 0x168;                 // CL647472 class dump
    const uintptr_t Bo_State = 0xB0, Bo_Duration = 0xB4, Bo_Effect = 0xB8, Bo_FinishingHit = 0x130, Bo_Replacements = 0x148, Bo_Handle = 0x160, Bo_Ready = 0x170;
    const uintptr_t LoadSynchronous = 0xEFAA10;
}
static int g_dwOn = -1, g_dwNet = 1, g_dwPreload = 1; static long g_dwLines = 0, g_dwAlarms = 0;
struct DwCall { void* obj; void* fn; void* p; };
static void dw_call(void* a) { DwCall* c = (DwCall*)a; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(c->obj, c->fn, c->p); }
static bool dw_pe(void* obj, void* fn, void* p) { if (!obj || !fn) return false; DwCall c = { obj, fn, p }; return guarded(dw_call, &c); }
static void* g_dwCharCls = 0, *g_dwFnHealth = 0, *g_dwFnMax = 0, *g_dwFnBleeding = 0;
static void* g_dwBoCls = 0, *g_dwFnTry = 0, *g_dwFnApply = 0, *g_dwFnSet = 0; static bool g_dwBoOk = false;
static void* g_dwGmCls = 0; static int g_dwGmOff = 0;
static void* g_dwKept[8]; static int g_dwKeptN = 0;
struct DwP { void* pawn; ULONGLONG nextAt, zeroAt, stageAt, lastLine, hotUntil; int stage; int lastState, lastHandle, lastZero; bool alive; };
static DwP g_dwP[64];
static void dw_init() {
    char v[8];
    g_dwOn = !(GetEnvironmentVariableA("D1147_DOWNWATCH", v, sizeof(v)) && v[0] == '0');
    g_dwNet = !(GetEnvironmentVariableA("D1147_DOWNNET", v, sizeof(v)) && v[0] == '0');
    g_dwPreload = !(GetEnvironmentVariableA("D1147_DOWNPRELOAD", v, sizeof(v)) && v[0] == '0');
    static const uint8_t e[25] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x48, 0x89, 0x7C, 0x24, 0x20, 0x41, 0x56, 0x48, 0x83, 0xEC, 0x20, 0x48, 0x8B, 0xF9, 0xE8 };
    if (g_dwPreload && memcmp((void*)(g_base + DW::LoadSynchronous), e, sizeof(e)) != 0) { g_dwPreload = 0; logf_("down watch: preload off, the game code at +0x%llX is not what was expected", (unsigned long long)DW::LoadSynchronous); }
    if (!g_dwOn) logf_("down watch: off (D1147_DOWNWATCH=0)");
    else logf_("down watch: on (report 800): players at 0 health who are not downed are logged%s%s", g_dwNet ? " and knocked out again" : ", safety net off (D1147_DOWNNET=0)", g_dwPreload ? "; the no-health effect is loaded ahead of time" : "; preload off");
}
struct DwLoad { void* soft; void* out; };
static void dw_load(void* a) { DwLoad* l = (DwLoad*)a; l->out = ((void* (*)(void*))(g_base + DW::LoadSynchronous))(l->soft); }
static void dw_preload(void* comp, const char* who) {
    if (!g_dwPreload) return;
    if (!at<uint64_t>((uintptr_t)comp + DW::Bo_Effect + 0x10)) return;                 // the soft path is empty: this character has no such effect
    DwLoad l = { (void*)((uintptr_t)comp + DW::Bo_Effect), 0 };
    if (!guarded(dw_load, &l)) { logf_("down watch: loading the no-health effect for %s was cut short", who); return; }
    void* cls = l.out;
    if (!cls || !readable((uintptr_t)cls, 0x30)) { logf_("down watch: the no-health effect of %s did not load", who); return; }
    for (int i = 0; i < g_dwKeptN; i++) if (g_dwKept[i] == cls) return;
    uintptr_t arr = g_base + VD::GUObjectArray;
    int32_t num = (int32_t)(at<uintptr_t>(arr + 0x20) >> 32); uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    int32_t idx = at<int32_t>((uintptr_t)cls + 0x0C);
    bool kept = false;
    if (chunks && idx >= 0 && idx < num) {
        uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(idx >> 16));
        uintptr_t item = chunk ? chunk + 0x18 * (uintptr_t)(idx & 0xFFFF) : 0;
        if (item && at<uintptr_t>(item) == (uintptr_t)cls) { __sync_fetch_and_or((volatile LONG*)(item + 8), (LONG)0x40000000); kept = true; }   // EInternalObjectFlags::RootSet
    }
    if (g_dwKeptN < 8) g_dwKept[g_dwKeptN++] = cls;
    char n[128]; logf_("down watch: no-health effect %s loaded ahead of time (first seen on %s)%s", name_of(cls, n, sizeof(n)), who, kept ? " and kept loaded" : "; it could NOT be marked to stay loaded");
}
static bool dw_is(void* cls, const wchar_t* want) { for (int d = 0; cls && d < 32; d++, cls = at<void*>((uintptr_t)cls + A::Struct_Super)) if (name_is(cls, want)) return true; return false; }
static void dw_say(DwP& s, const char* who, float hp, float maxHp, int state, bool bleeding, int handle, int fin, int ready, int mode, ULONGLONG now) {
    s.lastLine = now;
    if (g_dwLines++ > 8000) return;
    logf_("down watch: %s health %.0f of %.0f, downed %s (state %d, bleeding out %d, no-health effect %s, finishing hit %d, ready %d), movement mode %d", who, hp, maxHp,
          (state == 1 || bleeding) ? "YES" : "no", state, (int)bleeding, handle == -1 ? "off" : "on", fin, ready, mode);
}
static void down_watch(void* world, void* driver) {
    if (g_dwOn < 0) dw_init();
    if (!g_dwOn) return;
    const ULONGLONG now = GetTickCount64();
    TArrayRaw& conns = at<TArrayRaw>((uintptr_t)driver + A::Driver_ClientConnections);
    for (int i = 0; conns.Data && i < conns.Num && i < 64; i++) {
        DwP& s = g_dwP[i];
        if (now < s.nextAt) continue;
        s.nextAt = now + 1000;
        void* c = conns.Data[i]; if (!c) continue;
        if (at<uint32_t>((uintptr_t)c + A::Conn_State) != 3) continue;
        void* pc = at<void*>((uintptr_t)c + A::Conn_OwningActor); if (!pc) continue;
        void* pawn = at<void*>((uintptr_t)pc + A::PC_Pawn); if (!pawn || !readable((uintptr_t)pawn, 0x880)) continue;
        if (at<uint32_t>((uintptr_t)pawn + A::Object_Flags) & 0x60000000) continue;
        void* cls = at<void*>((uintptr_t)pawn + A::Object_Class);
        if (cls != g_dwCharCls) {
            g_dwCharCls = cls; g_dwFnHealth = find_function(cls, L"GetHealth"); g_dwFnMax = find_function(cls, L"GetMaxHealth"); g_dwFnBleeding = find_function(cls, L"GetIsBleedingOut");
            if (!dw_is(cls, L"ArchonCharacter")) g_dwFnHealth = 0;
            char a[128]; logf_("down watch: character class %s %s", name_of(cls, a, sizeof(a)), g_dwFnHealth ? "has GetHealth" : "is not an ArchonCharacter; not watched");
        }
        if (!g_dwFnHealth) continue;
        void* comp = at<void*>((uintptr_t)pawn + DW::Char_Bleedout); if (!comp || !readable((uintptr_t)comp, 0x180)) continue;
        void* bcls = at<void*>((uintptr_t)comp + A::Object_Class);
        if (bcls != g_dwBoCls) {
            g_dwBoCls = bcls; g_dwBoOk = dw_is(bcls, L"ArchonBleedoutComponent");
            g_dwFnTry = g_dwBoOk ? find_function(bcls, L"ServerTryStartBleedout") : 0; g_dwFnApply = g_dwBoOk ? find_function(bcls, L"ApplyNoHealthGameplayEffectToSelf") : 0; g_dwFnSet = g_dwBoOk ? find_function(bcls, L"AuthSetBleedoutState") : 0;
            char a[128]; logf_("down watch: bleed-out component %s: %s (ServerTryStartBleedout %s, ApplyNoHealthGameplayEffectToSelf %s, AuthSetBleedoutState %s)", name_of(bcls, a, sizeof(a)),
                  g_dwBoOk ? "ok" : "NOT an ArchonBleedoutComponent, players are not watched", g_dwFnTry ? "found" : "MISSING", g_dwFnApply ? "found" : "MISSING", g_dwFnSet ? "found" : "MISSING");
        }
        if (!g_dwBoOk) continue;
        char who[128]; name_of(pawn, who, sizeof(who));
        if (s.pawn != pawn) { memset(&s, 0, sizeof(s)); s.pawn = pawn; s.nextAt = now + 1000; s.lastState = -1; s.lastHandle = 0x7FFFFFFF; s.lastZero = -1; dw_preload(comp, who); }
        alignas(16) uint8_t q[16]; memset(q, 0, sizeof(q));
        if (!dw_pe(pawn, g_dwFnHealth, q)) continue;
        float hp; memcpy(&hp, q, 4);
        float maxHp = 0.0f; memset(q, 0, sizeof(q)); if (dw_pe(pawn, g_dwFnMax, q)) memcpy(&maxHp, q, 4);
        bool bleeding = false; memset(q, 0, sizeof(q)); if (dw_pe(pawn, g_dwFnBleeding, q)) bleeding = q[0] != 0;
        const int state = at<uint8_t>((uintptr_t)comp + DW::Bo_State), handle = at<int32_t>((uintptr_t)comp + DW::Bo_Handle);
        const int fin = at<uint8_t>((uintptr_t)comp + DW::Bo_FinishingHit), ready = at<uint8_t>((uintptr_t)comp + DW::Bo_Ready);
        void* mc = at<void*>((uintptr_t)pawn + DW::Char_Movement); const int mode = (mc && readable((uintptr_t)mc, 0x170)) ? at<uint8_t>((uintptr_t)mc + DW::Move_Mode) : -1;
        const bool downed = state == 1 || bleeding;
        const int zero = !(hp > 0.0f);
        const bool changed = state != s.lastState || handle != s.lastHandle || zero != s.lastZero;
        const bool first = s.lastState < 0;
        s.lastState = state; s.lastHandle = handle; s.lastZero = zero;
        if (changed) s.hotUntil = now + 10000;
        const bool hot = downed || zero || (maxHp > 0.0f && hp <= maxHp * 0.3f) || now < s.hotUntil;
        if (hot) s.nextAt = now + 250;
        if (first || changed || (hot && now - s.lastLine >= 1000)) dw_say(s, who, hp, maxHp, state, bleeding, handle, fin, ready, mode, now);
        // ---- alive at 0 health
        if (!zero) s.alive = true;                                             // judged only once it has been seen with health (not while it is still being set up)
        if (!zero || downed || !s.alive) {
            if (s.stage > 0) logf_("down watch: %s is %s now (after step %d of the safety net)", who, downed ? "downed" : "above 0 health", s.stage);
            s.zeroAt = 0; s.stage = 0; continue;
        }
        if (!s.zeroAt) { s.zeroAt = now; continue; }
        if (s.stage == 0 && now - s.zeroAt > (ULONGLONG)(fin ? 6000 : 2000)) {
            char reps[300]; int rn = 0; reps[0] = 0;
            uintptr_t rd = at<uintptr_t>((uintptr_t)comp + DW::Bo_Replacements); int rc = at<int32_t>((uintptr_t)comp + DW::Bo_Replacements + 8);
            for (int k = 0; rd && k < rc && k < 4 && rn < 220; k++) { void* ro = at<void*>(rd + 0x10 * (uintptr_t)k); char rnm[96];
                if (ro && readable((uintptr_t)ro, 0x30)) rn += snprintf(reps + rn, sizeof(reps) - rn, " %s", name_of(at<void*>((uintptr_t)ro + A::Object_Class), rnm, sizeof(rnm))); }
            g_dwAlarms++;
            logf_("down watch: ALIVE AT 0 HP: %s has had health %.0f for %.1f s and is not downed (state %d, no-health effect %s, finishing hit %d, ready %d, movement mode %d, %d replacement effect(s):%s) - case %ld on this server",
                  who, hp, (now - s.zeroAt) / 1000.0, state, handle == -1 ? "off" : "on", fin, ready, mode, rc, rn ? reps : " none", g_dwAlarms);
            s.stage = 1; s.stageAt = now;
            if (!g_dwNet) { s.stage = 3; continue; }
            bool ok = dw_pe(comp, g_dwFnTry, 0);
            logf_("down watch: safety net step 1 for %s: the game's own knock-out was run again (%s)", who, ok ? "ServerTryStartBleedout" : "the call FAILED");
            continue;
        }
        if (s.stage == 1 && now - s.stageAt > 1500) {
            void* gm = at<void*>((uintptr_t)world + A::World_AuthorityGameMode);
            if (gm && readable((uintptr_t)gm, 0x548)) {
                void* gc = at<void*>((uintptr_t)gm + A::Object_Class);
                if (gc != g_dwGmCls) { g_dwGmCls = gc; void* f = hr_prop(gc, L"BleedoutDuration"); int o = f ? at<int32_t>((uintptr_t)f + 0x4C) : 0; g_dwGmOff = (o > 0 && o < 0x2000) ? o : 0; }
                if (g_dwGmOff) { float d = at<float>((uintptr_t)gm + g_dwGmOff); if (d > 0.0f && d < 600.0f) at<float>((uintptr_t)comp + DW::Bo_Duration) = d; }
            }
            bool a = true; if (handle == -1) a = dw_pe(comp, g_dwFnApply, 0);
            alignas(16) uint8_t st[8]; memset(st, 0, sizeof(st)); st[0] = 1;                    // EArchonBleedoutState::Bleedout
            bool b = dw_pe(comp, g_dwFnSet, st);
            logf_("down watch: safety net step 2 for %s: bleed-out put on directly (no-health effect %s, AuthSetBleedoutState %s, bleed-out time %.1f s)", who,
                  handle != -1 ? "was already on" : a ? "applied" : "FAILED", b ? "called" : "FAILED", at<float>((uintptr_t)comp + DW::Bo_Duration));
            s.stage = 2; s.stageAt = now; continue;
        }
        if (s.stage == 2 && now - s.stageAt > 1500) { logf_("down watch: %s is STILL up at 0 health after both steps; nothing more is tried for this case", who); s.stage = 3; }
    }
}

static long g_ticks = 0;
static void (*orig_Tick)(void*, float, bool) = 0;
static void hook_Tick(void* engine, float dt, bool idle) {
    orig_Tick(engine, dt, idle);
    g_ticks++;
    void* world = at<void*>(g_base + A::GWorld);
    if (g_ticks == 1) logf_("first engine tick; world %p", world);
    if (!world) return;
    if (world != g_worldSeen) {
        g_worldSeen = world; g_worldSeenAt = GetTickCount64();
        char a[256], b[256], c[256];
        void* gm = at<void*>((uintptr_t)world + A::World_AuthorityGameMode);
        logf_("world is live: %p (tick %ld)  world '%s' in package '%s'", world, g_ticks, name_of(world, a, sizeof(a)), name_of(at<void*>((uintptr_t)world + A::Object_Outer), b, sizeof(b)));
        logf_("   game mode: %s   flags: client %d server %d", gm ? name_of(at<void*>((uintptr_t)gm + A::Object_Class), c, sizeof(c)) : "(none)", (int)at<uint8_t>(g_base + A::GIsClient), (int)at<uint8_t>(g_base + A::GIsServer));
        if (g_state == 2 || g_state == 3) { logf_("the world was replaced (the engine dropped the old net driver); listening again in 3 seconds"); g_driver = 0; g_lastConns = 0; g_repTicks = 0; g_repMsTotal = 0; }
        g_state = 1;
    }
    if (g_state == 1 && GetTickCount64() - g_worldSeenAt > 3000) do_listen(world);
    if (g_state == 2 && g_driver) {
        bool registered = false;
        void* ctx = context_of(at<void*>(g_base + A::GEngine), world);
        if (ctx) {
            void** arr = at<void**>((uintptr_t)ctx + A::Context_ActiveNetDrivers);
            int32_t n = at<int32_t>((uintptr_t)ctx + A::Context_ActiveNetDrivers + 8);
            for (int i = 0; arr && i < n && i < 16; i++) if (arr[i * 2] == g_driver) registered = true;
        }
        if (!registered) {
            logf_("the engine removed the net driver; listening again in 3 seconds");
            g_driver = 0; g_lastConns = 0; g_repTicks = 0; g_repMsTotal = 0; g_state = 1; g_worldSeenAt = GetTickCount64();
            return;
        }
        at<void*>((uintptr_t)g_driver + A::Driver_Notify) = (void*)((uintptr_t)world + A::World_NetworkNotify);
        at<void*>((uintptr_t)world + A::World_NetDriver) = g_driver;
        int32_t conns = at<int32_t>((uintptr_t)g_driver + A::Driver_ClientConnections + 8);
        if (conns != g_lastConns) { logf_("client connections: %d -> %d (tick %ld)", g_lastConns, conns, g_ticks); g_lastConns = conns; if (conns == 0) { g_repTicks = 0; g_repMsTotal = 0; } }
        movedisc_tick(world);                                                // DF-MOVEDISC-1147
        player_watch(g_driver);
        down_watch(world, g_driver);                                         // DF-DOWNWATCH-1147
        if (g_replicate) replicate_tick(world, g_driver);
        if (g_stamina) stamina_tick(g_driver);
        progression_tick(world);
        tuning_tick(world);                                                  // DF-TUNING-1147
        lore_release_tick();                                                  // DF-LOREWAIT-1147
        vendor_tick(world);                                                  // DF-VENDOR-1147
        if (g_ticks % 3600 == 0) { logf_("alive: tick %ld, %d client connection(s)", g_ticks, conns); movedisc_clock(world); }   // DF-MOVEDISC-1147: clock line
    }
}

// ---------------------------------------------------------------------------- stay out of sight
// A client build always creates its game window, even with -nullrhi. On a server copy that window would appear,
// take the keyboard focus from the game the player is using and block clicks until alt-tab. Every request to show
// or bring forward a window of this process is turned into "keep hidden".
static BOOL (WINAPI* orig_ShowWindow)(HWND, int) = 0;
static BOOL WINAPI hook_ShowWindow(HWND h, int) { return orig_ShowWindow(h, SW_HIDE); }
static BOOL (WINAPI* orig_SetForegroundWindow)(HWND) = 0;
static BOOL WINAPI hook_SetForegroundWindow(HWND) { return TRUE; }
static BOOL (WINAPI* orig_SetWindowPos)(HWND, HWND, int, int, int, int, UINT) = 0;
static BOOL WINAPI hook_SetWindowPos(HWND h, HWND after, int x, int y, int cx, int cy, UINT f) {
    f &= ~SWP_SHOWWINDOW; f |= SWP_NOACTIVATE;
    if (after == HWND_TOP || after == HWND_TOPMOST) f |= SWP_NOZORDER;
    return orig_SetWindowPos(h, after, x, y, cx, cy, f);
}
static HWND (WINAPI* orig_CreateWindowExW)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID) = 0;
static HWND WINAPI hook_CreateWindowExW(DWORD ex, LPCWSTR cls, LPCWSTR name, DWORD style, int x, int y, int w, int h, HWND parent, HMENU menu, HINSTANCE inst, LPVOID param) {
    if (!parent) { style &= ~WS_VISIBLE; ex |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW; ex &= ~WS_EX_APPWINDOW; }
    return orig_CreateWindowExW(ex, cls, name, style, x, y, w, h, parent, menu, inst, param);
}
// Mouse and focus: the hidden window must never take the player's mouse. A game window confines the cursor to
// itself, captures the mouse, registers raw mouse input and re-centres the cursor; on an invisible server window
// that leaves the player's clicks going nowhere while the server starts. In server mode all of that is a no-op.
static BOOL (WINAPI* orig_ClipCursor)(const RECT*) = 0;
static BOOL WINAPI hook_ClipCursor(const RECT*) { return TRUE; }
static HWND (WINAPI* orig_SetCapture)(HWND) = 0;
static HWND WINAPI hook_SetCapture(HWND) { return 0; }
static BOOL (WINAPI* orig_RegisterRawInputDevices)(PCRAWINPUTDEVICE, UINT, UINT) = 0;
static BOOL WINAPI hook_RegisterRawInputDevices(PCRAWINPUTDEVICE, UINT, UINT) { return TRUE; }
static BOOL (WINAPI* orig_SetCursorPos)(int, int) = 0;
static BOOL WINAPI hook_SetCursorPos(int, int) { return TRUE; }
static HWND (WINAPI* orig_SetFocus)(HWND) = 0;
static HWND WINAPI hook_SetFocus(HWND) { return 0; }
static HWND (WINAPI* orig_SetActiveWindow)(HWND) = 0;
static HWND WINAPI hook_SetActiveWindow(HWND) { return 0; }

// Sound: Dauntless plays its sound through Wwise, which ignores -nosound. 2c-fix3 refused the Windows audio-device
// list outright and Wwise crashed (a refused list is something Windows never does). 2c-fix4 hands Wwise a working
// device list that is simply empty - "this PC has no speakers", a normal state on servers and virtual machines -
// so Wwise has no output device and stays silent. Deliberately not the per-app mute: Windows can remember that
// setting per program path, and the player's game is the same exe.
static const GUID kClsidMMDeviceEnumerator = { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const GUID kIidUnknown              = { 0x00000000, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };
static const GUID kIidMMDeviceEnumerator   = { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const GUID kIidMMDeviceCollection   = { 0x0BD7A1BE, 0x7A1A, 0x44DB, { 0x83, 0x97, 0xCC, 0x53, 0x92, 0x38, 0x7B, 0x5E } };
static const HRESULT kNotFound = (HRESULT)0x80070490;      // HRESULT_FROM_WIN32(ERROR_NOT_FOUND): "no such device"
static volatile LONG g_audioFaked = 0;
static void audio_note(const char* what) { if (InterlockedIncrement(&g_audioFaked) <= 6) logf_("sound: %s (server copies stay silent)", what); }

// Plain COM objects written out by hand (vtable order as in mmdeviceapi.h). Both are static and never freed.
struct EmptyCollection;
struct EmptyCollectionVtbl {
    HRESULT (STDMETHODCALLTYPE* QueryInterface)(EmptyCollection*, REFIID, void**);
    ULONG   (STDMETHODCALLTYPE* AddRef)(EmptyCollection*);
    ULONG   (STDMETHODCALLTYPE* Release)(EmptyCollection*);
    HRESULT (STDMETHODCALLTYPE* GetCount)(EmptyCollection*, UINT*);
    HRESULT (STDMETHODCALLTYPE* Item)(EmptyCollection*, UINT, void**);
};
struct EmptyCollection { const EmptyCollectionVtbl* v; };
static HRESULT STDMETHODCALLTYPE ec_qi(EmptyCollection* self, REFIID iid, void** out) {
    if (!out) return E_POINTER;
    if (IsEqualGUID(iid, kIidUnknown) || IsEqualGUID(iid, kIidMMDeviceCollection)) { *out = self; return S_OK; }
    *out = 0; return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE ec_addref(EmptyCollection*) { return 1; }
static ULONG STDMETHODCALLTYPE ec_release(EmptyCollection*) { return 1; }
static HRESULT STDMETHODCALLTYPE ec_count(EmptyCollection*, UINT* n) { if (!n) return E_POINTER; *n = 0; return S_OK; }
static HRESULT STDMETHODCALLTYPE ec_item(EmptyCollection*, UINT, void** d) { if (d) *d = 0; return E_INVALIDARG; }
static const EmptyCollectionVtbl g_ecVtbl = { ec_qi, ec_addref, ec_release, ec_count, ec_item };
static EmptyCollection g_emptyCollection = { &g_ecVtbl };

struct EmptyEnumerator;
struct EmptyEnumeratorVtbl {
    HRESULT (STDMETHODCALLTYPE* QueryInterface)(EmptyEnumerator*, REFIID, void**);
    ULONG   (STDMETHODCALLTYPE* AddRef)(EmptyEnumerator*);
    ULONG   (STDMETHODCALLTYPE* Release)(EmptyEnumerator*);
    HRESULT (STDMETHODCALLTYPE* EnumAudioEndpoints)(EmptyEnumerator*, int, DWORD, void**);
    HRESULT (STDMETHODCALLTYPE* GetDefaultAudioEndpoint)(EmptyEnumerator*, int, int, void**);
    HRESULT (STDMETHODCALLTYPE* GetDevice)(EmptyEnumerator*, LPCWSTR, void**);
    HRESULT (STDMETHODCALLTYPE* RegisterEndpointNotificationCallback)(EmptyEnumerator*, void*);
    HRESULT (STDMETHODCALLTYPE* UnregisterEndpointNotificationCallback)(EmptyEnumerator*, void*);
};
struct EmptyEnumerator { const EmptyEnumeratorVtbl* v; };
static HRESULT STDMETHODCALLTYPE ee_qi(EmptyEnumerator* self, REFIID iid, void** out) {
    if (!out) return E_POINTER;
    if (IsEqualGUID(iid, kIidUnknown) || IsEqualGUID(iid, kIidMMDeviceEnumerator)) { *out = self; return S_OK; }
    *out = 0; return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE ee_addref(EmptyEnumerator*) { return 1; }
static ULONG STDMETHODCALLTYPE ee_release(EmptyEnumerator*) { return 1; }
static HRESULT STDMETHODCALLTYPE ee_enum(EmptyEnumerator*, int, DWORD, void** out) {
    if (!out) return E_POINTER;
    audio_note("device list asked for: answered with no devices");
    *out = &g_emptyCollection; return S_OK;
}
static HRESULT STDMETHODCALLTYPE ee_default(EmptyEnumerator*, int, int, void** out) {
    if (out) *out = 0;
    audio_note("default speakers asked for: answered 'none'");
    return kNotFound;
}
static HRESULT STDMETHODCALLTYPE ee_get(EmptyEnumerator*, LPCWSTR, void** out) { if (out) *out = 0; return kNotFound; }
static HRESULT STDMETHODCALLTYPE ee_reg(EmptyEnumerator*, void*) { return S_OK; }
static HRESULT STDMETHODCALLTYPE ee_unreg(EmptyEnumerator*, void*) { return S_OK; }
static const EmptyEnumeratorVtbl g_eeVtbl = { ee_qi, ee_addref, ee_release, ee_enum, ee_default, ee_get, ee_reg, ee_unreg };
static EmptyEnumerator g_emptyEnumerator = { &g_eeVtbl };

static HRESULT (WINAPI* orig_CoCreateInstance)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID*) = 0;
static HRESULT WINAPI hook_CoCreateInstance(REFCLSID clsid, LPUNKNOWN outer, DWORD ctx, REFIID iid, LPVOID* out) {
    if (IsEqualGUID(clsid, kClsidMMDeviceEnumerator)) {
        if (!out) return E_POINTER;
        audio_note("audio device list created: an empty one");
        return ee_qi(&g_emptyEnumerator, iid, out);
    }
    return orig_CoCreateInstance(clsid, outer, ctx, iid, out);
}
static HRESULT (WINAPI* orig_CoCreateInstanceEx)(REFCLSID, IUnknown*, DWORD, COSERVERINFO*, DWORD, MULTI_QI*) = 0;
static HRESULT WINAPI hook_CoCreateInstanceEx(REFCLSID clsid, IUnknown* outer, DWORD ctx, COSERVERINFO* srv, DWORD n, MULTI_QI* r) {
    if (IsEqualGUID(clsid, kClsidMMDeviceEnumerator)) {
        audio_note("audio device list created: an empty one");
        HRESULT any = E_NOINTERFACE; DWORD got = 0;
        for (DWORD i = 0; r && i < n; i++) {
            r[i].hr = ee_qi(&g_emptyEnumerator, *r[i].pIID, (void**)&r[i].pItf);
            if (SUCCEEDED(r[i].hr)) { got++; any = S_OK; }
        }
        if (!r || n == 0) return E_INVALIDARG;
        return got == n ? S_OK : (got ? CO_S_NOTALLINTERFACES : any);
    }
    return orig_CoCreateInstanceEx(clsid, outer, ctx, srv, n, r);
}
static void keep_quiet_and_off_the_mouse(void) {
    HMODULE u = LoadLibraryA("user32.dll");
    HMODULE c = LoadLibraryA("combase.dll");
    struct { HMODULE m; const char* n; void* d; void** o; } hs[] = {
        { u, "ClipCursor", (void*)hook_ClipCursor, (void**)&orig_ClipCursor },
        { u, "SetCapture", (void*)hook_SetCapture, (void**)&orig_SetCapture },
        { u, "RegisterRawInputDevices", (void*)hook_RegisterRawInputDevices, (void**)&orig_RegisterRawInputDevices },
        { u, "SetCursorPos", (void*)hook_SetCursorPos, (void**)&orig_SetCursorPos },
        { u, "SetFocus", (void*)hook_SetFocus, (void**)&orig_SetFocus },
        { u, "SetActiveWindow", (void*)hook_SetActiveWindow, (void**)&orig_SetActiveWindow },
        { c, "CoCreateInstance", (void*)hook_CoCreateInstance, (void**)&orig_CoCreateInstance },
        { c, "CoCreateInstanceEx", (void*)hook_CoCreateInstanceEx, (void**)&orig_CoCreateInstanceEx } };
    int ok = 0, n = 0;
    for (auto& x : hs) {
        n++;
        void* f = x.m ? (void*)GetProcAddress(x.m, x.n) : 0;
        if (f && MH_CreateHook(f, x.d, x.o) == MH_OK && MH_EnableHook(f) == MH_OK) ok++;
        else logf_("mouse/sound: could not hook %s", x.n);
    }
    logf_("server copy kept off the mouse and silent (%d of %d functions)", ok, n);
}

static void hide_windows(void) {
    HMODULE u = LoadLibraryA("user32.dll");
    struct { const char* n; void* d; void** o; } hs[] = {
        { "ShowWindow", (void*)hook_ShowWindow, (void**)&orig_ShowWindow },
        { "SetForegroundWindow", (void*)hook_SetForegroundWindow, (void**)&orig_SetForegroundWindow },
        { "SetWindowPos", (void*)hook_SetWindowPos, (void**)&orig_SetWindowPos },
        { "CreateWindowExW", (void*)hook_CreateWindowExW, (void**)&orig_CreateWindowExW } };
    int ok = 0;
    for (auto& x : hs) {
        void* f = u ? (void*)GetProcAddress(u, x.n) : 0;
        if (f && MH_CreateHook(f, x.d, x.o) == MH_OK && MH_EnableHook(f) == MH_OK) ok++;
        else logf_("hide window: could not hook %s", x.n);
    }
    logf_("server window kept hidden and in the background (%d of 4 window functions)", ok);
}

// ---------------------------------------------------------------------------- server set-up
// [Dauntless Forever] DF-CUEWATCH (Nov 2): a measurement for report 544 (effects that never go away on a hunt server:
// Chain Blades Reaper's Dance blast, enrage flames, Nayzaga shockwave). The destroy watch showed no effect actor is ever
// destroyed or replicated for them, so they live in the player's own game as gameplay cues or multicast calls, and what
// goes missing is the "remove" side. UObject::ProcessEvent is hooked in both the server copy and the player's game; the
// first time a function is seen its name is read once, and calls whose name has Cue, Multicast, or Effect with Add,
// Remov or Applied in it are written to the log (server: this log; player: d1147_dxgi.log) with the object's class.
// Each function is logged at most 40 times, 600 lines in all. Env D1147_CUEWATCH=0 turns it off.
static int g_cueWatch = 1;
static int g_isServerCopy = 0;
struct CwEntry { void* fn; int flag; int count; char name[80]; };
static CwEntry g_cw[4096];
static volatile LONG g_cwLines = 0;
static int g_cwLog = 0;                                                       // ship build: D1147_CUEWATCH=log writes the measuring lines
static void (*g_origProcessEvent)(void*, void*, void*) = 0;
static bool cw_wanted(const char* n) {
    if (strstr(n, "Cue") || strstr(n, "Multicast")) return true;
    if (strstr(n, "Effect") && (strstr(n, "Add") || strstr(n, "Remov") || strstr(n, "Applied"))) return true;
    // Nov 2, second pass: the blast is not a cue, it is started and should be stopped by the ability itself, so the
    // ability start and end calls are logged too, with the ability class (the object the function ran on).
    if (strstr(n, "Ability") && (strstr(n, "End") || strstr(n, "Activate") || strstr(n, "Cancel") || strstr(n, "Commit"))) return true;
    if (strstr(n, "Montage") && (strstr(n, "End") || strstr(n, "Stop") || strstr(n, "Interrupt") || strstr(n, "Blend"))) return true;
    if (strstr(n, "Reaper") || strstr(n, "Spin") || strstr(n, "Whirl")) return true;
    return false;
}
static void cw_log(const char* line) {
    if (g_isServerCopy) logf_("%s", line); else dxgi_note(line);
}
// [Dauntless Forever] DF-BOXLOG-1147 (Nov 2): a server copy keeps all of its windows hidden, which also hides the
// Windows error box such as "the code execution cannot proceed because <name>.dll was not found". The box still stops
// the copy, so the player only sees it die with nothing to go on, and the one thing that names the missing file is
// never seen by anyone. Its text is written to the log here. In a server copy the box is then answered with OK so the
// copy does not sit there waiting; in the player's own game the box is passed through and shown as it always was.
// D1147_BOXLOG=0 leaves the boxes alone.
static int g_boxLog = 1;
static int (WINAPI* orig_MessageBoxA)(HWND, LPCSTR, LPCSTR, UINT) = 0;
static int (WINAPI* orig_MessageBoxW)(HWND, LPCWSTR, LPCWSTR, UINT) = 0;
static void box_note(const char* caption, const char* text) {
    char line[460];
    snprintf(line, sizeof(line), "a message box came up: [%s] %s", caption ? caption : "", text ? text : "");
    if (g_isServerCopy) logf_("%s", line); else dxgi_note(line);
}
static int WINAPI hook_MessageBoxA(HWND h, LPCSTR t, LPCSTR c, UINT u) {
    box_note(c, t);
    if (g_isServerCopy) return 1;
    return orig_MessageBoxA ? orig_MessageBoxA(h, t, c, u) : 1;
}
static int WINAPI hook_MessageBoxW(HWND h, LPCWSTR t, LPCWSTR c, UINT u) {
    char tb[400] = { 0 }, cb[120] = { 0 };
    if (t) WideCharToMultiByte(CP_UTF8, 0, t, -1, tb, sizeof(tb) - 1, 0, 0);
    if (c) WideCharToMultiByte(CP_UTF8, 0, c, -1, cb, sizeof(cb) - 1, 0, 0);
    box_note(cb, tb);
    if (g_isServerCopy) return 1;
    return orig_MessageBoxW ? orig_MessageBoxW(h, t, c, u) : 1;
}
static void box_log_init(void) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_BOXLOG", v, sizeof(v)) && v[0] == '0') { g_boxLog = 0; return; }
    HMODULE u = LoadLibraryA("user32.dll");
    if (!u) return;
    int ok = 0;
    void* a = (void*)GetProcAddress(u, "MessageBoxA");
    void* w = (void*)GetProcAddress(u, "MessageBoxW");
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) {
        if (a && MH_CreateHook(a, (void*)hook_MessageBoxA, (void**)&orig_MessageBoxA) == MH_OK && MH_EnableHook(a) == MH_OK) ok++;
        if (w && MH_CreateHook(w, (void*)hook_MessageBoxW, (void**)&orig_MessageBoxW) == MH_OK && MH_EnableHook(w) == MH_OK) ok++;
    }
    char line[140];
    snprintf(line, sizeof(line), "message box text goes to this log (%d of 2)", ok);
    if (g_isServerCopy) logf_("%s", line); else dxgi_note(line);
}

// [Dauntless Forever] DF-LINGERFIX-1147 (Nov 2, report 544): cblades_reapers_dance_aoe_bp_C is spawned when Reaper's
// Dance finishes, on the server copy and in the player's game, each making its own (it is not replicated: the
// networked actor count does not move). Measured on Nov 2: it gets a BeginPlay and never an EndPlay or a Destroyed,
// while every other actor around it in the same seconds ends normally, so the bright dome stays where it was until
// the player leaves the island. Here it is given a life span when it starts, which is the engine's own way of ending
// a short-lived effect actor: EndPlay and Destroyed then run as they should. D1147_LINGERFIX=0 turns it off and
// D1147_LINGERSECS sets the seconds.
// Two numbers per effect: the first is for the player's game, where the actor is only the picture, and the second is
// for the server copy, where the same actor applies the damage and so is left alone a little longer.
struct LingerClass { const char* cls; float secs; float serverSecs; };
static const LingerClass g_lingerClasses[] = {
    { "cblades_reapers_dance_aoe_bp_C", 6.0f, 3.0f },    // Nov 3 AOEFX build: the actor removes itself at 3 s; 6 s is only a backstop
};
static bool linger_class(const char* cls) {
    for (unsigned i = 0; i < sizeof(g_lingerClasses) / sizeof(g_lingerClasses[0]); i++) if (strcmp(cls, g_lingerClasses[i].cls) == 0) return true;
    return false;
}
static int g_lingerFix = 1;
// DF-LINGERVFX-1147 (Nov 2, report 544, fourth pass): destroying cblades_reapers_dance_aoe_bp_C removed the actor on
// both sides and the dome stayed on screen, so the picture belongs to something that actor creates and that outlives it
// (an effect component spawned at a location belongs to the world, not to the actor). These name it and end it; the code
// is further down, next to the engine object list it reads.
static int g_vfxOn = 0, g_vfxFix = 0, g_vfxLogged = 0;   // ship build: off unless D1147_LINGERVFX=log (names) or 1 (ends them)   // Nov 3: names only (it found nothing to end: the dome is the actor's own)
static void vfx_before(void* actor);
static void dp_start(void* actor, const char* cls); static void dp_seen(void* obj, const char* fname); static void dp_tick(void); static void* volatile g_dpActor = 0;   // DF-DOMEPROBE-1147
static void vfx_after(void* actor, const char* cls);
static void vfx_on_kill(void* actor);
static void vfx_tick(void);
static bool linger_class(const char* cls);
static float g_lingerSecs = 0;
static int g_lingerLogged = 0;
struct LsCall { void* obj; void* fn; uint8_t parms[16]; };
static void ls_pe(void* arg) { LsCall* c = (LsCall*)arg; if (g_origProcessEvent) g_origProcessEvent(c->obj, c->fn, c->parms); }
// Nov 2, second pass: a life span was not enough (the dome was still there with it set), so the actor is destroyed
// outright when its time is up, which a blueprint cannot sit out. The life span is still asked for first, and when
// the deadline comes the log says whether the actor had already gone by itself, so we learn which part was failing.
// The actor is only touched when it is still the same one at that address and the engine has not begun to free it.
struct PendingKillOff { void* obj; void* cls; ULONGLONG due; ULONGLONG born; int phase; char name[72]; };
// DF-LINGERFADE-1147 (Nov 3): removing the actor outright cut its burst (at 1 s) or made it pop out (at 3 s). In the
// player's game the actor's own components are first switched off (Deactivate: no new particles, the ones on screen
// fade out as the effect was made to), and the actor is removed D1147_LINGERFADE seconds later (default 1.5).
static float g_lingerFade = 1.5f;
static int lf_deactivate(void* a, char* names, int namesLen) {
    int n = 0; names[0] = 0;
    const uintptr_t lists[2] = { A::Actor_BPComponents, A::Actor_InstComponents };
    for (int l = 0; l < 2; l++) {
        TArrayRaw& arr = at<TArrayRaw>((uintptr_t)a + lists[l]);
        if (!arr.Data || arr.Num <= 0 || arr.Num > 64) continue;
        for (int i = 0; i < arr.Num; i++) {
            void* c = arr.Data[i]; if (!c) continue;
            if (at<uint32_t>((uintptr_t)c + A::Object_Flags) & 0x60000000) continue;
            void* cc = at<void*>((uintptr_t)c + A::Object_Class);
            void* fn = find_function(cc, L"Deactivate");
            if (!fn) continue;
            LsCall call = { c, fn, { 0 } };
            if (guarded(ls_pe, &call)) { n++; char cn[64]; name_of(cc, cn, sizeof(cn)); size_t L = strlen(names); size_t K = strlen(cn); if (L + K + 3 < (size_t)namesLen) { if (L) { names[L++] = ','; names[L++] = ' '; } memcpy(names + L, cn, K + 1); } }
        }
    }
    return n;
}
static PendingKillOff g_pk[64]; static int g_pkN = 0;
static void linger_fix(void* a, const char* cls) {
    if (!g_lingerFix || !a) return;
    float secs = 0;
    for (unsigned i = 0; i < sizeof(g_lingerClasses) / sizeof(g_lingerClasses[0]); i++)
        if (strcmp(cls, g_lingerClasses[i].cls) == 0) { secs = g_isServerCopy ? g_lingerClasses[i].serverSecs : g_lingerClasses[i].secs; break; }
    if (secs <= 0) return;
    if (g_lingerSecs > 0) secs = g_lingerSecs;
    void* cl = at<void*>((uintptr_t)a + A::Object_Class);
    void* fn = find_function(cl, L"SetLifeSpan");
    if (fn) { LsCall c = { a, fn, { 0 } }; *(float*)c.parms = secs; guarded(ls_pe, &c); }
    int slot = -1;
    for (int i = 0; i < g_pkN; i++) if (!g_pk[i].obj) { slot = i; break; }
    if (slot < 0 && g_pkN < 64) slot = g_pkN++;
    if (slot >= 0) {
        PendingKillOff& p = g_pk[slot];
        p.obj = a; p.cls = cl; p.born = GetTickCount64(); p.due = p.born + (ULONGLONG)(secs * 1000.0f); p.phase = (g_isServerCopy || g_lingerFade <= 0) ? 1 : 0;
        snprintf(p.name, sizeof(p.name), "%s", cls);
    }
    if (g_lingerLogged++ < 6) { char line[220]; snprintf(line, sizeof(line), "lingering effect: %s starts, it goes in %.1f s", cls, secs); cw_log(line); }
}
static void pk_run(void) {
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < g_pkN; i++) {
        PendingKillOff& p = g_pk[i];
        if (!p.obj || now < p.due) continue;
        if (p.phase == 0) {                                                 // DF-LINGERFADE-1147: fade first
            p.phase = 1;
            if (at<void*>((uintptr_t)p.obj + A::Object_Class) == p.cls && !(at<uint32_t>((uintptr_t)p.obj + A::Object_Flags) & 0x60000000)) {
                char names[300]; int n = lf_deactivate(p.obj, names, sizeof(names));
                if (g_lingerLogged++ < 12) { char line[420]; snprintf(line, sizeof(line), "lingering effect: %s fading out after %lu ms (%d part(s) switched off: %s), removed in %.1f s", p.name, (unsigned long)(now - p.born), n, names[0] ? names : "none", g_lingerFade); cw_log(line); }
            }
            p.due = now + (ULONGLONG)(g_lingerFade * 1000.0f);
            continue;
        }
        void* a = p.obj; p.obj = 0;
        vfx_on_kill(a);                                                     // DF-LINGERVFX-1147
        char line[240];
        if (at<void*>((uintptr_t)a + A::Object_Class) != p.cls) {
            if (g_lingerLogged++ < 12) { snprintf(line, sizeof(line), "lingering effect: %s was already gone when its %lu ms were up", p.name, (unsigned long)(p.due - p.born)); cw_log(line); }
            continue;
        }
        if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000) {
            if (g_lingerLogged++ < 12) { snprintf(line, sizeof(line), "lingering effect: %s was ending by itself when its %lu ms were up", p.name, (unsigned long)(p.due - p.born)); cw_log(line); }
            continue;
        }
        void* fn = find_function(p.cls, L"K2_DestroyActor");
        if (!fn) { if (g_lingerLogged++ < 12) cw_log("lingering effect: DestroyActor not found, the effect is left as it is"); continue; }
        LsCall c = { a, fn, { 0 } };
        bool ok = guarded(ls_pe, &c);
        if (g_lingerLogged++ < 12) { snprintf(line, sizeof(line), "lingering effect: %s was still there after %lu ms and %s", p.name, (unsigned long)(p.due - p.born), ok ? "has been removed" : "could not be removed"); cw_log(line); }
    }
}

// DF-LINGERWATCH (Nov 2): names the next one by itself. Every effect-looking actor that starts is remembered, and one
// that has had no EndPlay and no Destroyed 20 s later is written to the log with its class, which is what report 544's
// enrage flames and Nayzaga shockwave will look like the first time they happen in a real hunt.
struct LwEntry { void* obj; ULONGLONG at; uint8_t done; char cls[80]; };
static LwEntry g_lw[256]; static int g_lwN = 0; static int g_lwLogged = 0; static LONG g_lwTicks = 0;
static bool lw_interesting(const char* n) {
    // Nov 2, second pass: vfx, beam, trail and aura matched things that are long-lived on purpose (the Ramsgate
    // hologram, the lantern trail), so only the sharp, short-lived kinds are watched.
    return strstr(n, "aoe") || strstr(n, "blast") || strstr(n, "explo") || strstr(n, "burst") || strstr(n, "shock") ||
           strstr(n, "nova") || strstr(n, "enrage") || strstr(n, "flame");
}
static void lw_begin(void* a, const char* cls) {
    if (!lw_interesting(cls)) return;
    int slot = -1;
    for (int i = 0; i < g_lwN; i++) if (g_lw[i].done) { slot = i; break; }
    if (slot < 0 && g_lwN < 256) slot = g_lwN++;
    if (slot < 0) return;
    LwEntry& e = g_lw[slot];
    e.obj = a; e.at = GetTickCount64(); e.done = 0;
    snprintf(e.cls, sizeof(e.cls), "%s", cls);
}
static void lw_end(void* a) { for (int i = 0; i < g_lwN; i++) if (g_lw[i].obj == a) g_lw[i].done = 1; }
static void lw_check(void) {
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < g_lwN; i++) {
        LwEntry& e = g_lw[i];
        if (e.done || now - e.at < 20000) continue;
        e.done = 1;
        if (g_cwLog && g_lwLogged++ < 40) { char line[220]; snprintf(line, sizeof(line), "lingering effect watch: %s has been there 20 s with no end and no destroy", e.cls); cw_log(line); }
    }
}

// Nov 2, third pass: the hunt server spawns, replicates and destroys nothing for the lingering blast (49 networked
// actors before, during and after the spin; no add or remove cue), so the blast is a blueprint actor created inside the
// player's own game by the ability and never removed. A blueprint actor's BeginPlay, EndPlay and Destroyed all run
// through ProcessEvent, so they are logged here with the actor's class, from the moment Reaper's Dance spins (armed by
// the first function with Spin in its name) for 40 s. That names the actor and shows whether anything ever ends it.
// [Dauntless Forever] DF-AOEFX-1147 (Nov 3, report 544). The probe showed what happens to the Reaper's Dance ball: the
// dance's own particle part (p_aoe_vfx) is started by the blueprint (Play Hit Effects) and, 16 ms later, the engine runs
// OnRep_IsActive on it: an "is active: no" has come in for it, the flag is now off, and OnRep_IsActive switches its
// ticking off. A particle effect that has drawn its first frame and no longer ticks is a still picture: the white ball
// that never animates (live: white flash, grows, turns purple, fades). In the player's game, for a particle or Niagara
// part of an effect actor (class name has "aoe"), that late "no" is ignored: the flag is put back on and OnRep_IsActive
// is not run, so the effect plays out by itself. The actor still removes itself as before. D1147_AOEFX=0 turns it off.
static int dp_is_fx(void* cls);
static int g_aoefx = -1; static long g_aoefxKept = 0;
static bool aoefx_keep(void* comp) {
    if (g_isServerCopy) return false;
    if (g_aoefx < 0) { char v[8]; g_aoefx = !(GetEnvironmentVariableA("D1147_AOEFX", v, sizeof(v)) && v[0] == '0'); if (!g_aoefx) cw_log("aoe effects: left as they are (D1147_AOEFX=0)"); }
    if (!g_aoefx) return false;
    void* cls = at<void*>((uintptr_t)comp + A::Object_Class);
    if (!cls || !dp_is_fx(cls)) return false;
    void* outer = at<void*>((uintptr_t)comp + A::Object_Outer); if (!outer) return false;
    char oc[96]; name_of(at<void*>((uintptr_t)outer + A::Object_Class), oc, sizeof(oc));
    void* bp = hr_prop(cls, L"bIsActive"); if (!bp) return false;
    if (!strstr(oc, "aoe") && !strstr(oc, "Aoe") && !strstr(oc, "AOE")) {   // Nov 3: log the same "off" on any other effect, change nothing
        static long seen = 0; uint8_t m = at<uint8_t>((uintptr_t)bp + HR::BoolProp_ByteMask);
        int o = at<int32_t>((uintptr_t)bp + HR::Prop_Offset) + at<uint8_t>((uintptr_t)bp + HR::BoolProp_ByteOffset);
        if (m && o >= 0x28 && o <= 0x400 && !(at<uint8_t>((uintptr_t)comp + o) & m) && seen < 20) {
            seen++; char cn[80], tn[96] = "?", line[300]; name_of(comp, cn, sizeof(cn));
            void* tp = hr_prop(cls, L"Template"); if (tp) { void* t = at<void*>((uintptr_t)comp + at<int32_t>((uintptr_t)tp + HR::Prop_Offset)); if (t) name_of(t, tn, sizeof(tn)); }
            snprintf(line, sizeof(line), "effect watch: a late 'not active' came for %s (effect %s) on %s, left as it is", cn, tn, oc); cw_log(line);
        }
        return false;
    }
    uint8_t mask = at<uint8_t>((uintptr_t)bp + HR::BoolProp_ByteMask);
    int off = at<int32_t>((uintptr_t)bp + HR::Prop_Offset) + at<uint8_t>((uintptr_t)bp + HR::BoolProp_ByteOffset);
    if (!mask || off < 0x28 || off > 0x400) return false;
    uint8_t& b = at<uint8_t>((uintptr_t)comp + off);
    if (b & mask) return false;                                            // it says "active": nothing to undo, let it run
    b |= mask;
    long n = InterlockedIncrement(&g_aoefxKept);
    if (n <= 12) { char cn[80], line[260]; name_of(comp, cn, sizeof(cn)); snprintf(line, sizeof(line), "aoe effect: %s on %s kept playing (a late 'not active' was ignored), %ld so far", cn, oc, n); cw_log(line); }
    return true;
}

// [Dauntless Forever] DF-EVENTSHOW-1147 (Nov 12): rate events (2x weeks) are applied by the backend when it stores a
// grant, so the save is right but the hunt's loot screens still show the amounts the hunt server rolled. The hunt server
// hands the player's game its loot list in one remote call, UPlayerLootComponent::ClientHandleLootGranted
// (TArray<FArchonLoot>: item id FString +0x00, Count int32 +0x58, 0x60 bytes each), and break-part pop-ups in
// player_controller_bp_C::NotifyOwningClientAboutConditionalLoot (item id FString +0x00, Amount int32 +0x10). Both arrive
// through ProcessEvent. In the player's game the amounts are logged as they arrive, and with D1147_EVENTSHOW=1 they are
// multiplied before the game's own code sees them, so the drops popup and the end-of-hunt screens show what the backend
// stores. Display only: nothing is sent anywhere and the save is not touched.
// The factors come from the backend's own table, <package>\data\event-display.txt (D1147_DIR, or three folders above the
// game's private LOCALAPPDATA): an optional first line "ends=<UTC time>", then "ITEM_ID=factor" for every item not at 1.
// Empty or missing file = normal amounts. Read again every 30 s. Rounding is the backend's: max(1, round(n * factor)).
// D1147_EVENTSHOW: not set = multiply what is shown (release), log = log every amount and change nothing, 0 = off.
// Log lines start "event show:"; in the release mode only the first 40 changed amounts are written.
static int g_esMode = 2;                     // 0 off, 1 log only, 2 multiply
struct EsItem { char id[64]; float f; };
static EsItem g_esItems[512]; static int g_esN = 0, g_esState = -1;
static ULONGLONG g_esReadAt = 0; static unsigned long long g_esEnds = 0;
static volatile LONG g_esLines = 0;
static int es_kind(const char* n) { return strcmp(n, "ClientHandleLootGranted") == 0 ? 5 : strcmp(n, "NotifyOwningClientAboutConditionalLoot") == 0 ? 6 : 0; }
static unsigned long long es_filetime(int y, int mo, int d, int h, int mi, int sec) {   // UTC date -> 100 ns since 1601
    y -= mo <= 2; const long long era = (y >= 0 ? y : y - 399) / 400; const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (unsigned)((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1); const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    const long long days = era * 146097 + (long long)doe - 719468 + 134774;
    return (unsigned long long)(days * 86400LL + h * 3600 + mi * 60 + sec) * 10000000ULL;
}
static void es_read(void) {
    const ULONGLONG now = GetTickCount64();
    if (g_esReadAt && now - g_esReadAt < 30000) return;
    g_esReadAt = now ? now : 1;
    wchar_t path[MAX_PATH + 64]; DWORD n = GetEnvironmentVariableW(L"D1147_DIR", path, MAX_PATH);
    if (n && n < MAX_PATH) wcscat(path, L"\\data\\event-display.txt");
    else { n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH); if (!n || n >= MAX_PATH) return; wcscat(path, L"\\..\\..\\..\\data\\event-display.txt"); }
    int count = 0; unsigned long long ends = 0;
    FILE* fh = _wfopen(path, L"rb");
    if (fh) {
        char line[160];
        while (count < 512 && fgets(line, sizeof(line), fh)) {
            char* p = line;
            if ((unsigned char)p[0] == 0xEF && (unsigned char)p[1] == 0xBB && (unsigned char)p[2] == 0xBF) p += 3;
            int eq = -1, len = 0;
            for (; p[len] && p[len] != '\r' && p[len] != '\n'; len++) if (p[len] == '=' && eq < 0) eq = len;
            p[len] = 0;
            if (eq <= 0 || p[0] == '#') continue;
            p[eq] = 0; const char* v = p + eq + 1; const int vlen = len - eq - 1;
            if (strcmp(p, "ends") == 0) { if (vlen >= 16) ends = es_filetime(atoi(v), atoi(v + 5), atoi(v + 8), atoi(v + 11), atoi(v + 14), vlen >= 19 ? atoi(v + 17) : 0); else ends = 1; continue; }   // unreadable end = already over
            if (eq >= 64) continue;
            const float f = (float)atof(v);
            if (!(f > 0.0f) || f > 100.0f || f == 1.0f) continue;
            EsItem& it = g_esItems[count++]; for (int i = 0; i <= eq; i++) it.id[i] = p[i]; it.f = f;
        }
        fclose(fh);
    }
    g_esN = count; g_esEnds = ends;
    if (count != g_esState) {
        g_esState = count; char m[200];
        if (count) snprintf(m, sizeof(m), "event show: %d item rate(s) read from data\\event-display.txt%s", count, ends ? " (it has an end time)" : "");
        else snprintf(m, sizeof(m), "event show: no event table (%s): normal amounts", fh ? "data\\event-display.txt is empty" : "no data\\event-display.txt");
        dxgi_note(m);
    }
}
static bool es_live(void) {
    if (!g_esN) return false;
    if (!g_esEnds) return true;
    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    return (((unsigned long long)ft.dwHighDateTime << 32) | ft.dwLowDateTime) < g_esEnds;
}
static float es_factor(const char* id) { for (int i = 0; i < g_esN; i++) if (strcmp(g_esItems[i].id, id) == 0) return g_esItems[i].f; return 1.0f; }
static int es_scale(int n, float f) {
    if (n <= 0 || f == 1.0f) return n;
    long long r = (long long)((double)n * (double)f + 0.5); if (r < 1) r = 1; if (r > 2000000000LL) r = 2000000000LL;
    return (int)r;
}
static void es_one(const char* what, uintptr_t idStr, int32_t* count, bool live) {
    const wchar_t* w = at<const wchar_t*>(idStr); const int32_t wn = at<int32_t>(idStr + 8);
    char id[64]; int k = 0;
    if (w && wn > 0 && wn <= 64) for (; k < wn - 1 && k < 63 && w[k]; k++) id[k] = w[k] < 128 ? (char)w[k] : '?';
    id[k] = 0;
    const float f = (live && k) ? es_factor(id) : 1.0f;
    const int was = *count, would = es_scale(was, f);
    if (g_esMode == 2 && would != was) *count = would;
    if (g_esMode == 2 && would == was) return;                          // release: only what the event changed
    if (InterlockedIncrement(&g_esLines) > (g_esMode == 2 ? 40 : 300)) return;
    char m[200];
    if (would == was) snprintf(m, sizeof(m), "event show: %s %s x%d", what, k ? id : "(no id)", was);
    else snprintf(m, sizeof(m), "event show: %s %s x%d, event rate %.2g: %s x%d", what, id, was, (double)f, g_esMode == 2 ? "now shows" : "would show", would);
    dxgi_note(m);
}
static void es_seen(int kind, void* parms) {
    es_read();
    const bool live = es_live();
    if (kind == 5) {                                                   // ClientHandleLootGranted(TArray<FArchonLoot>)
        const uintptr_t data = at<uintptr_t>((uintptr_t)parms); const int32_t num = at<int32_t>((uintptr_t)parms + 8);
        if (g_esMode == 1 && InterlockedIncrement(&g_esLines) <= 300) { char m[120]; snprintf(m, sizeof(m), "event show: loot list arrived, %d item(s)%s", num, live ? " (event table live)" : ""); dxgi_note(m); }
        if (!data || num <= 0 || num > 512) return;
        for (int32_t i = 0; i < num; i++) { const uintptr_t it = data + 0x60 * (uintptr_t)i; es_one("loot", it, &at<int32_t>(it + 0x58), live); }
    } else if (kind == 6) es_one("pop-up", (uintptr_t)parms, &at<int32_t>((uintptr_t)parms + 0x10), live);   // NotifyOwningClientAboutConditionalLoot
}
static void es_init(void) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_EVENTSHOW", v, sizeof(v))) g_esMode = v[0] == '0' ? 0 : (v[0] == 'l' || v[0] == 'L') ? 1 : 2;
    dxgi_note(aw_on() ? "ability watch: on, log only (report 760; D1147_ACTWATCH=0 turns it off)" : "ability watch: off (D1147_ACTWATCH=0)");
    dxgi_note(g_esMode == 0 ? "event show: off (D1147_EVENTSHOW=0)" : g_esMode == 2 ? "event show: loot amounts on screen follow the event table when one is live (D1147_EVENTSHOW=0 turns it off)" : "event show: log only, amounts on screen not changed (D1147_EVENTSHOW=log)");
    if (g_esMode) es_read();
}
static ULONGLONG g_cwArmedAt = 0;
static bool cw_life(const char* n) {
    return strcmp(n, "ReceiveBeginPlay") == 0 || strcmp(n, "ReceiveEndPlay") == 0 || strcmp(n, "ReceiveDestroyed") == 0;
}
// ---------------------------------------------------------------------------- DF-LOREWAIT-1147 (Nov 10): event items on islands
// An event item on an island (lore_object_bp and its child lore_object_robust_bp: the Silver Sword's pommel, blade and
// sigil, EventId SILVER_SWORD) asks at its ReceiveGameplayStart whether its event is running
// (TuningDataStatics::IsScheduledItemActive) and destroys itself on the server when it is not. A server copy only asks
// the backend for the event schedule after it listens (DF-TUNING-1147), seconds after the island's actors started, so
// every event item was gone on the server while players still saw it: holding E failed at once and the server logged
// "Received reference to pending kill object from client: lore_object_robust_bp_2" (Cold Runner, Nov 10).
// On server copies their ReceiveGameplayStart is held back and replayed once the schedule has had time to arrive:
// 5 s after the first schedule request, or at 30 s at the latest. D1147_LOREWAIT=0 turns it off.
static bool g_loreWaitOn = true;
struct LoreHeld { void* obj; void* fn; void* cls; };
static LoreHeld g_loreHeld[256];
static int g_loreHeldN = 0, g_loreHeldTotal = 0;
static ULONGLONG g_loreFirstAt = 0;
static bool g_loreDone = false;
struct LoreCls { void* cls; int lore; };
static LoreCls g_loreCls[2048];
static int g_loreLogged = 0;
static bool lore_class(void* obj) {
    void* cls = at<void*>((uintptr_t)obj + A::Object_Class);
    for (int d = 0; cls && d < 16; d++, cls = at<void*>((uintptr_t)cls + A::Struct_Super)) {
        char n[96]; name_of(cls, n, sizeof(n));
        if (!strcmp(n, "lore_object_bp_C")) return true;
        if (!strcmp(n, "Actor") || !strcmp(n, "Object")) return false;
    }
    return false;
}
struct LoreReplay { void* obj; void* fn; };
static void lore_replay(void* arg) { LoreReplay* r = (LoreReplay*)arg; alignas(16) uint8_t none[16] = { 0 }; g_origProcessEvent(r->obj, r->fn, none); }
static void lore_release_tick() {
    if (g_loreDone || !g_loreHeldN) return;
    ULONGLONG now = GetTickCount64();
    bool ready = (g_tuningAsks >= 1 && now - g_tuningAskAt >= 5000) || !g_tuningOk || (g_loreFirstAt && now - g_loreFirstAt >= 30000);
    if (!ready) return;
    int played = 0, gone = 0;
    for (int i = 0; i < g_loreHeldN; i++) {
        LoreHeld& h = g_loreHeld[i];
        if (at<void*>((uintptr_t)h.obj + A::Object_Class) != h.cls || (at<uint32_t>((uintptr_t)h.obj + A::Object_Flags) & 0x60000000)) { gone++; continue; }
        LoreReplay r = { h.obj, h.fn };
        char fnm[64], onm[128]; name_of(h.fn, fnm, sizeof(fnm)); name_of(h.obj, onm, sizeof(onm));
        if (guarded(lore_replay, &r)) { played++; if (played <= 12) logf_("lore wait: replayed %s on %s", fnm, onm); } else gone++;
    }
    logf_("lore wait: %d event item(s) started now, %.1f s after the first was held%s (%d gone or faulted)", played,
          (now - g_loreFirstAt) / 1000.0, g_tuningAsks ? ", the event schedule has been asked for" : ", no event schedule request was made", gone);
    g_loreHeldN = 0; g_loreDone = true;
}

// DF-ACTWATCH-1147, the player's game half (see the note above equipment_bridge.h).
static int aw_kind(const char* n) {
    if (strncmp(n, "ServerTryActivateAbility", 24) == 0) return 7;
    if (strncmp(n, "ClientActivateAbilitySucceed", 28) == 0) return 8;
    if (strcmp(n, "ClientActivateAbilityFailed") == 0) return 9;
    return 0;
}
static volatile LONG g_awLines = 0;
static void* g_awAsc = 0; static uint32_t g_awHandle = 0; static ULONGLONG g_awAt = 0; static int g_awStage = 0, g_awKey = 0;
static void aw_line(const char* what, int key, const char* when, const char* state) {
    if (InterlockedIncrement(&g_awLines) > 600) return;
    char m[250]; snprintf(m, sizeof(m), "ability watch: %s key=%d, %s: %s", what, key, when, state); dxgi_note(m);
}
static void aw_later(void) {                 // called from a ProcessEvent on the same component: it is alive
    const ULONGLONG since = GetTickCount64() - g_awAt;
    if ((g_awStage == 0 && since >= 1000) || (g_awStage == 1 && since >= 5000)) {
        char st[170]; aw_state(g_awAsc, g_awHandle, st, sizeof(st), 0);
        char when[40]; snprintf(when, sizeof(when), "%.1f s later", since / 1000.0);
        aw_line("server said REFUSED", g_awKey, when, st);
        if (++g_awStage >= 2) g_awAsc = 0;
    }
}

// DF-CRITTEXT-1147 (Nov 12-13): crits stand out, with settings on the game's own Options > Gameplay page.
// Player's game only. The game sends every damage number through combat_text_widget_bpc's
// SetCombatTextAndFont(record, threshold) and SetCombatTextColorAndOpacity(record) (both events, so they pass through
// ProcessEvent). The record carries bCrit at +0x94 (CL647472 dump). On a crit the threshold's FontSize (+0x98+0x04) and
// LifeSpan (+0x98+0x10) are raised, gravity (+0x6C) and the sideways push are removed so it hangs, the colour call gets
// the style's BaseColor (+0x38); after the game built the number its text block gets the style's outline, shadow and
// tilt, and the engine tick pops and twists it. Normal hits are left as the game sets them (36 to 62 by damage).
// Settings: <data>\crittext.txt, written by the rows the loader adds to Options > Gameplay (DF-CRITOPTS below).
// D1147_CRITTEXT=0 forces it off, =all starts in test mode (every number styled).
struct CritStyle { const char* name; float body[3]; float outline[3]; int outlineSize; float shadow; int cycle; bool plain; };
// cycle: 0 none, 1 outline runs through the rainbow, 2 outline flickers like embers; body {-1} = a new bright colour per crit
static const CritStyle kCritStyles[6] = {
    { "Comic",   { 1.00f, 0.86f, 0.08f }, { 0.00f, 0.00f, 0.00f }, 6, 5.0f, 0, false },
    { "Inferno", { 1.00f, 0.30f, 0.03f }, { 0.35f, 0.02f, 0.00f }, 6, 4.0f, 2, false },
    { "Frost",   { 0.55f, 0.90f, 1.00f }, { 1.00f, 1.00f, 1.00f }, 5, 4.0f, 0, false },
    { "Void",    { 0.02f, 0.00f, 0.05f }, { 0.62f, 0.12f, 1.00f }, 6, 0.0f, 0, false },
    { "Rainbow", { -1.0f, 0.00f, 0.00f }, { 0.00f, 0.00f, 0.00f }, 6, 5.0f, 1, false },
    { "Classic", { 0.00f, 0.00f, 0.00f }, { 0.00f, 0.00f, 0.00f }, 0, 0.0f, 0, true  },
};
struct CritSet { int on; int style; float size; int pop; float tilt; float hang; int test; };
static CritSet g_cs = { 0, 0, 2.2f, 1, 8.0f, 1.0f, 0 };   // Crit Numbers is OFF until the player turns it on in Options > Gameplay
static int g_ctInit = 0, g_ctForceOff = 0; static long g_ctSeen = 0, g_ctCrit = 0;
static float g_ctHue = 0.0f;                                              // Rainbow: the body colour of the crit being built
static bool ct_path(wchar_t* path) {
    DWORD n = GetEnvironmentVariableW(L"D1147_DIR", path, MAX_PATH);
    if (n && n < MAX_PATH) { wcscat(path, L"\\data\\crittext.txt"); return true; }
    n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH); if (!n || n >= MAX_PATH) return false;
    wcscat(path, L"\\..\\..\\..\\data\\crittext.txt"); return true;
}
static void ct_clamp() {
    g_cs.on = g_cs.on ? 1 : 0; g_cs.pop = g_cs.pop ? 1 : 0; g_cs.test = g_cs.test ? 1 : 0;
    if (g_cs.style < 0 || g_cs.style > 5) g_cs.style = 0;
    if (!(g_cs.size >= 1.0f && g_cs.size <= 3.0f)) g_cs.size = 2.2f;
    if (!(g_cs.tilt >= 0.0f && g_cs.tilt <= 15.0f)) g_cs.tilt = 8.0f;
    if (!(g_cs.hang >= 0.0f && g_cs.hang <= 3.0f)) g_cs.hang = 1.0f;
}
static void ct_save() {
    wchar_t path[MAX_PATH + 64]; if (!ct_path(path)) return;
    FILE* f = _wfopen(path, L"w"); if (!f) return;
    fprintf(f, "# crit numbers - written by the game's Options > Gameplay page (Dauntless Forever loader)\non=%d\nstyle=%d\nsize=%.2f\npop=%d\ntilt=%.1f\nhang=%.1f\n", g_cs.on, g_cs.style, g_cs.size, g_cs.pop, g_cs.tilt, g_cs.hang);
    fclose(f);
}
static void ct_init() {
    if (g_ctInit) return; g_ctInit = 1;
    wchar_t path[MAX_PATH + 64]; bool had = false;
    if (ct_path(path)) { FILE* f = _wfopen(path, L"r");
        if (f) { had = true; char l[96];
            while (fgets(l, sizeof(l), f)) { char* eq = l; while (*eq && *eq != '=') eq++; if (!*eq) eq = 0; if (!eq || l[0] == '#') continue; *eq = 0; double v = atof(eq + 1);
                if (!strcmp(l, "on")) g_cs.on = (int)v; else if (!strcmp(l, "style")) g_cs.style = (int)v; else if (!strcmp(l, "size")) g_cs.size = (float)v;
                else if (!strcmp(l, "pop")) g_cs.pop = (int)v; else if (!strcmp(l, "tilt")) g_cs.tilt = (float)v; else if (!strcmp(l, "hang")) g_cs.hang = (float)v; }
            fclose(f); } }
    ct_clamp();
    char v[8]; bool got = GetEnvironmentVariableA("D1147_CRITTEXT", v, sizeof(v)) > 0;
    if (got && v[0] == '0') g_ctForceOff = 1; if (got && (v[0] == 'a' || v[0] == 'A')) g_cs.test = 1;
    char m[220]; snprintf(m, sizeof(m), "crit text: %s, style %s, size x%.1f, pop %s, tilt %.0f, hang +%.1f s (%s; change it in Options > Gameplay)", g_ctForceOff ? "OFF (D1147_CRITTEXT=0)" : g_cs.on ? "on" : "off",
        kCritStyles[g_cs.style].name, g_cs.size, g_cs.pop ? "on" : "off", g_cs.tilt, g_cs.hang, had ? "from data\\crittext.txt" : "defaults");
    dxgi_note(m);
}
static bool ct_active() { ct_init(); return g_cs.on && !g_ctForceOff; }
static void ct_hsv(float h, float s, float v, float* out) {
    h = h - floorf(h); float i = floorf(h * 6.0f), f = h * 6.0f - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch ((int)i % 6) { case 0: out[0] = v; out[1] = t; out[2] = p; break; case 1: out[0] = q; out[1] = v; out[2] = p; break; case 2: out[0] = p; out[1] = v; out[2] = t; break;
        case 3: out[0] = p; out[1] = q; out[2] = v; break; case 4: out[0] = t; out[1] = p; out[2] = v; break; default: out[0] = v; out[1] = p; out[2] = q; break; }
}
static int ct_kind(const char* n) {
    if (strcmp(n, "SetCombatTextAndFont") == 0) return 10;
    if (strcmp(n, "SetCombatTextColorAndOpacity") == 0) return 11;
    return 0;
}
static void ct_seen(int kind, uint8_t* p) {
    if (!ct_active() || !readable((uintptr_t)p, 0xB0)) return;
    bool crit = p[0x94] != 0 || g_cs.test;
    const CritStyle& st = kCritStyles[g_cs.style];
    if (kind == 10) {
        g_ctSeen++;
        if (!crit) return;
        int32_t* fs = (int32_t*)(p + 0x9C); float* life = (float*)(p + 0xA8);
        int was = *fs; if (was < 8 || was > 400) return;
        int now = (int)(was * g_cs.size + 0.5f);
        *fs = now; if (*life > 0.0f && *life < 10.0f) *life += g_cs.hang;
        if (g_cs.hang > 0.05f) {   // hold it up: the record's velocity (+0x10) and gravity (+0x6C) move the number; no fall, no sideways push
            float* vel = (float*)(p + 0x10); float* grav = (float*)(p + 0x6C);
            vel[0] *= 0.35f; vel[1] *= 0.35f; vel[2] *= 0.35f; grav[0] = 0.0f; grav[1] = 0.0f; grav[2] = 0.0f; *(float*)(p + 0xA4) = 0.0f;
        }
        g_ctHue = (float)(GetTickCount64() % 997ULL) / 997.0f;
        if (++g_ctCrit <= 5) { char m[160]; snprintf(m, sizeof(m), "crit text: crit for %.0f, font %d -> %d, style %s (%ld numbers so far, %ld crits)", *(float*)p, was, now, st.name, g_ctSeen, g_ctCrit); dxgi_note(m); }
    } else if (kind == 11 && crit && !st.plain) {
        float* c = (float*)(p + 0x38);
        if (st.body[0] < 0.0f) ct_hsv(g_ctHue, 0.85f, 1.0f, c); else { c[0] = st.body[0]; c[1] = st.body[1]; c[2] = st.body[2]; }
        c[3] = 1.0f;
    }
}

// The look, after the game has built the number: outline, hard drop shadow, a tilt. The widget is pooled and reused, and
// the game does not reset the shadow, tilt or scale, so a number that is not a crit on a widget we changed gets them put back.
static void* g_cxFnWidget = 0, *g_cxFnFont = 0, *g_cxFnShOff = 0, *g_cxFnShCol = 0, *g_cxFnAngle = 0; static int g_cxTbOff = -1;
static float g_cxShOff0[2] = { 0, 0 }; static float g_cxShCol0[4] = { 0, 0, 0, 0 }; static bool g_cxSaved = false;
static void* g_cxDone[256]; static int g_cxDoneN = 0; static long g_cxLogs = 0;
static void* g_cxFnScale = 0;
struct CxAnim { void* tb; ULONGLONG t0; float a0; int style; int pop; float twist; float life; int frame; };
static CxAnim g_cxAnim[64]; static int g_cxAnimN = 0;
struct CxCall { void* obj; void* fn; uint8_t* p; };
static void cx_call(void* a) { CxCall* c = (CxCall*)a; g_origProcessEvent(c->obj, c->fn, c->p); }
static bool cx_pe(void* obj, void* fn, uint8_t* p) { CxCall c = { obj, fn, p }; return guarded(cx_call, &c); }
static void cx_outline(void* tb, int size, const float* rgb) {             // the font the game set, with our outline
    if (!g_cxFnFont) return;
    alignas(16) uint8_t f[0x60]; memset(f, 0, sizeof(f)); memcpy(f, (void*)((uintptr_t)tb + 0x1F0), 0x58);
    *(int32_t*)(f + 0x10) = size; float oc[4] = { rgb[0], rgb[1], rgb[2], 1.0f }; memcpy(f + 0x20, oc, 16);
    cx_pe(tb, g_cxFnFont, f);
}
static int g_cxOut0 = 0; static float g_cxOutCol0[4] = { 0, 0, 0, 1 };      // the game's own outline, read before the first change
static void cx_outline_back(void* tb) {                                    // pooled widget: the game keeps our outline unless it is put back
    if (!g_cxFnFont) return;
    alignas(16) uint8_t f[0x60]; memset(f, 0, sizeof(f)); memcpy(f, (void*)((uintptr_t)tb + 0x1F0), 0x58);
    *(int32_t*)(f + 0x10) = g_cxOut0; memcpy(f + 0x20, g_cxOutCol0, 16);
    cx_pe(tb, g_cxFnFont, f);
}
static void ct_after(void* comp, uint8_t* p) {
    if (!comp || !readable((uintptr_t)p, 0xB0)) return;
    bool crit = ct_active() && (p[0x94] != 0 || g_cs.test);
    if (!crit && !g_cxDoneN) return;
    if (!g_cxFnWidget) g_cxFnWidget = find_function(at<void*>((uintptr_t)comp + A::Object_Class), L"GetUserWidgetObject");
    if (!g_cxFnWidget) return;
    alignas(16) uint8_t r[16]; memset(r, 0, sizeof(r));
    if (!cx_pe(comp, g_cxFnWidget, r)) return;
    void* w = *(void**)r; if (!w || !readable((uintptr_t)w, 0x40)) return;
    if (g_cxTbOff < 0) {
        void* f = hr_prop(at<void*>((uintptr_t)w + A::Object_Class), L"TextBlock_Main");
        g_cxTbOff = f ? at<int32_t>((uintptr_t)f + 0x4C) : 0;
        if (g_cxTbOff <= 0 || g_cxTbOff > 0x2000) g_cxTbOff = 0;
    }
    if (!g_cxTbOff) return;
    void* tb = at<void*>((uintptr_t)w + g_cxTbOff); if (!tb || !readable((uintptr_t)tb, 0x330)) return;
    if (!g_cxFnFont) {
        void* tc = at<void*>((uintptr_t)tb + A::Object_Class);
        g_cxFnFont = find_function(tc, L"SetFont"); g_cxFnShOff = find_function(tc, L"SetShadowOffset");
        g_cxFnShCol = find_function(tc, L"SetShadowColorAndOpacity"); g_cxFnAngle = find_function(tc, L"SetRenderTransformAngle"); g_cxFnScale = find_function(tc, L"SetRenderScale");
        char m[200]; snprintf(m, sizeof(m), "crit text: look - text block at +0x%X, SetFont %s, SetShadowOffset %s, SetShadowColorAndOpacity %s, SetRenderTransformAngle %s, SetRenderScale %s",
            g_cxTbOff, g_cxFnFont ? "found" : "MISSING", g_cxFnShOff ? "found" : "MISSING", g_cxFnShCol ? "found" : "MISSING", g_cxFnAngle ? "found" : "MISSING", g_cxFnScale ? "found" : "MISSING");
        dxgi_note(m);
    }
    if (!g_cxSaved) { memcpy(g_cxShOff0, (void*)((uintptr_t)tb + 0x2D0), 8); memcpy(g_cxShCol0, (void*)((uintptr_t)tb + 0x2D8), 16);
        int o = at<int32_t>((uintptr_t)tb + 0x200); g_cxOut0 = (o >= 0 && o <= 4) ? o : 0; memcpy(g_cxOutCol0, (void*)((uintptr_t)tb + 0x210), 16); g_cxSaved = true;
        char m[120]; snprintf(m, sizeof(m), "crit text: the game's own outline is %d (read %d)", g_cxOut0, o); dxgi_note(m); }
    int idx = -1; for (int i = 0; i < g_cxDoneN; i++) if (g_cxDone[i] == tb) { idx = i; break; }
    alignas(16) uint8_t q[16];
    for (int i = 0; i < g_cxAnimN; i++) if (g_cxAnim[i].tb == tb) { g_cxAnim[i] = g_cxAnim[--g_cxAnimN]; break; }
    if (idx >= 0) {                                                               // back to the game's own outline, shadow, tilt and scale first
        cx_outline_back(tb);
        if (g_cxFnShOff) { memset(q, 0, 16); memcpy(q, g_cxShOff0, 8); cx_pe(tb, g_cxFnShOff, q); }
        if (g_cxFnShCol) { memset(q, 0, 16); memcpy(q, g_cxShCol0, 16); cx_pe(tb, g_cxFnShCol, q); }
        if (g_cxFnAngle) { memset(q, 0, 16); cx_pe(tb, g_cxFnAngle, q); }
        if (g_cxFnScale) { memset(q, 0, 16); float one[2] = { 1.0f, 1.0f }; memcpy(q, one, 8); cx_pe(tb, g_cxFnScale, q); }
        if (!crit) { g_cxDone[idx] = g_cxDone[--g_cxDoneN]; return; }
    }
    if (!crit) return;
    const CritStyle& st = kCritStyles[g_cs.style];
    float a = 0.0f;
    if (!st.plain) {
        if (st.outlineSize > 0) cx_outline(tb, st.outlineSize, st.outline);
        if (st.shadow > 0.0f) {
            if (g_cxFnShOff) { memset(q, 0, 16); float o[2] = { st.shadow, st.shadow }; memcpy(q, o, 8); cx_pe(tb, g_cxFnShOff, q); }
            if (g_cxFnShCol) { memset(q, 0, 16); float c[4] = { 0.0f, 0.0f, 0.0f, 0.9f }; memcpy(q, c, 16); cx_pe(tb, g_cxFnShCol, q); }
        }
        if (g_cs.tilt >= 0.5f) {
            ULONGLONG t = GetTickCount64(); float k = 0.6f + 0.4f * (float)(t % 11ULL) / 10.0f;
            a = g_cs.tilt * k * ((t / 13ULL) & 1ULL ? 1.0f : -1.0f);
            if (g_cxFnAngle) { memset(q, 0, 16); memcpy(q, &a, 4); cx_pe(tb, g_cxFnAngle, q); }
        }
    }
    if ((g_cs.pop || st.cycle) && g_cxAnimN < 64) {                               // the engine tick animates it
        CxAnim& c = g_cxAnim[g_cxAnimN++];
        c.tb = tb; c.t0 = GetTickCount64(); c.a0 = a; c.style = g_cs.style; c.pop = g_cs.pop; c.twist = st.plain ? 0.0f : g_cs.tilt * 0.6f; c.life = 1.6f + g_cs.hang; c.frame = 0;
    }
    if (idx < 0 && g_cxDoneN < 256) g_cxDone[g_cxDoneN++] = tb;
    if (++g_cxLogs <= 3) { char m[120]; snprintf(m, sizeof(m), "crit text: %s look applied (tilt %.0f, pop %s)", st.name, a, g_cs.pop ? "on" : "off"); dxgi_note(m); }
}

static void ct_anim_tick() {                     // player's game, every frame while crit numbers are up
    if (!g_cxAnimN) return;
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < g_cxAnimN; ) {
        CxAnim& c = g_cxAnim[i];
        float t = (now - c.t0) / 1000.0f;
        if (t > c.life || !readable((uintptr_t)c.tb, 0x330) || (at<uint32_t>((uintptr_t)c.tb + A::Object_Flags) & 0x60000000)) { g_cxAnim[i] = g_cxAnim[--g_cxAnimN]; continue; }
        alignas(16) uint8_t q[16];
        if (c.pop && g_cxFnScale) {
            float s;                                                         // 0.5 -> 1.6 pop, settle to 1.35, grow to 1.5
            if (t < 0.16f) s = 0.5f + (1.6f - 0.5f) * (t / 0.16f);
            else if (t < 0.34f) s = 1.6f - 0.25f * ((t - 0.16f) / 0.18f);
            else s = 1.35f + 0.15f * ((t - 0.34f) / (c.life - 0.34f));
            memset(q, 0, 16); float sc[2] = { s, s }; memcpy(q, sc, 8); cx_pe(c.tb, g_cxFnScale, q);
            if (g_cxFnAngle && c.twist > 0.2f) { float ang = c.a0 + c.twist * sinf(t * 5.5f); memset(q, 0, 16); memcpy(q, &ang, 4); cx_pe(c.tb, g_cxFnAngle, q); }
        }
        const CritStyle& st = kCritStyles[c.style];
        if (st.cycle && (c.frame++ % 3) == 0) {
            float oc[3];
            if (st.cycle == 1) ct_hsv(t * 0.9f + (float)(c.t0 % 100ULL) / 100.0f, 0.9f, 1.0f, oc);
            else { float k = 0.5f + 0.5f * sinf(t * 17.0f) * sinf(t * 7.3f + 1.0f); oc[0] = 0.45f + 0.55f * k; oc[1] = 0.05f + 0.75f * k * k; oc[2] = 0.0f; }
            cx_outline(c.tb, st.outlineSize, oc);
        }
        i++;
    }
}

// DF-CRITOPTS-1147 (Nov 13): the crit settings as rows on the game's Options > Gameplay page, under the Character rows.
// The page (w_options_gameplay_C, native parent OptionsCatGameplay) is seen when its Construct event passes through
// ProcessEvent (tag 12). A moment later, from the engine tick, the loader makes rows out of the game's own row widgets
// (w_options_toggle_C, w_options_slider_C) with WidgetBlueprintLibrary.Create and adds them to the vertical box that
// holds the Content Notifications row. While the page lives the tick reads the rows (CheckBox.IsChecked,
// Slider.GetValue), keeps their labels right, and saves changes to data\crittext.txt. Every call is fenced.
// Offsets (CL647472 dump): OptionsCatGameplay GameplayCombatTextToggle +0x3B0, CharacterResetBreadcrumbsButton +0x3F8;
// OptionsToggleWidget CheckboxControl +0x3A0; OptionsSliderWidget SliderControl +0x3A0. Blueprint fields by name.
struct OpRow { const char* label; int kind; void* w; void* ctrl; void* lab; void* qty; void* unit; char shown[24]; };   // kind 0 toggle, 1 slider
static OpRow g_opRows[7] = {
    { "Crit Numbers", 0 }, { "Crit Style", 1 }, { "Crit Size", 1 }, { "Crit Pop and Twist", 0 }, { "Crit Tilt", 1 }, { "Crit Hang Time", 1 }, { "Crit Test Mode (every hit)", 0 } };
static void* g_opPage = 0, *g_opPageCls = 0, *g_opToggleCls = 0, *g_opSliderCls = 0; static ULONGLONG g_opAt = 0; static int g_opState = 0;   // 0 none, 1 seen, 2 built, -1 failed
static void* g_opWBL = 0, *g_opKTL = 0, *g_opFnCreate = 0, *g_opFnToText = 0, *g_opFnAdd = 0, *g_opFnParent = 0;
static void* g_opFnIsChecked = 0, *g_opFnSetChecked = 0, *g_opFnGetValue = 0, *g_opFnSetValue = 0, *g_opFnSetStep = 0, *g_opFnSetText = 0;
static int g_opOffToggleLabel = 0, g_opOffSliderLabel = 0, g_opOffQty = 0, g_opOffUnit = 0; static long g_opFrame = 0; static ULONGLONG g_opDirtyAt = 0;
struct OpText { char s[28]; uint8_t ft[0x18]; }; static OpText g_opTexts[160]; static int g_opTextN = 0;
static int op_kind(void* fn, const char* n) {
    if (strcmp(n, "Construct") != 0) return 0;
    void* outer = at<void*>((uintptr_t)fn + A::Object_Outer); if (!outer) return 0;
    char on[64]; name_of(outer, on, sizeof(on)); return strcmp(on, "w_options_gameplay_C") == 0 ? 12 : 0;
}
// Is this still a live engine object? Its slot in the engine's object list (InternalIndex +0x0C) must point back at it
// and not be flagged Unreachable or PendingKill. Blueprint widgets AND their classes are unloaded when Options closes,
// so every pointer kept between frames is checked with this before use (crash Nov 13: a kept slider class was gone).
static bool op_listed(void* o) {
    if (!o || !readable((uintptr_t)o, 0x30)) return false;
    uintptr_t arr = g_base + VD::GUObjectArray;
    int32_t num = (int32_t)(at<uintptr_t>(arr + 0x20) >> 32); uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    int32_t idx = at<int32_t>((uintptr_t)o + 0x0C);
    if (!chunks || num <= 0 || idx < 0 || idx >= num) return false;
    uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(idx >> 16)); if (!chunk) return false;
    uintptr_t item = chunk + 0x18 * (uintptr_t)(idx & 0xFFFF);
    return at<uintptr_t>(item) == (uintptr_t)o && !(at<uint32_t>(item + 8) & 0x30000000u);
}
static bool op_alive(void* o, void* cls);
static void op_seen(void* page) {
    ct_init(); if (g_ctForceOff) return;
    if (page == g_opPage && g_opState == 2 && g_opRows[0].w && op_alive(g_opRows[0].w, g_opToggleCls)) return;   // same page shown again: its rows are still in it
    g_opPage = page; g_opPageCls = at<void*>((uintptr_t)page + A::Object_Class); g_opAt = GetTickCount64(); g_opState = 1;
}
struct OpFind { const wchar_t* want[3]; void* out[3]; };
static void op_find(void* arg) {
    OpFind* f = (OpFind*)arg;
    uintptr_t arr = g_base + VD::GUObjectArray;
    int32_t num = (int32_t)(at<uintptr_t>(arr + 0x20) >> 32); uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    if (num <= 0 || num > 20000000 || !chunks) return;
    for (int32_t i = 0; i < num; i++) {
        uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(i >> 16)); if (!chunk) continue;
        uintptr_t it = chunk + 0x18 * (uintptr_t)(i & 0xFFFF); uintptr_t o = at<uintptr_t>(it); if (!o || (at<uint32_t>(it + 8) & 0x30000000u)) continue;
        for (int k = 0; k < 3; k++) if (!f->out[k] && f->want[k] && name_is((void*)o, f->want[k])) f->out[k] = (void*)o;
        if ((f->out[0] || !f->want[0]) && (f->out[1] || !f->want[1]) && (f->out[2] || !f->want[2])) return;
    }
}
struct OpLoad { void* cls; const wchar_t* path; void* out; };
static void op_load(void* arg) { OpLoad* r = (OpLoad*)arg;
    r->out = ((void* (*)(void*, void*, const wchar_t*, const wchar_t*, uint32_t, void*, bool, void*))(g_base + VD::StaticLoadObject))(r->cls, 0, r->path, 0, 0, 0, true, 0); }
static int op_psize(void* fn) { return fn ? at<int32_t>((uintptr_t)fn + 0x58) : -1; }                 // UStruct::PropertiesSize
static int op_field(void* cls, const wchar_t* name) { void* f = hr_prop(cls, name); int o = f ? at<int32_t>((uintptr_t)f + 0x4C) : 0; return (o > 0 && o < 0x2000) ? o : 0; }
static const uint8_t* op_text(const char* s) {                                 // an FText for a short string, made once and kept
    for (int i = 0; i < g_opTextN; i++) if (strcmp(g_opTexts[i].s, s) == 0) return g_opTexts[i].ft;
    if (g_opTextN >= 160 || !g_opKTL || !g_opFnToText) return 0;
    wchar_t ws[32]; int n = 0; for (; s[n] && n < 27; n++) ws[n] = (wchar_t)(unsigned char)s[n]; ws[n] = 0;
    alignas(16) uint8_t p[0x28]; memset(p, 0, sizeof(p));
    FString fs; fs.Data = ws; fs.Num = n + 1; fs.Max = n + 1; memcpy(p, &fs, sizeof(fs));
    if (!cx_pe(g_opKTL, g_opFnToText, p)) return 0;
    if (!*(void**)(p + 0x10)) return 0;
    OpText& t = g_opTexts[g_opTextN++]; snprintf(t.s, sizeof(t.s), "%s", s); memcpy(t.ft, p + 0x10, 0x18); return t.ft;
}
static void op_set_text(void* tb, const char* s) {
    if (!g_opFnSetText || !op_listed(tb)) return;
    const uint8_t* ft = op_text(s); if (!ft) return;
    alignas(16) uint8_t p[0x18]; memcpy(p, ft, 0x18); cx_pe(tb, g_opFnSetText, p);
}
static float op_norm(int row) { return row == 1 ? g_cs.style / 5.0f : row == 2 ? (g_cs.size - 1.0f) / 2.0f : row == 4 ? g_cs.tilt / 15.0f : g_cs.hang / 3.0f; }
static bool op_alive(void* o, void* cls) { return op_listed(o) && readable((uintptr_t)o, 0x3B0) && at<void*>((uintptr_t)o + A::Object_Class) == cls; }
static void op_fail(const char* why) { char m[200]; snprintf(m, sizeof(m), "crit options: rows not added - %s", why); dxgi_note(m); g_opState = -1; }
static void op_build() {
    void* page = g_opPage;
    void* tgl = at<void*>((uintptr_t)page + 0x3B0), *btn = at<void*>((uintptr_t)page + 0x3F8);
    if (!op_listed(page) || !op_listed(tgl) || !op_listed(btn) || !readable((uintptr_t)tgl, 0x3B0)) return op_fail("the page's own rows are not there");
    g_opWBL = g_opKTL = g_opSliderCls = 0;                                          // nothing is kept from an earlier visit to the page
    g_opFnIsChecked = g_opFnSetChecked = g_opFnGetValue = g_opFnSetValue = g_opFnSetStep = g_opFnSetText = 0;
    void* tcls = at<void*>((uintptr_t)tgl + A::Object_Class);
    if (!name_is(tcls, L"w_options_toggle_C")) return op_fail("the Combat Text row is not a w_options_toggle_C (offsets differ)");
    g_opToggleCls = tcls;
    if (!g_opWBL || !g_opKTL || !g_opSliderCls) {
        OpFind f = { { L"Default__WidgetBlueprintLibrary", L"Default__KismetTextLibrary", L"w_options_slider_C" }, { 0, 0, 0 } };
        guarded(op_find, &f); g_opWBL = f.out[0]; g_opKTL = f.out[1]; g_opSliderCls = f.out[2];
        if (!g_opSliderCls) { OpLoad l = { at<void*>((uintptr_t)tcls + A::Object_Class), L"/Game/UI/Options/w_options_slider.w_options_slider_C", 0 }; if (guarded(op_load, &l)) g_opSliderCls = l.out; }
    }
    if (!op_listed(g_opWBL) || !op_listed(g_opKTL) || !op_listed(g_opSliderCls)) return op_fail("WidgetBlueprintLibrary, KismetTextLibrary or the slider row class not found");
    if (at<void*>((uintptr_t)g_opSliderCls + A::Object_Class) != at<void*>((uintptr_t)tcls + A::Object_Class)) return op_fail("the slider row class found is not a widget class");
    g_opFnCreate = find_function(at<void*>((uintptr_t)g_opWBL + A::Object_Class), L"Create");
    g_opFnToText = find_function(at<void*>((uintptr_t)g_opKTL + A::Object_Class), L"Conv_StringToText");
    g_opFnParent = find_function(at<void*>((uintptr_t)btn + A::Object_Class), L"GetParent");
    if (op_psize(g_opFnCreate) != 0x20 || op_psize(g_opFnToText) != 0x28 || op_psize(g_opFnParent) != 0x08) {
        char m[120]; snprintf(m, sizeof(m), "function shapes differ (Create %d, Conv_StringToText %d, GetParent %d)", op_psize(g_opFnCreate), op_psize(g_opFnToText), op_psize(g_opFnParent)); return op_fail(m); }
    alignas(16) uint8_t q[0x20]; memset(q, 0, sizeof(q));
    if (!cx_pe(btn, g_opFnParent, q)) return op_fail("GetParent failed");
    void* box = *(void**)q; if (!box || !readable((uintptr_t)box, 0x40)) return op_fail("the Content Notifications row has no parent box");
    void* bcls = at<void*>((uintptr_t)box + A::Object_Class);
    if (!name_is(bcls, L"VerticalBox")) return op_fail("the parent of the Content Notifications row is not a VerticalBox");
    g_opFnAdd = find_function(bcls, L"AddChildToVerticalBox");
    if (op_psize(g_opFnAdd) != 0x10) return op_fail("AddChildToVerticalBox shape differs");
    g_opOffToggleLabel = op_field(g_opToggleCls, L"ToggleLabel"); g_opOffSliderLabel = op_field(g_opSliderCls, L"SliderLabel");
    g_opOffQty = op_field(g_opSliderCls, L"QuantityLabel"); g_opOffUnit = op_field(g_opSliderCls, L"UnitLabel");
    if (!g_opOffToggleLabel || !g_opOffSliderLabel || !g_opOffQty || !g_opOffUnit) return op_fail("a label field of the row widgets was not found");
    int made = 0;
    for (int i = 0; i < 7; i++) {
        OpRow& r = g_opRows[i]; r.w = 0; r.ctrl = 0; r.lab = r.qty = r.unit = 0; r.shown[0] = 0;
        memset(q, 0, sizeof(q)); *(void**)(q + 0x00) = page; *(void**)(q + 0x08) = r.kind ? g_opSliderCls : g_opToggleCls;
        if (!cx_pe(g_opWBL, g_opFnCreate, q)) continue;
        void* w = *(void**)(q + 0x18); if (!op_listed(w) || !readable((uintptr_t)w, 0x3B0)) continue;
        alignas(16) uint8_t a[0x10]; memset(a, 0, sizeof(a)); *(void**)a = w;
        if (!cx_pe(box, g_opFnAdd, a) || !*(void**)(a + 8)) continue;
        r.w = w; r.ctrl = at<void*>((uintptr_t)w + 0x3A0);
        if (!op_listed(r.ctrl)) { r.w = 0; continue; }
        void* cc = at<void*>((uintptr_t)r.ctrl + A::Object_Class);
        if (r.kind == 0) {
            if (!g_opFnIsChecked) { g_opFnIsChecked = find_function(cc, L"IsChecked"); g_opFnSetChecked = find_function(cc, L"SetIsChecked"); }
            r.lab = at<void*>((uintptr_t)w + g_opOffToggleLabel);
            int v = i == 0 ? g_cs.on : i == 3 ? g_cs.pop : g_cs.test;
            if (g_opFnSetChecked) { alignas(16) uint8_t b[8]; memset(b, 0, 8); b[0] = v ? 1 : 0; cx_pe(r.ctrl, g_opFnSetChecked, b); }
        } else {
            if (!g_opFnGetValue) { g_opFnGetValue = find_function(cc, L"GetValue"); g_opFnSetValue = find_function(cc, L"SetValue"); g_opFnSetStep = find_function(cc, L"SetStepSize"); }
            r.lab = at<void*>((uintptr_t)w + g_opOffSliderLabel); r.qty = at<void*>((uintptr_t)w + g_opOffQty); r.unit = at<void*>((uintptr_t)w + g_opOffUnit);
            alignas(16) uint8_t b[8];
            if (g_opFnSetStep) { memset(b, 0, 8); float st = i == 1 ? 0.2f : i == 2 ? 0.05f : i == 4 ? 1.0f / 15.0f : 1.0f / 30.0f; memcpy(b, &st, 4); cx_pe(r.ctrl, g_opFnSetStep, b); }
            if (g_opFnSetValue) { memset(b, 0, 8); float v = op_norm(i); memcpy(b, &v, 4); cx_pe(r.ctrl, g_opFnSetValue, b); }
        }
        if (!g_opFnSetText && op_listed(r.lab)) g_opFnSetText = find_function(at<void*>((uintptr_t)r.lab + A::Object_Class), L"SetText");
        made++;
    }
    if (g_opFnSetText && op_psize(g_opFnSetText) != 0x18) g_opFnSetText = 0;
    char m[200]; snprintf(m, sizeof(m), "crit options: %d of 7 rows added to Options > Gameplay (IsChecked %s, GetValue %s, SetText %s)", made, g_opFnIsChecked ? "found" : "MISSING", g_opFnGetValue ? "found" : "MISSING", g_opFnSetText ? "found" : "MISSING");
    dxgi_note(m);
    g_opState = made ? 2 : -1; g_opFrame = 0;
}
static void op_tick() {                              // player's game, every frame; does nothing until the page was seen
    if (g_opDirtyAt && GetTickCount64() - g_opDirtyAt > 800) { g_opDirtyAt = 0; ct_save(); }
    if (g_opState <= 0) return;
    if (!op_alive(g_opPage, g_opPageCls)) { g_opState = 0; g_opPage = 0; return; }
    if (g_opState == 1) { if (GetTickCount64() - g_opAt < 200) return; op_build(); return; }
    g_opFrame++;
    bool changed = false; alignas(16) uint8_t b[8];
    for (int i = 0; i < 7; i++) {
        OpRow& r = g_opRows[i]; if (!r.w) continue;
        if (!op_alive(r.w, r.kind ? g_opSliderCls : g_opToggleCls) || at<void*>((uintptr_t)r.w + 0x3A0) != r.ctrl || !op_listed(r.ctrl)) { r.w = 0; continue; }
        char qty[24]; qty[0] = 0; const char* unit = "";
        if (r.kind == 0) {
            if (!g_opFnIsChecked) continue;
            memset(b, 0, 8); if (!cx_pe(r.ctrl, g_opFnIsChecked, b)) continue;
            int v = b[0] ? 1 : 0; int* dst = i == 0 ? &g_cs.on : i == 3 ? &g_cs.pop : &g_cs.test;
            if (*dst != v) { *dst = v; if (i != 6) changed = true; }
        } else {
            if (!g_opFnGetValue) continue;
            memset(b, 0, 8); if (!cx_pe(r.ctrl, g_opFnGetValue, b)) continue;
            float v; memcpy(&v, b, 4); if (!(v >= 0.0f)) v = 0.0f; if (v > 1.0f) v = 1.0f;
            if (i == 1) { int s = (int)(v * 5.0f + 0.5f); if (s != g_cs.style) { g_cs.style = s; changed = true; } snprintf(qty, sizeof(qty), "%s", kCritStyles[g_cs.style].name); }
            else if (i == 2) { float s = floorf((1.0f + 2.0f * v) * 10.0f + 0.5f) / 10.0f; if (fabsf(s - g_cs.size) > 0.01f) { g_cs.size = s; changed = true; } snprintf(qty, sizeof(qty), "%.1f", g_cs.size); unit = "x"; }
            else if (i == 4) { float s = floorf(15.0f * v + 0.5f); if (fabsf(s - g_cs.tilt) > 0.01f) { g_cs.tilt = s; changed = true; } snprintf(qty, sizeof(qty), "%.0f", g_cs.tilt); unit = "deg"; }
            else { float s = floorf(3.0f * v * 10.0f + 0.5f) / 10.0f; if (fabsf(s - g_cs.hang) > 0.01f) { g_cs.hang = s; changed = true; } snprintf(qty, sizeof(qty), "+%.1f", g_cs.hang); unit = "sec"; }
        }
        bool again = (g_opFrame % 20) == 1;                                      // the widgets write their own default text when they are built
        if (again) op_set_text(r.lab, r.label);
        if (r.kind == 1 && (again || (g_opFrame % 3) == 0 || strcmp(qty, r.shown) != 0)) { op_set_text(r.qty, qty); op_set_text(r.unit, unit[0] ? unit : " "); snprintf(r.shown, sizeof(r.shown), "%s", qty); }
    }
    if (changed) { g_opDirtyAt = GetTickCount64(); g_cxLogs = 0; }
}

// DF-STYLIST-1147 (Nov 10): Stylist2k (zzzzzzzzzzzzzzzz_Stylist1147_P.pak, a copy of Trainer Rosk) is a vendor NPC whose
// talk always opens the NPC menu (the screen is chosen inside the vendor blueprint's own code). His own talk is refused
// instead, so the only interaction at his spot is the Vault placed at his feet (data\vendor.txt), which opens the
// Vault shop. Both sides: the blueprint event CanUserStartInteraction answers false for his class, and
// SetInteractionAvailability(false) is called once after his BeginPlay. His class is learned from the first BeginPlay.
static void* g_stCls = 0; static void* g_stAvail = 0; static long g_stDenied = 0;
static void __fastcall cw_process_event(void* obj, void* fn, void* parms) {
    CwEntry* e = 0;
    if (fn) {
        uintptr_t h = ((uintptr_t)fn >> 4) & 4095;
        for (int i = 0; i < 64; i++) { CwEntry& c = g_cw[(h + i) & 4095]; if (c.fn == fn) { e = &c; break; } if (!c.fn) { c.fn = fn; name_of(fn, c.name, sizeof(c.name)); c.flag = cw_life(c.name) ? 3 : aw_kind(c.name) ? aw_kind(c.name) : (cw_wanted(c.name) ? 1 : (strcmp(c.name, "OnRep_IsActive") == 0 ? 4 : es_kind(c.name) ? es_kind(c.name) : ct_kind(c.name) ? ct_kind(c.name) : op_kind(fn, c.name) ? 12 : 2)); e = &c; break; } }
    }
    if (fn && g_cwLog && g_cwLines < 1500) {
        if (e && e->flag == 1 && e->count < 60) {
            e->count++;
            char cls[96], line[300]; name_of(obj ? at<void*>((uintptr_t)obj + A::Object_Class) : 0, cls, sizeof(cls));
            snprintf(line, sizeof(line), "cue watch %lu ms: %s on %s", (unsigned long)(GetTickCount64() % 100000000ull), e->name, cls);
            InterlockedIncrement(&g_cwLines); cw_log(line);
            if (strstr(e->name, "Spin") && !g_cwArmedAt) { g_cwArmedAt = GetTickCount64(); cw_log("actor life watch: armed by the spin, logging actors that start and end for 40 s"); }
        }
        else if (e && e->flag == 3 && g_cwArmedAt) {
            ULONGLONG since = GetTickCount64() - g_cwArmedAt;
            if (since < 40000) {
                char cls[96], line[300]; name_of(obj ? at<void*>((uintptr_t)obj + A::Object_Class) : 0, cls, sizeof(cls));
                snprintf(line, sizeof(line), "actor life %lu ms after the spin: %s on %s", (unsigned long)since, e->name, cls);
                InterlockedIncrement(&g_cwLines); cw_log(line);
            }
        }
    }
    if (e && e->flag == 4 && obj && aoefx_keep(obj)) return;                  // DF-AOEFX-1147
    if (e && (e->flag == 5 || e->flag == 6) && parms && g_esMode && !g_isServerCopy) es_seen(e->flag, parms);   // DF-EVENTSHOW-1147
    if (e && (e->flag == 10 || e->flag == 11) && parms && !g_isServerCopy) ct_seen(e->flag, (uint8_t*)parms);    // DF-CRITTEXT-1147
    char fixCls[96]; void* fixObj = 0;                                        // DF-LINGERFIX / DF-LINGERWATCH
    if (e && e->flag == 3 && obj) {
        if (strcmp(e->name, "ReceiveBeginPlay") == 0) { name_of(at<void*>((uintptr_t)obj + A::Object_Class), fixCls, sizeof(fixCls)); fixObj = obj; lw_begin(obj, fixCls);
            if (!g_stCls && strcmp(fixCls, "npc_stylist2k_bp_C") == 0) { g_stCls = at<void*>((uintptr_t)obj + A::Object_Class); cw_log("stylist: Stylist2k is here; his own talk is switched off so the Vault at his feet answers"); } }
        else lw_end(obj);
    }
    if (g_dpActor && obj && e && (obj == g_dpActor || at<void*>((uintptr_t)obj + A::Object_Outer) == g_dpActor)) dp_seen(obj, e->name);   // DF-DOMEPROBE-1147
    if ((InterlockedIncrement(&g_lwTicks) & 15) == 0) { pk_run(); vfx_tick(); dp_tick(); if ((g_lwTicks & 1023) == 0) lw_check(); }
    bool vfxWatch = fixObj && linger_class(fixCls);                           // DF-LINGERVFX-1147
    if (vfxWatch) vfx_before(fixObj);
    // DF-LOREWAIT-1147 v2: on server copies every call on a lore object is logged (lore watch), and its ReceiveBeginPlay
    // and ReceiveGameplayStart wait for the event schedule. Classes are looked up once per class pointer.
    if (g_loreWaitOn && g_isServerCopy && e && obj) {
        void* oc = at<void*>((uintptr_t)obj + A::Object_Class);
        uintptr_t ch = ((uintptr_t)oc >> 4) & 2047;
        int isLore = -1;
        for (int i = 0; i < 16; i++) { LoreCls& c = g_loreCls[(ch + i) & 2047]; if (c.cls == oc) { isLore = c.lore; break; } if (!c.cls) { c.cls = oc; c.lore = lore_class(obj) ? 1 : 0; isLore = c.lore; break; } }
        if (isLore == 1) {
            if (g_loreLogged < 600) {
                g_loreLogged++; char on[128], cn[96]; name_of(obj, on, sizeof(on)); name_of(oc, cn, sizeof(cn));
                logf_("lore watch: %s on %s (%s)%s", e->name, on, cn, (at<uint32_t>((uintptr_t)obj + A::Object_Flags) & 0x60000000) ? " [being destroyed]" : "");
            }
            if (!g_loreDone && (strcmp(e->name, "ReceiveGameplayStart") == 0 || strcmp(e->name, "ReceiveBeginPlay") == 0) && g_loreHeldN < 256) {
                if (!g_loreFirstAt) g_loreFirstAt = GetTickCount64();
                g_loreHeld[g_loreHeldN++] = { obj, fn, oc }; g_loreHeldTotal++;
                if (g_loreHeldTotal <= 6) { char cn[96]; name_of(oc, cn, sizeof(cn)); logf_("lore wait: held back %s of %s (%d so far) until the event schedule is in", e->name, cn, g_loreHeldTotal); }
                return;
            }
        }
    }
    bool stDeny = g_stCls && obj && e && parms && at<void*>((uintptr_t)obj + A::Object_Class) == g_stCls && strcmp(e->name, "CanUserStartInteraction") == 0;
    int awk = (e && e->flag >= 7 && e->flag <= 9 && obj && parms && !g_isServerCopy && aw_on()) ? e->flag : 0;      // DF-ACTWATCH-1147 (log only)
    char awBefore[170]; uint32_t awHandle = 0; int awKey = 0;
    if (awk) {
        bool awRole = false; awHandle = at<uint32_t>((uintptr_t)parms);
        awKey = at<int16_t>((uintptr_t)parms + (awk == 9 ? 4 : 0x10));   // FPredictionKey at +8, its key number at +8
        aw_state(obj, awHandle, awBefore, sizeof(awBefore), &awRole);
        if (awk != 9 && !awRole) awk = 0;
    }
    if (g_awAsc && obj == g_awAsc && !awk) aw_later();
    g_origProcessEvent(obj, fn, parms);
    if (e && e->flag == 10 && parms && !g_isServerCopy) ct_after(obj, (uint8_t*)parms);    // DF-CRITTEXT-1147 look
    if (e && e->flag == 12 && obj && !g_isServerCopy) op_seen(obj);                         // DF-CRITOPTS-1147
    if (awk) {
        const char* what = awk == 7 ? "asked the server" : awk == 8 ? "server said started" : "server said REFUSED";
        char awAfter[170]; aw_state(obj, awHandle, awAfter, sizeof(awAfter), 0);
        aw_line(what, awKey, "before", awBefore);
        if (strcmp(awBefore, awAfter) != 0) aw_line(what, awKey, "after", awAfter);
        if (awk == 9) { g_awAsc = obj; g_awHandle = awHandle; g_awKey = awKey; g_awAt = GetTickCount64(); g_awStage = 0; }
    }
    if (stDeny) { at<uint8_t>((uintptr_t)parms + 8) = 0; if (InterlockedIncrement(&g_stDenied) <= 3) cw_log("stylist: his talk refused (CanUserStartInteraction -> false)"); }
    if (fixObj && g_stCls && at<void*>((uintptr_t)fixObj + A::Object_Class) == g_stCls) {
        if (!g_stAvail) g_stAvail = find_function(g_stCls, L"SetInteractionAvailability");
        if (g_stAvail) { alignas(8) uint8_t ap[32] = { 0 }; g_origProcessEvent(fixObj, g_stAvail, ap); cw_log("stylist: SetInteractionAvailability(false) called"); }
    }
    if (vfxWatch) vfx_after(fixObj, fixCls);
    if (vfxWatch && !g_isServerCopy) dp_start(fixObj, fixCls);                 // DF-DOMEPROBE-1147
    if (fixObj) linger_fix(fixObj, fixCls);
}
static void cue_watch_init(int serverCopy) {
    char v[8];
    g_isServerCopy = serverCopy;
    if (GetEnvironmentVariableA("D1147_LINGERFIX", v, sizeof(v)) && v[0] == '0') g_lingerFix = 0;      // DF-LINGERFIX
    { char lv[8]; if (GetEnvironmentVariableA("D1147_LINGERVFX", lv, sizeof(lv))) { if (lv[0] == '0') g_vfxOn = 0; else if (lv[0] == '1') { g_vfxOn = 1; g_vfxFix = 1; } else if (lv[0] == 'l' || lv[0] == 'L') g_vfxOn = 1; } }   // DF-LINGERVFX-1147
    { char sv[16]; if (GetEnvironmentVariableA("D1147_LINGERSECS", sv, sizeof(sv))) { double d = atof(sv); if (d > 0 && d < 120) g_lingerSecs = (float)d; } }
    { char sv[16]; if (GetEnvironmentVariableA("D1147_LINGERFADE", sv, sizeof(sv))) { double d = atof(sv); if (d >= 0 && d < 30) g_lingerFade = (float)d; } }   // DF-LINGERFADE-1147
    cw_log(g_lingerFix ? "lingering effects (report 544) are given a life span so they clear: on" : "lingering effects: left as they are (D1147_LINGERFIX=0)");
    if (GetEnvironmentVariableA("D1147_CUEWATCH", v, sizeof(v)) && v[0] == '0') { cw_log("cue watch: off (D1147_CUEWATCH=0)"); return; }
    if (GetEnvironmentVariableA("D1147_CUEWATCH", v, sizeof(v)) && (v[0] == 'l' || v[0] == 'L')) g_cwLog = 1;
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(g_base + A::ProcessEvent), (void*)cw_process_event, (void**)&g_origProcessEvent);
    if (s == MH_OK) s = MH_EnableHook((void*)(g_base + A::ProcessEvent));
    cw_log(s == MH_OK ? (g_cwLog ? "effect fixes (report 544): on, measuring lines on (D1147_CUEWATCH=log)" : "effect fixes (report 544): on") : "effect fixes: hook FAILED, off");
    box_log_init();                                                          // DF-BOXLOG-1147
    if (!serverCopy && s == MH_OK) es_init();                                // DF-EVENTSHOW-1147
}

static void server_init(void) {
    // The work folder can be anywhere (any drive, spaces, non-English letters): wide-character path for the log.
    wchar_t dir[MAX_PATH] = L"."; char v[64];
    DWORD dn = GetEnvironmentVariableW(L"D1147_DIR", dir, MAX_PATH);
    if (dn == 0 || dn >= MAX_PATH) { dir[0] = L'.'; dir[1] = 0; }
    if (GetEnvironmentVariableA("D1147_PORT", v, sizeof(v))) { int p = atoi(v); if (p > 0 && p < 65536) g_port = p; }
    wchar_t path[MAX_PATH + 64];
    swprintf(path, MAX_PATH + 64, L"%ls\\logs\\server_%d.log", dir, g_port);
    g_log = _wfopen(path, L"w");
    g_base = (uintptr_t)GetModuleHandleA(0);
    g_gameThread = GetCurrentThreadId();
    if (GetEnvironmentVariableA("D1147_REPLICATE", v, sizeof(v)) && v[0] == '0') g_replicate = false;
    if (GetEnvironmentVariableA("D1147_OWNER_ONLY", v, sizeof(v)) && v[0] == '0') g_ownerOnly = 0;
    if (GetEnvironmentVariableA("D1147_MOVEDISC", v, sizeof(v)) && v[0] == '0') g_moveDisc = 0;   // DF-MOVEDISC-1147
    if (GetEnvironmentVariableA("D1147_BIGMOVE", v, sizeof(v)) && v[0] == '0') g_bigMove = 0;     // DF-BIGMOVE-1147
    if (GetEnvironmentVariableA("D1147_FALLSAFE", v, sizeof(v)) && v[0] == '0') g_fallSafe = 0;   // DF-FALLSAFE-1147
    if (GetEnvironmentVariableA("D1147_HIDDEN", v, sizeof(v)) && v[0] == '0') g_hiddenRule = 0;   // DF-HIDDENREL
    if (GetEnvironmentVariableA("D1147_REPDIV", v, sizeof(v)) && v[0] >= '1' && v[0] <= '9') g_repDiv = v[0] - '0';   // DF-REPCAP-1147
    if (GetEnvironmentVariableA("D1147_DESTROYWATCH", v, sizeof(v)) && v[0] == '1') g_destroyWatch = 1;   // DF-DESTROYWATCH
    if (GetEnvironmentVariableA("D1147_PROGRESSION", v, sizeof(v)) && v[0] == '0') g_progOk = false;
    if (GetEnvironmentVariableA("D1147_TUNING", v, sizeof(v)) && v[0] == '0') g_tuningOk = false;   // DF-TUNING-1147
    if (GetEnvironmentVariableA("D1147_STAMINA", v, sizeof(v)) && v[0] == '0') g_stamina = false;
    logf_("==== d1147 server loader, milestone 2c-fix5 + BigMove + FallSafe2 Nov 7 (dxgi forwarding retries + compatibility-shim freeze fix, empty audio device list, off the mouse). exe base %p, port %d ====", (void*)g_base, g_port);

    // DF-TIMERRES-1147 (Nov 1, reports 526-532, daveayling): a hunt server is started with -nullrhi and never asks
    // Windows for a fine timer. Windows 10 granted 1 ms system-wide as soon as any program asked (the player's own
    // game does), so the server got it for free; Windows 11 made the request per-process, so the server's frame
    // sleeps land on the 15.6 ms default and the hunt ticks about 46 a second instead of 60. Everyone in that hunt
    // feels it as rubberband, not just the host. Measured: 46.7 before, 58.9 after, same PC, nothing else changed.
    // Asked for through winmm by name so the build line needs no extra library. D1147_TIMERRES=0 turns it off.
    {
        char tv[8];
        if (GetEnvironmentVariableA("D1147_TIMERRES", tv, sizeof(tv)) && tv[0] == '0') logf_("frame timer: left alone (D1147_TIMERRES=0)");
        else {
            unsigned granted = 0;
            HMODULE wmm = LoadLibraryA("winmm.dll");
            if (wmm) {
                typedef unsigned(__stdcall * timeBeginPeriod_t)(unsigned);
                timeBeginPeriod_t tbp = (timeBeginPeriod_t)GetProcAddress(wmm, "timeBeginPeriod");
                if (tbp && tbp(1) == 0) granted = 1;   // TIMERR_NOERROR
            }
            logf_("frame timer: %s", granted ? "1 ms asked for (this hunt can tick at 60)" : "NOT granted: this hunt may tick near 46 a second");
        }
    }

    // Only this exact build: the LoadMap call to the stripped Listen stub.
    static const uint8_t listenCall[5] = { 0xE8, 0x0B, 0x79, 0x77, 0xFC };
    if (memcmp((void*)(g_base + A::LoadMapListenCall), listenCall, 5) != 0) {
        logf_("this is not the Dauntless 1.14.7 (CL 647472) exe; server mode not applied");
        return;
    }

    bool ok = true;
    { static const uint8_t r[5] = { 0xB0, 0x01, 0x90, 0x90, 0x90 };
      ok &= patch(A::LoadMapListenCall, listenCall, r, 5, "LoadMap listen -> true"); }
    { static const uint8_t e[13] = { 0x8B, 0x41, 0x78, 0xD1, 0xE8, 0x24, 0x01, 0x88, 0x05, 0xBA, 0x9B, 0x42, 0x06 };
      static const uint8_t r[13] = { 0xC6, 0x05, 0xC0, 0x9B, 0x42, 0x06, 0x00, 0x90, 0x90, 0x90, 0x90, 0x90, 0x90 };
      ok &= patch(A::PreInitA_Client, e, r, 13, "PreInit A: GIsClient = 0"); }
    { static const uint8_t e[12] = { 0x0F, 0xB6, 0x41, 0x78, 0x24, 0x01, 0x88, 0x05, 0xAF, 0x9B, 0x42, 0x06 };
      static const uint8_t r[12] = { 0xC6, 0x05, 0xB4, 0x9B, 0x42, 0x06, 0x01, 0x90, 0x90, 0x90, 0x90, 0x90 };
      ok &= patch(A::PreInitA_Server, e, r, 12, "PreInit A: GIsServer = 1"); }
    { static const uint8_t e[1] = { 0x01 }, r[1] = { 0x00 };
      ok &= patch(A::PreInitB_ClientImm, e, r, 1, "PreInit B: GIsClient = 0"); }
    { static const uint8_t e[1] = { 0x00 }, r[1] = { 0x01 };
      ok &= patch(A::PreInitC_ServerImm, e, r, 1, "PreInit C: GIsServer = 1"); }
    { static const uint8_t e[7] = { 0x44, 0x88, 0x25, 0xD4, 0x54, 0x42, 0x06 }, r[7] = { 0xC6, 0x05, 0xD4, 0x54, 0x42, 0x06, 0x00 };
      ok &= patch(A::PreInitC_Client, e, r, 7, "PreInit C: GIsClient = 0"); }
    // Oct 24 (DF-NULLRHI-1147, reports 153 163, sune report 12, the GPU-less VPS): some server copies still made a
    // D3D11 device despite -nullrhi (RHIInit exe+0x349A760 reached PlatformCreateDynamicRHI exe+0x34AA9D0) and died with
    // "Failed to choose a D3D11 Adapter" or DXGI_ERROR_DEVICE_REMOVED. A server copy never draws: the jump to the null
    // RHI (exe+0x348F3B0) is made unconditional. Not counted in ok: on another build it is only skipped.
    { static const uint8_t e[6] = { 0x0F, 0x85, 0x2F, 0x07, 0x00, 0x00 }, r[6] = { 0xE9, 0x30, 0x07, 0x00, 0x00, 0x90 };
      patch(A::RHIInitNullJump, e, r, 6, "RHIInit: always the null RHI"); }
    // DF-VFXREMOVE-1147 (Nov 2, report 544 and the Nov 1 hunt logs): when an effect ends, the game's Blueprints call a
    // multicast ("remove this visual": RemoveProxy on ce_weapons_mantis_buff, RemoveActivateEffects on ce_dontgethit,
    // Multi_DisableSuperModeEffects on enrage) and destroy the actor in the same frame. The engine refuses any remote
    // call from an actor already marked for destruction ("Remote function %s called from actor %s while actor is being
    // destroyed. Function will not be processed."), so players' games never hear "remove" and the blast, the enrage
    // flames and the rest hang around until the actor channel closes a few seconds later. The refusal is a test of
    // bActorIsBeingDestroyed (+0x5C bit 3) and a je to the normal path; the je is made unconditional so the call goes
    // out on the channel that is still open at that moment. Server copies only. D1147_VFXREMOVE=0 turns it off.
    { char vv[8]; const bool off = !(GetEnvironmentVariableA("D1147_VFXREMOVE", vv, sizeof(vv)) && vv[0] == '1');   // Nov 2: off unless asked for, it did not fix report 544
      static const uint8_t e[6] = { 0x0F, 0x84, 0x55, 0x01, 0x00, 0x00 }, r[6] = { 0xE9, 0x56, 0x01, 0x00, 0x00, 0x90 };
      if (off) logf_("effect removal calls from actors being destroyed: left as the engine has it (D1147_VFXREMOVE=1 turns the patch on)");
      else patch(A::RemoteFnDestroyedJump, e, r, 6, "ProcessRemoteFunction: calls from an actor being destroyed are still sent (effects clear at once)"); }
    // Oct 26 (DF-AMMO-LOG-1147, moved here from tools\ammo-fix-1147.ps1, which antivirus programs block because a script
    // writing into another process looks like malware): ServerAdjustAmmo's "ammo would go below 0" warning passes two values
    // to a format with three and crashes the server (Repeaters, reports 209 and others). The code after it already keeps ammo
    // between 0 and full, so the warning is always skipped: exe+0x220C8EF jns -> jmp. Not counted in ok.
    { static const uint8_t e[6] = { 0x0F, 0x89, 0xEC, 0x00, 0x00, 0x00 }, r[6] = { 0xE9, 0xED, 0x00, 0x00, 0x00, 0x90 };
      patch(0x220C8EF, e, r, 6, "ServerAdjustAmmo: skip broken warning"); }
    at<uint8_t>(g_base + A::GIsServer) = 1;
    at<uint8_t>(g_base + A::GIsClient) = 0;

    AddVectoredExceptionHandler(1, on_exception);

    MH_STATUS s = MH_Initialize();
    logf_("MinHook init: %d", (int)s);
    cue_watch_init(1);                                                       // DF-CUEWATCH
    hide_windows();
    keep_quiet_and_off_the_mouse();
    { static const uint8_t e[5] = { 0x40, 0x53, 0x48, 0x81, 0xEC }; ok &= hook(A::GetNetMode, e, 5, (void*)hook_GetNetMode, (void**)&orig_GetNetMode, "UWorld net mode -> dedicated"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 }; ok &= hook(A::ActorGetNetMode, e, 5, (void*)hook_ActorGetNetMode, (void**)&orig_ActorGetNetMode, "actor net mode -> dedicated"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 }; ok &= hook(A::ActorGetNetDriver, e, 5, (void*)hook_ActorGetNetDriver, (void**)&orig_ActorGetNetDriver, "actor net driver fallback"); }
    { static const uint8_t e[4] = { 0x48, 0x8B, 0xC4, 0x48 }; ok &= hook(A::GameEngineTick, e, 4, (void*)hook_Tick, (void**)&orig_Tick, "engine tick"); }
    { static const uint8_t e[4] = { 0x40, 0x56, 0x41, 0x56 }; ok &= hook(A::SetReplicationDriver, e, 4, (void*)hook_SetReplicationDriver, (void**)&orig_SetReplicationDriver, "no replication driver"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 }; ok &= hook(A::IsLevelInitForActor, e, 5, (void*)hook_IsLevelInitForActor, (void**)&orig_IsLevelInitForActor, "level ready for every actor"); }
    { static const uint8_t e[4] = { 0x4C, 0x8B, 0xC1, 0x84 }; ok &= hook(A::IsNetReady, e, 4, (void*)hook_IsNetReady, (void**)&orig_IsNetReady, "net-ready (no throttling)"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 }; ok &= hook(A::HasFinishedLoading, e, 5, (void*)hook_HasFinishedLoading, (void**)&orig_HasFinishedLoading, "player finished loading"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x54, 0x24, 0x10 }; ok &= hook(A::SetupPlayerInput, e, 5, (void*)hook_SetupPlayerInput, (void**)&orig_SetupPlayerInput, "skip input setup"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 }; ok &= hook(A::BountySeasonDates, e, 5, (void*)hook_BountySeasonDates, (void**)&orig_BountySeasonDates, "bounty season dates"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x20 }; ok &= hook(A::SwitchGameWindow, e, 5, (void*)hook_SwitchGameWindow, (void**)&orig_SwitchGameWindow, "no game-window view switch"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x10 }; ok &= hook(A::MessageDialogOpen, e, 5, (void*)hook_MessageDialogOpen, (void**)&orig_MessageDialogOpen, "message boxes answered silently"); }
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x18 }; ok &= hook(A::WeeklySeasonDates, e, 5, (void*)hook_WeeklySeasonDates, (void**)&orig_WeeklySeasonDates, "weekly bounty season dates"); }

    ok &= install_equipment_bridge();

    // DF-BIGMOVE-1147: push rbx / push rsi / push rdi / push r12 / push r14 / push r15 at the capsule move override
    if (g_bigMove || g_fallSafe) { static const uint8_t e[10] = { 0x40, 0x53, 0x56, 0x57, 0x41, 0x54, 0x41, 0x56, 0x41, 0x57 };
        if (!hook(0x3CA1A60, e, 10, (void*)hook_CapMove, (void**)&orig_CapMove, "capsule moves (big move watch, fall safe)")) { g_bigMove = 0; g_fallSafe = 0; } }
    // DF-FALLSAFE-1147: sub rsp,38h / mov rax,[rcx] / xor r9d,r9d at AActor::K2_TeleportTo
    if (g_fallSafe) { static const uint8_t e[10] = { 0x48, 0x83, 0xEC, 0x38, 0x48, 0x8B, 0x01, 0x45, 0x33, 0xC9 };
        if (!hook(0x18E17F0, e, 10, (void*)hook_K2Tele, (void**)&orig_K2Tele, "Blueprint teleports (fall safe)")) g_fallSafe = 0; }
    // push rbp / lea rbp,[rsp-4Fh] / sub rsp,0D0h at AActor::K2_SetActorTransform ("I'm stuck")
    if (g_fallSafe) { static const uint8_t e[11] = { 0x40, 0x55, 0x48, 0x8D, 0x6C, 0x24, 0xB1, 0x48, 0x81, 0xEC, 0xD0 };
        if (!hook(0x3B63C90, e, 11, (void*)hook_K2SetXform, (void**)&orig_K2SetXform, "Blueprint set-transform (fall safe)")) g_fallSafe = 0; }
    logf_("big move watch (player capsule moved over 50 m in one step, log only): %s", g_bigMove ? "on" : "off");
    logf_("fall safe v2 (a rescue or I am stuck move on a falling player goes to where they last stood 1.5 s, fall speed zeroed): %s", g_fallSafe ? "on" : "off (D1147_FALLSAFE=0)");

    // the functions the replication loop calls must look as expected, or it stays off
    { struct { uintptr_t a; uint8_t b[4]; const char* n; } chk[] = {
          { A::CallPreReplication, { 0x48, 0x85, 0xD2, 0x0F }, "CallPreReplication" }, { A::SendClientAdjustment, { 0x48, 0x89, 0x5C, 0x24 }, "SendClientAdjustment" },
          { A::CreateChannelByName, { 0x40, 0x53, 0x55, 0x56 }, "CreateChannelByName" }, { A::SetChannelActor, { 0x48, 0x89, 0x5C, 0x24 }, "SetChannelActor" },
          { A::ReplicateActor, { 0x4C, 0x8B, 0xDC, 0x55 }, "ReplicateActor" }, { A::WeakPtrAssign, { 0x40, 0x53, 0x48, 0x83 }, "WeakPtrAssign" } };
      for (auto& c : chk) if (memcmp((void*)(g_base + c.a), c.b, 4) != 0) { logf_("replication OFF: %s is not where expected", c.n); g_replicate = false; } }
    logf_("replication loop: %s", g_replicate ? "on" : "OFF");
    logf_("owner-only actors go to their owner only: %s", g_ownerOnly ? "on" : "off (D1147_OWNER_ONLY=0)");
    logf_("move checker resolution (the rubberband pull-back) will be switched off on the world's network manager: %s", g_moveDisc ? "yes" : "no (D1147_MOVEDISC=0)");   // DF-MOVEDISC-1147
    logf_("hidden actors wait until they are shown: %s", g_hiddenRule ? "on" : "off (D1147_HIDDEN=0)");   // DF-HIDDENREL
    logf_("replication serves up to 64 connections (was 8); each player's actors every %d tick(s) (D1147_REPDIV)", g_repDiv);   // DF-REPCAP-1147
    if (g_destroyWatch) logf_("destroy watch (a measurement, D1147_DESTROYWATCH=1): on");   // DF-DESTROYWATCH
    { static const uint8_t e[5] = { 0x48, 0x89, 0x5C, 0x24, 0x08 };
      if (memcmp((void*)(g_base + A::QueryHuntPassSeason), e, 5) != 0) { logf_("progression request OFF: function not where expected"); g_progOk = false; } }
    logf_("progression configuration request: %s", g_progOk ? "on" : "OFF");
    { static const uint8_t e[10] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18 };   // DF-TUNING-1147
      if (memcmp((void*)(g_base + A::TuningRequest), e, 10) != 0) { logf_("tuning request OFF: function not where expected"); g_tuningOk = false; } }
    logf_("tuning data request (event schedule): %s", g_tuningOk ? "on" : "OFF");
    { char lw[8]; if (GetEnvironmentVariableA("D1147_LOREWAIT", lw, sizeof(lw)) && lw[0] == '0') g_loreWaitOn = false; }   // DF-LOREWAIT-1147
    logf_("island event items wait for the event schedule: %s", g_loreWaitOn ? "on" : "OFF (D1147_LOREWAIT=0)");
    logf_(ok ? "server mode applied; waiting for the engine to start" : "server mode only PARTLY applied; see lines above");
    logf_("command line: %s", GetCommandLineA());
}

// ---------------------------------------------------------------------------- client mode: boss health bar (overlay)
// With D1147_CLIENT_BOSSBAR=1 the player's game shows the nearest behemoth's health and its parts' health in a small
// click-through window drawn over the top of the game window. The numbers come from the game's own replicated values:
// AArchonCreatureBase::GetCurrentHealth/GetMaxHealth/GetBehemothFullName and AMonsterPartActor::GetHealth/GetMaxHealth;
// a part's name is its MonsterPartComponent's object name (Head, LeftLeg, Tail...).
static bool g_clientBoss = false;
static long g_cTicks = 0;
struct BossPart { wchar_t name[48]; float cur, max; };
struct BossSnap { bool show; wchar_t name[64]; float cur, max; int nparts; BossPart parts[12]; };
static BossSnap g_snap; static CRITICAL_SECTION g_snapLock; static volatile LONG g_snapSeq = 0;
static HWND g_gameWnd = 0;
struct ClsKind { void* cls; uint8_t kind; };          // kind: 1 = behemoth, 2 = monster part, 3 = other
static ClsKind g_kinds[2048]; static void* g_kindsWorld = 0;
static bool class_chain_has(void* cls, const wchar_t* want) {
    for (int d = 0; cls && d < 40; d++, cls = at<void*>((uintptr_t)cls + A::Struct_Super)) if (name_is(cls, want)) return true;
    return false;
}
static uint8_t kind_of(void* cls) {
    uintptr_t h = ((uintptr_t)cls >> 4) & 2047;
    for (int i = 0; i < 2048; i++) {
        ClsKind& k = g_kinds[(h + i) & 2047];
        if (k.cls == cls) return k.kind;
        if (!k.cls) {
            k.cls = cls;
            k.kind = class_chain_has(cls, L"ArchonBehemoth") ? 1 : class_chain_has(cls, L"MonsterPartActor") ? 2 : 3;
            return k.kind;
        }
    }
    return 3;
}
static void* fn_cached(void* obj, const wchar_t* name, void** cache) {
    if (!*cache) *cache = find_function(at<void*>((uintptr_t)obj + A::Object_Class), name);
    return *cache;
}
struct PECall { void* obj; void* fn; uint8_t parms[32]; };
static void pe_call(void* arg) { PECall* c = (PECall*)arg; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(c->obj, c->fn, c->parms); }
static bool call_float(void* obj, void* fn, float* out) {
    if (!fn) return false; PECall c; c.obj = obj; c.fn = fn; memset(c.parms, 0, sizeof(c.parms));
    if (!guarded(pe_call, &c)) return false; *out = *(float*)c.parms; return true;
}
static void* g_fBehCur = 0, *g_fBehMax = 0, *g_fBehName = 0, *g_fPartCur = 0, *g_fPartMax = 0, *g_fLoc = 0;
static bool actor_loc(void* a, float* xyz) {
    if (!fn_cached(a, L"K2_GetActorLocation", &g_fLoc)) return false;
    PECall c; c.obj = a; c.fn = g_fLoc; memset(c.parms, 0, sizeof(c.parms));
    if (!guarded(pe_call, &c)) return false; memcpy(xyz, c.parms, 12); return true;
}
static void pretty_part(const wchar_t* in, wchar_t* out, int n) {
    // "LeftLeg" -> "Left leg", "head_part" -> "Head"; drops common suffixes
    wchar_t t[64]; int k = 0;
    for (int i = 0; in[i] && k < 62; i++) t[k++] = in[i]; t[k] = 0;
    const wchar_t* cut[] = { L"PartComponent", L"_part", L"Part", L"Component" };
    for (auto c : cut) { size_t lc = wcslen(c), lt = wcslen(t); if (lt > lc && _wcsicmp(t + lt - lc, c) == 0) t[lt - lc] = 0; }
    int o = 0;
    for (int i = 0; t[i] && o < n - 2; i++) {
        wchar_t ch = t[i];
        if (ch == L'_') { if (o && out[o - 1] != L' ') out[o++] = L' '; continue; }
        if (ch >= L'0' && ch <= L'9') continue;
        if (i && iswupper(ch) && o && out[o - 1] != L' ' && !iswupper(t[i - 1])) { out[o++] = L' '; ch = towlower(ch); }
        else if (o && out[o - 1] == L' ') ch = towlower(ch);
        out[o++] = ch;
    }
    while (o && out[o - 1] == L' ') o--;
    out[o] = 0; if (out[0]) out[0] = towupper(out[0]);
    if (!out[0]) wcsncpy(out, L"Part", n);
}
static void obj_wname(void* obj, wchar_t* out, int n) {
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)((uintptr_t)obj + A::Object_Name), &s);
    int i = 0; for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++) out[i] = s.Data[i]; out[i] = 0;
}
static void fname_w(uint64_t fname, wchar_t* out, int n) {
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))(&fname, &s);
    int i = 0; for (; s.Data && i < n - 1 && i < s.Num && s.Data[i]; i++) out[i] = s.Data[i]; out[i] = 0;
}
static long g_bossNotes = 0;
static void boss_collect(void* world) {
    if (world != g_kindsWorld) { memset(g_kinds, 0, sizeof(g_kinds)); g_kindsWorld = world; }
    void* gi = at<void*>((uintptr_t)world + A::World_GameInstance);
    TArrayRaw* lp = gi ? &at<TArrayRaw>((uintptr_t)gi + 0x38) : 0;
    void* pc = (lp && lp->Data && lp->Num > 0 && lp->Data[0]) ? at<void*>((uintptr_t)lp->Data[0] + 0x30) : 0;
    void* pawn = pc ? at<void*>((uintptr_t)pc + A::PC_Pawn) : 0;
    float me[3] = { 0, 0, 0 }; bool haveMe = pawn && actor_loc(pawn, me);
    void* beh[16]; int nb = 0; void* parts[64]; int np = 0;
    TArrayRaw& levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    for (int li = 0; levels.Data && li < levels.Num && li < 512; li++) {
        void* level = levels.Data[li]; if (!level) continue;
        TArrayRaw& actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; actors.Data && ai < actors.Num; ai++) {
            void* a = actors.Data[ai]; if (!a) continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000) continue;
            uint8_t k = kind_of(at<void*>((uintptr_t)a + A::Object_Class));
            if (k == 1 && nb < 16) beh[nb++] = a; else if (k == 2 && np < 64) parts[np++] = a;
        }
    }
    BossSnap s; memset(&s, 0, sizeof(s));
    void* best = 0; float bestScore = 1e30f, bestCur = 0, bestMax = 0;
    for (int i = 0; i < nb; i++) {
        float cur = 0, mx = 0;
        if (!call_float(beh[i], fn_cached(beh[i], L"GetMaxHealth", &g_fBehMax), &mx) || mx <= 0) continue;
        call_float(beh[i], fn_cached(beh[i], L"GetCurrentHealth", &g_fBehCur), &cur);
        if (cur <= 0) continue;
        float d2 = 1e20f, p[3];
        if (haveMe && actor_loc(beh[i], p)) d2 = (p[0]-me[0])*(p[0]-me[0]) + (p[1]-me[1])*(p[1]-me[1]) + (p[2]-me[2])*(p[2]-me[2]);
        bool hurt = cur < mx;
        if (!hurt && d2 > 9000.0f * 9000.0f) continue;          // far away and untouched: not shown
        float score = d2 - (hurt ? 1e12f : 0);
        if (score < bestScore) { bestScore = score; best = beh[i]; bestCur = cur; bestMax = mx; }
    }
    if (best) {
        s.show = true; s.cur = bestCur; s.max = bestMax;
        PECall c; c.obj = best; c.fn = fn_cached(best, L"GetBehemothFullName", &g_fBehName); memset(c.parms, 0, sizeof(c.parms));
        if (c.fn && guarded(pe_call, &c)) fname_w(*(uint64_t*)c.parms, s.name, 64);
        // parts named by the behemoth's own MonsterPartComponents (each points at its replicated part actor)
        static void* diagFor = 0; bool diag = best != diagFor; if (diag) diagFor = best;
        int ncomp = 0, nlinked = 0;
        // DF-BOSSBAR-SAFE (Oct 21): the part actors reached through this behemoth's MonsterPartComponents. Only those
        // components are read at PartComp_Actor (0x520): other components can be smaller, and reading 0x520 into
        // one ran past its memory (client crash at dxgi+0x8F12, SkyZzefHD report #1).
        void* linked[64]; int nl = 0;
        for (int arr = 0; arr < 2; arr++) {
            TArrayRaw& cs = at<TArrayRaw>((uintptr_t)best + (arr ? A::Actor_BPComponents : A::Actor_InstComponents));
            for (int ci = 0; cs.Data && ci < cs.Num && ci < 256; ci++) {
                void* comp = cs.Data[ci]; if (!comp) continue;
                void* cc = at<void*>((uintptr_t)comp + A::Object_Class);
                static void* partCompClass = 0;
                if (cc != partCompClass) { if (!class_chain_has(cc, L"MonsterPartComponent")) continue; partCompClass = cc; }
                ncomp++;
                void* pa = at<void*>((uintptr_t)comp + A::PartComp_Actor);
                if (diag) { wchar_t cn[64]; obj_wname(comp, cn, 64); char an[128]; logf_("boss bar:    component '%ls' -> part actor %s", cn, pa ? name_of(pa, an, sizeof(an)) : "(none on this PC)"); }
                if (!pa || s.nparts >= 12) continue;
                nlinked++;
                if (nl < 64) linked[nl++] = pa;
                bool dup = false; for (int k = 0; k < np; k++) if (parts[k] == pa) { dup = true; break; }
                if (!dup && np < 64) parts[np++] = pa;
            }
        }
        if (diag) logf_("boss bar: %d part component(s) on this behemoth, %d with a part actor here", ncomp, nlinked);
        for (int i = 0; i < np && s.nparts < 12; i++) {
            if (at<void*>((uintptr_t)parts[i] + A::Actor_Owner) != best) {
                bool mine = false;   // also accept part actors reached through the behemoth's part components (found above)
                for (int k = 0; k < nl && !mine; k++) if (linked[k] == parts[i]) mine = true;
                if (!mine) continue;
            }
            float cur = 0, mx = 0;
            if (!call_float(parts[i], fn_cached(parts[i], L"GetMaxHealth", &g_fPartMax), &mx) || mx <= 0) continue;
            call_float(parts[i], fn_cached(parts[i], L"GetHealth", &g_fPartCur), &cur);
            BossPart& bp = s.parts[s.nparts++];
            bp.cur = cur < 0 ? 0 : cur; bp.max = mx;
            void* comp = at<void*>((uintptr_t)parts[i] + A::Part_Component);
            wchar_t raw[64] = L""; if (comp) obj_wname(comp, raw, 64);
            pretty_part(raw, bp.name, 48);
        }
        static void* lastBest = 0;
        if (best != lastBest && ++g_bossNotes <= 40) {
            lastBest = best; char nm[160];
            logf_("boss bar: showing %s '%ls' %.0f/%.0f with %d part(s) (of %d part actors in the world)", name_of(best, nm, sizeof(nm)), s.name, s.cur, s.max, s.nparts, np);
            for (int i = 0; i < s.nparts; i++) logf_("   part '%ls' %.0f/%.0f", s.parts[i].name, s.parts[i].cur, s.parts[i].max);
        }
    }
    EnterCriticalSection(&g_snapLock); g_snap = s; LeaveCriticalSection(&g_snapLock);
    InterlockedIncrement(&g_snapSeq);
}

// ---- the overlay window (own thread). Drawn into a 32-bit premultiplied-alpha bitmap; text via GDI as a coverage mask.
static BOOL CALLBACK find_game_wnd(HWND h, LPARAM) {
    DWORD pid = 0; GetWindowThreadProcessId(h, &pid);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(h) || GetWindow(h, GW_OWNER)) return TRUE;
    wchar_t cls[64]; GetClassNameW(h, cls, 64);
    if (wcscmp(cls, L"UnrealWindow") == 0) { g_gameWnd = h; return FALSE; }
    return TRUE;
}
struct Canvas { uint32_t* px; int w, h; };
static void blend(Canvas& c, int x, int y, uint32_t rgb, int a) {      // a 0..255, rgb not premultiplied
    if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
    uint32_t& d = c.px[y * c.w + x];
    int da = d >> 24, dr = (d >> 16) & 255, dg = (d >> 8) & 255, db = d & 255;
    int sr = ((rgb >> 16) & 255) * a / 255, sg = ((rgb >> 8) & 255) * a / 255, sb = (rgb & 255) * a / 255;
    int ia = 255 - a;
    d = ((a + da * ia / 255) << 24) | ((sr + dr * ia / 255) << 16) | ((sg + dg * ia / 255) << 8) | (sb + db * ia / 255);
}
static void slant_bar(Canvas& c, int x, int y, int w, int h, int slant, uint32_t rgb, int a) {
    for (int j = 0; j < h; j++) { int off = slant * (h - 1 - j) / (h > 1 ? h - 1 : 1); for (int i = 0; i < w; i++) blend(c, x + off + i, y + j, rgb, a); }
}
static void bar_widget(Canvas& c, int x, int y, int w, int h, float frac, uint32_t fill, uint32_t empty) {
    int sl = h / 3;
    slant_bar(c, x - 3, y - 3, w + 6, h + 6, sl, 0x3A3A3A, 235);       // dark frame
    slant_bar(c, x, y, w, h, sl, empty, 235);
    if (frac > 0) { int fw = (int)(w * (frac > 1 ? 1 : frac) + 0.5f); if (fw > 0) slant_bar(c, x, y, fw, h, sl, fill, 245); }
}
static HDC g_tdc = 0; static HBITMAP g_tbmp = 0; static uint32_t* g_tpx = 0; static int g_tw = 0, g_th = 0;
static void text(Canvas& c, int x, int y, const wchar_t* t, int size, bool bold) {
    if (!t || !t[0]) return;
    int tw = c.w, th = size + 8;
    if (!g_tdc || g_tw != tw || g_th != th) {
        if (g_tbmp) DeleteObject(g_tbmp); if (!g_tdc) g_tdc = CreateCompatibleDC(0);
        BITMAPINFO bi = {}; bi.bmiHeader.biSize = sizeof(bi.bmiHeader); bi.bmiHeader.biWidth = tw; bi.bmiHeader.biHeight = -th; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
        g_tbmp = CreateDIBSection(g_tdc, &bi, DIB_RGB_COLORS, (void**)&g_tpx, 0, 0); SelectObject(g_tdc, g_tbmp); g_tw = tw; g_th = th;
    }
    memset(g_tpx, 0, (size_t)tw * th * 4);
    HFONT f = CreateFontW(-size, 0, 0, 0, bold ? FW_BOLD : FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, ANTIALIASED_QUALITY, 0, L"Segoe UI");
    HGDIOBJ old = SelectObject(g_tdc, f); SetBkMode(g_tdc, TRANSPARENT); SetTextColor(g_tdc, RGB(255, 255, 255));
    TextOutW(g_tdc, 2, 2, t, (int)wcslen(t)); GdiFlush(); SelectObject(g_tdc, old); DeleteObject(f);
    for (int pass = 0; pass < 2; pass++)                          // 0: shadow, 1: white text
        for (int j = 0; j < th; j++) for (int i = 0; i < tw; i++) {
            int cov = g_tpx[j * tw + i] & 255; if (!cov) continue;
            if (pass == 0) { for (int dy = -1; dy <= 2; dy++) for (int dx = -1; dx <= 2; dx++) blend(c, x + i - 2 + dx, y + j - 2 + dy, 0x000000, cov * 2 / 3); }
            else blend(c, x + i - 2, y + j - 2, 0xFFFFFF, cov);
        }
}
static void fmt_num(float v, wchar_t* out) {
    long long n = (long long)(v + 0.5f); if (n < 0) n = 0;
    wchar_t t[32]; int k = 0; do { t[k++] = L'0' + (wchar_t)(n % 10); n /= 10; if (n && k % 4 == 3) t[k++] = L','; } while (n && k < 30);
    for (int i = 0; i < k; i++) out[i] = t[k - 1 - i]; out[k] = 0;
}
// Where the bar sits: its centre at g_bbCx of the game window's width, its top at g_bbTy of the height. Ctrl+Alt+arrow
// keys move it (while it shows), Ctrl+Alt+Home puts it back; saved in <D1147_DIR>\data\bossbar_pos.txt.
static float g_bbCx = 0.5f, g_bbTy = 0.085f;
static wchar_t g_bbFile[MAX_PATH + 64] = L"";
static void bb_load() {
    if (!g_bbFile[0]) return;
    FILE* f = _wfopen(g_bbFile, L"r"); if (!f) return;
    float cx, ty; if (fscanf(f, "cx=%f ty=%f", &cx, &ty) == 2 && cx >= 0 && cx <= 1 && ty >= 0 && ty <= 0.95f) { g_bbCx = cx; g_bbTy = ty; }
    fclose(f);
}
static void bb_save() {
    if (!g_bbFile[0]) return;
    FILE* f = _wfopen(g_bbFile, L"w"); if (!f) return;
    fprintf(f, "cx=%.4f ty=%.4f\n", g_bbCx, g_bbTy); fclose(f);
}
static bool bb_keys() {          // true when the bar moved this time
    static bool moving = false;
    bool ca = (GetAsyncKeyState(VK_CONTROL) & 0x8000) && (GetAsyncKeyState(VK_MENU) & 0x8000);
    float dx = 0, dy = 0; bool home = false;
    if (ca) {
        if (GetAsyncKeyState(VK_LEFT) & 0x8000) dx -= 0.01f;
        if (GetAsyncKeyState(VK_RIGHT) & 0x8000) dx += 0.01f;
        if (GetAsyncKeyState(VK_UP) & 0x8000) dy -= 0.01f;
        if (GetAsyncKeyState(VK_DOWN) & 0x8000) dy += 0.01f;
        home = (GetAsyncKeyState(VK_HOME) & 0x8000) != 0;
    }
    if (home) { g_bbCx = 0.5f; g_bbTy = 0.085f; moving = true; return true; }
    if (dx != 0 || dy != 0) {
        g_bbCx += dx; g_bbTy += dy;
        if (g_bbCx < 0) g_bbCx = 0; if (g_bbCx > 1) g_bbCx = 1; if (g_bbTy < 0) g_bbTy = 0; if (g_bbTy > 0.95f) g_bbTy = 0.95f;
        moving = true; return true;
    }
    if (moving) { moving = false; bb_save(); logf_("boss bar: moved to cx=%.3f ty=%.3f (saved)", g_bbCx, g_bbTy); }
    return false;
}
static DWORD WINAPI overlay_thread(void*) {
    WNDCLASSW wc = {}; wc.lpfnWndProc = DefWindowProcW; wc.hInstance = GetModuleHandleW(0); wc.lpszClassName = L"d1147_bossbar";
    RegisterClassW(&wc);
    HWND ov = 0; int ow = 0, oh = 0; HDC mdc = CreateCompatibleDC(0); HBITMAP bmp = 0; uint32_t* px = 0;
    bool visible = false; LONG lastSeq = -1; RECT lastRc = {};
    for (;;) {
        MSG m; while (PeekMessageW(&m, 0, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessageW(&m); }
        Sleep(100);
        if (!g_gameWnd || !IsWindow(g_gameWnd)) { g_gameWnd = 0; EnumWindows(find_game_wnd, 0); if (!g_gameWnd) continue; }
        BossSnap s; EnterCriticalSection(&g_snapLock); s = g_snap; LeaveCriticalSection(&g_snapLock);
        bool fg = GetForegroundWindow() == g_gameWnd && !IsIconic(g_gameWnd);
        if (!s.show || !fg) { if (visible && ov) { ShowWindow(ov, SW_HIDE); visible = false; } continue; }
        RECT rc; GetClientRect(g_gameWnd, &rc); POINT tl = { 0, 0 }; ClientToScreen(g_gameWnd, &tl);
        int gw = rc.right - rc.left, gh = rc.bottom - rc.top; if (gw < 200 || gh < 200) continue;
        LONG seq = g_snapSeq;
        bool moved = bb_keys();
        if (!moved && seq == lastSeq && visible && tl.x == lastRc.left && tl.y == lastRc.top && gw == lastRc.right && gh == lastRc.bottom) continue;
        lastSeq = seq; lastRc = { tl.x, tl.y, gw, gh };
        // layout (scaled to the game window): health bar ~31% of the width; the part bars packed right under it, every
        // row exactly as wide as the health bar (up to 4 per row, rows balanced: 7 parts -> 4 + 3), name inside each bar
        float sc = gh / 1080.0f; if (sc < 0.6f) sc = 0.6f;
        int W = (int)(gw * 0.31f), bigH = (int)(30 * sc), partH = (int)(24 * sc), gapX = (int)(7 * sc), gapY = (int)(7 * sc), title = (int)(22 * sc);
        int n = s.nparts, rows = n ? (n + 3) / 4 : 0;
        int H = (int)(6 * sc) + title + bigH + (rows ? gapY + rows * partH + (rows - 1) * gapY : 0) + (int)(10 * sc);
        int Wtot = W + (int)(40 * sc);
        if (!ov) {
            ov = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, wc.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, 0, 0, wc.hInstance, 0);
            logf_("boss bar: overlay window %s", ov ? "created" : "FAILED");
            if (!ov) return 0;
        }
        if (Wtot != ow || H != oh) {
            if (bmp) DeleteObject(bmp);
            BITMAPINFO bi = {}; bi.bmiHeader.biSize = sizeof(bi.bmiHeader); bi.bmiHeader.biWidth = Wtot; bi.bmiHeader.biHeight = -H; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
            bmp = CreateDIBSection(mdc, &bi, DIB_RGB_COLORS, (void**)&px, 0, 0); SelectObject(mdc, bmp); ow = Wtot; oh = H;
        }
        memset(px, 0, (size_t)ow * oh * 4);
        Canvas c = { px, ow, oh };
        int x0 = (int)(20 * sc), y = (int)(6 * sc);
        wchar_t a[32], b[32], line[96]; fmt_num(s.cur, a); fmt_num(s.max, b);
        if (s.name[0]) text(c, x0 + 4, y, s.name, (int)(17 * sc), false);
        y += title;
        bar_widget(c, x0, y, W, bigH, s.max > 0 ? s.cur / s.max : 0, 0xB0403E, 0x4A1F1E);
        swprintf(line, 96, L"%ls/%ls", a, b); text(c, x0 + (int)(14 * sc), y + (bigH - (int)(22 * sc)) / 2 - 1, line, (int)(22 * sc), true);
        y += bigH + gapY;
        int idx = 0;
        for (int r = 0; r < rows; r++) {
            int inRow = n / rows + (r < n % rows ? 1 : 0);                 // balanced rows, the fuller ones first
            int pw = (W - (inRow - 1) * gapX) / inRow;
            int py = y + r * (partH + gapY);
            for (int col = 0; col < inRow && idx < n; col++, idx++) {
                int px0 = x0 + col * (pw + gapX);
                int wcol = (col == inRow - 1) ? (x0 + W - px0) : pw;     // last bar ends exactly where the health bar ends
                bool broken = s.parts[idx].cur <= 0;
                bar_widget(c, px0, py, wcol, partH, s.parts[idx].max > 0 ? s.parts[idx].cur / s.parts[idx].max : 0, 0xE8892B, broken ? 0x5A5A5A : 0x4A3218);
                text(c, px0 + (int)(10 * sc), py + (partH - (int)(17 * sc)) / 2 - 1, s.parts[idx].name, (int)(17 * sc), true);
            }
        }
        int dx0 = (int)(gw * g_bbCx) - Wtot / 2; if (dx0 < 0) dx0 = 0; if (dx0 > gw - Wtot) dx0 = gw - Wtot > 0 ? gw - Wtot : 0;
        int dy0 = (int)(gh * g_bbTy); if (dy0 > gh - H) dy0 = gh - H > 0 ? gh - H : 0;
        POINT dst = { tl.x + dx0, tl.y + dy0 }; SIZE sz = { ow, oh }; POINT src = { 0, 0 };
        BLENDFUNCTION bf = { AC_SRC_OVER, 0, 255, AC_SRC_ALPHA };
        UpdateLayeredWindow(ov, 0, &dst, &sz, mdc, &src, 0, &bf, ULW_ALPHA);
        if (!visible) { ShowWindow(ov, SW_SHOWNOACTIVATE); SetWindowPos(ov, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); visible = true; }
    }
}

// Server side: how many part actors exist, and whether the replication loop can send them (logged when it changes).

// ---------------------------------------------------------------------------- client: Modded mode (Oct 19)
// Player's game only (servers never run these unless D1147_SERVER_MODS=1 loads UE4SS there):
//   - D1147_CLIENT_BOSSBAR=1 -> the boss health bar overlay above (log: <D1147_DIR>\logs\client.log)
//   - "-dfmods" on the game's command line -> loads <exe folder>\ue4ss\UE4SS.dll (UE4SS without its dwmapi.dll proxy)

// ---------------------------------------------------------------------------- DF-CHARR-CLIENT (Nov 12)
// Player's game. On Oops All Charrogg only (the copy of Undervald Defile in zzzzzzzzzzzzzzzz_OopsAllCharrogg1147_P.pak) - recognised by its
// atmosphere actor, class atmospheres_chrgg_00_snow_bp_C (a red-tinted copy of the game's night snow atmosphere that only this
// hunt uses) - every Firebrand Charrogg (Heroic), class sq_sally_heroic_bp_C, gets a slight red glow: each material slot of
// its mesh becomes a dynamic instance and the Charrogg material's own on-fire glow (sq_sally_m: OnFireEmissiveColor,
// OnFirePower) is set to red at a low power. Same calls as the Toxic Emberthorn glow (dev loader 2E4BCC57, seen working
// Nov 10). Real Undervald Defile and every other Charrogg are untouched. Off with D1147_CLIENT_CHARR=0.
static bool g_clientCharr = true;
static void* g_chWorld = 0; static bool g_chOnHere = false; static void* g_chAtmoCls = 0, *g_chSallyCls = 0;
static void* g_chKCls[4096]; static uint8_t g_chKind[4096]; static int g_chKN = 0; static void* g_chTold[64]; static int g_chToldN = 0;
static void* g_chFnNum = 0, *g_chFnMid = 0, *g_chFnVec = 0, *g_chFnScal = 0; static uint64_t g_chCol = 0, g_chPow = 0, g_chRageCol = 0, g_chRage = 0, g_chEmis = 0;
static void* g_chStrLib = 0, *g_chFnStrToName = 0; static bool g_chLibTried = false;
static const float kCharrPower = 1.6f;                               // "slight" (the toxic Embermane uses 1.0)
static const uintptr_t kCharMesh = 0x280;                            // ACharacter::Mesh (CL647472 dump)
static void ch_log(const char* fmt, ...) {            // client.log when it is open, and always d1147_dxgi.log
    char line[700]; va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof(line), fmt, ap); va_end(ap);
    logf_("%s", line); dxgi_note(line);
}
// v8: the glow drifts slowly between light blue and purple and back (9 s there and back)
static void ch_cycle(float out[4]) {
    float ph = (float)(GetTickCount64() % 9000ULL) / 9000.0f;
    float w = ph < 0.5f ? ph * 2.0f : (1.0f - ph) * 2.0f; w = w * w * (3.0f - 2.0f * w);          // smooth 0..1..0
    static const float blue[3] = { 0.35f, 2.2f, 5.0f }, purple[3] = { 3.2f, 0.25f, 6.0f };
    for (int i = 0; i < 3; i++) out[i] = blue[i] + (purple[i] - blue[i]) * w;
    out[3] = 1.0f;
}
struct ChCall { void* obj; void* fn; uint8_t* p; };
static void ch_call(void* a) { ChCall* c = (ChCall*)a; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(c->obj, c->fn, c->p); }
static bool ch_pe(void* obj, void* fn, uint8_t* p) { ChCall c = { obj, fn, p }; return guarded(ch_call, &c); }
static void ch_find_strlib(void* arg) {
    void** out = (void**)arg;
    uintptr_t arr = g_base + VD::GUObjectArray;
    uintptr_t w = at<uintptr_t>(arr + 0x20); int32_t num = (int32_t)(w >> 32);
    uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    if (num <= 0 || num > 20000000 || !chunks) return;
    for (int32_t i = 0; i < num; i++) {
        uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(i >> 16)); if (!chunk) continue;
        uintptr_t o = at<uintptr_t>(chunk + 0x18 * (uintptr_t)(i & 0xFFFF)); if (!o) continue;
        if (name_is((void*)o, L"Default__KismetStringLibrary")) { *out = (void*)o; return; }
    }
}
static uint64_t ch_fname(const wchar_t* text) {         // KismetStringLibrary.Conv_StringToName: FString in, FName out
    if (!g_chStrLib || !g_chFnStrToName) return 0;
    alignas(16) uint8_t p[0x18]; memset(p, 0, sizeof(p));
    FString fs; fs.Data = (wchar_t*)text; fs.Num = (int32_t)wcslen(text) + 1; fs.Max = fs.Num; memcpy(p, &fs, sizeof(fs));
    if (!ch_pe(g_chStrLib, g_chFnStrToName, p)) return 0;
    return *(uint64_t*)(p + 0x10);
}
// Red snow (Nov 12 v2): the hunt's weather is the game's snow; every particle component that plays the game's snow
// effect (p_weather_snow or weather_snow_heavy_p) is given the ember-red copy p_weather_embr (OopsAllCharrogg pak) instead.
// Same method as the Toxic neon snow (dev loader, seen working Nov 10): SetTemplate on the component.
static void* g_csOrig[3] = { 0, 0, 0 }, *g_csRed = 0, *g_csPscCls = 0, *g_csSetTpl = 0; static const int g_csOff = 0x448; static bool g_csTried = false; static int g_csLogs = 0;   // g_csOff: ParticleSystemComponent::Template (CL647472 dump)
static void* g_csSeen[64]; static int g_csSeenN = 0, g_csSaid = 0;
struct CsLoad { void* cls; const wchar_t* path; void* out; };
static void cs_load(void* arg) { CsLoad* r = (CsLoad*)arg;
    r->out = ((void* (*)(void*, void*, const wchar_t*, const wchar_t*, uint32_t, void*, bool, void*))(g_base + VD::StaticLoadObject))(r->cls, 0, r->path, 0, 0, 0, true, 0); }
struct CsScan { void* found[32]; int n; void* psc; };
static void cs_scan(void* arg) {
    CsScan* r = (CsScan*)arg; r->n = 0;
    uintptr_t arr = g_base + VD::GUObjectArray;
    int32_t num = (int32_t)(at<uintptr_t>(arr + 0x20) >> 32); uintptr_t chunks = at<uintptr_t>(arr + 0x10);
    if (num <= 0 || num > 20000000 || !chunks) return;
    for (int32_t i = 0; i < num && r->n < 32; i++) {
        uintptr_t chunk = at<uintptr_t>(chunks + 8 * (uintptr_t)(i >> 16)); if (!chunk) continue;
        uintptr_t o = at<uintptr_t>(chunk + 0x18 * (uintptr_t)(i & 0xFFFF)); if (!o) continue;
        if (!g_csPscCls) { if (name_is((void*)o, L"Default__ParticleSystemComponent")) { r->psc = (void*)o; return; } continue; }
        if (at<void*>(o + A::Object_Class) != g_csPscCls) continue;
        if (at<uint32_t>(o + A::Object_Flags) & 0x60000000) continue;
        void* t = at<void*>(o + g_csOff);
        if (t && (t == g_csOrig[0] || t == g_csOrig[1] || t == g_csOrig[2])) r->found[r->n++] = (void*)o;
        else if (t && g_csSeenN < 64) { bool k = false; for (int q = 0; q < g_csSeenN; q++) if (g_csSeen[q] == t) { k = true; break; } if (!k) g_csSeen[g_csSeenN++] = t; }
    }
}
static void ch_snow_tick() {
    if (!g_csTried) {
        g_csTried = true;
        void* top = g_chAtmoCls; for (int d = 0; d < 32; d++) { void* up = at<void*>((uintptr_t)top + A::Struct_Super); if (!up) break; top = up; }   // UObject
        { CsLoad b = { top, L"/Game/Effects/World/atmospheric/weather/p_weather_snow.p_weather_snow", 0 }; if (guarded(cs_load, &b)) g_csOrig[0] = b.out; }
        { CsLoad b = { top, L"/Game/Effects/World/atmospheric/weather/weather_snow_heavy_p.weather_snow_heavy_p", 0 }; if (guarded(cs_load, &b)) g_csOrig[1] = b.out; }
        { CsLoad b = { top, L"/Game/Effects/World/atmospheric/weather/p_weather_snow_frostfall_RTR_p.p_weather_snow_frostfall_RTR_p", 0 }; if (guarded(cs_load, &b)) g_csOrig[2] = b.out; }
        { CsLoad b = { top, L"/Game/Effects/World/atmospheric/weather/p_weather_embr.p_weather_embr", 0 }; if (guarded(cs_load, &b)) g_csRed = b.out; }
        CsScan f; f.n = 0; f.psc = 0;
        if (guarded(cs_scan, &f) && f.psc) { g_csPscCls = at<void*>((uintptr_t)f.psc + A::Object_Class); g_csSetTpl = find_function(g_csPscCls, L"SetTemplate"); }
        ch_log("charrogg snow: game snow %s, heavy snow %s, red snow %s, particle component class %s, SetTemplate %s", g_csOrig[0] ? "found" : "MISSING", g_csOrig[1] ? "found" : "MISSING",
               g_csRed ? "loaded" : "MISSING (is zzzzzzzzzzzzzzzz_OopsAllCharrogg1147_P.pak in Paks?)", g_csPscCls ? "found" : "MISSING", g_csSetTpl ? "found" : "MISSING");
    }
    if ((!g_csOrig[0] && !g_csOrig[1] && !g_csOrig[2]) || !g_csRed || !g_csPscCls || !g_csSetTpl) return;
    CsScan r; r.n = 0; r.psc = 0;
    if (!guarded(cs_scan, &r)) { static int f = 0; if (f++ < 3) ch_log("charrogg snow: the scan was cut short (try %d)", f); return; }
    char an[160], tn[160];
    if (g_csSeenN > g_csSaid) { char line[600]; int n = 0; line[0] = 0;
        for (int i = g_csSaid; i < g_csSeenN && n < 500; i++) n += snprintf(line + n, sizeof(line) - n, "%s ", name_of(g_csSeen[i], tn, sizeof(tn)));
        g_csSaid = g_csSeenN; ch_log("charrogg snow: other particle effects running: %s", line); }
    for (int i = 0; i < r.n; i++) {
        alignas(16) uint8_t p[16]; memset(p, 0, sizeof(p)); *(void**)p = g_csRed;
        bool ok = ch_pe(r.found[i], g_csSetTpl, p);
        void* now = g_csOff ? at<void*>((uintptr_t)r.found[i] + g_csOff) : 0;
        if (g_csLogs < 12) { g_csLogs++; ch_log("charrogg snow: %s -> red snow %s (template now %s)", name_of(r.found[i], an, sizeof(an)), ok ? "ok" : "FAILED", now ? name_of(now, tn, sizeof(tn)) : "?"); }
    }
}
// Colour drift (Nov 12 v8): the material instances made by client_charr_tick, re-coloured every 3 frames.
static void* g_shMid[96]; static int g_shN = 0;
static void ch_shimmer_tick() {                           // every 3 frames while on the hunt: the slow colour drift
    if (!g_shN || !g_chFnVec || !g_chCol) return;
    float c[4]; ch_cycle(c);
    for (int i = 0; i < g_shN; i++) {
        void* mid = g_shMid[i]; if (!mid || !readable((uintptr_t)mid, 0x30)) continue;
        if (at<uint32_t>((uintptr_t)mid + A::Object_Flags) & 0x60000000) continue;
        alignas(16) uint8_t v[0x18]; memset(v, 0, sizeof(v)); *(uint64_t*)v = g_chCol; memcpy(v + 8, c, 16);
        ch_pe(mid, g_chFnVec, v);
        if (g_chRageCol) { memset(v, 0, sizeof(v)); *(uint64_t*)v = g_chRageCol; memcpy(v + 8, c, 16); ch_pe(mid, g_chFnVec, v); }
    }
}
// Class lookups for the once-a-second actor walk: a small open-addressed table keyed by class pointer, so a town with
// thousands of actors costs one probe per actor instead of a scan of every class seen so far.
static int ch_kind(void* c) {
    uintptr_t h = ((uintptr_t)c >> 4) & 4095;
    for (int i = 0; i < 4096; i++) {
        const uintptr_t k = (h + i) & 4095;
        if (g_chKCls[k] == c) return g_chKind[k];
        if (!g_chKCls[k]) {
            const int kind = name_is(c, L"atmospheres_chrgg_00_snow_bp_C") ? 2 : name_is(c, L"sq_sally_heroic_bp_C") ? 3 : 1;
            if (g_chKN < 3072) { g_chKCls[k] = c; g_chKind[k] = (uint8_t)kind; g_chKN++; }
            return kind;
        }
    }
    return name_is(c, L"atmospheres_chrgg_00_snow_bp_C") ? 2 : name_is(c, L"sq_sally_heroic_bp_C") ? 3 : 1;
}
static void client_charr_tick(void* world) {
    if (world != g_chWorld) { g_chWorld = world; g_chOnHere = false; g_chAtmoCls = 0; g_chSallyCls = 0; memset(g_chKCls, 0, sizeof(g_chKCls)); g_chKN = 0; g_chToldN = 0; g_csLogs = 0; g_shN = 0; }
    TArrayRaw& levels = at<TArrayRaw>((uintptr_t)world + A::World_Levels);
    void* found[16]; int nf = 0; bool here = false;
    for (int li = 0; li < levels.Num && li < 64; li++) {
        void* level = levels.Data[li]; if (!level) continue;
        TArrayRaw& actors = at<TArrayRaw>((uintptr_t)level + A::Level_Actors);
        for (int ai = 0; ai < actors.Num; ai++) {
            void* a = actors.Data[ai]; if (!a) continue;
            if (at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000) continue;
            void* c = at<void*>((uintptr_t)a + A::Object_Class); if (!c) continue;
            if (c != g_chAtmoCls && c != g_chSallyCls) {
                const int kind = ch_kind(c);                                         // 1 other, 2 atmosphere, 3 Charrogg
                if (kind == 2) g_chAtmoCls = c; else if (kind == 3) g_chSallyCls = c; else continue;
            }
            if (c == g_chAtmoCls) here = true;
            else if (nf < 16) found[nf++] = a;
        }
    }
    if (!here) { g_shN = 0; return; }
    if (!g_chOnHere) { g_chOnHere = true; ch_log("charrogg: this is Oops All Charrogg (its atmosphere found), %d Firebrand Charrogg (Heroic) in view", nf); }
    if (!g_chLibTried) { g_chLibTried = true; guarded(ch_find_strlib, &g_chStrLib);
        if (g_chStrLib) g_chFnStrToName = find_function(at<void*>((uintptr_t)g_chStrLib + A::Object_Class), L"Conv_StringToName");
        g_chCol = ch_fname(L"OnFireEmissiveColor"); g_chPow = ch_fname(L"OnFirePower"); g_chRageCol = ch_fname(L"RageColor"); g_chRage = ch_fname(L"AetherToRage"); g_chEmis = ch_fname(L"Emissive Multiplier");
        ch_log("charrogg: KismetStringLibrary %s, Conv_StringToName %s, glow names %s", g_chStrLib ? "found" : "MISSING", g_chFnStrToName ? "found" : "MISSING", (g_chCol && g_chPow) ? "ok" : "MISSING"); }
    ch_snow_tick();
    if (!g_chCol || !g_chPow) return;
    char an[160];
    g_shN = 0;
    for (int k = 0; k < nf; k++) {
        void* a = found[k];
        void* mesh = at<void*>((uintptr_t)a + kCharMesh); if (!mesh || !readable((uintptr_t)mesh, 0x30)) continue;
        void* mcls = at<void*>((uintptr_t)mesh + A::Object_Class);
        if (!g_chFnNum) { g_chFnNum = find_function(mcls, L"GetNumMaterials"); g_chFnMid = find_function(mcls, L"CreateDynamicMaterialInstance");
            ch_log("charrogg: mesh %s  GetNumMaterials %s  CreateDynamicMaterialInstance %s", name_of(mesh, an, sizeof(an)), g_chFnNum ? "found" : "MISSING", g_chFnMid ? "found" : "MISSING"); }
        if (!g_chFnNum || !g_chFnMid) return;
        alignas(16) uint8_t q[16]; memset(q, 0, sizeof(q));
        if (!ch_pe(mesh, g_chFnNum, q)) continue;
        int n = *(int32_t*)q; if (n < 0 || n > 32) n = 0;
        int set = 0;
        for (int i = 0; i < n; i++) {
            alignas(16) uint8_t m[0x20]; memset(m, 0, sizeof(m)); *(int32_t*)m = i;
            if (!ch_pe(mesh, g_chFnMid, m)) continue;
            void* mid = *(void**)(m + 0x18); if (!mid) mid = *(void**)(m + 0x10);
            if (!mid || !readable((uintptr_t)mid, 0x30)) continue;
            if (!g_chFnVec) { void* mc = at<void*>((uintptr_t)mid + A::Object_Class);
                g_chFnVec = find_function(mc, L"SetVectorParameterValue"); g_chFnScal = find_function(mc, L"SetScalarParameterValue");
                ch_log("charrogg: material %s  SetVectorParameterValue %s  SetScalarParameterValue %s", name_of(mid, an, sizeof(an)),
                      g_chFnVec ? "found" : "MISSING", g_chFnScal ? "found" : "MISSING"); }
            if (!g_chFnVec || !g_chFnScal) return;
            alignas(16) uint8_t v[0x18]; memset(v, 0, sizeof(v)); float cyc[4]; ch_cycle(cyc); *(uint64_t*)v = g_chCol; memcpy(v + 8, cyc, 16);
            bool ok = ch_pe(mid, g_chFnVec, v);
            alignas(16) uint8_t sc[16]; memset(sc, 0, sizeof(sc)); *(uint64_t*)sc = g_chPow; *(float*)(sc + 8) = kCharrPower;
            ok = ch_pe(mid, g_chFnScal, sc) && ok;
            if (g_shN < 96) g_shMid[g_shN++] = mid;                                     // v6: its rage colour is driven by ch_shimmer_tick
            if (g_chRage) { memset(sc, 0, sizeof(sc)); *(uint64_t*)sc = g_chRage; *(float*)(sc + 8) = 1.0f; ch_pe(mid, g_chFnScal, sc); }
            if (g_chEmis) { memset(sc, 0, sizeof(sc)); *(uint64_t*)sc = g_chEmis; *(float*)(sc + 8) = 4.0f; ch_pe(mid, g_chFnScal, sc); }           // its own lava glow, brighter
            if (ok) set++;
        }
        bool told = false; for (int t = 0; t < g_chToldN; t++) if (g_chTold[t] == a) { told = true; break; }
        if (!told) { if (g_chToldN < 64) g_chTold[g_chToldN++] = a; ch_log("charrogg: %s blue-to-purple glow set on %d of %d material slots", name_of(a, an, sizeof(an)), set, n); }
    }
}

static void (*orig_ClientTick)(void*, float, bool) = 0;
static void hook_ClientTick(void* engine, float dt, bool idle) {
    orig_ClientTick(engine, dt, idle);
    ++g_cTicks;
    void* world = at<void*>(g_base + A::GWorld);
    if (!world) return;
    if (g_clientBoss && g_cTicks % 15 == 0) boss_collect(world);
    if (g_clientCharr && g_cTicks % 60 == 30) client_charr_tick(world);
    if (g_cxAnimN) ct_anim_tick();                                                   // DF-CRITTEXT-1147 animation
    op_tick();                                                                       // DF-CRITOPTS-1147
    if (g_clientCharr && g_chOnHere && g_cTicks % 3 == 0) ch_shimmer_tick();
}
static DWORD WINAPI ue4ss_thread(void*) {
    wchar_t p[MAX_PATH + 32]; DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH);
    if (!n || n >= MAX_PATH) { dxgi_note("mods: exe path unknown, UE4SS not loaded"); return 0; }
    wchar_t* sl = wcsrchr(p, L'\\'); if (!sl) return 0; wcscpy(sl + 1, L"ue4ss\\UE4SS.dll");
    if (GetModuleHandleW(L"UE4SS.dll")) { dxgi_note("mods: UE4SS already loaded"); return 0; }
    if (GetFileAttributesW(p) == INVALID_FILE_ATTRIBUTES) { dxgi_note("mods: ue4ss\\UE4SS.dll not found, UE4SS not loaded"); return 0; }
    HMODULE m = LoadLibraryW(p);
    char msg[96]; snprintf(msg, sizeof(msg), "mods: UE4SS %s (error %lu)", m ? "loaded" : "FAILED to load", m ? 0UL : GetLastError());
    dxgi_note(msg); logf_("%s", msg);
    return 0;
}
static bool has_arg(const wchar_t* want) {
    const wchar_t* c = GetCommandLineW(); size_t wl = wcslen(want);
    for (const wchar_t* q = c; (q = wcsstr(q, want)) != nullptr; q += wl) {
        wchar_t before = q == c ? L' ' : q[-1], after = q[wl];
        if ((before == L' ' || before == L'\t') && (after == 0 || after == L' ' || after == L'\t')) return true;
    }
    return false;
}
// ---------------------------------------------------------------------------- client: corner badge (Oct 19)
// D1147_CLIENT_BADGE=<text> (up to 15 characters, e.g. "TR" for Trials Quick Retry): small white text with a shadow in
// the bottom-right corner of the game window while it is in front. Its own layered window, independent of the boss bar.
static wchar_t g_badge[16] = L"";
static DWORD WINAPI badge_thread(void*) {
    WNDCLASSW wc = {}; wc.lpfnWndProc = DefWindowProcW; wc.hInstance = GetModuleHandleW(0); wc.lpszClassName = L"d1147_badge";
    RegisterClassW(&wc);
    HWND ov = 0; HDC mdc = CreateCompatibleDC(0), tdc = CreateCompatibleDC(0); HBITMAP bmp = 0, tbmp = 0; uint32_t* px = 0; uint32_t* tpx = 0;
    int ow = 0, oh = 0; bool visible = false; RECT lastRc = {};
    for (;;) {
        MSG m; while (PeekMessageW(&m, 0, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessageW(&m); }
        Sleep(250);
        if (!g_gameWnd || !IsWindow(g_gameWnd)) { g_gameWnd = 0; EnumWindows(find_game_wnd, 0); if (!g_gameWnd) continue; }
        bool fg = GetForegroundWindow() == g_gameWnd && !IsIconic(g_gameWnd);
        if (!fg) { if (visible && ov) { ShowWindow(ov, SW_HIDE); visible = false; } continue; }
        RECT rc; GetClientRect(g_gameWnd, &rc); POINT tl = { 0, 0 }; ClientToScreen(g_gameWnd, &tl);
        int gw = rc.right - rc.left, gh = rc.bottom - rc.top; if (gw < 200 || gh < 200) continue;
        if (visible && tl.x == lastRc.left && tl.y == lastRc.top && gw == lastRc.right && gh == lastRc.bottom) continue;
        lastRc = { tl.x, tl.y, gw, gh };
        float sc = gh / 1080.0f; if (sc < 0.6f) sc = 0.6f;
        int size = (int)(26 * sc), W = (int)(size * 0.75f * (int)wcslen(g_badge)) + size, H = size + 12;
        if (!ov) {
            ov = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, wc.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, 0, 0, wc.hInstance, 0);
            if (!ov) return 0;
        }
        if (W != ow || H != oh) {
            if (bmp) DeleteObject(bmp); if (tbmp) DeleteObject(tbmp);
            BITMAPINFO bi = {}; bi.bmiHeader.biSize = sizeof(bi.bmiHeader); bi.bmiHeader.biWidth = W; bi.bmiHeader.biHeight = -H; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
            bmp = CreateDIBSection(mdc, &bi, DIB_RGB_COLORS, (void**)&px, 0, 0); SelectObject(mdc, bmp);
            tbmp = CreateDIBSection(tdc, &bi, DIB_RGB_COLORS, (void**)&tpx, 0, 0); SelectObject(tdc, tbmp); ow = W; oh = H;
        }
        memset(px, 0, (size_t)W * H * 4); memset(tpx, 0, (size_t)W * H * 4);
        HFONT f = CreateFontW(-size, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, ANTIALIASED_QUALITY, 0, L"Segoe UI");
        HGDIOBJ old = SelectObject(tdc, f); SetBkMode(tdc, TRANSPARENT); SetTextColor(tdc, RGB(255, 255, 255));
        SIZE ts = { 0, 0 }; GetTextExtentPoint32W(tdc, g_badge, (int)wcslen(g_badge), &ts);
        int tx = W - ts.cx - 4; if (tx < 2) tx = 2;
        TextOutW(tdc, tx, 4, g_badge, (int)wcslen(g_badge)); GdiFlush(); SelectObject(tdc, old); DeleteObject(f);
        Canvas c = { px, W, H };
        for (int pass = 0; pass < 2; pass++)
            for (int j = 0; j < H; j++) for (int i = 0; i < W; i++) {
                int cov = tpx[j * W + i] & 255; if (!cov) continue;
                if (pass == 0) { for (int dy = -1; dy <= 2; dy++) for (int dx = -1; dx <= 2; dx++) blend(c, i + dx, j + dy, 0x000000, cov * 2 / 3); }
                else blend(c, i, j, 0xFFFFFF, cov);
            }
        int margin = (int)(14 * sc);
        POINT dst = { tl.x + gw - W - margin, tl.y + gh - H - margin }; SIZE sz = { W, H }; POINT src = { 0, 0 };
        BLENDFUNCTION bf = { AC_SRC_OVER, 0, 255, AC_SRC_ALPHA };
        UpdateLayeredWindow(ov, 0, &dst, &sz, mdc, &src, 0, &bf, ULW_ALPHA);
        if (!visible) { ShowWindow(ov, SW_SHOWNOACTIVATE); SetWindowPos(ov, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); visible = true; }
    }
}
static void client_mods_init() {
    char v[8];
    g_clientBoss = GetEnvironmentVariableA("D1147_CLIENT_BOSSBAR", v, sizeof(v)) && v[0] == '1';
    bool mods = has_arg(L"-dfmods");
    g_clientCharr = !(GetEnvironmentVariableA("D1147_CLIENT_CHARR", v, sizeof(v)) && v[0] == '0');
    { wchar_t b[16]; DWORD n = GetEnvironmentVariableW(L"D1147_CLIENT_BADGE", b, 16); if (n > 0 && n < 16) { wcscpy(g_badge, b); HANDLE t = CreateThread(0, 0, badge_thread, 0, 0, 0); if (t) CloseHandle(t); } }
    if (!g_clientBoss && !g_clientCharr && !mods) return;
    wchar_t dir[MAX_PATH] = L"."; DWORD dn = GetEnvironmentVariableW(L"D1147_DIR", dir, MAX_PATH);
    if (dn == 0 || dn >= MAX_PATH) { dir[0] = L'.'; dir[1] = 0; }
    wchar_t path[MAX_PATH + 64]; swprintf(path, MAX_PATH + 64, L"%ls\\logs\\client.log", dir);
    g_log = _wfopen(path, L"w");
    swprintf(g_bbFile, MAX_PATH + 64, L"%ls\\data\\bossbar_pos.txt", dir); bb_load();
    g_base = (uintptr_t)GetModuleHandleA(0);
    g_gameThread = GetCurrentThreadId();
    logf_("==== d1147 loader, client: %s%s%s. exe base %p ====", g_clientBoss ? "boss health bar " : "", g_clientCharr ? "oops all charrogg glow " : "", mods ? "UE4SS (-dfmods)" : "", (void*)g_base);
    if (mods) { HANDLE t = CreateThread(0, 0, ue4ss_thread, 0, 0, 0); if (t) CloseHandle(t); }
    if (!g_clientBoss && !g_clientCharr) return;
    static const uint8_t listenCall[5] = { 0xE8, 0x0B, 0x79, 0x77, 0xFC };
    if (memcmp((void*)(g_base + A::LoadMapListenCall), listenCall, 5) != 0) { logf_("not the 1.14.7 exe; boss bar off"); g_clientBoss = false; g_clientCharr = false; return; }
    AddVectoredExceptionHandler(1, on_exception);
    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) { logf_("MinHook failed; boss bar off"); g_clientBoss = false; g_clientCharr = false; return; }
    static const uint8_t e[4] = { 0x48, 0x8B, 0xC4, 0x48 };
    if (!hook(A::GameEngineTick, e, 4, (void*)hook_ClientTick, (void**)&orig_ClientTick, "engine tick (client features)")) { g_clientBoss = false; g_clientCharr = false; return; }
    if (!g_clientBoss) return;
    InitializeCriticalSection(&g_snapLock); memset(&g_snap, 0, sizeof(g_snap));
    HANDLE t = CreateThread(0, 0, overlay_thread, 0, 0, 0); if (t) CloseHandle(t);
}

// ---------------------------------------------------------------------------- client: significance guard (Oct 18)
// The game's Significance Manager (Unreal plugin) sometimes keeps a dead object in its list after a behemoth dies and
// fades. Its next update calls that object's GetWorld through freed memory and the game crashes (exe+0x1499436, every
// few kills). FManagedObjectInfo::UpdateSignificance (exe+0x14992A0, this = the entry, object at +0x10) now skips an
// entry whose object no longer looks like a live UObject: its vtable must point into the game exe. Player's game only.
namespace SG { const uintptr_t UpdateSignificance = 0x14992A0; }
static uintptr_t g_exeLo = 0, g_exeHi = 0;
static void* g_origUpdSig = nullptr;
static volatile LONG g_sigSkips = 0;
static bool readable(const void* p, size_t n) {
    MEMORY_BASIC_INFORMATION mi;
    if (!VirtualQuery(p, &mi, sizeof(mi)) || mi.State != MEM_COMMIT) return false;
    if (mi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    if (!(mi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY))) return false;
    return (uintptr_t)p + n <= (uintptr_t)mi.BaseAddress + mi.RegionSize;
}
// Does this still look like a live UObject? vtable inside the exe, the vtable slot the caller is about to use
// (UpdateSignificance: +0x158) pointing into the exe too, and a readable class pointer (+0x10) whose own vtable is in
// the exe. Oct 19: a pt-BR player's crash passed the old vtable-only check and still called through a null slot.
// Oct 21 (FPS drop on hunts since the Oct 18/19 guards): the checks used VirtualQuery, a system call, up to four
// times per object per tick on every significance-managed object (hundreds on a hunt, few in Ramsgate): CPU 90-100%
// and 30-45 FPS on PCs that ran at 50%. The reads are now plain memory reads fenced by a vectored exception
// handler: a read of freed, unmapped memory lands on sg_try_read_land and counts as dead; nothing else changes.
extern "C" int sg_try_read(const void* p, uintptr_t* out);
extern "C" char sg_try_read_fault, sg_try_read_land;
__asm__(
    ".text\n"
    ".globl sg_try_read\n"
    "sg_try_read:\n"
    ".globl sg_try_read_fault\n"
    "sg_try_read_fault:\n"
    "    movq (%rcx), %rax\n"          // the one instruction allowed to fault
    "    movq %rax, (%rdx)\n"
    "    movl $1, %eax\n"
    "    ret\n"
    ".globl sg_try_read_land\n"
    "sg_try_read_land:\n"
    "    xorl %eax, %eax\n"
    "    ret\n");
// Oct 24 (DF-SIGGUARD3, reports 53 64 72 117 124 150 173: crashes 10-30 min into hunts and during island events with
// the guard on): the checks above still let some dead objects through. Freed memory that already holds new data keeps
// a vtable inside the exe, so the call went on and crashed a few instructions later (GetWorld returned null and
// +0x5A8 was read, a class at +0x30 was garbage, a vtable slot in .data was called). Three changes:
// - vtables must be in .rdata and the slot about to be called in .text (not just anywhere in the exe);
// - the object must still be in the engine's own object list (GUObjectArray exe+0x6E59EC0): its InternalIndex
//   (+0x0C) slot points back at it and is not flagged Unreachable or PendingKill (bits 28/29);
// - the per-object work itself runs fenced: a crash inside it (on any thread) returns to the guard, the entry is
//   remembered and skipped from then on, and the game keeps going.
namespace SG { const uintptr_t GUObjectArray = 0x6E59EC0; const uintptr_t ObjArrayRef = 0x9F558F; }
static uintptr_t g_textLo = 0, g_textHi = 0, g_rdataLo = 0, g_rdataHi = 0, g_objArr = 0;
struct SgJmp { uint64_t r[9]; uint64_t pad; uint8_t x[160]; };   // rbx rbp rdi rsi r12 r13 r14 r15 rsp; xmm6-xmm15
struct SgTls { int depth; SgJmp j[4]; };
static thread_local SgTls t_sg;
extern "C" int sg_fenced(SgJmp* j, void* fn, void* a1, void* a2, void* a3, void* a4, void* a5);
extern "C" char sg_fenced_land;
__asm__(
    ".text\n"
    ".globl sg_fenced\n"
    "sg_fenced:\n"
    ".intel_syntax noprefix\n"
    "    mov [rcx+0x00], rbx\n    mov [rcx+0x08], rbp\n    mov [rcx+0x10], rdi\n    mov [rcx+0x18], rsi\n"
    "    mov [rcx+0x20], r12\n    mov [rcx+0x28], r13\n    mov [rcx+0x30], r14\n    mov [rcx+0x38], r15\n"
    "    movdqu [rcx+0x50], xmm6\n  movdqu [rcx+0x60], xmm7\n  movdqu [rcx+0x70], xmm8\n  movdqu [rcx+0x80], xmm9\n"
    "    movdqu [rcx+0x90], xmm10\n movdqu [rcx+0xA0], xmm11\n movdqu [rcx+0xB0], xmm12\n movdqu [rcx+0xC0], xmm13\n"
    "    movdqu [rcx+0xD0], xmm14\n movdqu [rcx+0xE0], xmm15\n"
    "    push rbx\n"
    "    sub rsp, 0x30\n"
    "    mov rbx, rcx\n"
    "    mov [rbx+0x40], rsp\n"
    "    mov rax, rdx\n"
    "    mov rcx, r8\n"
    "    mov rdx, r9\n"
    "    mov r8, [rsp+0x60]\n"
    "    mov r9, [rsp+0x68]\n"
    "    mov r10, [rsp+0x70]\n"
    "    mov [rsp+0x20], r10\n"
    "    call rax\n"
    "    xor eax, eax\n"
    "    jmp 2f\n"
    ".globl sg_fenced_land\n"
    "sg_fenced_land:\n"
    "    mov eax, 1\n"
    "2:  add rsp, 0x30\n"
    "    pop rbx\n"
    "    ret\n"
    ".att_syntax prefix\n");
static bool sg_fault_code(DWORD c) { return c == 0xC0000005 || c == 0xC000001D || c == 0xC0000096 || c == 0xC0000094 || c == 0xC0000095; }
static LONG CALLBACK sg_read_veh(EXCEPTION_POINTERS* ep) {
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    if (code == 0xC0000005 && ep->ExceptionRecord->ExceptionAddress == (void*)&sg_try_read_fault) {
        ep->ContextRecord->Rip = (DWORD64)(uintptr_t)&sg_try_read_land;
        return EXCEPTION_CONTINUE_EXECUTION;
    }
    if (!sg_fault_code(code)) return EXCEPTION_CONTINUE_SEARCH;
    SgTls& t = t_sg;
    if (t.depth <= 0 || t.depth > 4) return EXCEPTION_CONTINUE_SEARCH;
    SgJmp* j = &t.j[t.depth - 1];
    CONTEXT* c = ep->ContextRecord;
    // Inside the fenced call = this thread's fence depth AND the fault's stack below the fence's saved rsp (inside
    // the thread's stack). Never by the faulting RIP: a call to address 0 faults with RIP = 0 (reports 53, 150).
    NT_TIB* tib = (NT_TIB*)NtCurrentTeb();
    if (c->Rsp >= j->r[8] || c->Rsp < (DWORD64)(uintptr_t)tib->StackLimit) return EXCEPTION_CONTINUE_SEARCH;
    c->Rbx = (DWORD64)(uintptr_t)j; c->Rbp = j->r[1]; c->Rdi = j->r[2]; c->Rsi = j->r[3];
    c->R12 = j->r[4]; c->R13 = j->r[5]; c->R14 = j->r[6]; c->R15 = j->r[7]; c->Rsp = j->r[8];
    memcpy(&c->Xmm6, j->x, 160);
    c->Rip = (DWORD64)(uintptr_t)&sg_fenced_land;
    return EXCEPTION_CONTINUE_EXECUTION;
}
typedef void (__fastcall* SgFn5)(void*, void*, void*, void*, void*);
static int sg_call(void* fn, void* a1, void* a2, void* a3, void* a4, void* a5) {
    SgTls& t = t_sg;
    if (t.depth < 0 || t.depth >= 4) { ((SgFn5)fn)(a1, a2, a3, a4, a5); return 0; }
    SgJmp* j = &t.j[t.depth];
    t.depth++;
    int r = sg_fenced(j, fn, a1, a2, a3, a4, a5);
    t.depth--;
    return r;
}
static inline bool sg_read(const void* p, uintptr_t* out) { return (uintptr_t)p >= 0x10000 && sg_try_read(p, out) != 0; }
static const char* sg_listed(void* obj) {
    if (!g_objArr) return nullptr;
    uintptr_t w, chunks, chunk, itemObj, flags;
    if (!sg_read((void*)(g_objArr + 0x20), &w)) return nullptr;            // MaxElements | NumElements
    int32_t num = (int32_t)(w >> 32);
    if (num <= 0 || num > (int32_t)(w & 0xFFFFFFFF)) return nullptr;        // list not ready: no verdict
    if (!sg_read((char*)obj + 0x08, &w)) return "unreadable";               // ObjectFlags | InternalIndex
    int32_t idx = (int32_t)(w >> 32);
    if (idx < 0 || idx >= num) return "not in the object list";
    if (!sg_read((void*)(g_objArr + 0x10), &chunks) || !chunks) return nullptr;
    if (!sg_read((void*)(chunks + 8 * (uintptr_t)(idx >> 16)), &chunk) || !chunk) return "not in the object list";
    uintptr_t item = chunk + 0x18 * (uintptr_t)(idx & 0xFFFF);
    if (!sg_read((void*)item, &itemObj)) return "not in the object list";
    if (itemObj != (uintptr_t)obj) return "replaced in the object list";
    if (!sg_read((void*)(item + 8), &flags)) return "not in the object list";
    if ((uint32_t)flags & ((1u << 28) | (1u << 29))) return "being destroyed";
    return nullptr;
}
static const char* sg_dead(void* obj, size_t slot) {
    uintptr_t vt, fn, cls, cvt;
    if (!sg_read(obj, &vt)) return "unreadable";
    if (vt < g_rdataLo || vt >= g_rdataHi) return "vtable outside the game";
    if (slot) {
        if (!sg_read((void*)(vt + slot), &fn)) return "vtable slot unreadable";
        if (fn < g_textLo || fn >= g_textHi) return "vtable slot outside the game";
    }
    if (!sg_read((char*)obj + 0x10, &cls) || !cls || !sg_read((void*)cls, &cvt)) return "class unreadable";
    if (cvt < g_rdataLo || cvt >= g_rdataHi) return "class vtable outside the game";
    return sg_listed(obj);
}
// Entries whose work crashed: skipped for 10 s, then tried again (a transient fault must not mute a live object for
// the whole session). A dead object is skipped anyway by sg_dead (object list: Unreachable / PendingKill / gone).
static const ULONGLONG SG_BAD_MS = 10000;
static void* volatile g_badEntry[256];
static void* volatile g_badObj[256];
static volatile ULONGLONG g_badUntil[256];
static volatile LONG g_badN = 0;     // slots ever used (max 256), 0 = nothing to look up
static volatile LONG g_badNext = 0;  // round robin when all slots are taken
static volatile LONG g_sigCaught = 0;
static bool sg_is_bad(void* entry, void* obj) {
    LONG n = g_badN; if (n > 256) n = 256;
    for (LONG i = 0; i < n; i++)
        if (g_badEntry[i] == entry && g_badObj[i] == obj) return GetTickCount64() < g_badUntil[i];
    return false;
}
static void sg_caught(const char* site, void* entry, void* obj) {
    ULONGLONG now = GetTickCount64();
    LONG n = g_badN; if (n > 256) n = 256;
    LONG slot = -1;
    for (LONG i = 0; i < n && slot < 0; i++) if (g_badEntry[i] == entry && g_badObj[i] == obj) slot = i;
    for (LONG i = 0; i < n && slot < 0; i++) if (g_badUntil[i] <= now) slot = i;            // an expired slot
    if (slot < 0) { LONG k = InterlockedIncrement(&g_badN) - 1; slot = k < 256 ? k : (InterlockedIncrement(&g_badNext) & 255); }
    g_badUntil[slot] = 0; g_badObj[slot] = obj; g_badEntry[slot] = entry; g_badUntil[slot] = now + SG_BAD_MS;
    LONG c = InterlockedIncrement(&g_sigCaught);
    if (c <= 8) { char m[200]; snprintf(m, sizeof(m), "significance guard: caught a crash in %s (%p), skipped for 10 s, %ld so far", site, obj, (long)c); dxgi_note(m); }
}
static void sg_log_skip(const char* site, void* obj, const char* why) {
    LONG n = InterlockedIncrement(&g_sigSkips);
    if (n <= 8) { char m[200]; snprintf(m, sizeof(m), "significance guard: %s skipped a dead object (%p: %s), %ld so far", site, obj, why, (long)n); dxgi_note(m); }
}
static void __fastcall upd_sig_hook(void* info, void* viewpoints, bool ascending) {
    uintptr_t o = 0;
    void* obj = info && sg_read((char*)info + 0x10, &o) ? (void*)o : nullptr;
    if (obj) {
        const char* why = sg_dead(obj, 0x158);
        if (why) { sg_log_skip("UpdateSignificance", obj, why); return; }
        if (g_badN && sg_is_bad(info, obj)) return;
    }
    if (sg_call(g_origUpdSig, info, viewpoints, (void*)(uintptr_t)(ascending ? 1 : 0), nullptr, nullptr)) sg_caught("UpdateSignificance", info, obj);
}
// Second site (Oct 19, nOsO's crash reports with the first guard on): the per-object PostSignificance thunk at
// exe+0x1D815E0 (rcx = holder, rdx = &entry; object at entry+0x10) casts the object and faults on its freed class
// pointer. The thunk returns void, so a dead object is simply skipped. The check runs in C; the hook itself is
// assembly so every argument register (rcx, rdx, r8, r9, xmm0-xmm3) reaches the game's code untouched.
namespace SG { const uintptr_t PostSignificance = 0x1D815E0; }
extern "C" void* g_origPostSig = nullptr;
static void __fastcall post_sig_hook(void* holder, void* entryPtr, void* oldSig, void* newSig, void* final_) {
    uintptr_t e = 0, o = 0;
    void* entry = entryPtr && sg_read(entryPtr, &e) ? (void*)e : nullptr;
    void* obj = entry && sg_read((char*)entry + 0x10, &o) ? (void*)o : nullptr;
    if (obj) {
        const char* why = sg_dead(obj, 0);
        if (why) { sg_log_skip("PostSignificance", obj, why); return; }
        if (g_badN && sg_is_bad(entry, obj)) return;
    }
    if (sg_call(g_origPostSig, holder, entryPtr, oldSig, newSig, final_)) sg_caught("PostSignificance", entry, obj);
}
// ---------------------------------------------------------------------------- client: chat domain (Oct 20)
// 1.14.7 starts its chat (XMPP over WebSocket) from [OnlineSubsystemPhoenix] ChatEndpoint: FOnlineSubsystemPhoenix
// (exe+0xE98250) passes that one string as both the server address and the XMPP domain to its login (exe+0xE66800,
// 5th and 6th arguments). With ChatEndpoint="ws://127.0.0.1" the address is right (the WebSocket path needs ws://), but
// the domain becomes "ws://127.0.0.1": the player's JID and the room JIDs ("muc.<domain>") break and the game never
// joins a chat room. The 6th argument (domain) is swapped for the game's normal one, only when it starts with ws.
namespace CD { const uintptr_t XmppLogin = 0xE66800; }
struct FStr { const wchar_t* Data; int32_t Num; int32_t Max; };
static const wchar_t g_chatDomainText[] = L"prod.ol.epicgames.com";
static FStr g_chatDomain = { g_chatDomainText, (int32_t)(sizeof(g_chatDomainText) / sizeof(wchar_t)), (int32_t)(sizeof(g_chatDomainText) / sizeof(wchar_t)) };
typedef uintptr_t (*XmppLoginFn)(void*, void*, void*, void*, void*, void*);
static XmppLoginFn g_origXmppLogin = nullptr;
static wchar_t g_chatUser[80] = L"";   // the account id the game's own chat connection (Phoenix) logs in with
static FStr g_chatUserStr = { g_chatUser, 0, 80 };
// The rooms (MCP chat) know the player by the sign-in id (EOS EpicAccountId, lower-case hex) and the game decides
// "this presence is my own join" by finding the connection's user in it (exe+0x4591240). The Phoenix connection
// logs in with the account id, so the game never saw its own join complete ("Another operation already pending").
// The connection now logs in with the sign-in id too: <EOS_OFFLINE_DIR>\eos_offline.ini EpicAccountId, or the
// stand-in's default when there is none. The chat server knows players by that id as well.
static wchar_t g_signinId[40] = L"";
static FStr g_signinStr = { g_signinId, 0, 40 };
static void load_signin_id() {
    wcscpy(g_signinId, L"d211000000000000000000000000e91c");
    wchar_t dir[MAX_PATH]; DWORD n = GetEnvironmentVariableW(L"EOS_OFFLINE_DIR", dir, MAX_PATH);
    if (n > 0 && n < MAX_PATH - 24) {
        wcscat(dir, L"\\eos_offline.ini");
        FILE* f = _wfopen(dir, L"rb");
        if (f) {
            char line[256];
            while (fgets(line, sizeof(line), f)) {
                char* p = line; while (*p == ' ' || *p == '\t') p++;
                if (_strnicmp(p, "EpicAccountId", 13) != 0) continue;
                p += 13; while (*p == ' ' || *p == '\t') p++; if (*p != '=') continue; p++; while (*p == ' ' || *p == '\t') p++;
                int k = 0; wchar_t id[40];
                while (k < 32 && isxdigit((unsigned char)p[k])) { id[k] = (wchar_t)tolower((unsigned char)p[k]); k++; }
                id[k] = 0;
                if (k == 32) wcscpy(g_signinId, id);
            }
            fclose(f);
        }
    }
    g_signinStr.Num = (int32_t)wcslen(g_signinId) + 1;
}
static uintptr_t xmpp_login_hook(void* a, void* b, void* c, void* d, void* addr, void* domain) {
    if (!g_signinStr.Num) load_signin_id();
    { static bool said = false; if (!said) { said = true; char m[120]; snprintf(m, sizeof(m), "chat user: the game's chat logs in as its sign-in id %ls", g_signinId); dxgi_note(m); } }
    b = &g_signinStr; c = &g_signinStr;
    FStr* u = (FStr*)b;
    if (u && readable(u, sizeof(FStr)) && u->Data && u->Num > 1 && u->Num < 80 && readable(u->Data, u->Num * 2)) {
        memcpy(g_chatUser, u->Data, u->Num * 2); g_chatUser[u->Num - 1] = 0; g_chatUserStr.Num = (int32_t)wcslen(g_chatUser) + 1;
    }
    FStr* f = (FStr*)domain;
    if (f && readable(f, sizeof(FStr)) && f->Data && f->Num > 5 && readable(f->Data, 12) && (wcsncmp(f->Data, L"ws://", 5) == 0 || wcsncmp(f->Data, L"wss://", 6) == 0)) {
        static bool said = false;
        if (!said) { said = true; dxgi_note("chat domain: the game's XMPP domain set to prod.ol.epicgames.com (ChatEndpoint is a ws:// address)"); }
        domain = &g_chatDomain;
    }
    return g_origXmppLogin(a, b, c, d, addr, domain);
}
// 1.14.7's main chat room is GetGeneralChatChannel (exe+0x1BDD930): "General" + the game's online session id. Offline
// there is no session id, so it comes back empty and the game never joins a room (it logs in to chat and stays idle).
// Every host runs its own chat server, so one fixed room per host is right: an empty answer becomes "GeneralDF".
// The game frees the string later, so it is grown with the game's own resize (exe+0x9FBE90, TArray<TCHAR>::ResizeTo).
namespace CR { const uintptr_t GetGeneralChatChannel = 0x1BDD930, StringResizeTo = 0x9FBE90; }
typedef void* (*GetChanFn)(void*, void*);
static GetChanFn g_origGetGeneral = nullptr;
static uintptr_t g_crBase = 0;
static void* get_general_hook(void* self, void* outp) {
    void* r = g_origGetGeneral(self, outp);
    FStr* out = (FStr*)outp;
    if (out && out->Num <= 1) {
        static const wchar_t room[] = L"GeneralDF";
        const int32_t n = (int32_t)(sizeof(room) / sizeof(wchar_t));   // with the terminator
        if (!out->Data || out->Max < n) ((void (*)(void*, int32_t))(g_crBase + CR::StringResizeTo))(out, n);
        if (out->Data && out->Max >= n) {
            memcpy((void*)out->Data, room, sizeof(room)); out->Num = n;
            static bool said = false;
            if (!said) { said = true; dxgi_note("chat room: no online session id, using the host's room GeneralDF"); }
        }
    }
    return r;
}
static void chat_room_init(uintptr_t b) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_CHATROOM", v, sizeof(v)) && v[0] == '0') { dxgi_note("chat room: off (D1147_CHATROOM=0)"); return; }
    static const uint8_t expect[10] = { 0x40, 0x56, 0x57, 0x48, 0x83, 0xEC, 0x48, 0x48, 0x8B, 0x01 };
    static const uint8_t expect2[9] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x57, 0x48, 0x83, 0xEC };
    g_crBase = b;
    if (memcmp((void*)(b + CR::GetGeneralChatChannel), expect, sizeof(expect)) != 0 || memcmp((void*)(b + CR::StringResizeTo), expect2, sizeof(expect2)) != 0) { dxgi_note("chat room: game code differs, off"); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + CR::GetGeneralChatChannel), (void*)get_general_hook, (void**)&g_origGetGeneral);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + CR::GetGeneralChatChannel));
    dxgi_note(s == MH_OK ? "chat room: on" : "chat room: hook FAILED, off");
}
// The game's chat rooms (City-<session>, Party-<party>) are joined by the MCP chat (FOnlineChatMcp::JoinPublicRoom,
// exe+0xB7CE90). It asks FXmppModule::GetConnection (exe+0x4583530) for a connection under its MCP user id (the
// sign-in id, d211...), but the only connection there is the Phoenix one, under the account id (measured with the
// game's own log, Oct 20: "JoinPublicRoom - failure - user(d211...) room(City-...)"). Offline both are the same
// player, so a lookup that finds nothing is answered with the Phoenix connection.
namespace CX { const uintptr_t GetConnection = 0x4583530; }
typedef void* (*GetConnFn)(void*, void*, void*);
static GetConnFn g_origGetConn = nullptr;
static void* get_conn_hook(void* self, void* out, void* user) {
    void* r = g_origGetConn(self, out, user);
    if (out && !((void**)out)[0] && g_chatUserStr.Num > 1) {
        FStr* u = (FStr*)user;
        bool same = u && u->Data && readable(u->Data, 4) && u->Num == g_chatUserStr.Num && wcscmp(u->Data, g_chatUser) == 0;
        if (!same) {
            r = g_origGetConn(self, out, &g_chatUserStr);
            static bool said = false;
            if (!said && ((void**)out)[0]) { said = true; dxgi_note("chat connection: the MCP chat uses the game's chat connection (one player offline)"); }
        }
    }
    return r;
}
static void chat_conn_init(uintptr_t b) {
    static const uint8_t expect[15] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x57, 0x48, 0x83, 0xEC, 0x30 };
    if (memcmp((void*)(b + CX::GetConnection), expect, sizeof(expect)) != 0) { dxgi_note("chat connection: game code differs, off"); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + CX::GetConnection), (void*)get_conn_hook, (void**)&g_origGetConn);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + CX::GetConnection));
    dxgi_note(s == MH_OK ? "chat connection: on" : "chat connection: hook FAILED, off");
}
static void chat_domain_init(uintptr_t b) {
    static const uint8_t expect[11] = { 0x48, 0x8B, 0xC4, 0x4C, 0x89, 0x48, 0x20, 0x4C, 0x89, 0x40, 0x18 };
    if (memcmp((void*)(b + CD::XmppLogin), expect, sizeof(expect)) != 0) { dxgi_note("chat domain: game code differs, off"); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + CD::XmppLogin), (void*)xmpp_login_hook, (void**)&g_origXmppLogin);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + CD::XmppLogin));
    dxgi_note(s == MH_OK ? "chat domain: on" : "chat domain: hook FAILED, off");
}

// ---------------------------------------------------------------------------- chat probe (TEST ONLY, records, changes nothing)
// Writes %LOCALAPPDATA%\d1147_chatprobe.log: what each step of a chat room join sees, so the fix is made from data.
namespace CP {
    const uintptr_t MucPresence = 0x4591240, JoinPublicDone = 0x4586520, McpConnCreated = 0xB78940,
                    McpOnJoinPublic = 0xB807A0, McpGetRoomInfo = 0xB77580;
}
static void cp_log(const char* fmt, ...) {
    static volatile LONG lines = 0;
    if (InterlockedIncrement(&lines) > 400) return;
    wchar_t path[MAX_PATH + 32];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (!n || n >= MAX_PATH) return;
    wcscat(path, L"\\d1147_chatprobe.log");
    HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    if (f == INVALID_HANDLE_VALUE) return;
    char line[1024]; SYSTEMTIME t; GetLocalTime(&t);
    int k = snprintf(line, sizeof(line), "%02d:%02d:%02d.%03d [%lu] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentThreadId());
    va_list ap; va_start(ap, fmt); k += vsnprintf(line + k, sizeof(line) - k - 3, fmt, ap); va_end(ap);
    if (k > (int)sizeof(line) - 3) k = sizeof(line) - 3;
    line[k++] = '\r'; line[k++] = '\n';
    DWORD w; WriteFile(f, line, k, &w, 0); CloseHandle(f);
}
// FString -> printable text (never faults: checks memory first)
static const char* cp_str(const void* fs, char* out, size_t cap) {
    strcpy(out, "<?>");
    if (!fs || !readable(fs, sizeof(FStr))) return out;
    const FStr* f = (const FStr*)fs;
    if (f->Num <= 0) { strcpy(out, "<empty>"); return out; }
    if (!f->Data || f->Num > 400 || !readable(f->Data, (size_t)f->Num * 2)) { snprintf(out, cap, "<bad num=%d>", f->Num); return out; }
    size_t j = 0;
    for (int i = 0; i < f->Num - 1 && j + 1 < cap; i++) { wchar_t c = f->Data[i]; out[j++] = (c >= 32 && c < 127) ? (char)c : '?'; }
    out[j] = 0; return out;
}
// IXmppConnection user (vtable +0x30 returns its FXmppUserJid, whose first field is the id FString; exe+0x4591430)
static const char* cp_conn_user(void* conn, char* out, size_t cap) {
    strcpy(out, "<noconn>");
    if (!conn || !readable(conn, 8)) return out;
    void** vt = *(void***)conn;
    if (!vt || !readable(vt, 0x38)) return out;
    uintptr_t fn = (uintptr_t)vt[6];
    if (fn < g_exeLo || fn >= g_exeHi) { strcpy(out, "<vt?>"); return out; }
    void* r = ((void* (*)(void*))fn)(conn);
    return cp_str(r, out, cap);
}
// FUniqueNetId::ToString (vtable +0x30, returns FString by out pointer; exe+0xB77651). The string is left to leak (probe only).
static const char* cp_netid(void* id, char* out, size_t cap) {
    strcpy(out, "<noid>");
    if (!id || !readable(id, 8)) return out;
    void** vt = *(void***)id;
    if (!vt || !readable(vt, 0x38)) return out;
    uintptr_t fn = (uintptr_t)vt[6];
    if (fn < g_exeLo || fn >= g_exeHi) { strcpy(out, "<vt?>"); return out; }
    FStr tmp = { 0, 0, 0 };
    ((void* (*)(void*, void*))fn)(id, &tmp);
    return cp_str(&tmp, out, cap);
}
typedef void* (*Fn4)(void*, void*, void*, void*);
typedef void* (*Fn5)(void*, void*, void*, void*, void*);
static Fn4 g_oMucPres = 0; static Fn4 g_oJoinDone = 0; static Fn4 g_oConnCreated = 0; static Fn5 g_oOnJoinPub = 0; static Fn4 g_oGetRoomInfo = 0;
static void* h_MucPres(void* self, void* pres, void* c, void* d) {
    char nick[300], room[300], user[120];
    void* conn = (self && readable(self, 0x28)) ? *(void**)((char*)self + 0x20) : 0;
    bool avail = pres && readable(pres, 8) && *((uint8_t*)pres + 4);
    cp_log("MUC presence in: nick=%s room=%s available=%d connection user=%s", cp_str((char*)pres + 0x68, nick, sizeof nick), cp_str((char*)pres + 0x48, room, sizeof room), (int)avail, cp_conn_user(conn, user, sizeof user));
    return g_oMucPres(self, pres, c, d);
}
static void* h_JoinDone(void* self, void* roomInfo, void* pres, void* d) {
    char room[300], nick[300];
    cp_log("MUC join complete called: room=%s nick=%s", cp_str((char*)roomInfo + 0x38, room, sizeof room), cp_str((char*)pres + 0x68, nick, sizeof nick));
    return g_oJoinDone(self, roomInfo, pres, d);
}
// FOnlineChatMcp has a second base at +0x110 (constructor exe+0xB483EA puts vtable exe+0x5095680 there);
// HandleXmppConnectionCreated is slot 19 of that vtable, so it runs with this = chat + 0x110 (its [this+0x2D0] weak
// self pointer is chat+0x3E0, set up in the same constructor).
static const uintptr_t CM_ConnHandlerBase = 0x110;
static void* g_cpAnnounced[16]; static volatile LONG g_cpAnnouncedN = 0;
static bool cp_was_announced(void* chat, void* conn) {
    for (LONG i = 0; i < g_cpAnnouncedN && i < 8; i++) if (g_cpAnnounced[i * 2] == chat && g_cpAnnounced[i * 2 + 1] == conn) return true;
    return false;
}
static void cp_mark_announced(void* chat, void* conn) {
    if (cp_was_announced(chat, conn)) return;
    LONG i = InterlockedIncrement(&g_cpAnnouncedN) - 1;
    if (i < 8) { g_cpAnnounced[i * 2] = chat; g_cpAnnounced[i * 2 + 1] = conn; }
}
static void* h_ConnCreated(void* self, void* connRef, void* c, void* d) {
    char user[120]; void* conn = (connRef && readable(connRef, 8)) ? *(void**)connRef : 0;
    cp_mark_announced((char*)self - CM_ConnHandlerBase, conn);   // self is the chat's second base (+0x110)
    cp_log("MCP chat %p told of new connection %p user=%s", self, conn, cp_conn_user(conn, user, sizeof user));
    return g_oConnCreated(self, connRef, c, d);
}
static void* h_OnJoinPub(void* self, void* connRef, void* ok, void* roomId, void* err) {
    char user[120], room[300]; void* conn = (connRef && readable(connRef, 8)) ? *(void**)connRef : 0;
    cp_log("MCP chat %p heard join result: ok=%d room=%s connection user=%s", self, (int)((uintptr_t)ok & 0xFF), cp_str(roomId, room, sizeof room), cp_conn_user(conn, user, sizeof user));
    return g_oOnJoinPub(self, connRef, ok, roomId, err);
}
static void* h_GetRoomInfo(void* self, void* out, void* user, void* roomId) {
    static volatile LONG n = 0;
    void* r = g_oGetRoomInfo(self, out, user, roomId);
    if (InterlockedIncrement(&n) <= 30) {
        char u[120], room[300];
        cp_log("MCP chat %p GetRoomInfo user=%s room=%s -> %s", self, cp_netid(user, u, sizeof u), cp_str(roomId, room, sizeof room), (out && *(void**)out) ? "FOUND" : "NONE");
    }
    return r;
}
static void cp_hook(uintptr_t b, uintptr_t off, const uint8_t* expect, size_t n, void* fn, void** orig, const char* name) {
    if (memcmp((void*)(b + off), expect, n) != 0) { cp_log("hook %s: game code differs, skipped", name); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + off), fn, orig);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + off));
    cp_log("hook %s: %s", name, s == MH_OK ? "on" : "FAILED");
}

// probe, part 2: where a sent room message goes after the server echoes it back
namespace CP2 { const uintptr_t MucGroupChat = 0x4590C10, McpRoomChat = 0xB860C0, TriggerRoomMsg = 0xBC4A20, SendRoomChat = 0xBAFF20; }
static void* volatile g_cmUiChat = 0;   // the MCP chat that joins rooms and sends (the chat window's one)
static Fn4 g_oMucGroup = 0; static Fn5 g_oMcpRoomChat = 0; static Fn4 g_oTrigRoomMsg = 0; static Fn4 g_oSendRoomChat = 0;
static void* h_MucGroup(void* self, void* a, void* b, void* c) { cp_log("MUC groupchat message in (XMPP level)"); return g_oMucGroup(self, a, b, c); }
static void* h_McpRoomChat(void* self, void* connRef, void* room, void* d, void* msg) {
    char r[300], x[300], body[300];
    void* m = (msg && readable(msg, 8)) ? *(void**)msg : 0;
    cp_log("MCP chat %p room message in: room=%s arg4=%s body=%s", self, cp_str(room, r, sizeof r), cp_str(d, x, sizeof x), m ? cp_str((char*)m + 0x60, body, sizeof body) : "<nomsg>");
    return g_oMcpRoomChat(self, connRef, room, d, msg);
}

// The room nickname is "<name>:<account id>:V2:archon_xmpp:::<guid>" (the game builds it that way and finds its own
// join by the id in it). The chat window prints the sender as it comes, so the message's nickname is cut to <name>
// in place (same buffer, shorter length) before the message is passed on. Only strings that carry ":V2:" are touched.
static bool cm_cut(FStr* f) {
    if (!readable(f, sizeof(FStr)) || !f->Data || f->Num < 6 || f->Num > 400 || f->Max < f->Num || !readable(f->Data, (size_t)f->Num * 2)) return false;
    if (f->Data[f->Num - 1] != 0 || !wcsstr(f->Data, L":V2:")) return false;
    const wchar_t* c = wcschr(f->Data, L':'); int idx = (int)(c - f->Data);
    if (idx <= 0) return false;
    ((wchar_t*)f->Data)[idx] = 0; f->Num = idx + 1; return true;
}
// one-time dump of the message object (and one level of pointers) so the name field can be found
static void cm_dump(void* m) {
    static volatile LONG once = 0; if (InterlockedIncrement(&once) > 2) return;
    char t[300];
    cp_log("message object %p:", m);
    for (int off = 0; off < 0x100; off += 8) {
        if (!readable((char*)m + off, 16)) break;
        uintptr_t v = *(uintptr_t*)((char*)m + off);
        cp_log("  +0x%02X = %016llX  as string: %s", off, (unsigned long long)v, cp_str((char*)m + off, t, sizeof t));
        if (v > 0x10000 && readable((void*)v, 0x60) && !(v >= g_exeLo && v < g_exeHi)) {
            for (int o2 = 0; o2 < 0x60; o2 += 8) {
                cp_str((char*)v + o2, t, sizeof t);
                if (t[0] != '<') cp_log("      [+0x%02X]+0x%02X string: %s", off, o2, t);
            }
        }
    }
}
static void cm_short_sender(void* msgRef) {
    void* m = (msgRef && readable(msgRef, 8)) ? *(void**)msgRef : 0;
    if (!m || !readable(m, 0x100)) return;
    cm_dump(m);
    // one level down: a pointer field whose object holds the nickname
    for (int off = 0; off < 0x100; off += 8) {
        uintptr_t v = *(uintptr_t*)((char*)m + off);
        if (v > 0x10000 && !(v >= g_exeLo && v < g_exeHi) && readable((void*)v, 0x60))
            for (int o2 = 0; o2 < 0x60; o2 += 8) if (cm_cut((FStr*)((char*)v + o2))) cp_log("chat window: sender name cut (message +0x%X -> +0x%X)", off, o2);
    }
    for (int off = 8; off + (int)sizeof(FStr) <= 0x100; off += 8) {
        FStr* f = (FStr*)((char*)m + off);
        if (!f->Data || f->Num < 6 || f->Num > 400 || f->Max < f->Num || !readable(f->Data, (size_t)f->Num * 2)) continue;
        if (f->Data[f->Num - 1] != 0) continue;
        if (!wcsstr(f->Data, L":V2:")) continue;
        const wchar_t* c = wcschr(f->Data, L':');
        int idx = (int)(c - f->Data);
        if (idx <= 0) continue;
        ((wchar_t*)f->Data)[idx] = 0; f->Num = idx + 1;
        static volatile LONG said = 0;
        if (InterlockedIncrement(&said) == 1) { char t[200]; cp_log("chat window: sender name cut to the name part (message +0x%X)", off); snprintf(t, sizeof t, "chat window: sender shown by name only (message field +0x%X)", off); dxgi_note(t); }
    }
}
static void* h_TrigRoomMsg(void* self, void* a, void* b, void* c) {
    int n = (self && readable((char*)self + 0xC8, 0x18)) ? *(int*)((char*)self + 0xC8 + 8) : -1;
    char r[300];
    cp_log("MCP chat %p broadcasts room message to %d listener(s), room=%s", self, n, cp_str(b, r, sizeof r));
    cm_short_sender(c);
    void* ret = g_oTrigRoomMsg(self, a, b, c);
    // Measured Oct 20 (probe run 3): the room message comes back through a second chat object, not the one the
    // chat window listens to (the one that joined the room and sends). It is handed to that one as well.
    void* ui = g_cmUiChat;
    if (ui && ui != self && readable((char*)ui + 0xC8, 0x18)) {
        int m = *(int*)((char*)ui + 0xC8 + 8);
        cp_log("chat window: room message also given to MCP chat %p (%d listener(s))", ui, m);
        { static volatile LONG said = 0; if (InterlockedIncrement(&said) == 1) dxgi_note("chat window: room messages are passed to the chat the window listens to"); }
        g_oTrigRoomMsg(ui, a, b, c);
    }
    return ret;
}
static void* h_SendRoomChat(void* self, void* user, void* room, void* body) {
    void* r = g_oSendRoomChat(self, user, room, body);
    char rm[300], bd[300];
    cp_log("MCP chat %p SendRoomChat room=%s body=%s -> %d", self, cp_str(room, rm, sizeof rm), cp_str(body, bd, sizeof bd), (int)((uintptr_t)r & 0xFF));
    return r;
}
static void chat_probe2_init(uintptr_t b) {
    static const uint8_t e1[] = { 0x48, 0x89, 0x5C, 0x24, 0x18, 0x48, 0x89, 0x6C, 0x24, 0x20, 0x56, 0x57 };
    static const uint8_t e2[] = { 0x4C, 0x89, 0x4C, 0x24, 0x20, 0x4C, 0x89, 0x44, 0x24, 0x18 };
    static const uint8_t e3[] = { 0x40, 0x56, 0x48, 0x83, 0xEC, 0x30, 0x48, 0x89, 0x6C, 0x24, 0x48 };
    static const uint8_t e4[] = { 0x48, 0x89, 0x5C, 0x24, 0x18, 0x4C, 0x89, 0x4C, 0x24, 0x20 };
    cp_hook(b, CP2::MucGroupChat, e1, sizeof e1, (void*)h_MucGroup, (void**)&g_oMucGroup, "MUC groupchat");
    cp_hook(b, CP2::McpRoomChat, e2, sizeof e2, (void*)h_McpRoomChat, (void**)&g_oMcpRoomChat, "MCP room message");
    cp_hook(b, CP2::TriggerRoomMsg, e3, sizeof e3, (void*)h_TrigRoomMsg, (void**)&g_oTrigRoomMsg, "MCP room message broadcast");
    cp_hook(b, CP2::SendRoomChat, e4, sizeof e4, (void*)h_SendRoomChat, (void**)&g_oSendRoomChat, "MCP SendRoomChat");
}
static void chat_probe_init(uintptr_t b) {
    cp_log("---- chat probe start (sign-in id from loader: %ls)", g_signinId[0] ? g_signinId : L"(not loaded yet)");
    static const uint8_t e1[] = { 0x40, 0x53, 0x55, 0x56, 0x57, 0x41, 0x54 };
    static const uint8_t e2[] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10 };
    static const uint8_t e3[] = { 0x48, 0x89, 0x54, 0x24, 0x10, 0x48, 0x89, 0x4C, 0x24, 0x08 };
    static const uint8_t e4[] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x18 };
    static const uint8_t e5[] = { 0x48, 0x8B, 0xC4, 0x53, 0x56, 0x48, 0x83, 0xEC, 0x78 };
    cp_hook(b, CP::MucPresence, e1, sizeof e1, (void*)h_MucPres, (void**)&g_oMucPres, "MUC presence");
    cp_hook(b, CP::JoinPublicDone, e2, sizeof e2, (void*)h_JoinDone, (void**)&g_oJoinDone, "MUC join complete");
    cp_hook(b, CP::McpConnCreated, e3, sizeof e3, (void*)h_ConnCreated, (void**)&g_oConnCreated, "MCP connection created");
    cp_hook(b, CP::McpOnJoinPublic, e4, sizeof e4, (void*)h_OnJoinPub, (void**)&g_oOnJoinPub, "MCP join result");
    cp_hook(b, CP::McpGetRoomInfo, e5, sizeof e5, (void*)h_GetRoomInfo, (void**)&g_oGetRoomInfo, "MCP GetRoomInfo");
    chat_probe2_init(b);
}

// ---------------------------------------------------------------------------- chat rooms: tell the MCP chat about the connection
// Measured with the chat probe (Oct 20): the room join completes at the XMPP level (MUC presence, own nick,
// HandleJoinPublicRoomComplete all fire), but FOnlineChatMcp::HandleXmppConnectionCreated (exe+0xB78940) never runs
// for the game's chat connection, so the MCP chat never binds its room delegates: OnXmppJoinPublicRoom never fires,
// GetRoomInfo finds nothing and every message ends "RoomInfo is not valid". Before the MCP chat joins a room
// (FOnlineChatMcp::JoinPublicRoom, exe+0xB7CE90) it is now handed the connection it is about to use, once:
// FOnlineSubsystemMcp::GetXmppConnection (exe+0xC4D6D0) -> HandleXmppConnectionCreated(chat, connection).
namespace CM { const uintptr_t JoinPublicRoom = 0xB7CE90, GetXmppConnection = 0xC4D6D0, Subsystem = 0x118; }
typedef void* (*JoinPubFn)(void*, void*, void*, void*, void*, void*);
static JoinPubFn g_oJoinPub = 0;
static uintptr_t g_cmBase = 0;
static void* h_JoinPub(void* self, void* user, void* room, void* nick, void* e, void* f) {
    static volatile LONG said = 0;
    if (self) g_cmUiChat = self;
    if (self && readable(self, CM::Subsystem + 8)) {
        void* sub = *(void**)((char*)self + CM::Subsystem);
        if (sub) {
            void* sp[2] = { 0, 0 };   // TSharedPtr<IXmppConnection>, released again below (a kept reference stops the game closing)
            ((void* (*)(void*, void*, void*))(g_cmBase + CM::GetXmppConnection))(sub, sp, user);
            if (sp[0] && !cp_was_announced(self, sp[0])) {
                cp_mark_announced(self, sp[0]);
                char u[120];
                cp_log("chat rooms: MCP chat %p given connection %p user=%s", self, sp[0], cp_conn_user(sp[0], u, sizeof u));
                ((void* (*)(void*, void*))(g_cmBase + CP::McpConnCreated))((char*)self + CM_ConnHandlerBase, sp);
                if (InterlockedIncrement(&said) == 1) dxgi_note("chat rooms: the MCP chat was given the game's chat connection");
            }
            // release our reference like the game does (exe+0xB78AB1): shared count at +8, weak count at +0xC
            if (sp[1] && readable(sp[1], 0x10)) {
                volatile LONG* rc = (volatile LONG*)((char*)sp[1] + 8);
                if (InterlockedDecrement(rc) == 0) {
                    void** vt = *(void***)sp[1];
                    ((void (*)(void*))vt[0])(sp[1]);
                    if (InterlockedDecrement(rc + 1) == 0) ((void (*)(void*, int))vt[1])(sp[1], 1);
                }
            }
        }
    }
    return g_oJoinPub(self, user, room, nick, e, f);
}
static void chat_mcp_init(uintptr_t b) {
    static const uint8_t e1[] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x4C, 0x89, 0x4C, 0x24, 0x20, 0x55, 0x56, 0x57 };
    static const uint8_t e2[] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74, 0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x40 };
    g_cmBase = b;
    if (memcmp((void*)(b + CM::JoinPublicRoom), e1, sizeof e1) != 0 || memcmp((void*)(b + CM::GetXmppConnection), e2, sizeof e2) != 0) { dxgi_note("chat rooms: game code differs, off"); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + CM::JoinPublicRoom), (void*)h_JoinPub, (void**)&g_oJoinPub);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + CM::JoinPublicRoom));
    dxgi_note(s == MH_OK ? "chat rooms: on" : "chat rooms: hook FAILED, off");
    cp_log("hook chat rooms (JoinPublicRoom): %s", s == MH_OK ? "on" : "FAILED");
}
static void startup_messages_init(uintptr_t b);
// Oct 26: fixed byte changes in the player's own game, made here instead of by PowerShell scripts writing into the game
// (antivirus programs block those: DF-AMMO-LOG-1147 and DF-PARTY-STAY-1147 were tools\*.ps1 until Oct 26).
// Each is written only when the original bytes are there.
static void client_patch(uintptr_t b, uintptr_t rva, const uint8_t* expect, const uint8_t* repl, size_t n, const char* what) {
    char line[160];
    uint8_t* p = (uint8_t*)(b + rva);
    if (memcmp(p, repl, n) == 0) { snprintf(line, sizeof(line), "%s: already on", what); dxgi_note(line); return; }
    if (memcmp(p, expect, n) != 0) { snprintf(line, sizeof(line), "%s: game code differs, off", what); dxgi_note(line); return; }
    DWORD old = 0;
    if (!VirtualProtect(p, n, PAGE_EXECUTE_READWRITE, &old)) { snprintf(line, sizeof(line), "%s: FAILED (VirtualProtect %lu)", what, GetLastError()); dxgi_note(line); return; }
    memcpy(p, repl, n);
    VirtualProtect(p, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), p, n);
    snprintf(line, sizeof(line), "%s: on", what); dxgi_note(line);
}
static void client_fixed_patches(uintptr_t b) {
    char v[8];
    // DF-PARTY-STAY-1147 (Oct 25): the game decides who in its party is online from Epic's live services; offline its check
    // finds nobody after a map change and leaves the party, or (leader) kicks the member. Real leaves and kicks still work.
    if (GetEnvironmentVariableA("D1147_PARTY_STAY", v, sizeof(v)) && v[0] == '0') dxgi_note("party stay: off (D1147_PARTY_STAY=0)");
    else {
        static const uint8_t e1[6] = { 0x0F, 0x85, 0x7E, 0x08, 0x00, 0x00 }, r1[6] = { 0x90, 0x90, 0x90, 0x90, 0x90, 0x90 };
        client_patch(b, 0x1C7B447, e1, r1, 6, "party stay: leave when all members look offline");
        static const uint8_t e2[6] = { 0x0F, 0x86, 0x8D, 0x05, 0x00, 0x00 }, r2[6] = { 0xE9, 0x8E, 0x05, 0x00, 0x00, 0x90 };
        client_patch(b, 0x1C7B47E, e2, r2, 6, "party stay: leader kicks a member who looks offline");
    }
    // DF-AMMO-LOG-1147: same change as the server copies get (the old script patched every game process)
    static const uint8_t e3[6] = { 0x0F, 0x89, 0xEC, 0x00, 0x00, 0x00 }, r3[6] = { 0xE9, 0xED, 0x00, 0x00, 0x00, 0x90 };
    client_patch(b, 0x220C8EF, e3, r3, 6, "ServerAdjustAmmo: skip broken warning");
}

// [Dauntless Forever] DF-LINGERVFX-1147 (Nov 2, report 544, fourth pass). Proven on Nov 2: cblades_reapers_dance_aoe_bp_C
// was destroyed on both sides and the dome was still drawn, so the dome is something that actor creates and that lives
// on without it. In UE 4.26 an effect spawned "at a location" belongs to the world, not to the actor that asked for it,
// and a looping one never finishes, so nothing ever removes it. Here, in the player's game only (that is where the dome
// is drawn), the engine's own object list is read right before and right after that actor's BeginPlay and again in its
// first 2.5 s: every object that appeared is written to d1147_dxgi.log with its class and owner, which names the dome.
// When the actor is removed (DF-LINGERFIX), every effect-like object it created that is still alive is ended the
// engine's way (Deactivate, then DestroyComponent; DestroyActor for an actor), and 20 s later the log says which of them
// are still there. D1147_LINGERVFX=0 turns all of this off; D1147_LINGERVFX=log only names, it does not end anything.
static uintptr_t* g_vfxSnap = 0; static int32_t g_vfxSnapN = 0, g_vfxSnapCap = 0;
struct VfxObj { void* obj; void* cls; void* owner; int32_t idx; ULONGLONG born; uint8_t ended; uint8_t told; uint8_t mayEnd; char cname[80]; char oname[80]; };
static VfxObj g_vfx[192]; static int g_vfxN = 0;
struct VfxActor { void* actor; ULONGLONG born; ULONGLONG killed; int step; };
static VfxActor g_vfxA[8];
static int32_t vfx_num(void) {
    uintptr_t w;
    if (!g_objArr || !sg_read((void*)(g_objArr + 0x20), &w)) return 0;
    int32_t num = (int32_t)(w >> 32), max = (int32_t)(w & 0xFFFFFFFF);
    return (num > 0 && num <= max) ? num : 0;
}
// object and flags at one index of the list (chunks of 65536 items, 0x18 bytes each: object, flags|cluster, serial)
static bool vfx_slot(uintptr_t chunk, int32_t idx, uintptr_t* obj, uint32_t* flags) {
    uintptr_t item = chunk + 0x18 * (uintptr_t)(idx & 0xFFFF), o, f;
    if (!sg_read((void*)item, &o) || !sg_read((void*)(item + 8), &f)) return false;
    *obj = o; *flags = (uint32_t)f; return true;
}
static uintptr_t vfx_chunk(int32_t idx) {
    uintptr_t chunks, chunk;
    if (!sg_read((void*)(g_objArr + 0x10), &chunks) || !chunks) return 0;
    if (!sg_read((void*)(chunks + 8 * (uintptr_t)(idx >> 16)), &chunk)) return 0;
    return chunk;
}
static void vfx_snap(void) {
    int32_t n = vfx_num(); g_vfxSnapN = 0;
    if (!n) return;
    if (n > g_vfxSnapCap) {
        if (g_vfxSnap) VirtualFree(g_vfxSnap, 0, MEM_RELEASE);
        g_vfxSnapCap = n + 65536;
        g_vfxSnap = (uintptr_t*)VirtualAlloc(0, sizeof(uintptr_t) * (size_t)g_vfxSnapCap, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!g_vfxSnap) { g_vfxSnapCap = 0; return; }
    }
    uintptr_t chunk = 0;
    for (int32_t i = 0; i < n; i++) {
        if ((i & 0xFFFF) == 0) chunk = vfx_chunk(i);
        uintptr_t o = 0; uint32_t f = 0;
        if (!chunk || !vfx_slot(chunk, i, &o, &f)) o = 0;
        g_vfxSnap[i] = o;
    }
    g_vfxSnapN = n;
}
static bool vfx_effect_like(const char* c) {
    return strstr(c, "Particle") || strstr(c, "Niagara") || strstr(c, "Emitter") || strstr(c, "Decal") ||
           strstr(c, "Light") || strstr(c, "Mesh") || strstr(c, "FX") || strstr(c, "Fx") || strstr(c, "fx") ||
           strstr(c, "VFX") || strstr(c, "vfx") || strstr(c, "Audio") || strstr(c, "Component");
}
// every object that is in the list now but was not at the last snapshot, logged and (if effect-like) remembered
static void vfx_diff(void* actor, const char* when, int stage) {
    int32_t n = vfx_num(); int seen = 0, kept = 0, logged = 0; uintptr_t chunk = 0;
    for (int32_t i = 0; i < n; i++) {
        if ((i & 0xFFFF) == 0) chunk = vfx_chunk(i);
        uintptr_t o = 0; uint32_t f = 0;
        if (!chunk || !vfx_slot(chunk, i, &o, &f) || !o) continue;
        if (i < g_vfxSnapN && g_vfxSnap[i] == o) continue;
        if (f & ((1u << 28) | (1u << 29))) continue;                      // Unreachable / PendingKill
        if (o == (uintptr_t)actor) continue;
        uintptr_t cls = 0, outer = 0;
        if (!sg_read((void*)(o + A::Object_Class), &cls) || !cls) continue;
        sg_read((void*)(o + A::Object_Outer), &outer);
        char cn[80], on[80], un[80];
        name_of((void*)cls, cn, sizeof(cn)); name_of((void*)o, on, sizeof(on)); name_of((void*)outer, un, sizeof(un));
        seen++;
        if (g_vfxLogged < 400 && logged < 120) {
            g_vfxLogged++; logged++;
            char line[340]; snprintf(line, sizeof(line), "effect watch: %s, new: %s %s (belongs to %s)", when, cn, on, un);
            dxgi_note(line);
        }
        if (vfx_effect_like(cn) && g_vfxN < (int)(sizeof(g_vfx) / sizeof(g_vfx[0]))) {
            VfxObj& v = g_vfx[g_vfxN++];
            v.obj = (void*)o; v.cls = (void*)cls; v.owner = actor; v.idx = i; v.born = GetTickCount64(); v.ended = 0; v.told = 0;
            // what may be ended when the dance goes: anything its BeginPlay made, and only particle or Niagara effects
            // from its first 0.6 s (other things made in that time can belong to anyone)
            v.mayEnd = (stage == 0) || (stage == 1 && (strstr(cn, "Particle") || strstr(cn, "Niagara")));
            snprintf(v.cname, sizeof(v.cname), "%s", cn); snprintf(v.oname, sizeof(v.oname), "%s", on);
            kept++;
        }
    }
    char line[200]; snprintf(line, sizeof(line), "effect watch: %s, %d new object(s), %d of them effect-like and watched", when, seen, kept);
    dxgi_note(line);
}
// still the same object at its index, not being destroyed
static bool vfx_alive(const VfxObj& v) {
    uintptr_t chunk = vfx_chunk(v.idx), o = 0; uint32_t f = 0;
    if (!chunk || !vfx_slot(chunk, v.idx, &o, &f)) return false;
    if (o != (uintptr_t)v.obj) return false;
    if (f & ((1u << 28) | (1u << 29))) return false;
    uintptr_t cls = 0;
    return sg_read((void*)(o + A::Object_Class), &cls) && cls == (uintptr_t)v.cls;
}
static void vfx_before(void* actor) {
    if (!g_vfxOn || g_isServerCopy || !g_objArr) return;
    vfx_snap();
}
static void vfx_after(void* actor, const char* cls) {
    if (!g_vfxOn || g_isServerCopy || !g_objArr || !g_vfxSnapN) return;
    char when[120]; snprintf(when, sizeof(when), "%s BeginPlay", cls);
    vfx_diff(actor, when, 0);
    vfx_snap();                                                             // later rescans compare with right after BeginPlay
    for (int i = 0; i < (int)(sizeof(g_vfxA) / sizeof(g_vfxA[0])); i++)
        if (!g_vfxA[i].actor) { g_vfxA[i].actor = actor; g_vfxA[i].born = GetTickCount64(); g_vfxA[i].killed = 0; g_vfxA[i].step = 0; break; }
}
struct VfxCall { void* obj; void* fn; uint8_t parms[16]; };
static void vfx_pe(void* arg) { VfxCall* c = (VfxCall*)arg; if (g_origProcessEvent) g_origProcessEvent(c->obj, c->fn, c->parms); }
static bool vfx_call(void* obj, void* cls, const wchar_t* name, void* arg8) {
    void* fn = find_function(cls, name);
    if (!fn) return false;
    VfxCall c = { obj, fn, { 0 } };
    if (arg8) *(void**)c.parms = arg8;
    return guarded(vfx_pe, &c);
}
static void vfx_on_kill(void* actor) {
    if (!g_vfxOn || g_isServerCopy || !g_objArr) return;
    for (int i = 0; i < (int)(sizeof(g_vfxA) / sizeof(g_vfxA[0])); i++) if (g_vfxA[i].actor == actor && !g_vfxA[i].killed) g_vfxA[i].killed = GetTickCount64();
    int ended = 0, tried = 0;
    for (int i = 0; i < g_vfxN; i++) {
        VfxObj& v = g_vfx[i];
        if (v.owner != actor || v.ended || !v.mayEnd) continue;
        v.ended = 1;
        if (!vfx_alive(v)) continue;
        tried++;
        if (!g_vfxFix) continue;
        bool isActor = (strstr(v.cname, "Actor") || strstr(v.cname, "Emitter")) && !strstr(v.cname, "Component");
        bool ok;
        if (isActor) ok = vfx_call(v.obj, v.cls, L"K2_DestroyActor", 0);
        else { bool d = vfx_call(v.obj, v.cls, L"Deactivate", 0); ok = vfx_call(v.obj, v.cls, L"K2_DestroyComponent", v.obj) || d; }
        if (ok) ended++;
        char line[300]; snprintf(line, sizeof(line), "effect watch: ended %s %s with its %s (%s)", v.cname, v.oname, isActor ? "actor" : "component", ok ? "done" : "no way to end it found");
        dxgi_note(line);
    }
    char line[200];
    snprintf(line, sizeof(line), "effect watch: the dance's actor is going: %d effect-like object(s) it made were still alive, %d ended%s", tried, ended, g_vfxFix ? "" : " (D1147_LINGERVFX=log: none ended on purpose)");
    dxgi_note(line);
}
static void vfx_tick(void) {
    if (!g_vfxOn || g_isServerCopy || !g_objArr) return;
    ULONGLONG now = GetTickCount64();
    for (int i = 0; i < (int)(sizeof(g_vfxA) / sizeof(g_vfxA[0])); i++) {
        VfxActor& a = g_vfxA[i];
        if (!a.actor) continue;
        if (a.step == 0 && now - a.born >= 600) { a.step = 1; vfx_diff(a.actor, "first 0.6 s after BeginPlay", 1); vfx_snap(); }
        else if (a.step == 1 && now - a.born >= 2500) { a.step = 2; vfx_diff(a.actor, "0.6 to 2.5 s after BeginPlay", 2); vfx_snap(); }
        else if (a.step == 2 && now - a.born >= 20000) {
            a.step = 3;
            int alive = 0;
            for (int k = 0; k < g_vfxN; k++) {
                VfxObj& v = g_vfx[k];
                if (v.owner != a.actor || v.told) continue;
                v.told = 1;
                if (vfx_alive(v)) { alive++; char line[300]; snprintf(line, sizeof(line), "effect watch: STILL THERE 20 s after the dance: %s %s", v.cname, v.oname); dxgi_note(line); }
            }
            char line[160]; snprintf(line, sizeof(line), "effect watch: 20 s after the dance, %d effect-like object(s) it made are still alive", alive);
            dxgi_note(line);
            a.actor = 0;
        }
    }
}

// ---------------------------------------------------------------------------- DF-DOMEPROBE-1147 (Nov 3)
// Addison, from an old video: on live the Reaper's Dance dome is an ANIMATION (white flash, grows, turns purple, fades)
// and then goes; ours is a still white dome that never goes. A still first frame that never ends is what an effect looks
// like when its own clock does not run: a Timeline that is not playing, a component that does not tick, or an actor
// whose time dilation is 0 (hit pause sets it). This probe reads the dance actor's own state with the engine's own
// functions, at 0.1 to 11 s after BeginPlay, and logs every function the engine runs on it or its parts (a running
// Timeline calls its __UpdateFunc every frame, and __FinishedFunc at the end). D1147_DOMEKICK=1 also starts what is
// stopped at 0.3 s (time dilation back to 1, ticking on, Timeline Play) to test the cause. Player's game only.
struct DpCall { char name[80]; char on[80]; long n; ULONGLONG first, last; };
static DpCall g_dpCalls[48]; static int g_dpCallN = 0;
static ULONGLONG g_dpBorn = 0; static int g_dpStep = 0, g_dpRuns = 0, g_dpKick = -1; static void* g_dpCls = 0; static char g_dpName[96];
static const int g_dpAt[] = { 100, 300, 400, 800, 1500, 2500, 3500, 5000, 7000, 9000, 11500 };
static int g_dpGone = 0; static float g_dpLoc[3]; static int g_dpHaveLoc = 0;
static void dp_long(const char* text) {                          // the log line holds about 200 characters: longer text in pieces
    size_t L = strlen(text); char part[212];
    for (size_t o = 0; o < L; o += 200) { size_t n = L - o > 200 ? 200 : L - o; memcpy(part, text + o, n); part[n] = 0; dxgi_note(part); }
}
static void dp_seen(void* obj, const char* fname) {
    ULONGLONG t = GetTickCount64() - g_dpBorn;
    char on[80]; name_of(at<void*>((uintptr_t)obj + A::Object_Class), on, sizeof(on));
    for (int i = 0; i < g_dpCallN; i++) if (!strcmp(g_dpCalls[i].name, fname) && !strcmp(g_dpCalls[i].on, on)) { g_dpCalls[i].n++; g_dpCalls[i].last = t; return; }
    if (g_dpCallN >= 48) return;
    DpCall& c = g_dpCalls[g_dpCallN++]; snprintf(c.name, sizeof(c.name), "%s", fname); snprintf(c.on, sizeof(c.on), "%s", on); c.n = 1; c.first = c.last = t;
}
// a reflected function with no arguments; its return value lands at parms[0]
static bool dp_ret(void* obj, const wchar_t* fn, uint8_t* out16) {
    void* f = find_function(at<void*>((uintptr_t)obj + A::Object_Class), fn);
    if (!f) return false;
    VfxCall c = { obj, f, { 0 } };
    if (!guarded(vfx_pe, &c)) return false;
    memcpy(out16, c.parms, 16); return true;
}
static bool dp_set_bool(void* obj, const wchar_t* fn, int v) {
    void* f = find_function(at<void*>((uintptr_t)obj + A::Object_Class), fn);
    if (!f) return false;
    VfxCall c = { obj, f, { 0 } }; c.parms[0] = (uint8_t)v;
    return guarded(vfx_pe, &c);
}
static bool dp_alive(void* a) {
    if (!a) return false;
    if (g_objArr) return sg_listed(a) == nullptr && at<void*>((uintptr_t)a + A::Object_Class) == g_dpCls;
    return at<void*>((uintptr_t)a + A::Object_Class) == g_dpCls && !(at<uint32_t>((uintptr_t)a + A::Object_Flags) & 0x60000000);
}
static void dp_fieldclass(void* prop, char* out, int n) {        // FField::ClassPrivate (+0x8) -> FFieldClass, its FName at +0
    out[0] = 0; uintptr_t fc = 0;
    if (!sg_read((char*)prop + 0x8, &fc) || !fc) { snprintf(out, n, "?"); return; }
    FString s = { 0, 0, 0 };
    ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)fc, &s);
    int k = 0; for (int i = 0; s.Data && i < s.Num && s.Data[i] && k < n - 1; i++) out[k++] = (char)s.Data[i]; out[k] = 0;
}
static void dp_layout(void* cls) {                                // the blueprint's own variables and functions, once per class
    static void* done[4]; for (int i = 0; i < 4; i++) { if (done[i] == cls) return; if (!done[i]) { done[i] = cls; break; } }
    void* c = cls;
    for (int d = 0; c && d < 3; d++, c = at<void*>((uintptr_t)c + A::Struct_Super)) {
        char cn[96]; name_of(c, cn, sizeof(cn));
        size_t L = strlen(cn); if (L < 2 || strcmp(cn + L - 2, "_C")) break;   // stop at the first native class
        char line[3000]; int k = snprintf(line, sizeof(line), "dome probe: %s variables:", cn);
        for (void* p = at<void*>((uintptr_t)c + HR::Struct_ChildProperties); p && k < (int)sizeof(line) - 120; p = at<void*>((uintptr_t)p + HR::FField_Next)) {
            FString s = { 0, 0, 0 }; ((void (*)(void*, FString*))(g_base + A::AppendString))((void*)((uintptr_t)p + HR::FField_Name), &s);
            char pn[64]; int j = 0; for (int i = 0; s.Data && i < s.Num && s.Data[i] && j < 63; i++) pn[j++] = (char)s.Data[i]; pn[j] = 0;
            char fc[48]; dp_fieldclass(p, fc, sizeof(fc));
            k += snprintf(line + k, sizeof(line) - k, " %s(%s)", pn, fc);
        }
        dp_long(line);
        k = snprintf(line, sizeof(line), "dome probe: %s functions:", cn);
        for (void* f = at<void*>((uintptr_t)c + A::Struct_Children); f && k < (int)sizeof(line) - 90; f = at<void*>((uintptr_t)f + A::Field_Next)) {
            char fnm[80]; name_of(f, fnm, sizeof(fnm)); k += snprintf(line + k, sizeof(line) - k, " %s", fnm);
        }
        dp_long(line);
    }
}
static void dp_comp(void* comp, const char* where, int kick) {
    if (!comp || (at<uint32_t>((uintptr_t)comp + A::Object_Flags) & 0x60000000)) return;
    char cn[80], on[80]; name_of(at<void*>((uintptr_t)comp + A::Object_Class), cn, sizeof(cn)); name_of(comp, on, sizeof(on));
    uint8_t r[16]; char line[420]; int k = snprintf(line, sizeof(line), "dome probe %s:   part %s %s:", where, cn, on);
    int tick = -1, active = -1, playing = -1;
    if (dp_ret(comp, L"IsComponentTickEnabled", r)) { tick = r[0] != 0; k += snprintf(line + k, sizeof(line) - k, " ticking=%d", tick); }
    if (dp_ret(comp, L"IsActive", r)) { active = r[0] != 0; k += snprintf(line + k, sizeof(line) - k, " active=%d", active); }
    if (dp_ret(comp, L"IsVisible", r)) k += snprintf(line + k, sizeof(line) - k, " visible=%d", r[0] != 0);
    if (dp_ret(comp, L"GetComponentScale", r) || dp_ret(comp, L"K2_GetComponentScale", r)) { float v[3]; memcpy(v, r, 12); k += snprintf(line + k, sizeof(line) - k, " scale=%.2f,%.2f,%.2f", v[0], v[1], v[2]); }
    if (strstr(cn, "Timeline") && dp_ret(comp, L"IsPlaying", r)) {
        playing = r[0] != 0; float pos = 0, len = 0, rate = 0;
        if (dp_ret(comp, L"GetPlaybackPosition", r)) memcpy(&pos, r, 4);
        if (dp_ret(comp, L"GetTimelineLength", r)) memcpy(&len, r, 4);
        if (dp_ret(comp, L"GetPlayRate", r)) memcpy(&rate, r, 4);
        k += snprintf(line + k, sizeof(line) - k, " TIMELINE playing=%d position=%.3f of %.3f rate=%.2f", playing, pos, len, rate);
    }
    {   // the material on part 0 (a dynamic one means the blueprint drives it)
        void* f = find_function(at<void*>((uintptr_t)comp + A::Object_Class), L"GetMaterial");
        if (f) { VfxCall c = { comp, f, { 0 } }; if (guarded(vfx_pe, &c)) { void* m = *(void**)(c.parms + 8); if (m) { char mc[64], mn[80]; name_of(at<void*>((uintptr_t)m + A::Object_Class), mc, sizeof(mc)); name_of(m, mn, sizeof(mn)); k += snprintf(line + k, sizeof(line) - k, " material=%s %s", mc, mn); } } }
    }
    dxgi_note(line);
    if (kick) {
        if (tick == 0 && dp_set_bool(comp, L"SetComponentTickEnabled", 1)) { snprintf(line, sizeof(line), "dome probe kick: %s ticking turned on", on); dxgi_note(line); }
        if (playing == 0) { void* f = find_function(at<void*>((uintptr_t)comp + A::Object_Class), L"Play"); VfxCall c = { comp, f, { 0 } }; if (f && guarded(vfx_pe, &c)) { snprintf(line, sizeof(line), "dome probe kick: %s Timeline Play", on); dxgi_note(line); } }
    }
}
static void dp_state(const char* where, int kick) {
    void* a = g_dpActor; uint8_t r[16]; char line[300];
    float dil = -1, cust = -1; int tick = -1; float life = -1;
    if (dp_ret(a, L"GetActorTimeDilation", r)) memcpy(&dil, r, 4);
    if (dp_ret(a, L"IsActorTickEnabled", r)) tick = r[0] != 0;
    if (dp_ret(a, L"GetLifeSpan", r)) memcpy(&life, r, 4);
    void* pc = hr_prop(g_dpCls, L"CustomTimeDilation"); int custOff = pc ? at<int32_t>((uintptr_t)pc + HR::Prop_Offset) : 0;
    if (custOff > 0x28 && custOff < 0x400) cust = at<float>((uintptr_t)a + custOff);
    snprintf(line, sizeof(line), "dome probe %s: actor %s time dilation=%.3f (own %.3f) ticking=%d life span=%.2f", where, g_dpName, dil, cust, tick, life);
    dxgi_note(line);
    if (kick) {
        if (custOff > 0x28 && custOff < 0x400 && cust >= 0 && cust < 0.99f) { at<float>((uintptr_t)a + custOff) = 1.0f; dxgi_note("dome probe kick: actor time dilation set back to 1"); }
        if (tick == 0 && dp_set_bool(a, L"SetActorTickEnabled", 1)) dxgi_note("dome probe kick: actor ticking turned on");
    }
    void* seen[80]; int ns = 0;
    const uintptr_t lists[2] = { A::Actor_BPComponents, A::Actor_InstComponents };
    for (int l = 0; l < 2; l++) {
        TArrayRaw& arr = at<TArrayRaw>((uintptr_t)a + lists[l]);
        if (!arr.Data || arr.Num <= 0 || arr.Num > 64) continue;
        for (int i = 0; i < arr.Num && ns < 80; i++) { void* c = arr.Data[i]; if (!c) continue; bool dup = false; for (int j = 0; j < ns; j++) dup |= seen[j] == c; if (dup) continue; seen[ns++] = c; dp_comp(c, where, kick); }
    }
    void* root = at<void*>((uintptr_t)a + HR::Actor_RootComponent); bool dup = false; for (int j = 0; j < ns; j++) dup |= seen[j] == root;
    if (root && !dup && at<void*>((uintptr_t)root + A::Object_Outer) == a) dp_comp(root, where, kick);
    if (ns == 0) dxgi_note("dome probe: the actor's own part lists are empty (its parts are native: only the root is shown)");
    char cl[3000]; int k = snprintf(cl, sizeof(cl), "dome probe %s: functions run on it so far:", where);
    for (int i = 0; i < g_dpCallN && k < (int)sizeof(cl) - 140; i++) k += snprintf(cl + k, sizeof(cl) - k, " %s on %s x%ld (%llu-%llu ms);", g_dpCalls[i].name, g_dpCalls[i].on, g_dpCalls[i].n, (unsigned long long)g_dpCalls[i].first, (unsigned long long)g_dpCalls[i].last);
    if (!g_dpCallN) k += snprintf(cl + k, sizeof(cl) - k, " none");
    dp_long(cl);
}
// Nov 3 second probe result: the dance actor removes ITSELF at 3 s (its Time To Decay), its own particle part p_aoe_vfx
// is inactive, and the ball stays: the ball is a particle effect the blueprint spawns from its ElementToParticle map,
// which belongs to the world (and in 4.26 is often a reused pooled component, so no new object appears). This finds
// every particle or Niagara component within 30 m of the dance and logs its effect asset, owner, active and ticking.
static void* g_dpClsC[2048]; static uint8_t g_dpClsV[2048];
static int dp_is_fx(void* cls) {                                  // 1 particle, 2 Niagara, 0 neither (cached per class)
    uintptr_t h = ((uintptr_t)cls >> 4) & 2047;
    for (int i = 0; i < 2048; i++) { int k = (h + i) & 2047; if (g_dpClsC[k] == cls) return g_dpClsV[k]; if (!g_dpClsC[k]) {
        int v = 0; void* c = cls;
        for (int d = 0; c && d < 12 && !v; d++, c = at<void*>((uintptr_t)c + A::Struct_Super)) { char n[64]; name_of(c, n, sizeof(n)); if (!strcmp(n, "ParticleSystemComponent")) v = 1; else if (!strcmp(n, "NiagaraComponent")) v = 2; }
        g_dpClsC[k] = cls; g_dpClsV[k] = (uint8_t)v; return v; } }
    return 0;
}
static void dp_scan(const char* where, int kick) {
    if (!g_objArr || !g_dpHaveLoc) return;
    int32_t n = vfx_num(); uintptr_t chunk = 0; int found = 0, total = 0;
    for (int32_t i = 0; i < n; i++) {
        if ((i & 0xFFFF) == 0) chunk = vfx_chunk(i);
        uintptr_t o = 0; uint32_t f = 0;
        if (!chunk || !vfx_slot(chunk, i, &o, &f) || !o) continue;
        if (f & ((1u << 28) | (1u << 29))) continue;
        uintptr_t cls = 0; if (!sg_read((void*)(o + A::Object_Class), &cls) || !cls) continue;
        int kind = dp_is_fx((void*)cls); if (!kind) continue;
        char on[80]; name_of((void*)o, on, sizeof(on)); if (!strncmp(on, "Default__", 9)) continue;
        total++;
        uint8_t r[16]; float loc[3];
        if (!dp_ret((void*)o, L"K2_GetComponentLocation", r)) continue;
        memcpy(loc, r, 12);
        float dx = loc[0] - g_dpLoc[0], dy = loc[1] - g_dpLoc[1], dz = loc[2] - g_dpLoc[2]; float dist = __builtin_sqrtf(dx * dx + dy * dy + dz * dz);
        if (dist > 3000.0f) continue;
        if (found++ >= 16) continue;
        char tn[96] = "?", un[80] = "?", own[80] = "none", par[80] = "none";
        void* tp = hr_prop((void*)cls, kind == 1 ? L"Template" : L"Asset"); if (tp) { void* t = at<void*>(o + at<int32_t>((uintptr_t)tp + HR::Prop_Offset)); if (t) name_of(t, tn, sizeof(tn)); else snprintf(tn, sizeof(tn), "none"); }
        name_of(at<void*>(o + A::Object_Outer), un, sizeof(un));
        if (dp_ret((void*)o, L"GetOwner", r) && *(void**)r) name_of(at<void*>((uintptr_t)*(void**)r + A::Object_Class), own, sizeof(own));
        if (dp_ret((void*)o, L"GetAttachParent", r) && *(void**)r) name_of(*(void**)r, par, sizeof(par));
        int active = -1, tick = -1, vis = -1;
        if (dp_ret((void*)o, L"IsActive", r)) active = r[0] != 0;
        if (dp_ret((void*)o, L"IsComponentTickEnabled", r)) tick = r[0] != 0;
        if (dp_ret((void*)o, L"IsVisible", r)) vis = r[0] != 0;
        char line[600]; snprintf(line, sizeof(line), "dome probe %s: effect near the dance (%.0f cm): %s %s, effect %s, belongs to %s, owner %s, attached to %s, active=%d ticking=%d visible=%d",
                                 where, dist, kind == 1 ? "particle" : "niagara", on, tn, un, own, par, active, tick, vis);
        dp_long(line);
        if (kick && vis == 1 && tick == 0 && dp_set_bool((void*)o, L"SetComponentTickEnabled", 1)) { snprintf(line, sizeof(line), "dome probe kick: %s %s ticking turned on", on, tn); dp_long(line); }
    }
    char line[200]; snprintf(line, sizeof(line), "dome probe %s: %d particle/niagara part(s) in the world, %d within 30 m of the dance", where, total, found);
    dxgi_note(line);
}

static void dp_start(void* actor, const char* cls) {
    static int want = -1; if (want < 0) { char v[8]; want = GetEnvironmentVariableA("D1147_DOMEPROBE", v, sizeof(v)) && v[0] == '1'; }   // ship build: off unless D1147_DOMEPROBE=1
    if (!want || g_dpActor || g_dpRuns >= 3 || !g_origProcessEvent) return;
    if (g_dpKick < 0) { char v[8]; g_dpKick = GetEnvironmentVariableA("D1147_DOMEKICK", v, sizeof(v)) && v[0] == '1'; }
    g_dpRuns++; g_dpCallN = 0; g_dpStep = 0; g_dpGone = 0; g_dpBorn = GetTickCount64(); g_dpCls = at<void*>((uintptr_t)actor + A::Object_Class);
    { uint8_t r[16]; g_dpHaveLoc = dp_ret(actor, L"K2_GetActorLocation", r); memcpy(g_dpLoc, r, 12); }
    snprintf(g_dpName, sizeof(g_dpName), "%s", cls);
    char line[200]; snprintf(line, sizeof(line), "dome probe: watching %s (run %d of 3, kick %s)", cls, g_dpRuns, g_dpKick ? "ON (D1147_DOMEKICK=1)" : "off");
    dxgi_note(line);
    dp_layout(g_dpCls);
    g_dpActor = actor;
}
static void dp_tick(void) {
    void* a = g_dpActor; if (!a) return;
    ULONGLONG t = GetTickCount64() - g_dpBorn;
    if (!g_dpGone && !dp_alive(a)) {
        g_dpGone = 1;
        char line[3000]; int k = snprintf(line, sizeof(line), "dome probe: the actor is gone at %llu ms; functions run on it:", (unsigned long long)t);
        for (int i = 0; i < g_dpCallN && k < (int)sizeof(line) - 140; i++) k += snprintf(line + k, sizeof(line) - k, " %s on %s x%ld (%llu-%llu ms);", g_dpCalls[i].name, g_dpCalls[i].on, g_dpCalls[i].n, (unsigned long long)g_dpCalls[i].first, (unsigned long long)g_dpCalls[i].last);
        dp_long(line); return;
    }
    if (g_dpStep >= (int)(sizeof(g_dpAt) / sizeof(g_dpAt[0])) || t < (ULONGLONG)g_dpAt[g_dpStep]) return;
    int at_ = g_dpAt[g_dpStep++];
    char where[32]; snprintf(where, sizeof(where), "%d ms", at_);
    if (!g_dpGone) dp_state(where, g_dpKick && at_ == 300);
    dp_scan(where, g_dpKick && at_ >= 400);
    if (g_dpStep >= (int)(sizeof(g_dpAt) / sizeof(g_dpAt[0]))) { dxgi_note("dome probe: done"); g_dpActor = 0; }
}

// ---------------------------------------------------------------------------- client: the loot screen that sticks (Nov 12)
// [Dauntless Forever] DF-LOOTWEDGE-1147 (reports 715, 699, 745). After a kill on an island the drops popup
// (UMatchLootPanelWidget, match_loot_panel_bpw_C) shows for its CloseLootPanelTime, 6.5 s. Pressing its key in that time
// runs UMatchLootPanelWidget::DisplaySummaryScreen (exe+0x1F12900, reached only through its script thunk exe+0x24410D0),
// which loads and opens the full loot screen (UMatchLootSummaryScreen, match_loot_summary_screen_bpw_C). In this build
// that screen comes up with nothing that can take focus ("UI Screen does not have a valid default focusable widget"), its
// tick then asks for the focus repair on every frame (the call at exe+0x1E506A0 into exe+0x1E3A6F0) and no key reaches a
// close button: the game has to be closed. All three reports are that one sequence.
//  1. (off by default since the release build) With D1147_LOOTSUMMARY=0 the full loot screen is not opened:
//     DisplaySummaryScreen returns at once and the popup closes by itself. Tested Nov 12: on a PC where the screen does
//     not stick it opens and closes normally, and players use it to read their loot, so it stays open by default and
//     part 2 guards the case where it sticks.
//  2. Safety net: a screen whose tick has asked for the focus repair on every frame for 2 s is stuck. If it is the loot
//     screen it is closed with the game's own close call (vtable +0x500, the call CloseAllUIScreens exe+0x1E36050 makes
//     for every screen); if it is still stuck 2 s later its ScreenHideEnd is run. Any other screen is only written to
//     the log (at most 6 lines) so the next report names it. D1147_LOOTNET=0 turns the net off.
// Player's game only (installed from client_init). Log lines start "loot screen:" in d1147_dxgi.log.
namespace LS {
    const uintptr_t DisplaySummaryScreen = 0x1F12900;   // UMatchLootPanelWidget::DisplaySummaryScreen(this)
    const uintptr_t FocusToDefault       = 0x1E3A6F0;   // the widget's "put focus on my default widget"; logs the "no valid default focusable widget" line
    const uintptr_t FocusRepairCall      = 0x1E506A0;   // the screen tick's call into it when it has lost focus (5 bytes)
    const uintptr_t Screen_Close         = 0x500;       // UArchonScreen vtable: close this screen
}
static void (*g_origLootSummary)(void*) = nullptr;
static uintptr_t (*g_origFocusToDefault)(void*, void*, void*, void*) = nullptr;
static int g_lsAllow = 1, g_lsNet = 1;
static volatile LONG g_lsRefused = 0, g_lsNotes = 0;
static void loot_summary_hook(void* panel) {
    if (g_lsAllow) { static volatile LONG opened = 0; LONG k = InterlockedIncrement(&opened); if (k <= 5) { char m[120]; snprintf(m, sizeof(m), "loot screen: the full loot screen was asked for and opened, %ld so far", (long)k); dxgi_note(m); } g_origLootSummary(panel); return; }
    LONG n = InterlockedIncrement(&g_lsRefused);
    if (n <= 5) { char m[200]; snprintf(m, sizeof(m), "loot screen: the full loot screen was asked for and not opened (D1147_LOOTSUMMARY=0), %ld so far", (long)n); dxgi_note(m); }
}
struct LsStuck { void* obj; void* cls; ULONGLONG first, last, acted; int n; int stage; char name[64]; };
static LsStuck g_ls;   // stage: 0 counting, 1 close call made, 2 ScreenHideEnd run, 9 nothing more to do for this one
static void ls_seen(void* w, ULONGLONG now) {
    if (g_ls.obj != w || now - g_ls.last > 400) { g_ls.obj = w; g_ls.cls = 0; g_ls.first = g_ls.last = now; g_ls.acted = 0; g_ls.n = 1; g_ls.stage = 0; g_ls.name[0] = 0; return; }
    g_ls.last = now; g_ls.n++;
    if (g_ls.stage == 0) {
        if (now - g_ls.first < 2000 || g_ls.n < 30) return;
        void* cls = at<void*>((uintptr_t)w + A::Object_Class);   // w is the screen whose own tick is running: alive
        if (!cls) { g_ls.stage = 9; return; }
        g_ls.cls = cls; name_of(cls, g_ls.name, sizeof(g_ls.name));
        char m[200];
        if (!g_lsNet || !strstr(g_ls.name, "match_loot_summary_screen")) {
            g_ls.stage = 9;
            if (InterlockedIncrement(&g_lsNotes) <= 6) { snprintf(m, sizeof(m), "loot screen: %s has asked for focus on every frame for 2 s (%d times); left as it is%s", g_ls.name, g_ls.n, g_lsNet ? " (only the loot screen is closed)" : " (net off)"); dxgi_note(m); }
            return;
        }
        uintptr_t vt = at<uintptr_t>((uintptr_t)w), fn = 0;
        bool ok = vt >= g_rdataLo && vt < g_rdataHi;
        if (ok) { fn = at<uintptr_t>(vt + LS::Screen_Close); ok = fn >= g_textLo && fn < g_textHi; }
        g_ls.stage = 1; g_ls.acted = now;
        snprintf(m, sizeof(m), "loot screen: %s is stuck without focus (asked %d times in 2 s); %s", g_ls.name, g_ls.n, ok ? "closing it with the game's own close call" : "its close call is not where expected, waiting for the second step");
        dxgi_note(m);
        if (ok) ((void (*)(void*))fn)(w);
        return;
    }
    if (g_ls.stage == 1 && now - g_ls.acted >= 2000) {
        g_ls.stage = 2; g_ls.acted = now;
        void* fn = find_function(g_ls.cls, L"ScreenHideEnd");
        dxgi_note(fn ? "loot screen: still stuck 2 s after the close call; running its ScreenHideEnd" : "loot screen: still stuck 2 s after the close call and ScreenHideEnd was not found");
        if (fn) { alignas(16) uint8_t none[16] = { 0 }; ((void (*)(void*, void*, void*))(g_base + A::ProcessEvent))(w, fn, none); }
        return;
    }
    if (g_ls.stage == 2 && now - g_ls.acted >= 3000) { g_ls.stage = 9; dxgi_note("loot screen: still stuck after both steps; the game has to be closed (please send this log)"); }
}
__attribute__((noinline)) static uintptr_t focus_to_default_hook(void* w, void* a2, void* a3, void* a4) {
    const uintptr_t from = (uintptr_t)__builtin_return_address(0);
    const uintptr_t r = g_origFocusToDefault(w, a2, a3, a4);
    const ULONGLONG now = GetTickCount64();
    if ((g_ls.stage == 1 || g_ls.stage == 2) && now - g_ls.last > 1000) {    // the every-frame asking stopped: it closed
        char m[160]; snprintf(m, sizeof(m), "loot screen: %s closed (%s), focus is back", g_ls.name, g_ls.stage == 1 ? "close call" : "ScreenHideEnd"); dxgi_note(m);
        g_ls.stage = 9;
    }
    if (w && from == g_base + LS::FocusRepairCall + 5) ls_seen(w, now);
    return r;
}
static void loot_screen_init(uintptr_t b) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_LOOTSUMMARY", v, sizeof(v)) && v[0] == '0') g_lsAllow = 0;
    if (GetEnvironmentVariableA("D1147_LOOTNET", v, sizeof(v)) && v[0] == '0') g_lsNet = 0;
    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) { dxgi_note("loot screen: hooks not available, nothing changed"); return; }
    static const uint8_t e1[18] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x57, 0x48, 0x81, 0xEC, 0xA0, 0x01, 0x00, 0x00 };
    if (memcmp((void*)(b + LS::DisplaySummaryScreen), e1, sizeof(e1)) != 0) dxgi_note("loot screen: game code differs at the loot screen call, left as it is");
    else {
        s = MH_CreateHook((void*)(b + LS::DisplaySummaryScreen), (void*)loot_summary_hook, (void**)&g_origLootSummary);
        if (s == MH_OK) s = MH_EnableHook((void*)(b + LS::DisplaySummaryScreen));
        dxgi_note(s != MH_OK ? "loot screen: hook FAILED, the full loot screen opens as before" :
                  g_lsAllow ? "loot screen: the full loot screen opens as normal (D1147_LOOTSUMMARY=0 blocks it)" :
                              "loot screen: the full loot screen is not opened (D1147_LOOTSUMMARY=0); the drops popup closes by itself");
    }
    if (!g_lsNet) { dxgi_note("loot screen: safety net off (D1147_LOOTNET=0)"); return; }
    static const uint8_t e2[18] = { 0x4C, 0x8B, 0xDC, 0x55, 0x53, 0x56, 0x48, 0x8B, 0xEC, 0x48, 0x83, 0xEC, 0x60, 0x33, 0xF6, 0x48, 0x8B, 0xD9 };
    static const uint8_t e3[5] = { 0xE8, 0x4B, 0xA0, 0xFE, 0xFF };
    if (memcmp((void*)(b + LS::FocusToDefault), e2, sizeof(e2)) != 0 || memcmp((void*)(b + LS::FocusRepairCall), e3, sizeof(e3)) != 0) { dxgi_note("loot screen: game code differs at the focus repair, safety net off"); return; }
    s = MH_CreateHook((void*)(b + LS::FocusToDefault), (void*)focus_to_default_hook, (void**)&g_origFocusToDefault);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + LS::FocusToDefault));
    dxgi_note(s == MH_OK ? "loot screen: safety net on (a loot screen stuck without focus for 2 s is closed)" : "loot screen: safety net hook FAILED, off");
}

// ---------------------------------------------------------------------------- client: loadout slot renaming (DF-LOADOUT-NAMES-1147)
// Custom in-game naming for the 30+ loadout slots in Dauntless 1.14.7.
// Allows renaming loadouts in-game by double-clicking the slot title/card.
// Updates ULoadoutSlotViewModel +0x110 (DefaultName) and +0x128 (DisplayLabel),
// and triggers an immediate Slate repaint via ULoadoutSlotCarousel::UpdateView (exe+0x209ba70)
// dispatched safely on the game thread via WM_USER + 1337.
namespace LN {
    const uintptr_t UpdateSlotViewModel = 0x20968c0;
    const uintptr_t UpdateView          = 0x209ba70;
    const uintptr_t GearScreenClose     = 0x207c0b0;
    const uintptr_t CarouselDestructor  = 0x241d090;
    const uintptr_t FromString          = 0x258f300;
    const uintptr_t TextAssign          = 0x0a183e0;
    const uintptr_t Broadcast           = 0x0a02d30;
    const uintptr_t SlotCheck           = 0x2072bc0;
    const uintptr_t CarouselUpdate      = 0x241d450;
}

static HINSTANCE g_loadoutInst = NULL;
static HWND g_hLoadoutGameWnd = NULL;
static WNDPROC g_origGameWndProc = NULL;
static void* g_pLoadoutViewModel = NULL;
static void* g_pLoadoutCarousel = NULL;
static DWORD g_lastLoadoutLClickTime = 0;
static DWORD g_lastLoadoutTriggerTime = 0;
static bool g_wasLoadoutLButtonDown = false;

// In-game inline loadout renaming state
static bool g_isRenamingInline = false;
static int32_t g_inlineSlot = -1;
static wchar_t g_inlineBuffer[64] = { 0 };
static wchar_t g_inlineOriginal[64] = { 0 };
static DWORD g_inlineCursorTick = 0;
static DWORD g_inlineStartTick = 0;
static bool g_inlineCursorVisible = true;

// In-game inline loadout search state
static bool g_isSearchingLoadout = false;
static wchar_t g_searchBuffer[64] = { 0 };
static int32_t g_searchOriginalSlot = -1;
static int32_t g_searchMatchIndices[64] = { 0 };
static int32_t g_searchMatchCount = 0;
static DWORD g_searchCursorTick = 0;
static DWORD g_searchStartTick = 0;
static bool g_searchCursorVisible = true;

typedef void (*UpdateSlotViewModel_t)(void* viewModel, void* slotData, int32_t slotIndex);
static UpdateSlotViewModel_t g_origUpdateSlotViewModel = NULL;

typedef void (*UpdateView_t)(void* carousel);
static UpdateView_t g_origUpdateView = NULL;

typedef void (*GearScreenClose_t)(void* screen);
static GearScreenClose_t g_origGearScreenClose = NULL;

typedef void (*CarouselDestructor_t)(void* carousel, uint8_t flags);
static CarouselDestructor_t g_origCarouselDestructor = NULL;

static bool IsCarouselValidAndActive(void* carousel) {
    if (!carousel || (uintptr_t)carousel < 0x10000) return false;
    if (!readable((uintptr_t)carousel, 0x420)) return false;

    // 1. Verify exact VTable of ULoadoutSlotCarousel (g_base + 0x58461f8)
    if (*(uintptr_t*)carousel != (g_base + 0x58461f8)) return false;

    // 2. Verify bCanScroll at +0x410 == 1
    uint8_t canScroll = *(uint8_t*)((uintptr_t)carousel + 0x410);
    if (canScroll != 1) return false;

    // 3. Verify Slots array
    TArrayRaw* slots = (TArrayRaw*)((uintptr_t)carousel + 0x3f0);
    if (!slots->Data || slots->Num <= 0 || slots->Num > 64) return false;

    // 4. Verify activeSlot index within array bounds
    int32_t activeSlot = *(int32_t*)((uintptr_t)carousel + 0x400);
    if (activeSlot < 0 || activeSlot >= slots->Num) return false;

    return true;
}

static void CancelInlineRename();
static void CancelLoadoutSearch();

static void hook_GearScreenClose(void* screen) {
    if (g_isRenamingInline) CancelInlineRename();
    if (g_isSearchingLoadout) CancelLoadoutSearch();
    g_pLoadoutCarousel = NULL;
    g_pLoadoutViewModel = NULL;
    if (g_origGearScreenClose) g_origGearScreenClose(screen);
}

static void hook_CarouselDestructor(void* carousel, uint8_t flags) {
    if (carousel == g_pLoadoutCarousel) {
        if (g_isRenamingInline) CancelInlineRename();
        if (g_isSearchingLoadout) CancelLoadoutSearch();
        g_pLoadoutCarousel = NULL;
        g_pLoadoutViewModel = NULL;
    }
    if (g_origCarouselDestructor) g_origCarouselDestructor(carousel, flags);
}

static void loadout_log(const char* fmt, ...) {
    char buf[512];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    OutputDebugStringA(buf);

    wchar_t path[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (n && n < MAX_PATH) {
        wcscat(path, L"\\DauntlessForever\\loadout_editor.log");
        FILE* fp = _wfopen(path, L"a");
        if (fp) {
            fprintf(fp, "%s\n", buf);
            fclose(fp);
        }
    }
}

static HWND GetLoadoutGameWindow() {
    if (g_hLoadoutGameWnd && IsWindow(g_hLoadoutGameWnd)) return g_hLoadoutGameWnd;
    HWND hFg = GetForegroundWindow();
    if (hFg) {
        DWORD pid = 0;
        GetWindowThreadProcessId(hFg, &pid);
        if (pid == GetCurrentProcessId()) {
            g_hLoadoutGameWnd = hFg;
            return hFg;
        }
    }
    HWND hWnd = FindWindowW(L"UnrealWindow", NULL);
    if (hWnd) {
        g_hLoadoutGameWnd = hWnd;
        return hWnd;
    }
    return NULL;
}

static bool GetCustomLoadoutName(int32_t slotIndex, wchar_t* outBuf, size_t outSize) {
    wchar_t path[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (!n || n >= MAX_PATH) return false;
    wcscat(path, L"\\DauntlessForever\\custom_loadouts.txt");

    FILE* fp = _wfopen(path, L"r");
    if (!fp) return false;
    char line[512];
    bool found = false;
    while (fgets(line, sizeof(line), fp)) {
        int idx = -1;
        char name[256] = { 0 };
        if (sscanf(line, "%d=%[^\r\n]", &idx, name) == 2) {
            if (idx == slotIndex) {
                MultiByteToWideChar(CP_UTF8, 0, name, -1, outBuf, (int)outSize);
                found = true;
                break;
            }
        }
    }
    fclose(fp);
    return found;
}

static void SaveCustomLoadoutName(int32_t slotIndex, const wchar_t* newName) {
    wchar_t path[MAX_PATH];
    DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", path, MAX_PATH);
    if (!n || n >= MAX_PATH) return;
    wcscat(path, L"\\DauntlessForever");
    CreateDirectoryW(path, NULL);
    wcscat(path, L"\\custom_loadouts.txt");

    wchar_t names[64][256];
    for (int i = 0; i < 64; ++i) names[i][0] = 0;

    FILE* fp = _wfopen(path, L"r");
    if (fp) {
        char line[512];
        while (fgets(line, sizeof(line), fp)) {
            int idx = -1;
            char val[256] = { 0 };
            if (sscanf(line, "%d=%[^\r\n]", &idx, val) == 2) {
                if (idx >= 0 && idx < 64) {
                    MultiByteToWideChar(CP_UTF8, 0, val, -1, names[idx], 256);
                }
            }
        }
        fclose(fp);
    }

    if (slotIndex >= 0 && slotIndex < 64) {
        if (newName && newName[0] != 0) {
            wcsncpy(names[slotIndex], newName, 255);
            names[slotIndex][255] = 0;
        } else {
            names[slotIndex][0] = 0;
        }
    }

    fp = _wfopen(path, L"w");
    if (fp) {
        for (int i = 0; i < 64; ++i) {
            if (names[i][0] != 0) {
                char utf8[512] = { 0 };
                WideCharToMultiByte(CP_UTF8, 0, names[i], -1, utf8, sizeof(utf8), NULL, NULL);
                fprintf(fp, "%d=%s\n", i, utf8);
            }
        }
        fclose(fp);
    }
    loadout_log("Saved custom name for slot %d: '%ls'", slotIndex, newName ? newName : L"<default>");
}

static void DestroyLoadoutFText(void* pText) {
    void* rbx = *(void**)((uintptr_t)pText + 8);
    if (rbx) {
        if (InterlockedDecrement((volatile LONG*)((uintptr_t)rbx + 8)) == 0) {
            void (**vtable)(void*) = *(void (***)(void*))rbx;
            vtable[0](rbx);
            if (InterlockedDecrement((volatile LONG*)((uintptr_t)rbx + 12)) == 0) {
                void (**vtable2)(void*, int) = *(void (***)(void*, int))rbx;
                vtable2[1](rbx, 1);
            }
        }
    }
}

static void SetSlotVMText(int32_t slotIndex, const wchar_t* customName) {
    void* slotVM = NULL;
    if (g_pLoadoutCarousel && readable((uintptr_t)g_pLoadoutCarousel, 0x410)) {
        TArrayRaw* slots = (TArrayRaw*)((uintptr_t)g_pLoadoutCarousel + 0x3f0);
        if (slots && slots->Data && slotIndex >= 0 && slotIndex < slots->Num) {
            if (readable((uintptr_t)slots->Data, (slotIndex + 1) * sizeof(void*))) {
                slotVM = slots->Data[slotIndex];
            }
        }
    }
    if (!slotVM && g_pLoadoutViewModel && readable((uintptr_t)g_pLoadoutViewModel, 0x130)) {
        TArrayRaw* slots = (TArrayRaw*)((uintptr_t)g_pLoadoutViewModel + 0x118);
        if (slots && slots->Data && slotIndex >= 0 && slotIndex < slots->Num) {
            if (readable((uintptr_t)slots->Data, (slotIndex + 1) * sizeof(void*))) {
                slotVM = slots->Data[slotIndex];
            }
        }
    }
    if (!slotVM || !readable((uintptr_t)slotVM, 0x150)) {
        loadout_log("SetSlotVMText: slotVM for slot %d not found or unreadable", slotIndex);
        return;
    }

    wchar_t displayName[256] = { 0 };
    if (customName && customName[0] != 0) {
        wcsncpy(displayName, customName, 255);
    } else {
        swprintf(displayName, 256, L"Slot %d", slotIndex + 1);
    }

    int32_t len = (int32_t)wcslen(displayName);
    FString str = { displayName, len + 1, len + 1 };

    uint8_t tempText[0x20] = { 0 };
    typedef void* (*FromString_t)(void* outText, const FString* str);
    ((FromString_t)(g_base + LN::FromString))(tempText, &str);

    void* defaultName = (void*)((uintptr_t)slotVM + 0x110);
    void* displayLabel = (void*)((uintptr_t)slotVM + 0x128);
    typedef void* (*TextAssign_t)(void* dest, const void* src);
    ((TextAssign_t)(g_base + LN::TextAssign))(defaultName, tempText);
    ((TextAssign_t)(g_base + LN::TextAssign))(displayLabel, tempText);

    DestroyLoadoutFText(tempText);
    loadout_log("SetSlotVMText: slot %d text directly updated to '%ls'", slotIndex, displayName);
}

static void ApplyAllCustomLoadoutNames(void* carousel) {
    if (!carousel || !readable((uintptr_t)carousel, 0x410)) return;
    TArrayRaw* slots = (TArrayRaw*)((uintptr_t)carousel + 0x3f0);
    if (!slots || !slots->Data || slots->Num <= 0 || slots->Num > 64) return;
    if (!readable((uintptr_t)slots->Data, slots->Num * sizeof(void*))) return;

    int32_t activeSlot = *(int32_t*)((uintptr_t)carousel + 0x400);

    for (int32_t i = 0; i < slots->Num; ++i) {
        if (g_isRenamingInline && i == g_inlineSlot) continue;
        if (g_isSearchingLoadout && i == activeSlot) continue;
        void* slotVM = slots->Data[i];
        if (!slotVM || !readable((uintptr_t)slotVM, 0x150)) continue;

        wchar_t customName[256] = { 0 };
        if (GetCustomLoadoutName(i, customName, 256) && customName[0] != 0) {
            int32_t len = (int32_t)wcslen(customName);
            FString str = { customName, len + 1, len + 1 };
            uint8_t tempText[0x20] = { 0 };
            typedef void* (*FromString_t)(void* outText, const FString* str);
            ((FromString_t)(g_base + LN::FromString))(tempText, &str);

            void* defaultName = (void*)((uintptr_t)slotVM + 0x110);
            void* displayLabel = (void*)((uintptr_t)slotVM + 0x128);
            typedef void* (*TextAssign_t)(void* dest, const void* src);
            ((TextAssign_t)(g_base + LN::TextAssign))(defaultName, tempText);
            ((TextAssign_t)(g_base + LN::TextAssign))(displayLabel, tempText);

            DestroyLoadoutFText(tempText);
        }
    }
}

static void hook_UpdateSlotViewModel(void* viewModel, void* slotData, int32_t slotIndex) {
    g_pLoadoutViewModel = viewModel;
    g_origUpdateSlotViewModel(viewModel, slotData, slotIndex);

    if (g_isRenamingInline && slotIndex == g_inlineSlot) return;
    if (g_isSearchingLoadout && g_pLoadoutCarousel && readable((uintptr_t)g_pLoadoutCarousel, 0x404)) {
        int32_t activeSlot = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);
        if (slotIndex == activeSlot) return;
    }

    wchar_t customName[256] = { 0 };
    if (!GetCustomLoadoutName(slotIndex, customName, 256) || customName[0] == 0) {
        return;
    }

    if (!viewModel || !readable((uintptr_t)viewModel, 0x130)) return;
    TArrayRaw* slots = (TArrayRaw*)((uintptr_t)viewModel + 0x118);
    if (!slots || !slots->Data || slotIndex < 0 || slotIndex >= slots->Num) {
        return;
    }
    if (!readable((uintptr_t)slots->Data, (slotIndex + 1) * sizeof(void*))) return;

    void* slotVM = slots->Data[slotIndex];
    if (!slotVM || !readable((uintptr_t)slotVM, 0x150)) return;

    int32_t len = (int32_t)wcslen(customName);
    FString str = { customName, len + 1, len + 1 };

    uint8_t tempText[0x20] = { 0 };
    typedef void* (*FromString_t)(void* outText, const FString* str);
    ((FromString_t)(g_base + LN::FromString))(tempText, &str);

    void* defaultName = (void*)((uintptr_t)slotVM + 0x110);
    void* displayLabel = (void*)((uintptr_t)slotVM + 0x128);
    typedef void* (*TextAssign_t)(void* dest, const void* src);
    ((TextAssign_t)(g_base + LN::TextAssign))(defaultName, tempText);
    ((TextAssign_t)(g_base + LN::TextAssign))(displayLabel, tempText);

    DestroyLoadoutFText(tempText);
}

static void hook_UpdateView(void* carousel) {
    g_pLoadoutCarousel = carousel;
    ApplyAllCustomLoadoutNames(carousel);
    g_origUpdateView(carousel);
}

// ---------------------------------------------------------------- in-game inline loadout renaming
static void UpdateInlineDisplayText() {
    if (!g_isRenamingInline || g_inlineSlot < 0) return;
    if (!g_pLoadoutCarousel) return;

    wchar_t displayText[80] = { 0 };
    if (g_inlineCursorVisible) {
        swprintf(displayText, 80, L"%ls|", g_inlineBuffer);
    } else {
        swprintf(displayText, 80, L"%ls ", g_inlineBuffer);
    }

    SetSlotVMText(g_inlineSlot, displayText);
    if (g_origUpdateView) {
        g_origUpdateView(g_pLoadoutCarousel);
    }
}

static void StartInlineRename(int32_t slotIndex) {
    if (slotIndex < 0) return;
    if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) return;

    g_inlineSlot = slotIndex;
    g_inlineBuffer[0] = 0;
    if (!GetCustomLoadoutName(slotIndex, g_inlineBuffer, 64) || g_inlineBuffer[0] == 0) {
        swprintf(g_inlineBuffer, 64, L"Slot %d", slotIndex + 1);
    }

    wcsncpy(g_inlineOriginal, g_inlineBuffer, 63);
    g_inlineOriginal[63] = 0;

    g_isRenamingInline = true;
    g_inlineCursorVisible = true;
    g_inlineCursorTick = GetTickCount();
    g_inlineStartTick = GetTickCount();

    loadout_log("StartInlineRename: slot %d, initial '%ls'", slotIndex, g_inlineBuffer);
    UpdateInlineDisplayText();
}

static void CommitInlineRename() {
    if (!g_isRenamingInline) return;

    int32_t slot = g_inlineSlot;
    wchar_t finalName[64];
    wcsncpy(finalName, g_inlineBuffer, 63);
    finalName[63] = 0;

    // Trim trailing whitespace
    size_t len = wcslen(finalName);
    while (len > 0 && finalName[len - 1] == L' ') {
        finalName[--len] = 0;
    }

    // If final name equals default "Slot %d", treat as empty so file stays clean
    wchar_t defaultName[32];
    swprintf(defaultName, 32, L"Slot %d", slot + 1);
    if (_wcsicmp(finalName, defaultName) == 0) {
        finalName[0] = 0;
    }

    g_isRenamingInline = false;
    g_inlineSlot = -1;

    // Save to disk (if empty, deletes custom entry)
    SaveCustomLoadoutName(slot, finalName);

    // Refresh slot text cleanly without cursor
    wchar_t resolvedName[64] = { 0 };
    if (!GetCustomLoadoutName(slot, resolvedName, 64) || resolvedName[0] == 0) {
        swprintf(resolvedName, 64, L"Slot %d", slot + 1);
    }
    SetSlotVMText(slot, resolvedName);
    if (g_pLoadoutCarousel && g_origUpdateView) {
        g_origUpdateView(g_pLoadoutCarousel);
    }
    loadout_log("CommitInlineRename: slot %d saved as '%ls'", slot, resolvedName);
}

static void CancelInlineRename() {
    if (!g_isRenamingInline) return;

    int32_t slot = g_inlineSlot;
    wchar_t origName[64];
    wcsncpy(origName, g_inlineOriginal, 63);
    origName[63] = 0;
    if (origName[0] == 0) {
        swprintf(origName, 64, L"Slot %d", slot + 1);
    }

    g_isRenamingInline = false;
    g_inlineSlot = -1;

    // Restore original text without cursor
    SetSlotVMText(slot, origName);
    if (g_pLoadoutCarousel && g_origUpdateView) {
        g_origUpdateView(g_pLoadoutCarousel);
    }
    loadout_log("CancelInlineRename: slot %d restored to '%ls'", slot, origName);
}

// ---------------------------------------------------------------- in-game inline loadout search
static bool CaseInsensitiveSubstr(const wchar_t* haystack, const wchar_t* needle) {
    if (!haystack || !needle) return false;
    if (!needle[0]) return true;
    wchar_t hUpper[256];
    wchar_t nUpper[256];
    wcsncpy(hUpper, haystack, 255); hUpper[255] = 0;
    wcsncpy(nUpper, needle, 255); nUpper[255] = 0;
    _wcsupr(hUpper);
    _wcsupr(nUpper);
    return wcsstr(hUpper, nUpper) != NULL;
}

static void UpdateSearchDisplayText() {
    if (!g_isSearchingLoadout) return;
    if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) return;

    int32_t activeSlot = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);

    wchar_t displayText[128] = { 0 };
    wchar_t cursorChar = g_searchCursorVisible ? L'|' : L' ';

    if (g_searchBuffer[0] == 0) {
        swprintf(displayText, 128, L"Search: %lc", cursorChar);
    } else if (g_searchMatchCount > 0) {
        swprintf(displayText, 128, L"Search: %ls%lc", g_searchBuffer, cursorChar);
    } else {
        swprintf(displayText, 128, L"Search: %ls%lc (No matches)", g_searchBuffer, cursorChar);
    }

    ApplyAllCustomLoadoutNames(g_pLoadoutCarousel);
    SetSlotVMText(activeSlot, displayText);
    if (g_origUpdateView) {
        g_origUpdateView(g_pLoadoutCarousel);
    }
}

static void ActivateLoadoutSlot(void* carousel, int32_t targetSlot) {
    if (!carousel || (uintptr_t)carousel < 0x10000) return;
    if (!readable((uintptr_t)carousel, 0x420)) return;

    TArrayRaw* slots = (TArrayRaw*)((uintptr_t)carousel + 0x3f0);
    if (!slots || !slots->Data || targetSlot < 0 || targetSlot >= slots->Num) return;

    // Set active slot in carousel
    *(int32_t*)((uintptr_t)carousel + 0x400) = targetSlot;

    // Notify GearScreen to switch and equip the new active loadout
    struct {
        int32_t slot;
        uint8_t flag;
        uint8_t pad[3];
    } params = { targetSlot, 0, { 0, 0, 0 } };

    typedef void (*ProcessMulticastDelegate_t)(void* delegate, void* params);
    ((ProcessMulticastDelegate_t)(g_base + LN::Broadcast))((void*)((uintptr_t)carousel + 0x360), &params);

    // Update slot VM state and carousel equip status
    void* slotVM = slots->Data[targetSlot];
    if (slotVM && readable((uintptr_t)slotVM, 0x150)) {
        typedef uint8_t (*SlotCheck_t)(void* slotVM);
        uint8_t canEquip = ((SlotCheck_t)(g_base + LN::SlotCheck))(slotVM);

        typedef void (*CarouselUpdate_t)(void* carousel, uint32_t canEquip);
        ((CarouselUpdate_t)(g_base + LN::CarouselUpdate))(carousel, canEquip);
    }
}

static void SelectSearchMatch(int32_t targetSlot) {
    if (targetSlot < 0) {
        UpdateSearchDisplayText();
        return;
    }
    if (IsCarouselValidAndActive(g_pLoadoutCarousel)) {
        int32_t oldActive = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);
        if (oldActive != targetSlot) {
            wchar_t cleanOldName[64] = { 0 };
            if (!GetCustomLoadoutName(oldActive, cleanOldName, 64) || cleanOldName[0] == 0) {
                swprintf(cleanOldName, 64, L"Slot %d", oldActive + 1);
            }
            SetSlotVMText(oldActive, cleanOldName);

            ActivateLoadoutSlot(g_pLoadoutCarousel, targetSlot);
        }
    }
    UpdateSearchDisplayText();
}

static void FindSearchMatches() {
    g_searchMatchCount = 0;

    if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) return;
    TArrayRaw* slots = (TArrayRaw*)((uintptr_t)g_pLoadoutCarousel + 0x3f0);
    if (!slots || slots->Num <= 0) return;

    int totalSlots = slots->Num;
    if (totalSlots > 64) totalSlots = 64;

    for (int32_t i = 0; i < totalSlots; ++i) {
        wchar_t slotName[256] = { 0 };
        if (!GetCustomLoadoutName(i, slotName, 256) || slotName[0] == 0) {
            swprintf(slotName, 256, L"Slot %d", i + 1);
        }

        if (g_searchBuffer[0] == 0 || CaseInsensitiveSubstr(slotName, g_searchBuffer)) {
            g_searchMatchIndices[g_searchMatchCount++] = i;
        }
    }
}

static void StartLoadoutSearch() {
    if (g_isSearchingLoadout) return;
    if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) return;
    if (g_isRenamingInline) CancelInlineRename();

    if (g_hLoadoutGameWnd && g_origGameWndProc) {
        CallWindowProcW(g_origGameWndProc, g_hLoadoutGameWnd, WM_KEYUP, VK_CONTROL, 0xC0000001);
    }

    g_searchOriginalSlot = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);
    g_searchBuffer[0] = 0;
    g_isSearchingLoadout = true;
    g_searchCursorVisible = true;
    g_searchCursorTick = GetTickCount();
    g_searchStartTick = GetTickCount();

    FindSearchMatches();
    SelectSearchMatch(g_searchMatchCount > 0 ? g_searchMatchIndices[0] : -1);
    loadout_log("StartLoadoutSearch: original slot %d, matches=%d", g_searchOriginalSlot, g_searchMatchCount);
}

static void CommitLoadoutSearch() {
    if (!g_isSearchingLoadout) return;

    g_isSearchingLoadout = false;

    if (g_hLoadoutGameWnd && g_origGameWndProc) {
        CallWindowProcW(g_origGameWndProc, g_hLoadoutGameWnd, WM_KEYUP, VK_CONTROL, 0xC0000001);
    }

    if (IsCarouselValidAndActive(g_pLoadoutCarousel)) {
        int32_t activeSlot = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);
        wchar_t cleanName[64] = { 0 };
        if (!GetCustomLoadoutName(activeSlot, cleanName, 64) || cleanName[0] == 0) {
            swprintf(cleanName, 64, L"Slot %d", activeSlot + 1);
        }
        SetSlotVMText(activeSlot, cleanName);

        // Ensure activeSlot is activated and equipped in GearScreen
        ActivateLoadoutSlot(g_pLoadoutCarousel, activeSlot);

        if (g_origUpdateView) {
            g_origUpdateView(g_pLoadoutCarousel);
        }
        loadout_log("CommitLoadoutSearch: slot %d selected ('%ls')", activeSlot, cleanName);
    }
}

static void CancelLoadoutSearch() {
    if (!g_isSearchingLoadout) return;

    g_isSearchingLoadout = false;
    int32_t revertSlot = g_searchOriginalSlot;

    if (g_hLoadoutGameWnd && g_origGameWndProc) {
        CallWindowProcW(g_origGameWndProc, g_hLoadoutGameWnd, WM_KEYUP, VK_CONTROL, 0xC0000001);
    }

    if (IsCarouselValidAndActive(g_pLoadoutCarousel)) {
        if (revertSlot >= 0) {
            ActivateLoadoutSlot(g_pLoadoutCarousel, revertSlot);
        }

        ApplyAllCustomLoadoutNames(g_pLoadoutCarousel);

        wchar_t cleanName[64] = { 0 };
        if (!GetCustomLoadoutName(revertSlot, cleanName, 64) || cleanName[0] == 0) {
            swprintf(cleanName, 64, L"Slot %d", revertSlot + 1);
        }
        SetSlotVMText(revertSlot, cleanName);

        if (g_origUpdateView) {
            g_origUpdateView(g_pLoadoutCarousel);
        }
        loadout_log("CancelLoadoutSearch: reverted to slot %d ('%ls')", revertSlot, cleanName);
    }
}

static LRESULT CALLBACK HookedGameWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (g_isSearchingLoadout) {
        if (msg == WM_KEYDOWN) {
            if (wParam == VK_RETURN) {
                CommitLoadoutSearch();
                return 0;
            }
            if (wParam == VK_ESCAPE) {
                CancelLoadoutSearch();
                return 0;
            }

            if (wParam == VK_BACK) {
                if (GetKeyState(VK_CONTROL) & 0x8000) {
                    g_searchBuffer[0] = 0;
                } else {
                    size_t len = wcslen(g_searchBuffer);
                    if (len > 0) {
                        g_searchBuffer[len - 1] = 0;
                    }
                }
                g_searchCursorVisible = true;
                g_searchCursorTick = GetTickCount();
                FindSearchMatches();
                SelectSearchMatch(g_searchMatchCount > 0 ? g_searchMatchIndices[0] : -1);
                return 0;
            }

            if (wParam == VK_DELETE) {
                g_searchBuffer[0] = 0;
                g_searchCursorVisible = true;
                g_searchCursorTick = GetTickCount();
                FindSearchMatches();
                SelectSearchMatch(g_searchMatchCount > 0 ? g_searchMatchIndices[0] : -1);
                return 0;
            }

            if (wParam == 'V' && (GetKeyState(VK_CONTROL) & 0x8000)) {
                if (OpenClipboard(hWnd)) {
                    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
                    if (hData) {
                        const wchar_t* pText = (const wchar_t*)GlobalLock(hData);
                        if (pText) {
                            while (*pText && wcslen(g_searchBuffer) < 24) {
                                if (*pText >= 32 && *pText != 127) {
                                    size_t l = wcslen(g_searchBuffer);
                                    g_searchBuffer[l] = *pText;
                                    g_searchBuffer[l + 1] = 0;
                                }
                                pText++;
                            }
                            GlobalUnlock(hData);
                            g_searchCursorVisible = true;
                            g_searchCursorTick = GetTickCount();
                            FindSearchMatches();
                            SelectSearchMatch(g_searchMatchCount > 0 ? g_searchMatchIndices[0] : -1);
                        }
                    }
                    CloseClipboard();
                }
                return 0;
            }

            // Consume all other keys while searching so Slayer doesn't move or open menus
            return 0;
        }

        // Pass WM_KEYUP through so Slate/game releases modifier keys (Ctrl, Shift, etc.) properly

        if (msg == WM_CHAR) {
            wchar_t ch = (wchar_t)wParam;
            if (ch >= 32 && ch != 127) {
                size_t len = wcslen(g_searchBuffer);
                if (len < 24) {
                    g_searchBuffer[len] = ch;
                    g_searchBuffer[len + 1] = 0;
                    g_searchCursorVisible = true;
                    g_searchCursorTick = GetTickCount();
                    FindSearchMatches();
                    SelectSearchMatch(g_searchMatchCount > 0 ? g_searchMatchIndices[0] : -1);
                }
                return 0;
            }
            return 0;
        }

        if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN) {
            RECT rc;
            GetClientRect(hWnd, &rc);
            int w = rc.right - rc.left;
            int h = rc.bottom - rc.top;
            int mx = (short)LOWORD(lParam);
            int my = (short)HIWORD(lParam);
            if (w > 0 && h > 0) {
                float rx = (float)mx / (float)w;
                float ry = (float)my / (float)h;
                if (!(rx >= 0.38f && rx <= 0.62f && ry >= 0.68f && ry <= 0.90f)) {
                    CommitLoadoutSearch();
                }
            } else {
                CommitLoadoutSearch();
            }
        }
    }

    if (g_isRenamingInline) {
        if (msg == WM_KEYDOWN) {
            if (wParam == VK_RETURN) {
                CommitInlineRename();
                return 0;
            }
            if (wParam == VK_ESCAPE) {
                CancelInlineRename();
                return 0;
            }
            if (wParam == VK_BACK) {
                if (GetKeyState(VK_CONTROL) & 0x8000) {
                    g_inlineBuffer[0] = 0;
                } else {
                    size_t len = wcslen(g_inlineBuffer);
                    if (len > 0) {
                        g_inlineBuffer[len - 1] = 0;
                    }
                }
                g_inlineCursorVisible = true;
                g_inlineCursorTick = GetTickCount();
                UpdateInlineDisplayText();
                return 0;
            }
            if (wParam == VK_DELETE) {
                g_inlineBuffer[0] = 0;
                g_inlineCursorVisible = true;
                g_inlineCursorTick = GetTickCount();
                UpdateInlineDisplayText();
                return 0;
            }
            if (wParam == 'V' && (GetKeyState(VK_CONTROL) & 0x8000)) {
                if (OpenClipboard(hWnd)) {
                    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
                    if (hData) {
                        const wchar_t* pText = (const wchar_t*)GlobalLock(hData);
                        if (pText) {
                            while (*pText && wcslen(g_inlineBuffer) < 24) {
                                if (*pText >= 32 && *pText != 127) {
                                    size_t l = wcslen(g_inlineBuffer);
                                    g_inlineBuffer[l] = *pText;
                                    g_inlineBuffer[l + 1] = 0;
                                }
                                pText++;
                            }
                            GlobalUnlock(hData);
                            g_inlineCursorVisible = true;
                            g_inlineCursorTick = GetTickCount();
                            UpdateInlineDisplayText();
                        }
                    }
                    CloseClipboard();
                }
                return 0;
            }
            // Consume all other keys while editing so Slayer doesn't move or open menus
            return 0;
        }
        // Pass WM_KEYUP through so Slate/game releases modifier keys properly
        if (msg == WM_CHAR) {
            wchar_t ch = (wchar_t)wParam;
            if (ch >= 32 && ch != 127) { // printable character
                size_t len = wcslen(g_inlineBuffer);
                if (len < 24) { // max 24 characters
                    g_inlineBuffer[len] = ch;
                    g_inlineBuffer[len + 1] = 0;
                    g_inlineCursorVisible = true;
                    g_inlineCursorTick = GetTickCount();
                    UpdateInlineDisplayText();
                }
                return 0;
            }
            if (ch == 8 || ch == 13 || ch == 27 || ch == 127) {
                return 0; // handled in WM_KEYDOWN
            }
            return 0;
        }
        if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN) {
            if (GetTickCount() - g_inlineStartTick > 350) {
                RECT rc;
                GetClientRect(hWnd, &rc);
                int w = rc.right - rc.left;
                int h = rc.bottom - rc.top;
                int mx = (short)LOWORD(lParam);
                int my = (short)HIWORD(lParam);
                if (w > 0 && h > 0) {
                    float rx = (float)mx / (float)w;
                    float ry = (float)my / (float)h;
                    if (!(rx >= 0.38f && rx <= 0.62f && ry >= 0.68f && ry <= 0.90f)) {
                        CommitInlineRename();
                    }
                } else {
                    CommitInlineRename();
                }
            }
        }
    }

    if (!g_isRenamingInline && !g_isSearchingLoadout) {
        if (msg == WM_KEYDOWN) {
            bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
            if (ctrl && wParam == 'F') {
                if (IsCarouselValidAndActive(g_pLoadoutCarousel)) {
                    StartLoadoutSearch();
                    if (g_origGameWndProc) {
                        CallWindowProcW(g_origGameWndProc, hWnd, WM_KEYUP, VK_CONTROL, 0xC0000001);
                    }
                    return 0;
                }
            }
        }
    }

    if (msg == WM_KEYDOWN && wParam == VK_ESCAPE) {
        g_pLoadoutCarousel = NULL;
        g_pLoadoutViewModel = NULL;
    }

    if (msg == WM_USER + 1338) {
        if (g_isRenamingInline) {
            UpdateInlineDisplayText();
        }
        return 0;
    }

    if (msg == WM_USER + 1339) {
        StartInlineRename((int32_t)wParam);
        return 0;
    }

    if (msg == WM_USER + 1340) {
        CommitInlineRename();
        return 0;
    }

    if (msg == WM_USER + 1341) {
        CancelInlineRename();
        return 0;
    }

    if (msg == WM_USER + 1342) {
        if (g_isSearchingLoadout) {
            UpdateSearchDisplayText();
        }
        return 0;
    }

    if (msg == WM_USER + 1343) {
        CommitLoadoutSearch();
        return 0;
    }

    if (msg == WM_USER + 1344) {
        CancelLoadoutSearch();
        return 0;
    }

    if (msg == WM_USER + 1345) {
        StartLoadoutSearch();
        return 0;
    }

    if (msg == WM_USER + 1337) {
        loadout_log("HookedGameWndProc: refresh requested for slot %d", (int)wParam);
        if (g_pLoadoutCarousel && g_origUpdateView) {
            g_origUpdateView(g_pLoadoutCarousel);
        }
        return 0;
    }

    return CallWindowProcW(g_origGameWndProc, hWnd, msg, wParam, lParam);
}

static void EnsureGameSubclassed(HWND hWnd) {
    if (!hWnd || !IsWindow(hWnd)) return;
    if (!g_origGameWndProc) {
        g_origGameWndProc = (WNDPROC)SetWindowLongPtrW(hWnd, GWLP_WNDPROC, (LONG_PTR)HookedGameWndProc);
        loadout_log("EnsureGameSubclassed: subclassed game window %p", hWnd);
    }
}

static void TriggerLoadoutRename() {
    DWORD now = GetTickCount();
    if (now - g_lastLoadoutTriggerTime < 300) return;
    g_lastLoadoutTriggerTime = now;

    if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) {
        g_pLoadoutCarousel = NULL;
        g_pLoadoutViewModel = NULL;
        loadout_log("TriggerLoadoutRename: carousel not ready or active screen is not loadout gear screen");
        return;
    }

    int32_t activeSlot = *(int32_t*)((uintptr_t)g_pLoadoutCarousel + 0x400);

    loadout_log("TriggerLoadoutRename: inline rename requested for active slot: %d", activeSlot);
    if (g_hLoadoutGameWnd) {
        PostMessageW(g_hLoadoutGameWnd, WM_USER + 1339, (WPARAM)activeSlot, 0);
    }
}

static DWORD WINAPI LoadoutInputListenerThread(LPVOID) {
    loadout_log("LoadoutInputListenerThread started");
    static bool s_wasSearchKeyDown = false;

    while (TRUE) {
        Sleep(16);

        HWND hFg = GetForegroundWindow();
        if (!hFg) continue;

        DWORD pid = 0;
        GetWindowThreadProcessId(hFg, &pid);
        if (pid != GetCurrentProcessId()) {
            if (g_isRenamingInline) {
                PostMessageW(hFg, WM_USER + 1340, 0, 0); // commit on window focus loss
            }
            if (g_isSearchingLoadout) {
                PostMessageW(hFg, WM_USER + 1343, 0, 0); // commit search on window focus loss
            }
            g_wasLoadoutLButtonDown = false;
            s_wasSearchKeyDown = false;
            continue;
        }

        g_hLoadoutGameWnd = hFg;
        EnsureGameSubclassed(hFg);

        DWORD now = GetTickCount();

        // Blinking cursor update while inline renaming
        if (g_isRenamingInline) {
            if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) {
                PostMessageW(hFg, WM_USER + 1340, 0, 0); // commit rename
            } else if (now - g_inlineCursorTick >= 500) {
                g_inlineCursorTick = now;
                g_inlineCursorVisible = !g_inlineCursorVisible;
                PostMessageW(hFg, WM_USER + 1338, 0, 0);
            }
        }

        // Blinking cursor update while searching loadouts
        if (g_isSearchingLoadout) {
            if (!IsCarouselValidAndActive(g_pLoadoutCarousel)) {
                PostMessageW(hFg, WM_USER + 1343, 0, 0); // commit search
            } else if (now - g_searchCursorTick >= 500) {
                g_searchCursorTick = now;
                g_searchCursorVisible = !g_searchCursorVisible;
                PostMessageW(hFg, WM_USER + 1342, 0, 0);
            }
        }

        // Clear carousel pointer if Escape is pressed (when not inline renaming and not searching)
        bool isEscDown = (GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0;
        if (isEscDown && !g_isRenamingInline && !g_isSearchingLoadout) {
            g_pLoadoutCarousel = NULL;
            g_pLoadoutViewModel = NULL;
        }

        // 1. Check Search Hotkey (Ctrl + F) edge-triggered
        bool isFDown = (GetAsyncKeyState('F') & 0x8000) != 0;
        if (isFDown && !s_wasSearchKeyDown) {
            if (!g_isRenamingInline && !g_isSearchingLoadout) {
                bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                if (ctrl && IsCarouselValidAndActive(g_pLoadoutCarousel)) {
                    PostMessageW(hFg, WM_USER + 1345, 0, 0); // StartLoadoutSearch
                }
            }
        }
        s_wasSearchKeyDown = isFDown;

        // 2. Check Double-click in carousel region edge-triggered
        bool isLButtonDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
        if (isLButtonDown && !g_wasLoadoutLButtonDown) {
            POINT pt;
            GetCursorPos(&pt);
            ScreenToClient(hFg, &pt);
            RECT rc;
            GetClientRect(hFg, &rc);
            int w = rc.right - rc.left;
            int h = rc.bottom - rc.top;
            if (w > 0 && h > 0) {
                float rx = (float)pt.x / (float)w;
                float ry = (float)pt.y / (float)h;

                // If inline renaming and clicking outside the active card area, commit
                if (g_isRenamingInline) {
                    if (now - g_inlineStartTick > 350) {
                        if (!(rx >= 0.38f && rx <= 0.62f && ry >= 0.68f && ry <= 0.90f)) {
                            PostMessageW(hFg, WM_USER + 1340, 0, 0);
                        }
                    }
                }

                // If searching and clicking outside the active card area, commit
                if (g_isSearchingLoadout) {
                    if (now - g_searchStartTick > 350) {
                        if (!(rx >= 0.38f && rx <= 0.62f && ry >= 0.68f && ry <= 0.90f)) {
                            PostMessageW(hFg, WM_USER + 1343, 0, 0);
                        }
                    }
                }

                // If clicking outside carousel (e.g. left menu or bottom-right BACK button), reset carousel
                if (rx <= 0.30f || (rx >= 0.82f && ry >= 0.88f)) {
                    if (g_isSearchingLoadout) {
                        PostMessageW(hFg, WM_USER + 1344, 0, 0);
                    }
                    g_pLoadoutCarousel = NULL;
                    g_pLoadoutViewModel = NULL;
                }

                if (now - g_lastLoadoutLClickTime <= GetDoubleClickTime()) {
                    // Carousel region: center horizontal (30%-70%), bottom cards strip (68%-90%)
                    if (rx >= 0.30f && rx <= 0.70f && ry >= 0.68f && ry <= 0.90f) {
                        if (!g_isRenamingInline && !g_isSearchingLoadout) {
                            loadout_log("Double-click in carousel detected (rx=%.2f, ry=%.2f)", rx, ry);
                            TriggerLoadoutRename();
                        }
                    }
                }
            }
            g_lastLoadoutLClickTime = now;
        }
        g_wasLoadoutLButtonDown = isLButtonDown;
    }
    return 0;
}

static void loadout_rename_init(uintptr_t b) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_LOADOUT_NAMES", v, sizeof(v)) && v[0] == '0') {
        dxgi_note("loadout slot renaming: off (D1147_LOADOUT_NAMES=0)");
        return;
    }

    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) {
        dxgi_note("loadout slot renaming: hooks not available, off");
        return;
    }

    static const uint8_t expectSlot[8] = { 0x40, 0x55, 0x53, 0x57, 0x41, 0x55, 0x41, 0x57 };
    if (memcmp((void*)(b + LN::UpdateSlotViewModel), expectSlot, sizeof(expectSlot)) != 0) {
        dxgi_note("loadout slot renaming: game code differs at UpdateSlotViewModel, off");
        return;
    }

    static const uint8_t expectCarousel[8] = { 0x4C, 0x8B, 0xDC, 0x55, 0x53, 0x56, 0x49, 0x8D };
    if (memcmp((void*)(b + LN::UpdateView), expectCarousel, sizeof(expectCarousel)) != 0) {
        dxgi_note("loadout slot renaming: game code differs at UpdateView, off");
        return;
    }

    s = MH_CreateHook((void*)(b + LN::UpdateSlotViewModel), (void*)hook_UpdateSlotViewModel, (void**)&g_origUpdateSlotViewModel);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + LN::UpdateSlotViewModel));
    if (s != MH_OK) {
        dxgi_note("loadout slot renaming: hook on UpdateSlotViewModel FAILED, off");
        return;
    }

    s = MH_CreateHook((void*)(b + LN::UpdateView), (void*)hook_UpdateView, (void**)&g_origUpdateView);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + LN::UpdateView));
    if (s != MH_OK) {
        dxgi_note("loadout slot renaming: hook on UpdateView FAILED, off");
        return;
    }

    static const uint8_t expectGearClose[8] = { 0x40, 0x53, 0x56, 0x57, 0x41, 0x54, 0x41, 0x55 };
    if (memcmp((void*)(b + LN::GearScreenClose), expectGearClose, sizeof(expectGearClose)) == 0) {
        s = MH_CreateHook((void*)(b + LN::GearScreenClose), (void*)hook_GearScreenClose, (void**)&g_origGearScreenClose);
        if (s == MH_OK) s = MH_EnableHook((void*)(b + LN::GearScreenClose));
        if (s != MH_OK) {
            dxgi_note("loadout slot renaming: hook on GearScreenClose FAILED (non-fatal)");
        }
    }

    static const uint8_t expectCarouselDestr[8] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x57, 0x48, 0x83 };
    if (memcmp((void*)(b + LN::CarouselDestructor), expectCarouselDestr, sizeof(expectCarouselDestr)) == 0) {
        s = MH_CreateHook((void*)(b + LN::CarouselDestructor), (void*)hook_CarouselDestructor, (void**)&g_origCarouselDestructor);
        if (s == MH_OK) s = MH_EnableHook((void*)(b + LN::CarouselDestructor));
        if (s != MH_OK) {
            dxgi_note("loadout slot renaming: hook on CarouselDestructor FAILED (non-fatal)");
        }
    }

    HANDLE hThread = CreateThread(NULL, 0, LoadoutInputListenerThread, NULL, 0, NULL);
    if (hThread) CloseHandle(hThread);

    dxgi_note("loadout slot renaming: on (DF-LOADOUT-NAMES-1147; in-game inline editor)");
}

static void client_init() {
    char v[8];
    HMODULE exe = GetModuleHandleW(nullptr);
    uintptr_t b = (uintptr_t)exe;
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)b;
    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)(b + dos->e_lfanew);
    if (nt->OptionalHeader.SizeOfImage < 0x6000000) { dxgi_note("significance guard: not the 1.14.7 game exe, off"); return; }
    g_exeLo = b; g_exeHi = b + nt->OptionalHeader.SizeOfImage;
    {
        IMAGE_SECTION_HEADER* sec = IMAGE_FIRST_SECTION(nt);
        for (int i = 0; i < nt->FileHeader.NumberOfSections; i++) {
            uintptr_t lo = b + sec[i].VirtualAddress, hi = lo + sec[i].Misc.VirtualSize;
            if (!memcmp(sec[i].Name, ".text\0", 6)) { g_textLo = lo; g_textHi = hi; }
            if (!memcmp(sec[i].Name, ".rdata\0", 7)) { g_rdataLo = lo; g_rdataHi = hi; }
        }
        if (!g_textHi || !g_rdataHi) { g_textLo = g_rdataLo = g_exeLo; g_textHi = g_rdataHi = g_exeHi; }
    }
    client_mods_init();
    startup_messages_init(b);
    chat_domain_init(b);
    chat_room_init(b);
    chat_conn_init(b);
    chat_probe_init(b);
    chat_mcp_init(b);
    client_fixed_patches(b);
    g_base = b; cue_watch_init(0);                                           // DF-CUEWATCH
    loot_screen_init(b);                                                     // DF-LOOTWEDGE-1147
    loadout_rename_init(b);                                                  // DF-LOADOUT-NAMES-1147
    if (GetEnvironmentVariableA("D1147_SIGGUARD", v, sizeof(v)) && v[0] == '0') { dxgi_note("significance guard: off (D1147_SIGGUARD=0)"); return; }
    static const uint8_t expect[12] = { 0x48, 0x8B, 0xC4, 0x53, 0x48, 0x83, 0xEC, 0x60, 0x83, 0x7A, 0x08, 0x00 };
    if (memcmp((void*)(b + SG::UpdateSignificance), expect, sizeof(expect)) != 0) { dxgi_note("significance guard: game code differs, off"); return; }
    {   // mov rax, [rip+X] with X = GUObjectArray.ObjObjects.Objects (+0x10): same exe, same object list
        static const uint8_t ref[3] = { 0x48, 0x8B, 0x05 };
        int32_t disp; memcpy(&disp, (void*)(b + SG::ObjArrayRef + 3), 4);
        if (!memcmp((void*)(b + SG::ObjArrayRef), ref, 3) && SG::ObjArrayRef + 7 + disp == SG::GUObjectArray + 0x10) g_objArr = b + SG::GUObjectArray;
        dxgi_note(g_objArr ? "significance guard 3: object list check on" : "significance guard 3: object list not found, check off");
    }
    AddVectoredExceptionHandler(1, sg_read_veh);   // in front of any other handler: a fenced read never reaches the game's crash handling
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + SG::UpdateSignificance), (void*)upd_sig_hook, &g_origUpdSig);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + SG::UpdateSignificance));
    dxgi_note(s == MH_OK ? "significance guard: on" : "significance guard: hook FAILED, off");
    // second site
    static const uint8_t expect2[15] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x74, 0x24, 0x10, 0x57, 0x48, 0x83, 0xEC, 0x50 };
    if (memcmp((void*)(b + SG::PostSignificance), expect2, sizeof(expect2)) != 0) { dxgi_note("significance guard 2: game code differs, off"); return; }
    s = MH_CreateHook((void*)(b + SG::PostSignificance), (void*)post_sig_hook, &g_origPostSig);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + SG::PostSignificance));
    dxgi_note(s == MH_OK ? "significance guard 2 (PostSignificance): on" : "significance guard 2: hook FAILED, off");
}

// ---------------------------------------------------------------------------- client: startup messages (Oct 18)
// From KombatKing's Startup Messages R1 (AGPL-3.0-only), moved into this loader so no separate DLL is injected:
// - the offline "Failed to create IGameClient instance!" message is cleared (exact text only; the load result is kept)
// - the "press any key" start screen is skipped through the game's own ShouldSkipPressStartScreen check
#include "startup_message_policy.h"
namespace SM { const uintptr_t LoadGameClient = 0x1477dd0, ShouldSkipPressStart = 0x17805a0; }
static bool (*g_origLoadClient)(void*, void*) = nullptr;
static void (*g_origSkipPress)(void*, void*, void*) = nullptr;
static volatile LONG g_smErr = 0, g_smSkip = 0;
static bool sm_read(uintptr_t at, void* dest, size_t n) { if (!at || !readable((const void*)at, n)) return false; memcpy(dest, (const void*)at, n); return true; }
static bool load_client_hook(void* client, void* path) {
    const bool loaded = g_origLoadClient(client, path);
    if (StartupMessages::ClearExactError(loaded, client, sm_read) && InterlockedIncrement(&g_smErr) <= 2) dxgi_note("startup messages: offline IGameClient message cleared");
    return loaded;
}
static void skip_press_hook(void* object, void* frame, void* result) {
    g_origSkipPress(object, frame, result);              // keeps the Blueprint frame handling as it is
    if (result) { *(unsigned char*)result = 1; if (InterlockedIncrement(&g_smSkip) <= 2) dxgi_note("startup messages: press-start screen skipped"); }
}
static void startup_messages_init(uintptr_t b) {
    char v[8];
    if (GetEnvironmentVariableA("D1147_STARTUPFIX", v, sizeof(v)) && v[0] == '0') { dxgi_note("startup messages: off (D1147_STARTUPFIX=0)"); return; }
    static const uint8_t load[8] = { 0x48, 0x89, 0x5c, 0x24, 0x18, 0x55, 0x56, 0x57 };
    static const uint8_t skip[6] = { 0x40, 0x53, 0x48, 0x83, 0xec, 0x20 };
    if (memcmp((void*)(b + SM::LoadGameClient), load, sizeof(load)) != 0 || memcmp((void*)(b + SM::ShouldSkipPressStart), skip, sizeof(skip)) != 0) { dxgi_note("startup messages: game code differs, off"); return; }
    MH_STATUS s = MH_Initialize();
    if (s == MH_OK || s == MH_ERROR_ALREADY_INITIALIZED) s = MH_CreateHook((void*)(b + SM::LoadGameClient), (void*)load_client_hook, (void**)&g_origLoadClient);
    if (s == MH_OK) s = MH_CreateHook((void*)(b + SM::ShouldSkipPressStart), (void*)skip_press_hook, (void**)&g_origSkipPress);
    if (s == MH_OK) s = MH_EnableHook((void*)(b + SM::LoadGameClient));
    if (s == MH_OK) s = MH_EnableHook((void*)(b + SM::ShouldSkipPressStart));
    if (s != MH_OK) { MH_DisableHook((void*)(b + SM::LoadGameClient)); MH_DisableHook((void*)(b + SM::ShouldSkipPressStart)); }
    dxgi_note(s == MH_OK ? "startup messages: on" : "startup messages: hook FAILED, off");
}

extern "C" BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        char v[8];
        if (GetEnvironmentVariableA("D1147_SERVER", v, sizeof(v)) && v[0] == '1') {
            server_init();
            // Modded mode "also on my servers": UE4SS in the server copies only when the scripts ask for it
            if (GetEnvironmentVariableA("D1147_SERVER_MODS", v, sizeof(v)) && v[0] == '1') { HANDLE t = CreateThread(0, 0, ue4ss_thread, 0, 0, 0); if (t) CloseHandle(t); }
        }
        else client_init();
    }
    return TRUE;
}
