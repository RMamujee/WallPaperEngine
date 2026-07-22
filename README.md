# WallpaperForge

An animated desktop wallpaper engine for Windows, in the spirit of Wallpaper
Engine. It renders WebGL/canvas scenes, looping video, and image slideshows
**behind your desktop icons**, and gets out of the way when you launch a game.

Built on Electron, so a wallpaper is just a web page.

```
npm install
npm start
```

A tray icon appears; double-click it (or use **Open library...**) to pick a
wallpaper per monitor.

---

## How it works

Windows Explorer draws the desktop as a small window hierarchy. On Windows 11
it looks like this:

```
Progman  ("Program Manager")
  +- SHELLDLL_DefView        <- the icon grid, on top
  |    +- SysListView32
  +- WorkerW                 <- the wallpaper layer, underneath
```

WallpaperForge finds that `WorkerW` and `SetParent`s one borderless
`BrowserWindow` per monitor into it. That places our rendering above the static
wallpaper bitmap but below the icons, which is exactly where Wallpaper Engine
draws.

Windows 10 arranges things differently — `SHELLDLL_DefView` is hosted by a
*top-level* `WorkerW`, and the wallpaper layer is the next `WorkerW` sibling in
Z-order. Both layouts are handled, and if neither exists the engine nudges
Explorer with the undocumented `0x052C` message to create one. Failing even
that, it falls back to parenting into `Progman` and forcing itself to the
bottom of the Z-order so icons stay visible.

Three things fight you when you do this, and all three are handled in
`src/main/`:

| Problem | Fix |
| --- | --- |
| Chromium stops painting windows it thinks are hidden — and a window behind the icons *always* looks hidden | `disable-features=CalculateNativeWinOcclusion` plus `backgroundThrottling: false` |
| Chromium clamps `WS_POPUP` windows to the monitor **work area**, cropping a taskbar-sized strip off the bottom | after `SetParent`, the window style is switched to a real `WS_CHILD` |
| Explorer restarts, monitors change, Chromium re-asserts its own bounds | a 2s healing pass re-resolves the host and re-applies exact geometry |

## Features

- **Web / WebGL wallpapers** — any HTML page, with a small runtime API
- **Video wallpapers** — mp4 / webm / mkv, looped, with optional audio
- **Slideshows** — a folder of images with crossfade and Ken Burns drift
- **Per-monitor** assignment, DPI-aware, survives monitor hot-plug
- **Pauses on fullscreen** — when a game or video player covers a monitor, that
  surface is hidden natively, so it costs no GPU. Optionally pause everything,
  or pause on battery
- **Audio reactive** — captures Windows loopback audio and streams a 32-band
  spectrum to wallpapers that want it
- **Cursor tracking** for parallax effects
- Tray menu, library UI, start-with-Windows

## Writing a wallpaper

Create a folder under `%APPDATA%\WallpaperForge\wallpapers\<name>\` containing a
`wallpaper.json` and an `index.html`:

```json
{
  "name": "My Wallpaper",
  "type": "web",
  "entry": "index.html",
  "description": "shown in the library",
  "audio": true,
  "cursor": true,
  "properties": { "speed": 1.0 }
}
```

The page is served over `wf://` (a real secure origin, so `fetch`, workers and
crypto all behave) and gets `window.wallpaperForge`:

```js
const config = await wallpaperForge.getConfig();
// -> { displayId, paused, volume, wallpaper: { name, type, properties, payload } }

// Poll once per frame - cheap, always the latest values.
const { audio, cursor } = wallpaperForge.frame();
// audio  -> { bands: number[32], level, bass, mid, treble }   each 0..1
// cursor -> { x, y }  normalised 0..1 within this monitor

wallpaperForge.onPause((paused) => { /* stop your rAF loop */ });
wallpaperForge.onVolume((v) => { /* 0..1 */ });
```

**Always honour `onPause`** — stop your `requestAnimationFrame` loop when
paused. The window is hidden natively too, but a running rAF still burns CPU.

`wallpapers/nebula` (a domain-warped fbm shader) and `wallpapers/particles`
(a canvas particle network) are complete worked examples.

### Other types

`"type": "video"` with `"source": "C:/clips/loop.mp4"`, or `"type":
"slideshow"` with `"folder": "C:/pictures"`. Both are rendered by built-in host
pages, so they accept `properties` too — `fit`, `playbackRate` for video;
`interval`, `transition`, `kenBurns`, `shuffle` for slideshows. The library UI's
**+ Video file** / **+ Image folder** buttons just write these manifests for you.

## Configuration

`%APPDATA%\WallpaperForge\config.json` holds per-display assignments and
settings. It is safe to hand-edit (a UTF-8 BOM is tolerated); restart to apply.

## Known limitations

- **Windows only.** The whole approach depends on the Explorer `WorkerW` layer.
- **Wallpapers cannot receive mouse input.** The desktop swallows clicks, so
  interactive wallpapers are not supported — cursor *position* is provided
  instead, which covers parallax and cursor-reactive effects.
- Video playback is wired up and served with byte-range support, but has not
  been exercised against a real video file on this machine (no codec sample was
  available to test with).
- Audio capture uses `getDisplayMedia` loopback. If it fails, wallpapers simply
  receive zeroed spectrum data instead of breaking.

## Layout

```
src/main/
  index.js      app entry, IPC wiring
  win32.js      all Win32 interop: WorkerW resolution, parenting, geometry
  desktop.js    one surface per monitor; pause, healing, frame pump
  monitor.js    fullscreen / lock / battery detection
  library.js    wallpaper discovery + manifest resolution
  protocol.js   wf:// scheme with byte-range support
  audio.js      hidden loopback-capture window
  tray.js, picker.js, config.js
src/preload/    the wallpaperForge and library-UI bridges
src/renderer/builtin/   picker UI + video/slideshow host pages
wallpapers/     bundled example wallpapers
```
