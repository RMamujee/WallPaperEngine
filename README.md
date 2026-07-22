# WallpaperForge

An animated desktop wallpaper engine for Windows, in the spirit of Wallpaper
Engine. It renders WebGL/canvas scenes, looping video, and image slideshows
**behind your desktop icons**, and gets out of the way when you launch a game.

Built on Electron, so a wallpaper is just a web page.

```
npm install
npm start
npm run shortcuts   # Desktop + Start-menu icon (optional, Windows only)
```

A tray icon appears; double-click it (or use **Open library...**) to pick a
wallpaper per monitor.

`npm run shortcuts` writes a `WallpaperForge.lnk` to your Desktop and to the
Start menu, so the app launches like any installed program and shows up when you
type "WallpaperForge" in the taskbar search. The shortcuts carry the app's
AppUserModelID, which is what stops Windows filing it under a generic "Electron"
taskbar button. `npm run shortcuts -- --remove` deletes them again.

No packaging step is involved — the shortcut just points at the local
`electron.exe` with this folder as its argument, exactly like `npm start`. Move
the project folder and you'll need to re-run the command.

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
- **Living images** — a still painting animated with wind, drifting clouds,
  birds and pollen, driven entirely by a shader
- **Self-contained library** — added wallpapers are copied in, so they survive
  you moving or deleting the original file
- **Per-monitor** assignment, DPI-aware, survives monitor hot-plug
- **Pauses on fullscreen** — when a game or video player covers a monitor, that
  surface is hidden natively, so it costs no GPU. Optionally pause everything,
  or pause on battery
- **Audio reactive** — captures Windows loopback audio and streams a 32-band
  spectrum to wallpapers that want it
- **Cursor tracking** for parallax effects
- Tray menu, library UI, start-with-Windows

## Bundled wallpapers

Everything in `wallpapers/` ships with the repo and appears in the picker on a
fresh clone — no import step. Each is a plate (a still image) plus a shader or
canvas layer that animates only the parts that should move.

| Wallpaper | Type | What moves |
| --- | --- | --- |
| **Constellation** | web | Drifting particle network that pulses with the beat — the audio-reactive worked example |
| **Aerial Shore** | web | Palm crowns twisting in travelling gusts, a light swell washing up the sand, fish shadows in the turquoise shallows |
| **Knight in the Meadow** | living | Wind through the wildflowers, drifting cloud, birds over the peak |
| **Konbini Night** | web | Pixel-art vending machines: humming fluorescent light, glowing shelves, snow falling onto the pavement |
| **Neon Tokyo** | web | Cloud bands drift across a golden-hour sunset; lit windows breathe, some switch off and back on, signage shimmers |
| **Rainy Corner** | web | Layered rain over a blue night corner — the wet road ripples and splashes while the traffic light cycles |
| **Red Cloud Shore** | web | Woodblock seascape: swell along the painted surf lines, foam running up the coral sand, salmon cumulus drifting |

They are ordinary folders, so they double as reference material: open any
`wallpaper.json` to see a fully tuned property set, or its `index.html` for the
shader that consumes it.

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

`wallpapers/particles` (a canvas particle network) is a complete worked example.

### Other types

`"type": "video"` with `"source": "media/loop.mp4"`, or `"type": "slideshow"`
with `"folder": "media"`. Both are rendered by built-in host pages, so they
accept `properties` too — `fit`, `playbackRate` for video; `interval`,
`transition`, `kenBurns`, `shuffle` for slideshows. Paths may be absolute or
relative to the wallpaper's own folder.

## Living images

`"type": "living"` animates a **still picture**: no video, no AI, just a shader
that moves parts of the image based on where they sit in the frame.

- below `horizon`, UVs are displaced by a travelling sum-of-sines, so grass and
  flowers sway; amplitude grows toward the bottom because foreground plants are
  nearer and larger
- the sway is gated on colour saturation, so grey rock and dirt inside the same
  band stay put while vegetation moves (`vegFloor` sets how much they still move)
- above `horizon`, bright cloud masses drift very slowly. This is deliberately
  gated on brightness: sliding a featureless blue sky shows no change anyway,
  and sliding the rock below it looks broken
- birds and pollen are drawn on a 2D overlay above the shader
- the cursor adds a few pixels of parallax

Add one from the picker's **+ Animated image** button, or from the CLI:

```
npm run living -- add "C:\pics\meadow.png" --name "Meadow Ride"
npm run living -- set meadow-ride --props-file tune.json
npm run living -- list
npm run living -- show meadow-ride
```

`--props-file` takes a JSON object of any of the properties below. It exists
because PowerShell 5.1 mangles double quotes when passing arguments to a native
executable, so inline `--props "{...}"` is unreliable on the only platform this
app runs on.

| Property | Default | What it does |
| --- | --- | --- |
| `fit` | `cover` | `cover` crops to fill, `contain` letterboxes, `blur` fills the gaps with a blurred blow-up of the image |
| `focus` | `[0.5, 0.5]` | which point of the image to keep when `cover` crops |
| `horizon` | `0.62` | image-space Y where vegetation starts. **The one value no default can guess** |
| `wind` | `0.007` | sway amplitude, in image UV units |
| `windSpeed` | `1` | time multiplier for the sway |
| `vegFloor` | `0.25` | how much non-vegetation still moves, 0 = only saturated pixels |
| `skyDrift` | `0.004` | cloud drift amplitude |
| `shimmer` | `0.012` | slow global brightness breathing |
| `parallax` | `0.012` | cursor parallax, 0 disables cursor polling |
| `vignette` / `saturate` / `brightness` | `0.18` / `1.04` / `1` | grading |
| `birds` | `7` | bird count, 0 = none |
| `birdBand` | `[0.08, 0.42]` | screen-space Y range they fly in |
| `birdSpeed` | `1` | multiplier |
| `motes` | `40` | drifting pollen specks in the lower half |

### Aspect ratio matters more than anything else here

The shader renders at your full display resolution, but it cannot invent detail
that is not in the source file. For a 2560x1600 screen, a **2560x1600 (16:10)**
source is what "fullscreen with good detail" actually requires.

A portrait image on a landscape screen has no good answer: `cover` throws away
most of the composition, `contain` leaves bars. `fit: "blur"` is the least-bad
option — the whole painting stays visible, centred, with its own blurred
blow-up filling the sides — but it is a mitigation, not a fix.

## Saving wallpapers

The library UI's **+ Video file**, **+ Image**, and **+ Image folder** buttons
copy what you pick into the wallpaper's own `media/` folder and write a manifest
that points at *that copy*:

```
%APPDATA%\WallpaperForge\wallpapers\
  ocean-loop\
    wallpaper.json      -> { "type": "video", "source": "media/ocean.mp4" }
    preview.jpg
    media\ocean.mp4
```

So a saved wallpaper keeps working after you move, rename, or delete the file
you originally picked — the library is self-contained, and switching between
saved wallpapers is just a click. The cost is disk space: a 500 MB video means
500 MB in the library. Deleting a wallpaper from the library (the **×** on its
card) removes its copied media too.

Thumbnails come for free on slideshows (the first image). For video there's no
frame to point at, so after the copy finishes the main process asks the open
picker window to decode one frame ~10% into the clip and hand back a JPEG, which
is saved as `preview.jpg`. It's best-effort — if the decode fails the card keeps
its generated gradient placeholder.

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
src/renderer/builtin/   picker UI + video/slideshow/living host pages
tools/
  make-icon.js          generates assets/app.ico
  install-shortcuts.js  Desktop + Start-menu .lnk files
  living.js             create/tune living-image wallpapers
wallpapers/     bundled wallpapers, shipped with the repo
```
