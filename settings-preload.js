'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (config) => ipcRenderer.invoke('settings:save', config),
  overlay: (action, value) => ipcRenderer.invoke('overlay:control', action, value),
  suspendHotkeys: (on) => ipcRenderer.send('hotkeys:suspend', on),
  onOverlayState: (callback) => ipcRenderer.on('overlay:state', (_event, state) => callback(state)),
});
