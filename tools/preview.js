'use strict';
/**
 * Render any wallpaper offscreen and save frames as PNGs, so a wallpaper can be
 * inspected without putting an unverified one on the real desktop.
 *
 *   npm run preview -- knight-meadow
 *   npm run preview -- knight-meadow --out C:\tmp\shot --gap 3000 --size 1280x800
 *
 * Writes <out>-a.png and <out>-b.png, then reports:
 *   - any error the wallpaper page surfaced
 *   - whether the two frames differ at all (a static frame means nothing is
 *     animating, which a screenshot alone will not tell you)
 *   - mean pixel delta per horizontal band, which is how you check that the
 *     motion is where you intended it rather than merely present
 *
 * This exists because a broken shader renders a *silently black* wallpaper:
 * there is no exception, no console error, just a dark desktop.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const pkg = require('../package.json');
app.setName(pkg.name);
app.setPath('userData', path.join(app.getPath('appData'), pkg.name));

const library = require('../src/main/library');
const protocolServer = require('../src/main/protocol');

// Same switches the real app uses; without them a wallpaper surface is treated
// as occluded and stops painting.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocolServer.registerScheme();

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  protocolServer.serve();

  const argv = process.argv.slice(2).filter((a) => !a.endsWith('preview.js'));
  const { positional, flags } = parseArgs(argv);
  const key = positional[0];

  if (!key) {
    console.log('usage: npm run preview -- <wallpaper-dir-name> [--out <prefix>] [--gap <ms>] [--size WxH]');
    return app.exit(1);
  }

  const wallpaper = library.byId(key.includes(':') ? key : `user:${key}`) || library.byId(`builtin:${key}`);
  if (!wallpaper) {
    console.error(`no wallpaper "${key}"`);
    return app.exit(1);
  }

  const [w, h] = String(flags.size || '1280x800').split('x').map(Number);
  const gap = Number(flags.gap || 2200);
  const out = flags.out || path.join(app.getPath('temp'), `wf-preview-${wallpaper.dirName}`);

  const resolved = library.resolveForRender(wallpaper);
  console.log(`wallpaper : ${wallpaper.id} (${wallpaper.type})`);
  console.log(`url       : ${resolved.url}`);

  const config = {
    displayId: 1,
    paused: false,
    volume: 0,
    wallpaper: {
      name: resolved.name,
      type: resolved.type,
      properties: resolved.properties,
      payload: resolved.payload
    }
  };

  const win = new BrowserWindow({
    width: w,
    height: h,
    // Hidden windows hand back black captures for GPU content, so render it for
    // real but park it outside the visible desktop.
    x: -(w + 320),
    y: 0,
    show: true,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: [`--wf-config=${encodeURIComponent(JSON.stringify(config))}`]
    }
  });

  const pageLogs = [];
  win.webContents.on('console-message', (_e, _level, message) => {
    if (!message.includes('Electron Security Warning')) pageLogs.push(message);
  });

  await win.loadURL(resolved.url);
  await sleep(2500);

  const diagnostics = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('error');
    const shown = box && getComputedStyle(box).display !== 'none';
    return { errorShown: !!shown, errorText: shown ? box.textContent : null };
  })()`).catch((err) => ({ errorShown: true, errorText: `executeJavaScript failed: ${err.message}` }));

  for (const message of pageLogs) console.log(`[page] ${message}`);

  if (diagnostics.errorShown) {
    console.error(`PAGE ERROR: ${diagnostics.errorText}`);
    win.destroy();
    return app.exit(1);
  }

  const first = await win.webContents.capturePage();
  fs.writeFileSync(`${out}-a.png`, first.toPNG());
  await sleep(gap);
  const second = await win.webContents.capturePage();
  fs.writeFileSync(`${out}-b.png`, second.toPNG());

  const size = first.getSize();
  console.log(`captured  : ${size.width}x${size.height}`);
  console.log(`saved     : ${out}-a.png, ${out}-b.png`);

  const a = first.toBitmap();
  const b = second.toBitmap();

  let lit = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] > 8 || a[i + 1] > 8 || a[i + 2] > 8) lit++;
  }
  console.log(`non-black : ${Math.round((lit / (a.length / 4)) * 100)}%`);
  console.log(Buffer.compare(a, b) === 0 ? 'motion    : STATIC (nothing is animating)' : 'motion    : ANIMATING');

  const BANDS = 5;
  const rows = Math.floor(size.height / BANDS);
  for (let band = 0; band < BANDS; band++) {
    let sum = 0;
    let n = 0;
    for (let y = band * rows; y < (band + 1) * rows; y++) {
      for (let x = 0; x < size.width; x += 3) {
        const i = (y * size.width + x) * 4;
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]);
        n += 2;
      }
    }
    console.log(
      `band y ${(band / BANDS).toFixed(1)}-${((band + 1) / BANDS).toFixed(1)} : mean delta ${(sum / n).toFixed(2)}`
    );
  }

  win.destroy();
  app.exit(0);
});
