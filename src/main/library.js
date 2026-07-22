'use strict';
/**
 * Wallpaper library: scans the bundled `wallpapers/` folder plus the user's
 * own folder in %APPDATA%/WallpaperForge/wallpapers.
 *
 * Every wallpaper is a directory containing a `wallpaper.json` manifest:
 *
 *   {
 *     "name": "Nebula Flow",
 *     "type": "web" | "video" | "slideshow",
 *     "entry": "index.html",         // web only
 *     "source": "C:/clips/loop.mp4", // video only (abs path or relative to the folder)
 *     "folder": "images",            // slideshow only
 *     "preview": "preview.png",
 *     "audio": true,                 // wants audio spectrum data
 *     "cursor": true,                // wants cursor position
 *     "properties": { ... }          // free-form, handed to the wallpaper
 *   }
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.m4v', '.mov']);

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

/** Create a user wallpaper folder from a picked video file or image folder. */
function importSource(kind, sourcePath) {
  const root = userRoot();
  fs.mkdirSync(root, { recursive: true });
  const label = path.basename(sourcePath, kind === 'video' ? path.extname(sourcePath) : '');
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'imported';

  let dirName = slug;
  let n = 2;
  while (fs.existsSync(path.join(root, dirName))) dirName = `${slug}-${n++}`;

  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const manifest =
    kind === 'video'
      ? { name: label, type: 'video', source: sourcePath, audio: false, cursor: false }
      : { name: label, type: 'slideshow', folder: sourcePath, audio: false, cursor: false };

  fs.writeFileSync(path.join(dir, 'wallpaper.json'), JSON.stringify(manifest, null, 2));
  return `user:${dirName}`;
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
  remove,
  builtinRoot,
  userRoot,
  mediaUrl,
  IMAGE_EXT,
  VIDEO_EXT
};
