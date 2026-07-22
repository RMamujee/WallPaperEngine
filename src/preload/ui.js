'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  state: () => ipcRenderer.invoke('wf:ui-state'),
  apply: (displayId, wallpaperId) => ipcRenderer.invoke('wf:ui-apply', { displayId, wallpaperId }),
  settings: (patch) => ipcRenderer.invoke('wf:ui-settings', patch),
  pause: (value) => ipcRenderer.invoke('wf:ui-pause', value),
  import: (kind) => ipcRenderer.invoke('wf:ui-import', kind),
  remove: (id) => ipcRenderer.invoke('wf:ui-remove', id),
  openFolder: () => ipcRenderer.invoke('wf:ui-open-folder'),
  reload: () => ipcRenderer.invoke('wf:ui-reload'),
  close: () => ipcRenderer.send('wf:ui-close')
});
