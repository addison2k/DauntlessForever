// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('launcher', {
  listVersions: invoke('versions:list'),
  status: invoke('versions:status'),
  info: invoke('launcher:info'),
  freeSpace: invoke('launcher:freeSpace'),
  pickFolder: invoke('game:pickFolder'),
  forgetFolder: invoke('game:forget'),
  pickGamesRoot: invoke('launcher:pickGamesRoot'),
  setLast: invoke('launcher:setLast'),
  download: invoke('game:download'),
  cancelDownload: invoke('game:cancelDownload'),
  partialInfo: invoke('game:partialInfo'),
  deletePartial: invoke('game:deletePartial'),
  setup: invoke('game:setup'),
  play: invoke('game:play'),
  importRevived: invoke('game:importRevived'),          // (id, tutorialOnly) the Revived 1.4.4 import, in a window
  stop: invoke('game:stop'),
  openPath: invoke('open:path'),
  openUrl: invoke('open:url'),
  openVersionFolder: invoke('open:versionFolder'),
  openGameFolder: invoke('open:gameFolder'),
  openLogs: invoke('open:logs'),
  readme: invoke('read:readme'),
  onLog: on('log:line'),
  onDownloadProgress: on('download:progress'),
  onDownloadState: on('download:state'),
  onSetupState: on('setup:state'),
  onPlayState: on('play:state'),
  onUpdatesEvent: on('updates:event'),
  onUpdatesDone: on('updates:done'),
  onLauncherUpdate: on('launcher:update'),
  newerLauncher: invoke('launcher:newer'),
  restartLauncher: invoke('launcher:restart'),
  checkUpdates: invoke('updates:check'),
  communityInfo: invoke('community:info'),
  seasons: invoke('seasons:list'),
  setSeason: invoke('seasons:set'),
  openSeasonDoc: invoke('seasons:openDoc'),
  events: invoke('events:list'),
  setEvents: invoke('events:set'),
  menuBackgrounds: invoke('menu:list'),
  gameLanguage: invoke('lang:get'),        // {languages: [[code, name]], current, versions}
  setGameLanguage: invoke('lang:set'),     // (code) -> {ok, versions, running}
  setMenuBackground: invoke('menu:set'),
  pickMenuPicture: invoke('menu:pickCustom'),
  rules: invoke('rules:list'),
  setRules: invoke('rules:set'),
  items: invoke('items:list'),
  setItems: invoke('items:set'),
  gearItems: invoke('items:gear'),
  patchNotes: invoke('patchnotes:list'),
  // one player name for every version and the Friends page (main/player.js)
  playerGet: invoke('player:get'),
  playerSet: invoke('player:set'),
  // Friends page (main/social.js)
  socialState: invoke('social:state'),
  socialRegister: invoke('social:register'),
  socialRename: invoke('social:rename'),
  socialAdd: invoke('social:add'),
  socialAccept: invoke('social:accept'),
  socialRemove: invoke('social:remove'),
  socialJoin: invoke('social:join'),
  socialHost: invoke('social:host'),
  socialRefresh: invoke('social:refresh'),
  socialStopHost: invoke('social:stopHost'),          // ({later: 60}) gives players a minute; ({cancel: true}) calls it off
  socialPlayOnline: invoke('social:playOnline'),      // join a game open to everyone, or host one
  socialCancelOnline: invoke('social:cancelOnline'),
  socialSetAllowRandoms: invoke('social:setAllowRandoms'),
  socialSetOffline: invoke('social:setOffline'),
  onSocialUpdate: on('social:update'),
  // Voice (main/voice.js, renderer/voice.js)
  voiceState: invoke('voice:state'),
  voiceJoin: invoke('voice:join'),
  voiceLeave: invoke('voice:leave'),
  voiceSignal: invoke('voice:signal'),
  voiceSettings: invoke('voice:settings'),
  voiceCaptureKey: invoke('voice:captureKey'),
  voiceCancelCapture: invoke('voice:cancelCapture'),
  onVoiceUpdate: on('voice:update'),
  onVoiceSignals: on('voice:signals'),
  onVoicePtt: on('voice:ptt'),
  // Host Mode (main/hostmode.js, renderer/hostmode.js)
  hostState: invoke('hostmode:state'),
  hostStart: invoke('hostmode:start'),
  hostStop: invoke('hostmode:stop'),                 // (later) true: players get 60 seconds
  hostSet: invoke('hostmode:set'),
  hostBan: invoke('hostmode:ban'),
  hostUnban: invoke('hostmode:unban'),
  hostBackup: invoke('hostmode:backup'),
  hostOpenBackups: invoke('hostmode:openBackups'),
  onHostUpdate: on('hostmode:update'),
});
