'use strict';
/**
 * Wallpaper library: scans the bundled `wallpapers/` folder plus the user's
 * own folder in %APPDATA%/WallpaperForge/wallpapers.
 *
 * Every wallpaper is a directory containing a `wallpaper.json` manifest:
 *
 *   {
 *     "name": "Constellation",
 *     "type": "web" | "video" | "slideshow",
 *     "entry": "index.html",         // web only
 *     "source": "media/loop.mp4",    // video only (abs path or relative to the folder)
 *     "folder": "media",             // slideshow only
 *     "preview": "preview.jpg",
 *     "audio": true,                 // wants audio spectrum data
 *     "cursor": true,                // wants cursor position
 *     "properties": { ... }          // free-form, handed to the wallpaper
 *   }
 *
 * Imported wallpapers own their media: the picked video/images are COPIED into
 * the wallpaper's own `media/` folder and the manifest points at that copy with
 * a relative path. Deleting or moving the file you originally picked therefore
 * can't break a saved wallpaper.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.m4v', '.mov']);

/** Starting properties for a `living` wallpaper; see renderer/builtin/living.html. */
const LIVING_DEFAULTS = {
  fit: 'cover',
  focus: [0.5, 0.5],
  horizon: 0.62,
  wind: 0.007,
  windSpeed: 1,
  vegFloor: 0.25,
  earthGuard: 0.85,
  calm: [],
  skyDrift: 0.004,
  shimmer: 0.012,
  parallax: 0.012,
  vignette: 0.18,
  saturate: 1.04,
  brightness: 1,
  birds: 7,
  birdBand: [0.08, 0.42],
  birdSpeed: 1,
  motes: 40
};

function builtinRoot() {
  return path.join(app.getAppPath(), 'wallpapers');
}

function userRoot() {
  return path.join(app.getPath('userData'), 'wallpapers');
}

function roots() {
  return [
    { dir: builtinRoot(), builtin: true },
    { dir: userRoot(), builtin: false }
  ];
}

function readManifest(dir) {
  const manifestPath = path.join(dir, 'wallpaper.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function listImages(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function scan() {
  const out = [];
  for (const { dir, builtin } of roots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const wpDir = path.join(dir, entry.name);
      const manifest = readManifest(wpDir);
      if (!manifest) continue;
      const id = `${builtin ? 'builtin' : 'user'}:${entry.name}`;
      out.push({
        id,
        dirName: entry.name,
        dir: wpDir,
        builtin,
        name: manifest.name || entry.name,
        type: manifest.type || 'web',
        author: manifest.author || '',
        description: manifest.description || '',
        entry: manifest.entry || 'index.html',
        source: manifest.source || '',
        folder: manifest.folder || '',
        preview: manifest.preview ? path.join(wpDir, manifest.preview) : null,
        audio: manifest.audio !== false,
        cursor: manifest.cursor !== false,
        properties: manifest.properties || {}
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function byId(id) {
  return scan().find((w) => w.id === id) || null;
}

function resolveRelative(wallpaper, value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(wallpaper.dir, value);
}

/** Build a wf://media URL for an absolute path on disk. */
function mediaUrl(absolutePath) {
  return `wf://media/${encodeURIComponent(absolutePath)}`;
}

/**
 * Turn a library entry into everything the renderer needs: which page to load
 * and what payload that page should receive.
 */
function resolveForRender(wallpaper) {
  if (!wallpaper) return null;
  const base = {
    id: wallpaper.id,
    name: wallpaper.name,
    type: wallpaper.type,
    audio: wallpaper.audio,
    cursor: wallpaper.cursor,
    properties: wallpaper.properties
  };

  if (wallpaper.type === 'video') {
    const file = resolveRelative(wallpaper, wallpaper.source);
    return { ...base, url: 'wf://builtin/video.html', payload: { source: mediaUrl(file) } };
  }

  // A still image animated by the living-image shader (wind, sky drift, birds).
  if (wallpaper.type === 'living') {
    const file = resolveRelative(wallpaper, wallpaper.source);
    return { ...base, url: 'wf://builtin/living.html', payload: { source: mediaUrl(file) } };
  }

  if (wallpaper.type === 'slideshow') {
    const dir = wallpaper.folder ? resolveRelative(wallpaper, wallpaper.folder) : wallpaper.dir;
    return {
      ...base,
      url: 'wf://builtin/slideshow.html',
      payload: { images: listImages(dir).map(mediaUrl) }
    };
  }

  // Default: a web wallpaper served from its own folder.
  const entry = String(wallpaper.entry || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
  const scope = wallpaper.builtin ? 'builtin' : 'user';
  return {
    ...base,
    url: `wf://wallpaper/${scope}/${encodeURIComponent(wallpaper.dirName)}/${entry}`,
    payload: {}
  };
}

function slugify(label) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'imported'
  );
}

/** Strip anything Windows won't accept in a filename, keeping the extension. */
function safeFileName(name) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

/** Reserve an unused directory under the user library for `slug`. */
function reserveDir(root, slug) {
  let dirName = slug;
  let n = 2;
  while (fs.existsSync(path.join(root, dirName))) dirName = `${slug}-${n++}`;
  return { dirName, dir: path.join(root, dirName) };
}

/**
 * Copy `files` into `destDir`, de-duplicating names so two sources that happen
 * to share a basename don't overwrite each other. Returns the new basenames in
 * the same order.
 */
async function copyAll(files, destDir, onProgress) {
  const used = new Set();
  const names = [];

  for (let i = 0; i < files.length; i++) {
    const ext = path.extname(files[i]);
    const stem = safeFileName(path.basename(files[i], ext));
    let name = `${stem}${ext}`;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${stem}-${n++}${ext}`;
    used.add(name.toLowerCase());

    await fs.promises.copyFile(files[i], path.join(destDir, name));
    names.push(name);
    if (onProgress) onProgress(i + 1, files.length);
  }
  return names;
}

/**
 * Create a user wallpaper from a picked video, single image, or image folder.
 * The media is copied into the new wallpaper's `media/` folder so the saved
 * wallpaper no longer depends on wherever the file came from.
 *
 * Async and non-blocking: a multi-gigabyte video must not freeze the desktop.
 */
async function importSource(kind, sourcePath, onProgress) {
  const root = userRoot();
  await fs.promises.mkdir(root, { recursive: true });

  const isFolder = kind === 'folder';
  const label = isFolder
    ? path.basename(sourcePath)
    : path.basename(sourcePath, path.extname(sourcePath));

  const { dirName, dir } = reserveDir(root, slugify(label));
  const mediaDir = path.join(dir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });

  let manifest;
  try {
    if (kind === 'living') {
      const [name] = await copyAll([sourcePath], mediaDir, onProgress);
      manifest = {
        name: label,
        type: 'living',
        source: `media/${name}`,
        preview: `media/${name}`,
        audio: false,
        cursor: true,
        // Neutral starting point. A per-image tuning pass overwrites these —
        // `horizon` especially, since it is the one value no default can guess.
        properties: { ...LIVING_DEFAULTS }
      };
    } else if (kind === 'video') {
      const [name] = await copyAll([sourcePath], mediaDir, onProgress);
      manifest = {
        name: label,
        type: 'video',
        source: `media/${name}`,
        audio: false,
        cursor: false
      };
    } else {
      const images = isFolder ? listImages(sourcePath) : [sourcePath];
      if (!images.length) throw new Error(`No images found in ${sourcePath}`);

      const names = await copyAll(images, mediaDir, onProgress);
      manifest = {
        name: label,
        type: 'slideshow',
        folder: 'media',
        // The first frame is a free, always-correct thumbnail.
        preview: `media/${names[0]}`,
        audio: false,
        cursor: false
      };
    }
  } catch (err) {
    // Never leave a half-copied wallpaper in the library.
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  await fs.promises.writeFile(path.join(dir, 'wallpaper.json'), JSON.stringify(manifest, null, 2));
  return `user:${dirName}`;
}

/**
 * Attach a thumbnail to a saved wallpaper. `buffer` is raw JPEG bytes captured
 * from the renderer (see `wf:ui-poster`); best effort, never fatal.
 */
function setPreview(id, buffer) {
  const wp = byId(id);
  if (!wp || wp.builtin) return false;
  try {
    fs.writeFileSync(path.join(wp.dir, 'preview.jpg'), buffer);
    const manifest = readManifest(wp.dir) || {};
    manifest.preview = 'preview.jpg';
    fs.writeFileSync(path.join(wp.dir, 'wallpaper.json'), JSON.stringify(manifest, null, 2));
    return true;
  } catch (err) {
    console.error('[library] preview save failed:', err.message);
    return false;
  }
}

function remove(id) {
  const wp = byId(id);
  if (!wp || wp.builtin) return false;
  fs.rmSync(wp.dir, { recursive: true, force: true });
  return true;
}

module.exports = {
  scan,
  byId,
  resolveForRender,
  importSource,
  setPreview,
  remove,
  LIVING_DEFAULTS,
  builtinRoot,
  userRoot,
  mediaUrl,
  IMAGE_EXT,
  VIDEO_EXT
};
