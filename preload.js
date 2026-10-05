'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getConfig: () => ipcRenderer.invoke('overlay:config'),
  reportStatus: (kind, text) => ipcRenderer.send('overlay:status', { kind, text }),
  onEditMode: (callback) => ipcRenderer.on('edit-mode', (_event, on) => callback(on)),
});
