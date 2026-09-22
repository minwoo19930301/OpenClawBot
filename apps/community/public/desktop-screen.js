// Fullscreen and orientation locking require a user gesture and browser support.
export async function enterDesktopScreen(element, orientation = globalThis.screen?.orientation) {
  let fullscreen = false, landscape = false;
  try { if (element.requestFullscreen) { await element.requestFullscreen(); fullscreen = true; } } catch {}
  try { if (orientation?.lock) { await orientation.lock('landscape'); landscape = true; } } catch {}
  return { fullscreen, landscape };
}
export function configureDesktopInput(rfb, viewOnly = false) {
  rfb.viewOnly = viewOnly;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  // Preserve noVNC touch gestures: longpress -> right click, two-drag -> wheel,
  // pinch -> Ctrl+wheel (remote application/page zoom), one-drag -> mouse drag.
  rfb.dragViewport = false;
  rfb.focusOnClick = true;
}
