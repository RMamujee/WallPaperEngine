'use strict';
/**
 * Owns one "surface" (a BrowserWindow parented into the desktop WorkerW) per
 * physical display, and keeps them in sync with monitor changes, Explorer
 * restarts, pause state and per-frame data.
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const win32 = require('./win32');
const library = require('./library');
const config = require('./config');

const PRELOAD = path.join(__dirname, '..', 'preload', 'wallpaper.js');
const BLANK_URL = 'wf://builtin/blank.html';

/** displayId -> surface */
const surfaces = new Map();

let host = { host: 0, kind: 'none' };
let watchdog = null;
let cursorTimer = null;
let latestAudio = null;

function physicalBounds(display) {
  try {
    return screen.dipToScreenRect(null, display.bounds);
  } catch {
    // Fall back to manual scaling if the conversion is unavailable.
    const f = display.scaleFactor || 1;
    return {
      x: Math.round(display.bounds.x * f),
      y: Math.round(display.bounds.y * f),
      width: Math.round(display.bounds.width * f),
      height: Math.round(display.bounds.height * f)
    };
  }
}

function ensureHost(force = false) {
  if (force || !win32.isWindow(host.host)) {
    host = win32.resolveWallpaperHost();
    console.log(`[desktop] wallpaper host resolved: ${host.kind}`);
  }
  return host;
}

/**
 * A surface is only shown when it has something to draw. An empty surface is
 * opaque black, which would hide the user's real Windows wallpaper.
 */
function syncVisibility(surface) {
  const visible = !!surface.render && !surface.paused;
  if (visible) win32.showWindowNoActivate(surface.hwnd);
  else win32.hideWindow(surface.hwnd);
}

function attachSurface(surface) {
  ensureHost();
  if (!win32.nz(host.host)) return false;
  win32.attachToHost(surface.hwnd, host.host);
  win32.makeNonInteractive(surface.hwnd);
  win32.placeChild(surface.hwnd, physicalBounds(surface.display), host);
  syncVisibility(surface);
  return true;
}

function createSurface(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    hasShadow: false,
    thickFrame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    title: `WallpaperForge Surface ${display.id}`,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Critical: Chromium throttles rAF in windows it thinks are hidden, and a
      // window living behind the desktop icons always looks hidden.
      backgroundThrottling: false,
      webgl: true,
      additionalArguments: [`--wf-display-id=${display.id}`]
    }
  });

  win.setMenu(null);
  win.setIgnoreMouseEvents(true);

  const surface = {
    display,
    win,
    hwnd: win32.hwndFromBuffer(win.getNativeWindowHandle()),
    paused: false,
    wallpaperId: null,
    render: null
  };

  // Show it through Electron first so Chromium spins up the compositor for a
  // real on-screen window; syncVisibility then hides it natively if it has no
  // wallpaper to draw yet.
  win.showInactive();
  attachSurface(surface);
  // Explorer sometimes re-lays-out its children when a new one appears, so
  // assert our geometry once more after attaching.
  win32.placeChild(surface.hwnd, physicalBounds(display), host);
  syncVisibility(surface);

  // Chromium settles the window bounds again once a document has loaded, so
  // re-assert immediately instead of waiting for the healing timer.
  win.webContents.on('did-finish-load', () => {
    if (surface.win.isDestroyed()) return;
    win32.placeChild(surface.hwnd, physicalBounds(surface.display), host);
    syncVisibility(surface);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[desktop] renderer gone on display ${display.id}:`, details.reason);
    if (surface.wallpaperId) applyToDisplay(display.id, surface.wallpaperId);
  });

  surfaces.set(display.id, surface);
  return surface;
}

function destroySurface(displayId) {
  const surface = surfaces.get(displayId);
  if (!surface) return;
  surfaces.delete(displayId);
  if (!surface.win.isDestroyed()) surface.win.destroy();
}

/** Create/remove/reposition surfaces so they match the current monitor layout. */
function reconcile() {
  // The host WorkerW is resized by Explorer when monitors change, so its
  // origin has to be re-read before anything is repositioned against it.
  ensureHost(true);
  const displays = screen.getAllDisplays();
  const seen = new Set();

  for (const display of displays) {
    seen.add(display.id);
    const existing = surfaces.get(display.id);
    if (existing) {
      existing.display = display;
      win32.placeChild(existing.hwnd, physicalBounds(display), host);
      syncVisibility(existing);
    } else {
      const surface = createSurface(display);
      const assigned = config.assignmentFor(display.id);
      if (assigned) applyToDisplay(display.id, assigned, false);
      else surface.win.loadURL(BLANK_URL);
    }
  }

  for (const id of [...surfaces.keys()]) {
    if (!seen.has(id)) destroySurface(id);
  }
}

/**
 * @param persist  false when replaying an assignment we just read from config,
 *                 so an unresolvable id is never written back as "none".
 */
function applyToDisplay(displayId, wallpaperId, persist = true) {
  const surface = surfaces.get(displayId);
  if (!surface || surface.win.isDestroyed()) return null;

  const wallpaper = wallpaperId ? library.byId(wallpaperId) : null;
  if (wallpaperId && !wallpaper) {
    console.warn(`[desktop] wallpaper "${wallpaperId}" is not in the library (removed or unreadable manifest)`);
  }
  const render = wallpaper ? library.resolveForRender(wallpaper) : null;

  // Keep the requested id even when it cannot be resolved right now - the
  // folder may be on a drive that is temporarily unavailable.
  surface.wallpaperId = wallpaperId || null;
  surface.render = render;
  if (persist) config.assign(displayId, surface.wallpaperId);

  surface.win.loadURL(render ? render.url : BLANK_URL).catch((err) => {
    console.error('[desktop] load failed:', err.message);
  });
  syncVisibility(surface);
  return render;
}

function renderConfigForWebContents(webContentsId) {
  for (const surface of surfaces.values()) {
    if (!surface.win.isDestroyed() && surface.win.webContents.id === webContentsId) {
      return {
        displayId: surface.display.id,
        paused: surface.paused,
        wallpaper: surface.render,
        volume: config.get('volume')
      };
    }
  }
  return null;
}

function setPaused(displayId, paused) {
  const surface = surfaces.get(displayId);
  if (!surface || surface.paused === paused || surface.win.isDestroyed()) return;
  surface.paused = paused;
  // Tell the page first so it can stop timers/video, then take the window out
  // of the compositor entirely - that is what actually drops GPU usage to zero.
  surface.win.webContents.send('wf:paused', paused);
  syncVisibility(surface);
}

function setPausedAll(paused) {
  for (const id of surfaces.keys()) setPaused(id, paused);
}

function pausedState() {
  const out = {};
  for (const [id, surface] of surfaces) out[id] = surface.paused;
  return out;
}

function setAudioFrame(frame) {
  latestAudio = frame;
}

function setVolume(volume) {
  for (const surface of surfaces.values()) {
    if (!surface.win.isDestroyed()) surface.win.webContents.send('wf:volume', volume);
  }
}

/**
 * Push cursor + audio data to every live surface. Runs at ~30Hz, which is
 * plenty for parallax and spectrum bars and costs almost nothing.
 */
function pumpFrame() {
  const wantCursor = config.get('cursorTracking');
  const wantAudio = config.get('audioReactive');
  const point = wantCursor ? win32.cursorPos() : null;

  for (const surface of surfaces.values()) {
    if (surface.paused || surface.win.isDestroyed()) continue;
    if (!surface.render) continue;

    const frame = {};
    if (point && surface.render.cursor) {
      const b = physicalBounds(surface.display);
      frame.cursor = {
        x: b.width ? (point.x - b.x) / b.width : 0.5,
        y: b.height ? (point.y - b.y) / b.height : 0.5
      };
    }
    if (wantAudio && latestAudio && surface.render.audio) {
      frame.audio = latestAudio;
    }
    if (frame.cursor || frame.audio) surface.win.webContents.send('wf:frame', frame);
  }
}

/**
 * Self-healing pass. Two things fight us over these windows:
 *
 *  - Explorer can restart or crash, destroying the WorkerW and orphaning us.
 *  - Chromium re-applies its own bounds after layout and clamps windows to the
 *    monitor work area, which leaves a taskbar-sized gap along the bottom.
 *
 * Rather than trying to win every race, we just re-assert the truth on a timer.
 */
function heal() {
  if (!win32.isWindow(host.host)) {
    console.warn('[desktop] wallpaper host vanished, re-attaching');
    ensureHost(true);
    for (const surface of surfaces.values()) attachSurface(surface);
    return;
  }

  for (const surface of surfaces.values()) {
    if (surface.win.isDestroyed()) continue;
    const bounds = physicalBounds(surface.display);
    if (!win32.matchesBounds(surface.hwnd, bounds)) {
      win32.placeChild(surface.hwnd, bounds, host);
      syncVisibility(surface);
    }
  }
}

function start() {
  ensureHost(true);
  reconcile();

  screen.on('display-added', reconcile);
  screen.on('display-removed', reconcile);
  screen.on('display-metrics-changed', reconcile);

  watchdog = setInterval(heal, 2000);

  cursorTimer = setInterval(pumpFrame, 33);
}

function stop() {
  if (watchdog) clearInterval(watchdog);
  if (cursorTimer) clearInterval(cursorTimer);
  watchdog = null;
  cursorTimer = null;
  for (const id of [...surfaces.keys()]) destroySurface(id);
}

function list() {
  return screen.getAllDisplays().map((display) => {
    const surface = surfaces.get(display.id);
    return {
      id: display.id,
      label: display.label || `Display ${display.id}`,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      primary: display.id === screen.getPrimaryDisplay().id,
      wallpaperId: surface ? surface.wallpaperId : config.assignmentFor(display.id),
      paused: surface ? surface.paused : false
    };
  });
}

function reloadAll() {
  for (const surface of surfaces.values()) {
    if (!surface.win.isDestroyed()) surface.win.webContents.reload();
  }
}

module.exports = {
  start,
  stop,
  reconcile,
  physicalBounds,
  applyToDisplay,
  renderConfigForWebContents,
  setPaused,
  setPausedAll,
  pausedState,
  setAudioFrame,
  setVolume,
  list,
  reloadAll,
  surfaces,
  hostInfo: () => host
};
