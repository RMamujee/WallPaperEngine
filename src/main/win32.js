'use strict';
/**
 * Win32 interop for parenting windows into the desktop's WorkerW layer.
 *
 * Windows draws the desktop in a stack that looks roughly like this:
 *
 *   Progman  ("Program Manager", the desktop root)
 *     +-- WorkerW            <- icons live here (contains SHELLDLL_DefView)
 *     |     +-- SHELLDLL_DefView
 *     |           +-- SysListView32   (the icon grid)
 *     +-- WorkerW            <- EMPTY sibling; this is where wallpapers go
 *
 * That second, empty WorkerW only exists after Explorer has been nudged with
 * the undocumented message 0x052C. Once it exists we SetParent our render
 * windows into it, which puts them above the static wallpaper bitmap but
 * below the icons - exactly where Wallpaper Engine draws.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

// Pointer-sized integer used for HWND. koffi exposes uintptr_t on all the
// platforms we care about, but fall back to uint64 (x64/arm64) just in case.
let PTR = 'uint64';
try {
  koffi.sizeof('uintptr_t');
  PTR = 'uintptr_t';
} catch {
  /* keep uint64 */
}

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const FindWindowW = user32.func(`${PTR} __stdcall FindWindowW(const char16_t *cls, const char16_t *title)`);
const FindWindowExW = user32.func(
  `${PTR} __stdcall FindWindowExW(${PTR} parent, ${PTR} after, const char16_t *cls, const char16_t *title)`
);
const SendMessageTimeoutW = user32.func(
  `${PTR} __stdcall SendMessageTimeoutW(${PTR} hwnd, uint32_t msg, ${PTR} wParam, ${PTR} lParam, uint32_t flags, uint32_t timeout, void *result)`
);
const GetTopWindow = user32.func(`${PTR} __stdcall GetTopWindow(${PTR} hwnd)`);
const GetWindow = user32.func(`${PTR} __stdcall GetWindow(${PTR} hwnd, uint32_t cmd)`);
const GetClassNameW = user32.func(`int __stdcall GetClassNameW(${PTR} hwnd, uint16_t *buf, int max)`);
const SetParent = user32.func(`${PTR} __stdcall SetParent(${PTR} child, ${PTR} parent)`);
const SetWindowPos = user32.func(
  `bool __stdcall SetWindowPos(${PTR} hwnd, ${PTR} after, int x, int y, int cx, int cy, uint32_t flags)`
);
const GetForegroundWindow = user32.func(`${PTR} __stdcall GetForegroundWindow()`);
const GetWindowRect = user32.func(`bool __stdcall GetWindowRect(${PTR} hwnd, _Out_ RECT *rect)`);
const GetCursorPos = user32.func(`bool __stdcall GetCursorPos(_Out_ POINT *pt)`);
const IsWindow = user32.func(`bool __stdcall IsWindow(${PTR} hwnd)`);
const IsWindowVisible = user32.func(`bool __stdcall IsWindowVisible(${PTR} hwnd)`);
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const ShowWindow = user32.func(`bool __stdcall ShowWindow(${PTR} hwnd, int cmd)`);
const GetWindowLongPtrW = user32.func(`${PTR} __stdcall GetWindowLongPtrW(${PTR} hwnd, int index)`);
const SetWindowLongPtrW = user32.func(`${PTR} __stdcall SetWindowLongPtrW(${PTR} hwnd, int index, ${PTR} value)`);

const GW_HWNDNEXT = 2;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOCOPYBITS = 0x0100;
const SW_HIDE = 0;
const SW_SHOWNA = 8;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const SMTO_ABORTIFHUNG = 0x0002;

/** Handles come back as Number or BigInt depending on magnitude; this makes `if` checks safe. */
function nz(handle) {
  return handle !== null && handle !== undefined && Number(handle) !== 0;
}

/** Electron hands us the HWND as a raw buffer; turn it into something koffi accepts. */
function hwndFromBuffer(buf) {
  if (!buf || buf.length === 0) return 0;
  if (buf.length >= 8) {
    const v = buf.readBigUInt64LE(0);
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  return buf.readUInt32LE(0);
}

function className(hwnd) {
  const buf = new Uint16Array(256);
  const len = GetClassNameW(hwnd, buf, buf.length);
  if (len <= 0) return '';
  return Buffer.from(buf.buffer, 0, len * 2).toString('utf16le');
}

function windowRect(hwnd) {
  const r = {};
  if (!GetWindowRect(hwnd, r)) return null;
  return r;
}

function cursorPos() {
  const p = {};
  if (!GetCursorPos(p)) return null;
  return p;
}

function virtualScreen() {
  return {
    x: GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: GetSystemMetrics(SM_CYVIRTUALSCREEN)
  };
}

/**
 * Windows 11 layout. The wallpaper WorkerW is a *child* of Progman, sitting
 * directly below SHELLDLL_DefView in Z-order:
 *
 *   Progman
 *     +- SHELLDLL_DefView   (icons, on top)
 *     +- WorkerW            (wallpaper layer, underneath)  <- we want this
 */
function findWorkerWUnderProgman(progman) {
  const worker = FindWindowExW(progman, 0, 'WorkerW', null);
  return nz(worker) ? worker : 0;
}

/**
 * Windows 10 layout. SHELLDLL_DefView is hosted by a top-level WorkerW, and
 * the wallpaper layer is the *next* top-level WorkerW in Z-order. Walks the
 * window list with GetWindow so we never have to register an FFI callback.
 */
function findSiblingWorkerW() {
  let hwnd = GetTopWindow(0);
  let guard = 0;
  while (nz(hwnd) && guard++ < 5000) {
    if (nz(FindWindowExW(hwnd, 0, 'SHELLDLL_DefView', null))) {
      const worker = FindWindowExW(0, hwnd, 'WorkerW', null);
      if (nz(worker)) return worker;
    }
    hwnd = GetWindow(hwnd, GW_HWNDNEXT);
  }
  return 0;
}

function findWallpaperWorkerW(progman) {
  return findWorkerWUnderProgman(progman) || findSiblingWorkerW();
}

/**
 * Locate the window we should parent wallpapers into.
 *
 * `origin` is the host's top-left in screen pixels; child windows are placed
 * relative to it, which keeps multi-monitor setups correct no matter where
 * the virtual desktop starts.
 */
function resolveWallpaperHost() {
  const progman = FindWindowW('Progman', null);
  if (!nz(progman)) return { host: 0, kind: 'none', origin: { x: 0, y: 0 }, bottom: false };

  let worker = findWallpaperWorkerW(progman);

  // If neither layout is present yet, nudge Explorer into creating the layer.
  // Different builds expect different wParam/lParam pairs for 0x052C.
  if (!nz(worker)) {
    for (const [wParam, lParam] of [
      [0, 0],
      [0x0d, 0x01],
      [0x0d, 0x00]
    ]) {
      SendMessageTimeoutW(progman, 0x052c, wParam, lParam, SMTO_ABORTIFHUNG, 1000, null);
      worker = findWallpaperWorkerW(progman);
      if (nz(worker)) break;
    }
  }

  if (nz(worker)) {
    return { host: worker, kind: 'workerw', origin: originOf(worker), bottom: false };
  }

  // Last resort: parent straight into Progman. That works, but our window would
  // land on top of SHELLDLL_DefView, so it has to be pushed to the bottom of
  // the Z-order for the icons to stay visible.
  return { host: progman, kind: 'progman', origin: originOf(progman), bottom: true };
}

function originOf(hwnd) {
  const rect = windowRect(hwnd);
  if (rect) return { x: rect.left, y: rect.top };
  return { x: GetSystemMetrics(SM_XVIRTUALSCREEN), y: GetSystemMetrics(SM_YVIRTUALSCREEN) };
}

function attachToHost(childHwnd, hostHwnd) {
  if (!nz(childHwnd) || !nz(hostHwnd)) return false;
  return nz(SetParent(childHwnd, hostHwnd)) || true;
}

/**
 * Prepare a freshly re-parented window to behave as part of the desktop.
 *
 * Two separate fixes, both required:
 *
 *  - Extended styles keep it out of Alt-Tab, the taskbar and the activation
 *    chain, so it never steals focus.
 *  - The style flips from WS_POPUP to WS_CHILD. Chromium clamps popup windows
 *    to the monitor *work area*, which silently cropped a taskbar-sized strip
 *    off the bottom of every wallpaper and offset it by the invisible resize
 *    border. As a real child window, Windows honours the exact rect we ask for.
 */
function makeNonInteractive(hwnd) {
  try {
    const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);

    const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE));
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);

    // Styles only take effect once the frame is recalculated.
    SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  } catch {
    /* non-fatal */
  }
}

/**
 * Position a child of the wallpaper host. Coordinates are relative to the
 * host's client area, whose origin is the top-left of the virtual desktop -
 * negative when a monitor sits left of or above the primary one.
 *
 * When we had to fall back to Progman the window must also be forced to the
 * bottom of the Z-order, otherwise it covers the desktop icons.
 *
 * Deliberately does not touch visibility - callers own that, so repositioning
 * never resurrects a surface that is meant to be hidden or paused.
 */
function placeChild(hwnd, physicalBounds, host) {
  const origin = (host && host.origin) || virtualScreen();
  const sendToBottom = !!(host && host.bottom);
  return SetWindowPos(
    hwnd,
    sendToBottom ? HWND_BOTTOM : 0,
    physicalBounds.x - origin.x,
    physicalBounds.y - origin.y,
    physicalBounds.width,
    physicalBounds.height,
    (sendToBottom ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE | SWP_NOCOPYBITS
  );
}

/** True when the window already occupies exactly the requested screen rect. */
function matchesBounds(hwnd, physicalBounds) {
  const r = windowRect(hwnd);
  if (!r) return false;
  return (
    r.left === physicalBounds.x &&
    r.top === physicalBounds.y &&
    r.right - r.left === physicalBounds.width &&
    r.bottom - r.top === physicalBounds.height
  );
}

function hideWindow(hwnd) {
  return ShowWindow(hwnd, SW_HIDE);
}

function showWindowNoActivate(hwnd) {
  return ShowWindow(hwnd, SW_SHOWNA);
}

/** Shell surfaces that should never count as "a fullscreen app is running". */
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
  'ForegroundStaging',
  'MultitaskingViewFrame',
  'DV2ControlHost',
  'Progman_Fallback'
]);

function foregroundWindowInfo() {
  const hwnd = GetForegroundWindow();
  if (!nz(hwnd) || !IsWindowVisible(hwnd)) return null;
  const cls = className(hwnd);
  if (SHELL_CLASSES.has(cls)) return null;
  const rect = windowRect(hwnd);
  if (!rect) return null;
  return { hwnd, className: cls, rect };
}

module.exports = {
  nz,
  hwndFromBuffer,
  className,
  windowRect,
  cursorPos,
  virtualScreen,
  resolveWallpaperHost,
  findWallpaperWorkerW,
  attachToHost,
  makeNonInteractive,
  placeChild,
  matchesBounds,
  hideWindow,
  showWindowNoActivate,
  foregroundWindowInfo,
  isWindow: (h) => nz(h) && IsWindow(h)
};
