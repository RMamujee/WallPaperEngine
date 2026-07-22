'use strict';
const path = require('path');
const { Tray, Menu, nativeImage, app, shell } = require('electron');
const config = require('./config');
const library = require('./library');
const desktop = require('./desktop');
const monitor = require('./monitor');

let tray = null;
let openPicker = () => {};
// Settings are applied through the main process so side effects (starting the
// audio capture window, registering the login item) happen exactly once.
let applySettings = (patch) => config.set(patch);

function icon() {
  const file = path.join(app.getAppPath(), 'assets', 'tray.png');
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

function displayMenus(wallpapers) {
  return desktop.list().map((display) => ({
    label: `${display.label}${display.primary ? ' (primary)' : ''} - ${display.bounds.width}x${display.bounds.height}`,
    submenu: [
      {
        label: 'None',
        type: 'radio',
        checked: !display.wallpaperId,
        click: () => desktop.applyToDisplay(display.id, null)
      },
      { type: 'separator' },
      ...wallpapers.map((wallpaper) => ({
        label: wallpaper.name,
        type: 'radio',
        checked: display.wallpaperId === wallpaper.id,
        click: () => desktop.applyToDisplay(display.id, wallpaper.id)
      }))
    ]
  }));
}

function toggle(key, label) {
  return {
    label,
    type: 'checkbox',
    checked: !!config.get(key),
    click: (item) => {
      applySettings({ [key]: item.checked });
      rebuild();
    }
  };
}

function rebuild() {
  if (!tray) return;
  const wallpapers = library.scan();
  const paused = monitor.isManuallyPaused();

  const menu = Menu.buildFromTemplate([
    { label: `WallpaperForge ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open library...', click: () => openPicker() },
    {
      label: paused ? 'Resume wallpapers' : 'Pause wallpapers',
      click: () => {
        monitor.setManualPause(!paused);
        rebuild();
      }
    },
    { type: 'separator' },
    ...displayMenus(wallpapers),
    { type: 'separator' },
    toggle('pauseOnFullscreen', 'Pause when an app is fullscreen'),
    toggle('pauseOnBattery', 'Pause on battery power'),
    toggle('audioReactive', 'Audio reactive'),
    toggle('cursorTracking', 'Cursor tracking'),
    toggle('launchOnStartup', 'Start with Windows'),
    { type: 'separator' },
    { label: 'Reload wallpapers', click: () => desktop.reloadAll() },
    { label: 'Open wallpapers folder', click: () => shell.openPath(library.userRoot()) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(paused ? 'WallpaperForge - paused' : 'WallpaperForge');
}

function create({ onOpenPicker, onApplySettings }) {
  openPicker = onOpenPicker;
  if (onApplySettings) applySettings = onApplySettings;
  tray = new Tray(icon());
  tray.on('double-click', () => openPicker());
  rebuild();
  return tray;
}

module.exports = { create, rebuild };
