// Dauntless Forever - Dauntless 1.6.2 loader (dxgi.dll), milestone "162-fix5"
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//
// Replaces the original Undaunted 1.6.2 loader (gwog and contributors, AGPL-3.0; SHA256 9A431D7B...), which did two things:
//   1. forwarded CreateDXGIFactory / CreateDXGIFactory1 / CreateDXGIFactory2 to the system dxgi.dll, loaded inside DllMain;
//   2. loaded UndauntedInternalServer.dll (the 1.6.2 server/client code) from DllMain.
// Why it is replaced (Oct 16, 2026): on Windows 11 25H2 laptops with two GPUs (RTX 4070 Laptop + Intel UHD) the player's
// game crashed at start-up with "faulting module unknown, fault offset 0x0", while the hidden server copies (-nullrhi,
// no graphics) ran fine. Windows' graphics code asks dxgi.dll for functions the old loader did not have. Same family as
// the 1.14.7 25H2 crash; the fix below is the 1.14.7 loader's dxgi forwarding (milestone 2c-fix5, in use since Oct 13):
// all 20 dxgi exports, the system DLL loaded on the first call (not in DllMain) with retries and fallbacks, a safe answer
// for anything missing, and the compatibility-shim re-entry guard. Step 2 is unchanged.
// Notes are written to %LOCALAPPDATA%\d162_dxgi.log only when something is unusual.
#include <windows.h>
#include <stdio.h>
#include <string.h>

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
//   - anything missing is written once to %LOCALAPPDATA%\d162_dxgi.log so the next report names it.
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
    wcscat(path, L"\\d162_dxgi.log");
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
    wcscat(copy, L"d162_system_dxgi.dll");
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


// ---------------------------------------------------------------------------- the 1.6.2 code
extern "C" BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        // as the original loader: UndauntedInternalServer.dll from the game folder (the exe's folder is searched first)
        if (!LoadLibraryA("UndauntedInternalServer.dll")) {
            char msg[120];
            snprintf(msg, sizeof(msg), "loader 162-fix5: UndauntedInternalServer.dll did not load (error %lu)", (unsigned long)GetLastError());
            dxgi_note(msg);
        }
    }
    return TRUE;
}
