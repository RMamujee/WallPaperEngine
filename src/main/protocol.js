'use strict';
/**
 * Custom `wf://` scheme. Wallpapers are served over it rather than file:// so
 * that pages get a real secure origin (fetch, workers, WebGL extensions and
 * crypto all behave) while still living on disk.
 *
 *   wf://builtin/video.html                 -> bundled host pages
 *   wf://wallpaper/builtin/nebula/index.html -> a library wallpaper's own files
 *   wf://media/<uri-encoded-absolute-path>   -> user media (video/images)
 *
 * Range requests are implemented by hand so <video> can seek and loop cleanly.
 */

const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
const { Readable } = require('stream');
const library = require('./library');

const SCHEME = 'wf';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glsl': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ]);
}

/** Join user-controlled segments onto a root without letting them escape it. */
function safeJoin(root, segments) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

function notFound(reason) {
  return new Response(`Not found: ${reason}`, { status: 404, headers: { 'content-type': 'text/plain' } });
}

function serveFile(filePath, request) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return notFound(filePath);
  }
  if (stat.isDirectory()) return serveFile(path.join(filePath, 'index.html'), request);

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${stat.size}` }
        });
      }
      const last = Math.min(end, stat.size - 1);
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end: last }));
      return new Response(stream, {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(last - start + 1),
          'content-range': `bytes ${start}-${last}/${stat.size}`,
          'accept-ranges': 'bytes'
        }
      });
    }
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: {
      'content-type': type,
      'content-length': String(stat.size),
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache'
    }
  });
}

function handle(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return notFound(request.url);
  }

  const host = url.hostname;
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (host === 'builtin') {
    const target = safeJoin(path.join(__dirname, '..', 'renderer', 'builtin'), segments);
    return target ? serveFile(target, request) : notFound('builtin');
  }

  if (host === 'wallpaper') {
    const [scope, dirName, ...rest] = segments;
    if (!scope || !dirName) return notFound('wallpaper path');
    const root = scope === 'user' ? library.userRoot() : library.builtinRoot();
    const wallpaperDir = safeJoin(root, [dirName]);
    if (!wallpaperDir) return notFound('wallpaper dir');
    const target = safeJoin(wallpaperDir, rest.length ? rest : ['index.html']);
    return target ? serveFile(target, request) : notFound('wallpaper file');
  }

  if (host === 'media') {
    const raw = segments.join(path.sep);
    if (!raw) return notFound('media path');
    return serveFile(path.normalize(raw), request);
  }

  return notFound(host);
}

function serve() {
  protocol.handle(SCHEME, handle);
}

module.exports = { registerScheme, serve, SCHEME };
