'use strict';
/**
 * System audio capture. A hidden renderer grabs the Windows loopback stream
 * (whatever your speakers are playing), runs an FFT over it, and streams a
 * small spectrum frame back here ~30 times a second. Wallpapers that opt in
 * receive it and can react to music.
 */

const path = require('path');
const { BrowserWindow, desktopCapturer, session } = require('electron');

let win = null;
let handlerInstalled = false;

function installDisplayMediaHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          // We only want the audio; the video source is required to satisfy
          // getDisplayMedia and is stopped immediately in the renderer.
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

function start() {
  if (win && !win.isDestroyed()) return;
  installDisplayMediaHandler();

  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  win.setMenu(null);
  win.loadURL('wf://builtin/audio.html').catch((err) => {
    console.error('[audio] failed to load capture page:', err.message);
  });
}

function stop() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function isRunning() {
  return !!win && !win.isDestroyed();
}

module.exports = { start, stop, isRunning };
