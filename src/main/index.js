'use strict';
const fs = require('fs');
const { app, ipcMain, dialog, shell } = require('electron');

const protocolServer = require('./protocol');
const config = require('./config');
const library = require('./library');
const desktop = require('./desktop');
const monitor = require('./monitor');
const audio = require('./audio');
const tray = require('./tray');
const picker = require('./picker');

if (process.platform !== 'win32') {
  console.error('[WallpaperForge] Windows only: this depends on the Explorer WorkerW desktop layer.');
}

// Chromium aggressively stops painting windows it believes are hidden or
// occluded. A wallpaper surface lives behind the desktop icons and looks
// occluded 100% of the time, so all three of these are required for it to
// keep animating.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Without an explicit AppUserModelID, Windows groups the app under "Electron"
// in the taskbar and refuses to associate the Start-menu shortcut with it.
// Must match the ID stamped on the .lnk files by tools/install-shortcuts.js.
app.setAppUserModelId('com.rmamujee.wallpaperforge');

protocolServer.registerScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => picker.open());
  app.whenReady().then(bootstrap);
}

function bootstrap() {
  protocolServer.serve();

  desktop.start();
  monitor.start();
  if (config.get('audioReactive')) audio.start();

  tray.create({ onOpenPicker: () => picker.open(), onApplySettings: applySettings });
  registerIpc();

  app.setLoginItemSettings(loginItemSettings(config.get('launchOnStartup')));

  // Launching from the desktop/Start-menu icon should show the library. Only
  // the autostart entry passes --hidden, so login stays silent.
  if (!process.argv.includes('--hidden')) picker.open();

  console.log(
    `[WallpaperForge] ready - desktop host: ${desktop.hostInfo().kind}, ${library.scan().length} wallpapers in library`
  );
}

/**
 * Unpackaged, process.execPath is electron.exe itself, which boots Electron's
 * stock welcome app unless the project directory is its first argument — so a
 * bare `electron.exe --hidden` autostart shows an empty "Electron" window at
 * login and never renders a wallpaper. No manual quoting: setLoginItemSettings
 * quotes each arg itself, and pre-quoted values end up as literal quote
 * characters in the registry command line.
 */
function loginItemSettings(openAtLogin) {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  args.push('--hidden');
  return { openAtLogin: !!openAtLogin, args };
}

function applySettings(patch) {
  config.set(patch);

  if ('audioReactive' in patch) {
    if (patch.audioReactive) audio.start();
    else audio.stop();
  }
  if ('launchOnStartup' in patch) {
    app.setLoginItemSettings(loginItemSettings(patch.launchOnStartup));
  }
  if ('volume' in patch) {
    desktop.setVolume(patch.volume);
  }

  monitor.evaluate();
  tray.rebuild();
  return config.load();
}

/**
 * Thumbnails are written after import (video poster capture), so the URL has to
 * change when the file does or the picker keeps showing the cached miss.
 */
function previewUrl(file) {
  if (!file) return null;
  try {
    return `${library.mediaUrl(file)}?v=${Math.round(fs.statSync(file).mtimeMs)}`;
  } catch {
    return null;
  }
}

function libraryForUi() {
  return library.scan().map((wallpaper) => ({
    id: wallpaper.id,
    name: wallpaper.name,
    type: wallpaper.type,
    author: wallpaper.author,
    description: wallpaper.description,
    builtin: wallpaper.builtin,
    preview: previewUrl(wallpaper.preview)
  }));
}

function uiState() {
  return {
    wallpapers: libraryForUi(),
    displays: desktop.list(),
    settings: config.load(),
    status: { ...monitor.status(), host: desktop.hostInfo().kind, audio: audio.isRunning() }
  };
}

function registerIpc() {
  // --- wallpaper surfaces ---
  ipcMain.handle('wf:surface-config', (event) => desktop.renderConfigForWebContents(event.sender.id));
  ipcMain.on('wf:audio-frame', (_event, frame) => desktop.setAudioFrame(frame));
  ipcMain.on('wf:audio-status', (_event, status) => console.log('[audio]', status));

  // --- library / picker UI ---
  ipcMain.handle('wf:ui-state', () => uiState());

  ipcMain.handle('wf:ui-apply', (_event, { displayId, wallpaperId }) => {
    desktop.applyToDisplay(displayId, wallpaperId || null);
    tray.rebuild();
    return uiState();
  });

  ipcMain.handle('wf:ui-settings', (_event, patch) => {
    applySettings(patch || {});
    return uiState();
  });

  ipcMain.handle('wf:ui-pause', (_event, value) => {
    monitor.setManualPause(!!value);
    tray.rebuild();
    return uiState();
  });

  const IMPORT_DIALOGS = {
    video: {
      title: 'Choose a video to save as a wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: [...library.VIDEO_EXT].map((e) => e.slice(1)) }]
    },
    image: {
      title: 'Choose an image to save as a wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: [...library.IMAGE_EXT].map((e) => e.slice(1)) }]
    },
    living: {
      title: 'Choose an image to bring to life',
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: [...library.IMAGE_EXT].map((e) => e.slice(1)) }]
    },
    folder: { title: 'Choose a folder of images', properties: ['openDirectory'] }
  };

  ipcMain.handle('wf:ui-import', async (_event, kind) => {
    const options = IMPORT_DIALOGS[kind] || IMPORT_DIALOGS.folder;

    const result = await dialog.showOpenDialog(picker.window() || undefined, options);
    if (result.canceled || !result.filePaths.length) return uiState();

    let importedId = null;
    try {
      importedId = await library.importSource(kind, result.filePaths[0]);
    } catch (err) {
      dialog.showErrorBox('Could not save wallpaper', err.message);
    }

    // Videos have no thumbnail until we grab a frame. The picker does the decode
    // (a normal GPU-backed renderer) and hands the JPEG back via `wf:ui-poster`.
    if (importedId) {
      const wallpaper = library.byId(importedId);
      const resolved = wallpaper && library.resolveForRender(wallpaper);
      if (resolved && wallpaper.type === 'video' && resolved.payload.source) {
        const window = picker.window();
        if (window) window.webContents.send('wf:make-poster', { id: importedId, url: resolved.payload.source });
      }
    }

    tray.rebuild();
    return uiState();
  });

  ipcMain.handle('wf:ui-poster', (_event, { id, dataUrl }) => {
    const base64 = String(dataUrl || '').split(',')[1];
    if (base64) library.setPreview(id, Buffer.from(base64, 'base64'));
    return uiState();
  });

  ipcMain.handle('wf:ui-remove', (_event, wallpaperId) => {
    for (const display of desktop.list()) {
      if (display.wallpaperId === wallpaperId) desktop.applyToDisplay(display.id, null);
    }
    try {
      library.remove(wallpaperId);
    } catch (err) {
      dialog.showErrorBox('Could not delete', err.message);
    }
    tray.rebuild();
    return uiState();
  });

  ipcMain.handle('wf:ui-open-folder', () => shell.openPath(library.userRoot()));
  ipcMain.handle('wf:ui-reload', () => {
    desktop.reloadAll();
    return uiState();
  });
  ipcMain.on('wf:ui-close', () => picker.close());
}

// Tray app: closing the picker must not end the process.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  monitor.stop();
  audio.stop();
  desktop.stop();
});
