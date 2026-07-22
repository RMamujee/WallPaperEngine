'use strict';
/**
 * Composite a rectangular region from one image onto another, matching tone and
 * feathering the seam.
 *
 *   npm run patch -- <base> <patch> --rect "x,y,w,h" --out <path> [--feather 16]
 *
 * Exists because gpt-image edits are not a masked composite: asking the API to
 * erase one object re-renders the entire frame, so everything else drifts too
 * (lighting dies, small figures vanish). The fix is to keep the good plate and
 * take only the repaired rectangle from the regenerated one.
 *
 * Tone matching samples a ring just outside the rect in both images and shifts
 * the patch by the difference, so a globally darker regeneration still drops in
 * seamlessly.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

const dataUrl = (file) =>
  `data:image/${path.extname(file).slice(1) || 'png'};base64,${fs.readFileSync(file).toString('base64')}`;

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const argv = process.argv.slice(2).filter((a) => !a.endsWith('patch-region.js'));
  const { positional, flags } = parseArgs(argv);

  try {
    const [base, patch] = positional;
    if (!base || !patch) throw new Error('usage: <base> <patch> --rect "x,y,w,h" --out <path>');
    if (!flags.rect) throw new Error('--rect is required (normalised x,y,w,h)');
    for (const f of [base, patch]) if (!fs.existsSync(f)) throw new Error(`no such file: ${f}`);

    const rect = flags.rect.split(',').map(Number);
    if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) throw new Error(`bad rect: ${flags.rect}`);

    const out = flags.out || path.join(app.getPath('temp'), 'patched.png');
    const feather = Number(flags.feather || 16);

    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
    });
    await win.loadURL('data:text/html,<html><body></body></html>');

    const result = await win.webContents.executeJavaScript(`(async () => {
      const load = (src) => new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode failed'));
        i.src = src;
      });

      const baseImg = await load(${JSON.stringify(dataUrl(base))});
      const patchImg = await load(${JSON.stringify(dataUrl(patch))});
      if (baseImg.width !== patchImg.width || baseImg.height !== patchImg.height) {
        throw new Error('base and patch must be the same size ('
          + baseImg.width + 'x' + baseImg.height + ' vs ' + patchImg.width + 'x' + patchImg.height + ')');
      }

      const W = baseImg.width, H = baseImg.height;
      const [rx, ry, rw, rh] = ${JSON.stringify(rect)};
      const x = Math.round(rx * W), y = Math.round(ry * H);
      const w = Math.round(rw * W), h = Math.round(rh * H);
      const F = ${feather};

      const ctxOf = (img) => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
        return c.getContext('2d', { willReadFrequently: true });
      };
      const baseCtx = ctxOf(baseImg);
      const patchCtx = ctxOf(patchImg);

      // Mean colour of a ring just outside the rect, in both images.
      const ring = (ctx) => {
        const pad = 24;
        const gx = Math.max(0, x - pad), gy = Math.max(0, y - pad);
        const gw = Math.min(W - gx, w + pad * 2), gh = Math.min(H - gy, h + pad * 2);
        const outer = ctx.getImageData(gx, gy, gw, gh).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let py = 0; py < gh; py++) {
          for (let px = 0; px < gw; px++) {
            const insideX = gx + px >= x && gx + px < x + w;
            const insideY = gy + py >= y && gy + py < y + h;
            if (insideX && insideY) continue;
            const i = (py * gw + px) * 4;
            r += outer[i]; g += outer[i + 1]; b += outer[i + 2]; n++;
          }
        }
        return [r / n, g / n, b / n];
      };

      const baseRing = ring(baseCtx);
      const patchRing = ring(patchCtx);
      const shift = [baseRing[0] - patchRing[0], baseRing[1] - patchRing[1], baseRing[2] - patchRing[2]];

      // Pull the patch rect, tone-shift it, and feather its alpha at the edges.
      const region = patchCtx.getImageData(x, y, w, h);
      const d = region.data;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4;
          d[i]     = Math.max(0, Math.min(255, d[i]     + shift[0]));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + shift[1]));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + shift[2]));
          const edge = Math.min(px, py, w - 1 - px, h - 1 - py);
          d[i + 3] = Math.round(255 * Math.min(1, edge / F));
        }
      }

      const scratch = document.createElement('canvas');
      scratch.width = w; scratch.height = h;
      scratch.getContext('2d').putImageData(region, 0, 0);

      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const oc = out.getContext('2d');
      oc.drawImage(baseImg, 0, 0);
      oc.drawImage(scratch, x, y);

      return {
        dataUrl: out.toDataURL('image/png'),
        size: W + 'x' + H,
        rect: [x, y, w, h].join(','),
        shift: shift.map((s) => Math.round(s)).join(',')
      };
    })()`);

    win.destroy();

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(result.dataUrl.split(',')[1], 'base64'));
    console.log(`patched ${result.size}, rect ${result.rect}, tone shift rgb ${result.shift}`);
    console.log(`saved ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
    app.exit(0);
  } catch (err) {
    console.error(`error: ${err.message}`);
    app.exit(1);
  }
});
