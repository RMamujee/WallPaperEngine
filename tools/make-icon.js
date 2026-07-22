'use strict';
/**
 * Generates assets/tray.png (tray icon) and assets/app.ico (shortcut / taskbar
 * icon) so the repo carries no binary blobs. Draws a soft cyan-to-violet orb
 * with a supersampled edge.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 3; // supersampling factor for antialiasing
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

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
  const g = Math.round(231 + (92 - 231) * t + highlight * 200);
  const b = 255;
  const fade = 1 - Math.pow(d, 6) * 0.25;
  return [Math.min(255, r), Math.min(255, Math.round(g * fade)), Math.min(255, b), 255];
}

function renderPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
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
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Vista-era ICO: each entry may hold a PNG payload verbatim. */
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, png: renderPng(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, i) => {
    const base = i * 16;
    directory[base] = image.size >= 256 ? 0 : image.size; // 0 means 256
    directory[base + 1] = image.size >= 256 ? 0 : image.size;
    directory[base + 2] = 0; // palette size
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const trayPath = path.join(outDir, 'tray.png');
fs.writeFileSync(trayPath, renderPng(64));
console.log(`wrote ${trayPath}`);

const icoPath = path.join(outDir, 'app.ico');
fs.writeFileSync(icoPath, buildIco(ICO_SIZES));
console.log(`wrote ${icoPath} (${ICO_SIZES.join(', ')})`);
