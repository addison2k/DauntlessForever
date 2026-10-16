// Dauntless Forever - Dauntless 1.6.2 offline package
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Based on KombatKing's ResupplyNative162 ("Resupply Beacons 162" R1, Dauntless Forever community). Licence: AGPL-3.0-only.
// Dauntless Forever changes: waits and retries while the new server is still loading; class renamed.
//
// The beacon charge is AArchonCharacter::SupplyCrateQuantityAmount (offset 0x768). Placing a beacon runs
// "dec dword ptr [rbx+0x768]" (FF 8B 68 07 00 00) at RVA 0x013A7339 of the 1.6.2 CL271281 exe. This replaces those
// 6 bytes with NOPs in the given server's memory only, after checking: the exe's SHA256, the server-authority test
// before it (Role == 3), the class test right before it, and the 6 bytes themselves. Anything else: nothing is written.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
public static class DfResupply162 {
 const long Site = 0x013A7339;
 const string Hash = "e7acba587320491b71cb53bb8f8cbf5f3760bb52f78e74a82384b8bc42d05fd6";
 [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
 [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr size, out UIntPtr count);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr size, out UIntPtr count);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualProtectEx(IntPtr process, IntPtr address, UIntPtr size, uint protection, out uint old);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushInstructionCache(IntPtr process, IntPtr address, UIntPtr size);
 static byte[] Read(IntPtr process, long address, int size) { byte[] b = new byte[size]; UIntPtr n; if (!ReadProcessMemory(process, new IntPtr(address), b, new UIntPtr((uint)size), out n) || n.ToUInt64() != (ulong)size) throw new Exception("memory read failed."); return b; }
 static void Equal(byte[] got, byte[] expected, string what) { if (got.Length != expected.Length) throw new Exception(what + ": length mismatch."); for (int i = 0; i < got.Length; i++) if (got[i] != expected[i]) throw new Exception(what + ": unexpected bytes (not the 1.6.2 code this was made for)."); }
 static void Write(IntPtr process, long address, byte[] bytes) { UIntPtr n; if (!WriteProcessMemory(process, new IntPtr(address), bytes, new UIntPtr((uint)bytes.Length), out n) || n.ToUInt64() != (ulong)bytes.Length) throw new Exception("memory write failed."); Equal(Read(process, address, bytes.Length), bytes, "write check"); FlushInstructionCache(process, new IntPtr(address), new UIntPtr((uint)bytes.Length)); }
 static long ImageBase(int pid, string expectedExe) {
  // A server that has only just started may not list its modules yet: wait and try again (up to ~10 s).
  Exception last = null;
  for (int i = 0; i < 20; i++) {
   try {
    using (Process child = Process.GetProcessById(pid)) {
     if (child.HasExited) throw new Exception("the hunt server has already closed.");
     ProcessModule main = child.MainModule;
     if (!String.Equals(Path.GetFullPath(main.FileName), expectedExe, StringComparison.OrdinalIgnoreCase)) throw new Exception("not the expected game server exe.");
     return main.BaseAddress.ToInt64();
    }
   } catch (ArgumentException) { throw new Exception("the hunt server has already closed."); }
   catch (Exception e) { last = e; if (e.Message.StartsWith("the hunt server") || e.Message.StartsWith("not the expected")) throw; Thread.Sleep(500); }
  }
  throw new Exception("could not read the new hunt server (" + (last != null ? last.Message : "timeout") + ").");
 }
 public static void Apply(int pid, string expectedExe) {
  if (!Environment.Is64BitProcess) throw new Exception("needs 64-bit Windows PowerShell.");
  expectedExe = Path.GetFullPath(expectedExe);
  string digest; using (SHA256 sha = SHA256.Create()) using (FileStream file = File.OpenRead(expectedExe)) { digest = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
  if (digest != Hash) throw new Exception("this game exe is not 1.6.2 CL271281.");
  long image = ImageBase(pid, expectedExe);
  IntPtr handle = OpenProcess(0x0438 | 0x0800, false, pid); if (handle == IntPtr.Zero) throw new Exception("Windows did not allow opening the hunt server.");
  bool suspended = false, protectedPage = false, changed = false; uint old = 0;
  byte[] original = { 0xff, 0x8b, 0x68, 0x07, 0x00, 0x00 }; byte[] replacement = { 0x90, 0x90, 0x90, 0x90, 0x90, 0x90 };
  try {
   if (NtSuspendProcess(handle) != 0) throw new Exception("could not pause the hunt server."); suspended = true;
   byte[] now = Read(handle, image + Site, 6);
   bool already = true; for (int i = 0; i < 6; i++) if (now[i] != 0x90) already = false;
   if (already) return;
   Equal(Read(handle, image + 0x013A7205, 13), new byte[] { 0x80, 0xbb, 0xf0, 0x00, 0x00, 0x00, 0x03, 0x0f, 0x85, 0x32, 0x01, 0x00, 0x00 }, "authority check");
   Equal(Read(handle, image + 0x013A7333, 12), new byte[] { 0x4a, 0x39, 0x14, 0xc0, 0x75, 0x06, 0xff, 0x8b, 0x68, 0x07, 0x00, 0x00 }, "class check");
   Equal(now, original, "charge instruction");
   if (!VirtualProtectEx(handle, new IntPtr(image + Site), new UIntPtr(6), 0x40, out old)) throw new Exception("memory protection change failed."); protectedPage = true;
   changed = true; Write(handle, image + Site, replacement);
   uint ignored; VirtualProtectEx(handle, new IntPtr(image + Site), new UIntPtr(6), old, out ignored); protectedPage = false;
  } catch {
   if (changed) { try { uint ignored; VirtualProtectEx(handle, new IntPtr(image + Site), new UIntPtr(6), 0x40, out ignored); Write(handle, image + Site, original); } catch { } }
   throw;
  } finally {
   if (protectedPage) { uint ignored; VirtualProtectEx(handle, new IntPtr(image + Site), new UIntPtr(6), old, out ignored); }
   if (suspended) NtResumeProcess(handle);
   CloseHandle(handle);
  }
 }
}
