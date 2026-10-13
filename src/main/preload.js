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
  setup: invoke('game:setup'),
  play: invoke('game:play'),
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
  checkUpdates: invoke('updates:check'),
  communityInfo: invoke('community:info'),
  seasons: invoke('seasons:list'),
  setSeason: invoke('seasons:set'),
  openSeasonDoc: invoke('seasons:openDoc'),
});
