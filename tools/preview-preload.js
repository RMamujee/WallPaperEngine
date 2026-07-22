'use strict';
/**
 * Stands in for src/preload/wallpaper.js when a wallpaper is rendered by
 * tools/preview.js, which has no real desktop surface behind it.
 *
 * Keep the shape identical to the real bridge, or a wallpaper can pass here and
 * still fail on the desktop.
 */

const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--wf-config='));
const config = arg ? JSON.parse(decodeURIComponent(arg.slice('--wf-config='.length))) : null;

// A slow circular sweep, so cursor-reactive wallpapers show movement in a
// preview even though nothing is touching the mouse.
const started = Date.now();
function cursor() {
  const t = (Date.now() - started) / 4000;
  return { x: 0.5 + Math.cos(t) * 0.35, y: 0.5 + Math.sin(t) * 0.28 };
}

contextBridge.exposeInMainWorld('wallpaperForge', {
  version: 1,
  displayId: 1,
  getConfig: async () => config,
  frame: () => ({
    audio: { bands: new Array(32).fill(0), level: 0, bass: 0, mid: 0, treble: 0 },
    cursor: cursor()
  }),
  isPaused: () => false,
  onFrame: () => () => {},
  onPause: () => () => {},
  onVolume: () => () => {}
});
