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

  app.setLoginItemSettings({
    openAtLogin: !!config.get('launchOnStartup'),
    args: ['--hidden']
  });

  const startedHidden = process.argv.includes('--hidden');
  const hasAssignments = Object.keys(config.get('assignments')).length > 0;
  if (!startedHidden && !hasAssignments) picker.open();

  console.log(
    `[WallpaperForge] ready - desktop host: ${desktop.hostInfo().kind}, ${library.scan().length} wallpapers in library`
  );
}

function applySettings(patch) {
  config.set(patch);

  if ('audioReactive' in patch) {
    if (patch.audioReactive) audio.start();
    else audio.stop();
  }
  if ('launchOnStartup' in patch) {
    app.setLoginItemSettings({ openAtLogin: !!patch.launchOnStartup, args: ['--hidden'] });
  }
  if ('volume' in patch) {
    desktop.setVolume(patch.volume);
  }

  monitor.evaluate();
  tray.rebuild();
  return config.load();
}

function libraryForUi() {
  return library.scan().map((wallpaper) => ({
    id: wallpaper.id,
    name: wallpaper.name,
    type: wallpaper.type,
    author: wallpaper.author,
    description: wallpaper.description,
    builtin: wallpaper.builtin,
    preview: wallpaper.preview && fs.existsSync(wallpaper.preview) ? library.mediaUrl(wallpaper.preview) : null
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

  ipcMain.handle('wf:ui-import', async (_event, kind) => {
    const options =
      kind === 'video'
        ? {
            title: 'Choose a video to use as a wallpaper',
            properties: ['openFile'],
            filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'm4v', 'mov'] }]
          }
        : { title: 'Choose a folder of images', properties: ['openDirectory'] };

    const result = await dialog.showOpenDialog(picker.window() || undefined, options);
    if (result.canceled || !result.filePaths.length) return uiState();

    try {
      library.importSource(kind, result.filePaths[0]);
    } catch (err) {
      dialog.showErrorBox('Import failed', err.message);
    }
    tray.rebuild();
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
