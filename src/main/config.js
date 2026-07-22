'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // displayId -> wallpaperId
  assignments: {},
  pauseOnFullscreen: true,
  // 'monitor' pauses only the display the fullscreen app is on; 'all' pauses everything
  pauseScope: 'monitor',
  pauseOnBattery: false,
  audioReactive: true,
  cursorTracking: true,
  // Wallpaper audio output volume, 0 = silent
  volume: 0,
  launchOnStartup: false
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'config.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  try {
    // Notepad and PowerShell's `Set-Content -Encoding utf8` both prepend a BOM,
    // which JSON.parse rejects. Hand-edited configs are expected here, so strip
    // it rather than silently resetting everything to defaults.
    const text = fs.readFileSync(file(), 'utf8').replace(/^﻿/, '');
    const raw = JSON.parse(text);
    cache = { ...DEFAULTS, ...raw, assignments: { ...raw.assignments } };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[config] ${file()} unreadable (${err.message}); using defaults`);
    }
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
}

function get(key) {
  return load()[key];
}

function set(patch) {
  Object.assign(load(), patch);
  save();
  return load();
}

function assign(displayId, wallpaperId) {
  const cfg = load();
  if (wallpaperId) cfg.assignments[String(displayId)] = wallpaperId;
  else delete cfg.assignments[String(displayId)];
  save();
  return cfg;
}

function assignmentFor(displayId) {
  return load().assignments[String(displayId)] || null;
}

module.exports = { DEFAULTS, load, get, set, assign, assignmentFor, save };
