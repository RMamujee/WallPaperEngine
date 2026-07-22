'use strict';
/**
 * Create and tune `living` wallpapers from still images.
 *
 *   npm run living -- add "C:\pics\meadow.png" --name "Meadow Ride"
 *   npm run living -- add "C:\pics\meadow.png" --props-file tune.json
 *   npm run living -- set meadow-ride --props-file tune.json
 *   npm run living -- list
 *   npm run living -- show meadow-ride
 *
 * `add` never guesses well on its own: `horizon` (where vegetation starts) and
 * `fit` depend on what is actually in the picture. The intended workflow is to
 * add the image, look at it, then `set` the handful of values that matter, which
 * is exactly the loop an agent can run per image without touching any code.
 *
 * Runs under Electron because the library resolves paths via app.getPath.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// `electron tools/living.js` boots with Electron's default app name, so
// userData would resolve to %APPDATA%\Electron and this tool would quietly
// build a second, invisible library. Pin it to the same folder the app uses
// before anything calls getPath('userData').
const pkg = require('../package.json');
app.setName(pkg.name);
app.setPath('userData', path.join(app.getPath('appData'), pkg.name));

const library = require('../src/main/library');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

/** Accepts a bare directory name, or a full `user:<dir>` id. */
function findLiving(key) {
  const wanted = key.startsWith('user:') ? key : `user:${key}`;
  const wallpaper = library.byId(wanted);
  if (!wallpaper) throw new Error(`no wallpaper named "${key}" - try: npm run living -- list`);
  if (wallpaper.type !== 'living') throw new Error(`"${key}" is a ${wallpaper.type} wallpaper, not living`);
  return wallpaper;
}

function readManifest(wallpaper) {
  return JSON.parse(fs.readFileSync(path.join(wallpaper.dir, 'wallpaper.json'), 'utf8').replace(/^﻿/, ''));
}

function writeManifest(wallpaper, manifest) {
  fs.writeFileSync(path.join(wallpaper.dir, 'wallpaper.json'), JSON.stringify(manifest, null, 2));
}

/**
 * Reads tuning from `--props '{...}'` or `--props-file <path>`.
 *
 * The file form exists because PowerShell 5.1 mangles double quotes when it
 * passes arguments to a native executable, so inline JSON is unreliable on the
 * one platform this app runs on.
 */
function parseProps(raw, file) {
  if (file) {
    if (!fs.existsSync(file)) throw new Error(`no such props file: ${file}`);
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  }
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`props are not valid JSON: ${err.message}`);
  }

  const unknown = Object.keys(parsed).filter((k) => !(k in library.LIVING_DEFAULTS));
  if (unknown.length) {
    throw new Error(
      `unknown propert${unknown.length > 1 ? 'ies' : 'y'} ${unknown.join(', ')}\n` +
        `valid: ${Object.keys(library.LIVING_DEFAULTS).join(', ')}`
    );
  }
  return parsed;
}

async function add({ positional, flags }) {
  const source = positional[0];
  if (!source) throw new Error('usage: add <image> [--name "..."] [--props-file <path>]');
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`);

  const patch = parseProps(flags.props, flags['props-file']);
  const id = await library.importSource('living', source);
  const wallpaper = library.byId(id);

  if (flags.name || Object.keys(patch).length) {
    const manifest = readManifest(wallpaper);
    if (flags.name) manifest.name = flags.name;
    manifest.properties = { ...manifest.properties, ...patch };
    writeManifest(wallpaper, manifest);
  }

  const final = library.byId(id);
  console.log(`created  ${id}`);
  console.log(`name     ${final.name}`);
  console.log(`folder   ${final.dir}`);
  console.log(`props    ${JSON.stringify(final.properties)}`);
  console.log(`\nTune it with:  npm run living -- set ${final.dirName} --props-file <path>`);
}

function set({ positional, flags }) {
  const wallpaper = findLiving(positional[0] || '');
  const patch = parseProps(flags.props, flags['props-file']);
  if (!Object.keys(patch).length && !flags.name) throw new Error('nothing to change - pass --props-file or --name');

  const manifest = readManifest(wallpaper);
  if (flags.name) manifest.name = flags.name;
  manifest.properties = { ...manifest.properties, ...patch };
  writeManifest(wallpaper, manifest);

  console.log(`updated ${wallpaper.id}`);
  console.log(JSON.stringify(manifest.properties, null, 2));
  console.log('\nHit Reload in the picker to see it.');
}

function show({ positional }) {
  const wallpaper = findLiving(positional[0] || '');
  console.log(
    JSON.stringify(
      { id: wallpaper.id, name: wallpaper.name, dir: wallpaper.dir, properties: wallpaper.properties },
      null,
      2
    )
  );
}

function list() {
  const living = library.scan().filter((w) => w.type === 'living');
  if (!living.length) return console.log('no living wallpapers yet - npm run living -- add <image>');
  for (const w of living) console.log(`${w.dirName.padEnd(28)} ${w.name}`);
}

const COMMANDS = { add, set, show, list };

app.whenReady().then(async () => {
  // Electron keeps the script path in argv; drop it plus the exe.
  const argv = process.argv.slice(2).filter((a) => !a.endsWith('living.js'));
  const { positional, flags } = parseArgs(argv);
  const command = COMMANDS[positional[0]];

  if (!command) {
    console.log('usage: npm run living -- <add|set|show|list> [...]');
    return app.exit(positional[0] ? 1 : 0);
  }

  try {
    await command({ positional: positional.slice(1), flags });
    app.exit(0);
  } catch (err) {
    console.error(`error: ${err.message}`);
    app.exit(1);
  }
});
