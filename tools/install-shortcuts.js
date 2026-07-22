'use strict';
/**
 * Creates the Desktop and Start-menu shortcuts for WallpaperForge.
 *
 *   npm run shortcuts            create/refresh them
 *   npm run shortcuts -- --remove  delete them again
 *
 * Runs under Electron rather than plain Node because `shell.writeShortcutLink`
 * is the only API here that can stamp an AppUserModelID onto the .lnk. Without
 * that ID Windows treats the shortcut and the running process as two unrelated
 * things: the taskbar shows a second "Electron" button instead of highlighting
 * the pinned icon, and Start-menu search doesn't reliably surface the app.
 *
 * The shortcut points at the local electron.exe with the project folder as its
 * argument, which is exactly what `npm start` does. No packaging step needed.
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const APP_DIR = path.resolve(__dirname, '..');
const APP_USER_MODEL_ID = 'com.rmamujee.wallpaperforge';
const NAME = 'WallpaperForge';

function startMenuDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function targets() {
  return [
    { label: 'Desktop', file: path.join(app.getPath('desktop'), `${NAME}.lnk`) },
    { label: 'Start menu', file: path.join(startMenuDir(), `${NAME}.lnk`) }
  ];
}

function install() {
  const icon = path.join(APP_DIR, 'assets', 'app.ico');
  if (!fs.existsSync(icon)) {
    console.error(`[shortcuts] missing ${icon} — run "npm run icon" first`);
    return 1;
  }

  const options = {
    target: process.execPath, // the electron.exe running this script
    args: `"${APP_DIR}"`,
    cwd: APP_DIR,
    icon,
    iconIndex: 0,
    description: 'Animated desktop wallpaper engine',
    appUserModelId: APP_USER_MODEL_ID
  };

  let failed = 0;
  for (const { label, file } of targets()) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 'replace' fails when the .lnk doesn't exist yet, so always use 'create',
      // which overwrites in place.
      if (!shell.writeShortcutLink(file, 'create', options)) throw new Error('writeShortcutLink returned false');
      console.log(`[shortcuts] ${label}: ${file}`);
    } catch (err) {
      console.error(`[shortcuts] ${label} failed: ${err.message}`);
      failed++;
    }
  }

  if (!failed) {
    console.log(`[shortcuts] done — search "${NAME}" in the taskbar to launch it`);
  }
  return failed ? 1 : 0;
}

function remove() {
  for (const { label, file } of targets()) {
    try {
      fs.rmSync(file, { force: true });
      console.log(`[shortcuts] removed ${label}: ${file}`);
    } catch (err) {
      console.error(`[shortcuts] could not remove ${file}: ${err.message}`);
    }
  }
  return 0;
}

app.whenReady().then(() => {
  if (process.platform !== 'win32') {
    console.error('[shortcuts] Windows only');
    app.exit(1);
    return;
  }
  app.exit(process.argv.includes('--remove') ? remove() : install());
});
