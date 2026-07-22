'use strict';
/**
 * API handed to every wallpaper page as `window.wallpaperForge`.
 *
 * Minimal on purpose - a wallpaper only ever needs to know: what am I, am I
 * paused, and what is the audio/cursor doing right now.
 */

const { contextBridge, ipcRenderer } = require('electron');

const displayArg = process.argv.find((a) => a.startsWith('--wf-display-id='));
const displayId = displayArg ? Number(displayArg.split('=')[1]) : null;

const frameListeners = new Set();
const pauseListeners = new Set();
const volumeListeners = new Set();

let lastFrame = {
  audio: { bands: new Array(32).fill(0), level: 0, bass: 0, mid: 0, treble: 0 },
  cursor: { x: 0.5, y: 0.5 }
};
let paused = false;

ipcRenderer.on('wf:frame', (_event, frame) => {
  if (frame.audio) lastFrame.audio = frame.audio;
  if (frame.cursor) lastFrame.cursor = frame.cursor;
  for (const fn of frameListeners) {
    try {
      fn(lastFrame);
    } catch (err) {
      console.error('[wallpaperForge] frame listener threw:', err);
    }
  }
});

ipcRenderer.on('wf:paused', (_event, value) => {
  paused = value;
  for (const fn of pauseListeners) {
    try {
      fn(value);
    } catch (err) {
      console.error('[wallpaperForge] pause listener threw:', err);
    }
  }
});

ipcRenderer.on('wf:volume', (_event, volume) => {
  for (const fn of volumeListeners) {
    try {
      fn(volume);
    } catch (err) {
      console.error('[wallpaperForge] volume listener threw:', err);
    }
  }
});

contextBridge.exposeInMainWorld('wallpaperForge', {
  version: 1,
  displayId,

  /** Resolves to { displayId, paused, volume, wallpaper: { name, type, properties, payload } } */
  getConfig: () => ipcRenderer.invoke('wf:surface-config'),

  /** Latest audio spectrum + normalised cursor position, safe to poll each frame. */
  frame: () => lastFrame,
  isPaused: () => paused,

  onFrame(fn) {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
  },
  onPause(fn) {
    pauseListeners.add(fn);
    return () => pauseListeners.delete(fn);
  },
  onVolume(fn) {
    volumeListeners.add(fn);
    return () => volumeListeners.delete(fn);
  }
});
