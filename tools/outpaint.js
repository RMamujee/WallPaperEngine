'use strict';
/**
 * Turn a portrait image into a landscape wallpaper plate using the OpenAI
 * images API.
 *
 *   npm run outpaint -- extend  <image> --out plate.png --prompt "..."
 *   npm run outpaint -- create  --out plate.png --prompt "..." --size 2560x1600
 *
 * `extend` pads the source onto a landscape canvas and asks the model to fill
 * the empty sides (/v1/images/edits with a mask). `create` generates a fresh
 * plate from a prompt alone (/v1/images/generations).
 *
 * IMPORTANT, and the reason `create` exists at all: gpt-image edits are not a
 * pixel-level composite. The model re-renders the whole frame, so the middle of
 * an `extend` result is a *re-interpretation* of the source, not the original
 * pixels carried through untouched. Expect the subject to shift slightly.
 *
 * gpt-image-2 accepts an arbitrary WIDTHxHEIGHT, which is what makes a native
 * 2560x1600 plate possible; gpt-image-1 is limited to 1536x1024 and would need
 * upscaling. The model falls back automatically if the requested size is
 * rejected.
 *
 * Needs OPENAI_API_KEY in the environment.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const API = 'https://api.openai.com/v1';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in this process environment');
  return key;
}

/**
 * Composites the source onto a landscape canvas and builds the matching mask.
 * Runs in a renderer because that is the only canvas available here.
 *
 * The mask is OPAQUE over the source and TRANSPARENT everywhere else: the API
 * edits the fully-transparent regions, which are exactly the new side panels.
 */
async function buildPlate(sourcePath, width, height) {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const sourceData = `data:image/${path.extname(sourcePath).slice(1) || 'png'};base64,${fs
    .readFileSync(sourcePath)
    .toString('base64')}`;

  const result = await win.webContents.executeJavaScript(`(async () => {
    const W = ${width}, H = ${height};
    const image = new Image();
    await new Promise((res, rej) => {
      image.onload = res;
      image.onerror = () => rej(new Error('could not decode source image'));
      image.src = ${JSON.stringify(sourceData)};
    });

    // Fit the source to the canvas height, centred, leaving the sides empty.
    const scale = H / image.height;
    const w = Math.round(image.width * scale);
    const x = Math.round((W - w) / 2);

    const plate = document.createElement('canvas');
    plate.width = W; plate.height = H;
    const pc = plate.getContext('2d');
    pc.clearRect(0, 0, W, H);
    pc.drawImage(image, x, 0, w, H);

    const mask = document.createElement('canvas');
    mask.width = W; mask.height = H;
    const mc = mask.getContext('2d');
    mc.clearRect(0, 0, W, H);
    // Opaque = keep. Inset slightly so the model can blend across the seam
    // instead of butting new content hard against the original edge.
    const inset = Math.round(w * 0.04);
    mc.fillStyle = '#000000';
    mc.fillRect(x + inset, 0, Math.max(1, w - inset * 2), H);

    return {
      plate: plate.toDataURL('image/png'),
      mask: mask.toDataURL('image/png'),
      sourceWidth: image.width,
      sourceHeight: image.height,
      placedWidth: w,
      newPixelsPercent: Math.round((1 - w / W) * 100)
    };
  })()`);

  win.destroy();
  return {
    ...result,
    plateBuffer: Buffer.from(result.plate.split(',')[1], 'base64'),
    maskBuffer: Buffer.from(result.mask.split(',')[1], 'base64')
  };
}

/**
 * Builds an image + mask for erasing regions of an existing plate. Rects are
 * normalised `x,y,w,h` in 0..1. The mask is transparent inside them (edit) and
 * opaque everywhere else (keep), which is the inverse of the outpaint mask.
 *
 * Used to remove a fixed object from a plate so an animated version of it can
 * be drawn on top instead.
 */
async function buildErase(sourcePath, rects) {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('data:text/html,<html><body></body></html>');

  const sourceData = `data:image/${path.extname(sourcePath).slice(1) || 'png'};base64,${fs
    .readFileSync(sourcePath)
    .toString('base64')}`;

  const result = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    await new Promise((res, rej) => {
      image.onload = res;
      image.onerror = () => rej(new Error('could not decode source image'));
      image.src = ${JSON.stringify(sourceData)};
    });
    const W = image.width, H = image.height;

    const plate = document.createElement('canvas');
    plate.width = W; plate.height = H;
    plate.getContext('2d').drawImage(image, 0, 0);

    const mask = document.createElement('canvas');
    mask.width = W; mask.height = H;
    const mc = mask.getContext('2d');
    mc.fillStyle = '#000000';
    mc.fillRect(0, 0, W, H);
    mc.globalCompositeOperation = 'destination-out';
    for (const r of ${JSON.stringify(rects)}) {
      mc.fillRect(Math.round(r[0] * W), Math.round(r[1] * H), Math.round(r[2] * W), Math.round(r[3] * H));
    }

    return { plate: plate.toDataURL('image/png'), mask: mask.toDataURL('image/png'), width: W, height: H };
  })()`);

  win.destroy();
  return {
    ...result,
    plateBuffer: Buffer.from(result.plate.split(',')[1], 'base64'),
    maskBuffer: Buffer.from(result.mask.split(',')[1], 'base64')
  };
}

async function callApi(endpoint, form) {
  // Large renders routinely run for minutes; without a heartbeat this looks
  // identical to a hang.
  const started = Date.now();
  const beat = setInterval(
    () => console.log(`  ... still waiting (${Math.round((Date.now() - started) / 1000)}s)`),
    15000
  );

  let response;
  try {
    response = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}` },
      body: form,
      signal: AbortSignal.timeout(Number(process.env.WF_OUTPAINT_TIMEOUT_MS) || 600000)
    });
  } finally {
    clearInterval(beat);
  }
  console.log(`  responded ${response.status} after ${Math.round((Date.now() - started) / 1000)}s`);
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error?.message || text;
    } catch {}
    const err = new Error(detail);
    err.status = response.status;
    throw err;
  }
  return JSON.parse(text);
}

function saveResult(payload, outPath) {
  const b64 = payload?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`no image in response: ${JSON.stringify(payload).slice(0, 400)}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`saved ${outPath} (${kb} KB)`);
  if (payload.usage) console.log(`usage: ${JSON.stringify(payload.usage)}`);
}

/** gpt-image-2 takes any WIDTHxHEIGHT; older models must fall back to a preset. */
const FALLBACK = { model: 'gpt-image-1', size: '1536x1024' };

async function extend({ positional, flags }) {
  const source = positional[0];
  if (!source) throw new Error('usage: extend <image> --out <path> --prompt "..."');
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`);
  if (!flags.prompt) throw new Error('--prompt is required: describe what belongs in the new side panels');

  const out = flags.out || path.join(app.getPath('temp'), 'plate.png');
  const size = flags.size || '2560x1600';
  const [width, height] = size.split('x').map(Number);

  const built = await buildPlate(source, width, height);
  console.log(
    `source ${built.sourceWidth}x${built.sourceHeight} -> ${size}; ` +
      `${built.newPixelsPercent}% of the frame must be invented`
  );

  const attempts = [
    { model: flags.model || 'gpt-image-2', size },
    FALLBACK
  ];

  for (const attempt of attempts) {
    // A preset-size fallback needs the plate rebuilt at those dimensions.
    const plate =
      attempt.size === size ? built : await buildPlate(source, ...attempt.size.split('x').map(Number));

    const form = new FormData();
    form.append('model', attempt.model);
    form.append('image', new Blob([plate.plateBuffer], { type: 'image/png' }), 'image.png');
    form.append('mask', new Blob([plate.maskBuffer], { type: 'image/png' }), 'mask.png');
    form.append('prompt', flags.prompt);
    form.append('size', attempt.size);
    form.append('quality', flags.quality || 'high');
    form.append('n', '1');

    try {
      console.log(
        `requesting ${attempt.model} at ${attempt.size} ` +
          `(plate ${Math.round(plate.plateBuffer.length / 1024)} KB, mask ${Math.round(plate.maskBuffer.length / 1024)} KB) ...`
      );
      saveResult(await callApi('images/edits', form), out);
      return;
    } catch (err) {
      console.error(`  ${attempt.model} failed (${err.status || '?'}): ${err.message}`);
      if (attempt === attempts[attempts.length - 1]) throw err;
      console.error('  falling back ...');
    }
  }
}

async function create({ flags }) {
  if (!flags.prompt) throw new Error('--prompt is required');
  const out = flags.out || path.join(app.getPath('temp'), 'plate.png');
  const size = flags.size || '2560x1600';

  const attempts = [{ model: flags.model || 'gpt-image-2', size }, FALLBACK];

  for (const attempt of attempts) {
    const form = new FormData();
    form.append('model', attempt.model);
    form.append('prompt', flags.prompt);
    form.append('size', attempt.size);
    form.append('quality', flags.quality || 'high');
    form.append('n', '1');

    try {
      console.log(`requesting ${attempt.model} at ${attempt.size} ...`);
      saveResult(await callApi('images/generations', form), out);
      return;
    } catch (err) {
      console.error(`  ${attempt.model} failed (${err.status || '?'}): ${err.message}`);
      if (attempt === attempts[attempts.length - 1]) throw err;
      console.error('  falling back ...');
    }
  }
}

/** Lists which image models this key can actually reach. */
async function models() {
  const response = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey()}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || JSON.stringify(body));
  const image = (body.data || []).map((m) => m.id).filter((id) => id.includes('image'));
  console.log(image.length ? image.sort().join('\n') : 'no image models visible to this key');
}

async function clean({ positional, flags }) {
  const source = positional[0];
  if (!source) throw new Error('usage: clean <image> --erase "x,y,w,h[;x,y,w,h]" --out <path> --prompt "..."');
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`);
  if (!flags.erase) throw new Error('--erase is required: normalised x,y,w,h rects separated by ";"');
  if (!flags.prompt) throw new Error('--prompt is required: describe what should replace the erased region');

  const rects = flags.erase.split(';').map((r) => {
    const nums = r.split(',').map(Number);
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error(`bad rect: ${r}`);
    return nums;
  });

  const out = flags.out || path.join(app.getPath('temp'), 'cleaned.png');
  const built = await buildErase(source, rects);
  const size = `${built.width}x${built.height}`;
  console.log(`erasing ${rects.length} region(s) from ${size}`);

  const form = new FormData();
  form.append('model', flags.model || 'gpt-image-2');
  form.append('image', new Blob([built.plateBuffer], { type: 'image/png' }), 'image.png');
  form.append('mask', new Blob([built.maskBuffer], { type: 'image/png' }), 'mask.png');
  form.append('prompt', flags.prompt);
  form.append('size', size);
  form.append('quality', flags.quality || 'high');
  form.append('n', '1');

  console.log(`requesting clean plate at ${size} ...`);
  saveResult(await callApi('images/edits', form), out);
}

const COMMANDS = { extend, create, clean, models };

// buildPlate destroys its renderer, and Electron quits the app by default once
// the last window closes. That killed the in-flight API request silently: exit
// code 0, no response, no file. Keep the process alive until we exit on purpose.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const argv = process.argv.slice(2).filter((a) => !a.endsWith('outpaint.js'));
  const { positional, flags } = parseArgs(argv);
  const command = COMMANDS[positional[0]];

  if (!command) {
    console.log('usage: npm run outpaint -- <extend|create|models> [...]');
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
