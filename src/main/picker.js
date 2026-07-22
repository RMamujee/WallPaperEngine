'use strict';
const path = require('path');
const { BrowserWindow } = require('electron');

let win = null;

function open() {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    show: false,
    title: 'WallpaperForge',
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.setMenu(null);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });
  win.loadURL('wf://builtin/picker.html');
  return win;
}

function close() {
  if (win && !win.isDestroyed()) win.close();
}

function window() {
  return win && !win.isDestroyed() ? win : null;
}

module.exports = { open, close, window };
