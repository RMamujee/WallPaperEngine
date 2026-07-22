'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wfAudioBridge', {
  send: (frame) => ipcRenderer.send('wf:audio-frame', frame),
  report: (status) => ipcRenderer.send('wf:audio-status', status)
});
