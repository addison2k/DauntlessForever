DAUNTLESS 1.6.2 - PLAY OFFLINE, SOLO
====================================

This lets you play Dauntless 1.6.2 on your own PC with no Epic sign-in and no internet servers.
It is a fan project, early and unofficial. Back up anything you care about.

WHAT WORKS (so far)
  - Log in, the tutorial hunt, Ramsgate, hunts
  - Weapon XP and mastery, the Slayer's Path, crafting, cores, bounties, cell fusion (middle slot)
  - Solo only.
  - Not working yet: Escalation progress and rewards (shows a fake level 25), factions, challenges.
  - Hunt Pass: 36 seasons to pick from (Seasons page in the launcher, or write a season key from
      seasons\index.json into data\season.txt). Each season keeps its own level. The game's own pass
      screen always says "Time Strike"; the levels and rewards are the season you picked.

WHAT YOU NEED
  1. Windows 10 or 11 (64-bit).
  2. Dauntless version 1.6.2, exactly (build 271281). This package does NOT include the game.
     Set-up checks your copy and tells you if it is the wrong version.
  3. Node.js 20.6 or newer (free). If you do not have it, set-up offers to install it for you.
  4. Internet once, during set-up (it downloads the backend's parts, about 30 MB, with npm).

HOW TO USE
  1. Unzip this whole folder somewhere simple, for example C:\Games\Dauntless-1.6.2-Offline
     (do not run it from inside the zip).
  2. Double-click  "1 - SETUP.bat"
       - It looks for the game; if it cannot find it, a window asks you to pick the game folder
         (the folder that has "Archon" inside it).
       - Answer the questions (Enter = yes). Pick a player name or press Enter for "Slayer".
       - Wait for "SET-UP DONE".
  3. Double-click  "2 - PLAY.bat"  every time you want to play.
       - It starts the local backend and the game servers (a minute or two), then the game opens.
       - A small black text window opens with the game. That is normal, leave it open.
       - Keep the PLAY window open while you play. When you close the game, it closes everything else.

  If Windows asks whether Node.js or Dauntless may use the network: click Cancel. Everything stays on your PC.
  If Windows SmartScreen warns about a .bat file: "More info" -> "Run anyway".
  A new character starts with the tutorial hunt, then goes to Ramsgate.

IF SOMETHING GOES WRONG
  - Stuck, or "a Dauntless process is running", or "port ... is already in use":
      close the game, double-click "STOP (if something got stuck).bat", then "2 - PLAY.bat" again.
  - "the game folder is missing files": the game was updated or repaired. Run "1 - SETUP.bat" again.
  - "not Dauntless 1.6.2": you have a different version. This package only works with 1.6.2.
  - Set-up says it cannot change files in the game folder: move the game to a normal folder
      (like C:\Games\Dauntless), or right-click "1 - SETUP.bat" -> Run as administrator.
  - "installing the backend parts failed": check your internet and run "1 - SETUP.bat" again.
  - The game will not start at all, or says xinput1_3.dll / x3daudio1_7.dll / VCRUNTIME140.dll is missing:
      run "1 - SETUP.bat" again. It installs the Visual C++ runtime and Microsoft's DirectX End-User Runtime
      (or install them yourself from microsoft.com).
  - If you also run another Dauntless private server on this PC, close it first. Only one can run at a time.
  - Asking for help? Send the two zips in the "upload" folder (client_logs.zip, server_logs.zip).
    Your PC name, Windows user name and account key are blanked out in them.

UNDO EVERYTHING
  Double-click "UNINSTALL (restore the game folder).bat". It takes this package's two files out of the game folder
  (they are kept in the backup folder). Then you can delete this folder.
  Your offline progress is in the data folder (keep it if you want to come back).

WHAT IT CHANGES IN THE GAME FOLDER (only these two files, in Archon\Binaries\Win64)
  - dxgi.dll                    : added. Undaunted's loader; it starts the file below when the game starts.
  - UndauntedInternalServer.dll : added. Points the game at the local backend, and lets hidden copies of the game
                                  act as your local game servers.
  If another dxgi.dll was there (for example ReShade), set-up moves it into the backup folder instead of deleting it.
  The game and its server copies get the local backend address from the server DLL, so no Game.ini is needed anywhere.
  The game may still write its usual settings (graphics, key bindings) to the normal Dauntless settings folder.

WHAT IS IN THIS FOLDER
  1 - SETUP.bat, 2 - PLAY.bat, STOP..., UNINSTALL...   the things you click
  tools\       the PowerShell scripts behind them, and backend-setup.js (plain text, read them if you like)
  backend\     metagame\ (accounts, inventory, progression) and deploy\ (starts the game servers), with full source
  seasons\     the Hunt Pass seasons (index.json, one file per season, docs\ = reward lists)
  bin\         the two DLLs set-up copies into the game folder
  source\      full source of the 1.6.2 server DLL, with build steps
  profile\     Game.ini: a spare copy of the backend addresses (not needed since package 2026-10-12.4)
  data\        your save, account and keys appear here. Keep them private: do not share the data folder.
  home\        the game's private settings folder (made by set-up)

CREDITS AND LICENCES
  - Built on Undaunted by gwog (Gregory Morford) and contributors, https://github.com/SyST3MDeV/Undaunted (AGPL-3.0).
    The backend, the loader and the server DLL are modified versions of Undaunted's, ported to 1.6.2 by Addison2k
    (Oct 2026). Licence: AGPL-3.0 (LICENSE-AGPL-3.0.txt). Source: backend\*\src and source\.
  - The server DLL uses MinHook by Tsuda Kageyu (BSD-2-Clause).
  - Dauntless is a trademark of its owners. This project is not affiliated with them and includes no game files.
