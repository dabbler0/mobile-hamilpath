export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface ViewportBounds {
  minScale: number;
  maxScale: number;
}

/** Computes a viewport that centers a `w` x `h` board within an `availW` x `availH` area, clamped to sane zoom bounds. */
export function computeFitView(w: number, h: number, availW: number, availH: number, bounds: ViewportBounds): Viewport {
  const fitScale = Math.min(availW / w, availH / h);
  const scale = Math.max(bounds.minScale, Math.min(fitScale, 1.6));
  return {
    scale,
    tx: (availW - w * scale) / 2,
    ty: (availH - h * scale) / 2,
  };
}

/** Returns a new viewport zoomed to `newScale`, keeping the point under (wrapLocalX, wrapLocalY) stationary on screen. */
export function computeZoomAt(view: Viewport, wrapLocalX: number, wrapLocalY: number, newScale: number, bounds: ViewportBounds): Viewport {
  const clampedScale = Math.max(bounds.minScale, Math.min(bounds.maxScale, newScale));
  const localX = (wrapLocalX - view.tx) / view.scale;
  const localY = (wrapLocalY - view.ty) / view.scale;
  return {
    scale: clampedScale,
    tx: wrapLocalX - localX * clampedScale,
    ty: wrapLocalY - localY * clampedScale,
  };
}

/** Returns a new viewport panned by (dx, dy) screen pixels. */
export function computePan(view: Viewport, dx: number, dy: number): Viewport {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/** Converts client-space coordinates into canvas-internal pixel coordinates, undoing pan/zoom. */
export function toCanvasLocal(wrapLocalX: number, wrapLocalY: number, view: Viewport): [number, number] {
  return [(wrapLocalX - view.tx) / view.scale, (wrapLocalY - view.ty) / view.scale];
}

/** Inverse of `toCanvasLocal`: where a canvas-internal point lands in wrap-local (on-screen) pixels under the current pan/zoom. */
export function toWrapLocal(canvasLocalX: number, canvasLocalY: number, view: Viewport): [number, number] {
  return [canvasLocalX * view.scale + view.tx, canvasLocalY * view.scale + view.ty];
}

/**
 * Returns a view panned by the minimal amount needed to bring a
 * canvas-internal point back within `margin` on-screen pixels of every edge
 * of an `availW` x `availH` viewport — used to keep the keyboard cursor
 * on-screen as it's moved around a board that doesn't fully fit the
 * viewport (`main.ts`'s `setKeyboardCursor`). Only pans on whichever axis
 * actually needs it, and leaves `view` untouched (same object) when the
 * point is already within bounds, so ordinary cursor movement within a
 * screenful of board causes no pan at all. `margin` is clamped to half the
 * viewport's size on each axis so an unreasonably large margin can't demand
 * an impossible (both-edges-satisfied) pan on a small viewport.
 */
export function panToKeepVisible(view: Viewport, canvasLocalX: number, canvasLocalY: number, availW: number, availH: number, margin: number): Viewport {
  const [sx, sy] = toWrapLocal(canvasLocalX, canvasLocalY, view);
  const marginX = Math.min(margin, availW / 2);
  const marginY = Math.min(margin, availH / 2);

  let dx = 0;
  if (sx < marginX) dx = marginX - sx;
  else if (sx > availW - marginX) dx = availW - marginX - sx;

  let dy = 0;
  if (sy < marginY) dy = marginY - sy;
  else if (sy > availH - marginY) dy = availH - marginY - sy;

  if (dx === 0 && dy === 0) return view;
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}
