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
