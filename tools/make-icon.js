'use strict';
/**
 * Generates assets/tray.png so the repo carries no binary blobs.
 * Draws a soft cyan-to-violet orb with a supersampled edge.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 64;
const SS = 3; // supersampling factor for antialiasing

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Colour at a point in the unit square, or null outside the orb. */
function sample(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy) / 0.46;
  if (d > 1) return null;

  // Diagonal gradient from cyan to violet, brightened toward the top-left.
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const highlight = Math.max(0, 1 - Math.hypot(u - 0.33, v - 0.3) * 1.9) * 0.45;
  const r = Math.round((110 + (124 - 110) * t) * (1 - t * 0.15) + highlight * 255);
  const g = Math.round((231 + (92 - 231) * t) + highlight * 200);
  const b = Math.round(255 + (255 - 255) * t);
  const fade = 1 - Math.pow(d, 6) * 0.25;
  return [Math.min(255, r), Math.min(255, Math.round(g * fade)), Math.min(255, b), 255];
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let offset = 0;
for (let y = 0; y < SIZE; y++) {
  raw[offset++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = sample((x + (sx + 0.5) / SS) / SIZE, (y + (sy + 0.5) / SS) / SIZE);
        if (px) {
          r += px[0];
          g += px[1];
          b += px[2];
          a += px[3];
        }
      }
    }
    const samples = SS * SS;
    const coverage = a / (samples * 255);
    raw[offset++] = coverage ? Math.round(r / (samples * coverage)) : 0;
    raw[offset++] = coverage ? Math.round(g / (samples * coverage)) : 0;
    raw[offset++] = coverage ? Math.round(b / (samples * coverage)) : 0;
    raw[offset++] = Math.round(coverage * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
