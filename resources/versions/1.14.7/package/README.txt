DAUNTLESS 1.14.7 - PLAY OFFLINE, SOLO
=====================================

This lets you play Dauntless 1.14.7 on your own PC with no Epic sign-in and no internet servers.
It is a fan project, early and unofficial. Back up anything you care about.

WHAT WORKS (so far)
  - Sign in offline, Ramsgate, NPCs and quests (quest progress is saved)
  - Training grounds, sprint, attacking
  - Hunts (tested: the first Embermane hunt)
  - Solo only. Much else may not work yet.

WHAT YOU NEED
  1. Windows 10 or 11 (64-bit).
  2. Dauntless version 1.14.7, exactly (build 647472). This package does NOT include the game.
     Set-up checks your copy and tells you if it is the wrong version.
  3. Node.js (free). If you do not have it, set-up offers to install it for you.
  4. Internet once, during set-up (it downloads a small public data pack from GitHub).

HOW TO USE
  1. Unzip this whole folder somewhere simple, for example C:\Games\Dauntless-1.14.7-Offline
     (do not run it from inside the zip).
  2. Double-click  "1 - SETUP.bat"
       - It looks for the game; if it cannot find it, a window asks you to pick the game folder
         (the folder that has "Archon" inside it).
       - Answer the questions (Enter = yes). Pick a player name or press Enter for "Slayer".
       - Wait for "SET-UP DONE".
  3. Double-click  "2 - PLAY.bat"  every time you want to play.
       - It starts everything in order (about a minute), then the game opens.
       - Keep that window open while you play. When you close the game, it closes everything else.

  If Windows asks whether Dauntless may use the network: click Cancel. Everything stays on your PC.
  If Windows SmartScreen warns about a .bat file: "More info" -> "Run anyway".

IF SOMETHING GOES WRONG
  - Game stuck on a loading screen, or "a Dauntless process is running":
      close the game, double-click "STOP (if something got stuck).bat", then "2 - PLAY.bat" again.
  - "the offline sign-in is not in the game folder": the game was updated or repaired.
      Run "1 - SETUP.bat" again.
  - "not Dauntless 1.14.7": you have a different version. This package only works with 1.14.7.
  - Set-up says it cannot change files in the game folder: move the game to a normal folder
      (like C:\Games\Dauntless), or right-click "1 - SETUP.bat" -> Run as administrator.
  - The game will not start at all, or says xinput1_3.dll / x3daudio1_7.dll / VCRUNTIME140.dll is missing:
      run "1 - SETUP.bat" again. It installs the Visual C++ runtime and Microsoft's DirectX End-User Runtime
      (or install them yourself from microsoft.com).
  - Asking for help? Send the two zips in the "upload" folder (client_logs.zip, server_logs.zip).
    Your PC name and Windows user name are blanked out in them.

UNDO EVERYTHING
  Double-click "UNINSTALL (restore the game folder).bat". It puts Epic's original sign-in file back and removes
  the server loader from the game folder. Then you can delete this folder.
  Your offline progress is in data\state.json (keep it if you want to come back).

WHAT IT CHANGES IN THE GAME FOLDER (only these two files, in Archon\Binaries\Win64)
  - EOSSDK-Win64-Shipping.dll : replaced by an offline stand-in. Epic's original is kept next to it
                                as EOSSDK-Win64-Shipping.dll.epic.
  - dxgi.dll                  : added. Lets a second, hidden copy of the game act as your local game server.
                                It does nothing when you start the game normally.
  Your normal Dauntless settings are not touched: the game runs with its own settings folder (home\ in this folder).

WHAT IS IN THIS FOLDER
  1 - SETUP.bat, 2 - PLAY.bat, STOP..., UNINSTALL...   the things you click
  tools\       the PowerShell scripts behind them (plain text, read them if you like)
  backend\     recorder-1147.js: the small local backend the game talks to (127.0.0.1 only)
  bin\         the two DLLs set-up copies into the game folder
  source\      full source code of both DLLs, with build steps
  profile\     Game.ini: points the game at the local backend
  data\        hunts_1147.json (which map and monster each hunt uses); your save (state.json) appears here
  captures\    downloaded by set-up: github.com/EisigesEis/DauntlessEndpointDocumentation
               (replies recorded from the live servers, used as reference data)

CREDITS AND LICENCES
  - Server loader (bin\dxgi.dll): the approach comes from Undaunted (gwog and contributors, AGPL-3.0); this is a new
    implementation for 1.14.7. Licence AGPL-3.0 (LICENSE-AGPL-3.0.txt), source in source\d1147_source.zip.
    Uses MinHook by Tsuda Kageyu (BSD-2-Clause, licence inside the source zip).
  - Offline sign-in stand-in (bin\EOSSDK-Win64-Shipping.dll): source in source\eos_offline_source.zip.
  - Backend reference data: EisigesEis/DauntlessEndpointDocumentation (downloaded from GitHub by set-up, not included).
  - Dauntless is a trademark of its owners. This project is not affiliated with them and includes no game files.
