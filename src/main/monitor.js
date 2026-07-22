'use strict';
/**
 * Decides when wallpapers should stop rendering: a fullscreen app (game, video
 * player, presentation), a locked session, or battery power.
 *
 * "Fullscreen" here means the foreground window's rect covers a monitor
 * completely. A merely maximised window stops short of the taskbar, so it
 * correctly does not trigger a pause.
 */

const { screen, powerMonitor } = require('electron');
const win32 = require('./win32');
const config = require('./config');
const desktop = require('./desktop');

let timer = null;
let manualPause = false;
let sessionLocked = false;
let lastReason = 'running';

// DIP-to-physical conversion rounds (a 2560x1600 panel reports as 2561x1601),
// so an exactly-fullscreen window can fall a pixel short of covering it.
// A maximised window stops ~a taskbar short, far outside this tolerance.
const COVER_TOLERANCE = 4;

function coveredDisplayIds() {
  const info = win32.foregroundWindowInfo();
  if (!info) return [];
  const r = info.rect;
  const ids = [];
  for (const display of screen.getAllDisplays()) {
    const b = desktop.physicalBounds(display);
    if (
      r.left <= b.x + COVER_TOLERANCE &&
      r.top <= b.y + COVER_TOLERANCE &&
      r.right >= b.x + b.width - COVER_TOLERANCE &&
      r.bottom >= b.y + b.height - COVER_TOLERANCE
    ) {
      ids.push(display.id);
    }
  }
  return ids;
}

function evaluate() {
  if (manualPause) return apply(true, 'paused by user');
  if (sessionLocked) return apply(true, 'session locked');
  if (config.get('pauseOnBattery') && powerMonitor.onBatteryPower) return apply(true, 'on battery');
  if (!config.get('pauseOnFullscreen')) return apply(false, 'running');

  const covered = coveredDisplayIds();
  if (config.get('pauseScope') === 'all') {
    return apply(covered.length > 0, covered.length ? 'fullscreen app' : 'running');
  }

  for (const display of screen.getAllDisplays()) {
    desktop.setPaused(display.id, covered.includes(display.id));
  }
  lastReason = covered.length ? 'fullscreen app (per monitor)' : 'running';
}

function apply(paused, reason) {
  desktop.setPausedAll(paused);
  lastReason = reason;
}

function setManualPause(value) {
  manualPause = value;
  evaluate();
  return manualPause;
}

function isManuallyPaused() {
  return manualPause;
}

function status() {
  return { manualPause, sessionLocked, reason: lastReason };
}

function start() {
  powerMonitor.on('lock-screen', () => {
    sessionLocked = true;
    evaluate();
  });
  powerMonitor.on('unlock-screen', () => {
    sessionLocked = false;
    evaluate();
  });
  powerMonitor.on('suspend', () => {
    sessionLocked = true;
    evaluate();
  });
  powerMonitor.on('resume', () => {
    sessionLocked = false;
    evaluate();
  });
  powerMonitor.on('on-battery', evaluate);
  powerMonitor.on('on-ac', evaluate);

  timer = setInterval(evaluate, 1000);
  evaluate();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, evaluate, setManualPause, isManuallyPaused, status };
