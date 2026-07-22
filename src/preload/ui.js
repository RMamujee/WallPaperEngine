'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  state: () => ipcRenderer.invoke('wf:ui-state'),
  apply: (displayId, wallpaperId) => ipcRenderer.invoke('wf:ui-apply', { displayId, wallpaperId }),
  settings: (patch) => ipcRenderer.invoke('wf:ui-settings', patch),
  pause: (value) => ipcRenderer.invoke('wf:ui-pause', value),
  import: (kind) => ipcRenderer.invoke('wf:ui-import', kind),
  remove: (id) => ipcRenderer.invoke('wf:ui-remove', id),
  // Main asks the picker to decode one video frame; the picker sends the JPEG back.
  onMakePoster: (fn) => ipcRenderer.on('wf:make-poster', (_event, payload) => fn(payload)),
  poster: (id, dataUrl) => ipcRenderer.invoke('wf:ui-poster', { id, dataUrl }),
  openFolder: () => ipcRenderer.invoke('wf:ui-open-folder'),
  reload: () => ipcRenderer.invoke('wf:ui-reload'),
  close: () => ipcRenderer.send('wf:ui-close')
});
