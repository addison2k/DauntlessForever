# Dauntless Forever (launcher)

One window to pick a Dauntless build, download it from Epic's own servers, set it up and play it offline.

It wraps the per-version "two-click" packages (`1 - SETUP.bat` / `2 - PLAY.bat`) without changing them: each version is a folder under `resources/versions/<id>/` with a `version.json` and the untouched package. The launcher adds the download step (via [DauntlessManifestArchive](https://github.com/addison2k/DauntlessManifestArchive) + `manifest.exe`), shows where the player is in the three steps, runs the package scripts and shows what they print.

No game files are included. Fan project, solo play, unofficial.

## For players

1. Unzip `DauntlessForever-<version>-x64.zip` anywhere (e.g. `C:\Games\DauntlessForever`) and run `Dauntless Forever.exe`.
   (Or run the installer, once it is built on Windows - see below.)
2. Pick a build on the left.
3. Press the big button. It is always the next step: **Download** (11-15 GB from Epic), then **Set up** (a black window asks one or two questions), then **Play**.

Already have the game? "More" -> "Use a game folder I already have".

Saves, settings, logs: `%LOCALAPPDATA%\DauntlessForever\ (DauntlessOffline\ for players from before the rename) versions\<id>\` (`data\` is the save; `upload\` has the two log zips for asking for help, with PC and user names blanked out). Nothing is written into your Windows Dauntless settings. Uninstalling the launcher does not delete that folder.

## Building

Needs Node.js 20+ and npm.

```
npm install
npm start            # run from source
npm run dist         # Windows: dist\DauntlessForever-<ver>-x64.exe (installer) and ...-x64.zip (portable)
```

On Linux/macOS only the `zip` target builds (`npx electron-builder --win zip --x64`); the NSIS installer and the exe icon need Wine there. Build on Windows for the full result.

`npm run dev` runs it in mock mode on any OS: fake statuses, fake download, no PowerShell. Good for working on the UI.

## Layout

```
src/main/
  main.js        window + IPC (status, download, set-up, play, stop, uninstall)
  versions.js    reads resources/versions/*/version.json; copies each package to the data folder
                 (never touching config.json, data, home, logs, backup, eos, captures, node_modules);
                 status = exe hash + installed DLL hashes + set-up marker files
  runner.js      set-up/uninstall in a visible PowerShell window (they ask questions);
                 play hidden with every line streamed to the window; stop = the package's own stop
  downloader.js  manifest.exe download <manifestUrl> --base-url <Epic CDN> --output <folder>;
                 progress parsed from its progress bar; cancel keeps .manifest-cache so it resumes
  settings.js    %LOCALAPPDATA%\DauntlessForever\ (DauntlessOffline\ for players from before the rename) launcher.json (games folder, game folder per version)
  paths.js       all paths; no drive letters anywhere
  preload.js     the window's bridge (contextIsolation, sandbox)
src/renderer/    index.html, styles.css, app.js (plain HTML/CSS/JS, no framework)
resources/
  versions/<id>/version.json + package/   one folder per build (see below)
  tools/manifest.exe                      meszmate/manifest v0.1.0 + plain-chunk fix (MIT), sha256-checked
build/icon.*     the launcher icon (original mark)
```

## Links, credits and supporters

- `resources/community.json`: Discord invite, Patreon page, repo links. The sidebar buttons appear once the URLs are filled in. The launcher also reads the copy in the repo on start, so changing a link does not need a build.
- `resources/credits.json`: the Credits page (people, what they did, what the project is built on).
- `supporters.json` (repo root): Patreon supporters to thank by name, read live from the repo: `{"supporters": ["name", {"name": "name", "top": true}], "anonymous": 2}`. Ask new supporters how they want to be credited (or "anonymous") in the Patreon welcome message.

## Updating a version's server files (no launcher rebuild)

Patched a DLL or a backend script? Test the package the normal way, then from the repo folder:

```
tools\pack-version.ps1 -Id 1.6.2 -From "D:\d162\package\Dauntless-1.6.2-Offline" -Note "what changed"
```

It copies the package in (leaving out anything personal), refreshes the DLL hashes and `packageVersion` in `version.json`, checks they agree with the package's own `common.ps1`, writes `dist\packages\1.6.2-<date>.zip` and records it in `packages.json`. Then, in this order: upload the zip to the GitHub release tagged `packages` (`gh release upload packages <zip> --clobber`; create that release once), and push. Every launcher reads `packages.json` on start, fetches changed zips (hash-checked), applies them over the player's copy without touching saves, and shows "run Set up again" so the new files go into the game folder. Rebuild the launcher only when you want the bundled copy refreshed too.

### A rebuilt DLL

```
tools\update-dll.ps1 -Id 1.6.2 -Dll "D:\...\x64\Release\UndauntedInternalServer.dll" -Note "what changed" -Pack
```

Copies the DLL into the package's `bin\`, swaps its hash in the package's `tools\common.ps1`, then runs `pack-version.ps1` on the package in place. Players see "Set-up needed" once (set-up puts the new DLL into the game folder; the old one goes to `backup\`).

## Adding a version

1. Make and test the two-click package for it the normal way (recipe doc: "easy two-click package recipe").
2. Copy the finished package folder to `resources/versions/<id>/package/` (the whole thing: `tools\`, `bin\`, `backend\`, `source\`, README, licence, .bat files).
3. Write `resources/versions/<id>/version.json` next to it. Copy `1.14.7/version.json` and change:
   - `id`, `name`, `build`, `released`, `era`, `blurb`, `works`, `notWorking`
   - `exeSha256` (from `$ExeHash` in the package's `common.ps1`)
   - `download`: the manifest URL and sizes from the archive README
   - `package.installedFiles`: every file set-up puts into the game folder, with its sha256 (`bin\` hashes)
   - `package.setupDoneFiles`: files/folders set-up creates in the package folder when it is done (used to tell "Set-up needed" from "Ready")
   - `package.stop`: the package's stop scripts and backend pid files
   - `package.packageVersion`: bump it whenever the package changes; the launcher re-copies it on next start
4. Keep `"package": null` for a build that is archived but has no offline package yet (it shows as "coming soon").

That is all. The launcher itself does not change.

## Credits and licences

- Built on [Undaunted](https://github.com/SyST3MDeV/Undaunted) by gwog and contributors (AGPL-3.0). The per-version server DLLs, loaders and backends are modified versions, with full source in each package's `source\` and `backend\` folders.
- Download tool: [meszmate/manifest](https://github.com/meszmate/manifest) (MIT), with the uncompressed-chunk fix from DauntlessManifestArchive.
- Launcher: AGPL-3.0, Addison2k, 2026.
- Dauntless belongs to its owners. This project is not affiliated with them.

## Releasing a new launcher

1. Raise `version` in package.json, then `npm run dist`.
2. `powershell -ExecutionPolicy Bypass -File tools\release-launcher.ps1 -Notes "what changed"` writes the `launcher` block in packages.json.
3. On GitHub, Releases > Draft a new release: tag `vX.Y.Z` (the new version), title `Dauntless Forever X.Y.Z`,
   attach `dist\DauntlessForever-X.Y.Z-x64.zip` (and the `.exe` installer if you want), Publish.
   (Or run the `gh release create ...` command the script prints.)
4. `git add -A`, `git commit -m "Launcher X.Y.Z"`, `git push`.

Every launcher reads packages.json on start; older ones show "Dauntless Forever X.Y.Z is out" with a Download
button that opens the release page.

## Releasing new server files

1. `powershell -ExecutionPolicy Bypass -File tools\pack-version.ps1 -Id 1.6.2 -From resources\versions\1.6.2\package -Note "what changed"`
2. On GitHub, open the `packages` release, click the pencil, attach the new zip from `dist\packages`, Update release.
3. `git add -A`, `git commit -m "1.6.2 server files"`, `git push`.

Launchers download and apply it on their next start.
