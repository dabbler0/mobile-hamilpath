import { faceAt, type Layout } from './game/geometry';
import type { PathOp, PathState } from './game/pathEdit';
import { toggleRegion } from './game/pathEdit';
import { regionAt, type RegionMap } from './game/regions';
import type { Puzzle } from './game/puzzle';
import { topologyFor } from './game/topology';
import { computePan, toCanvasLocal, type Viewport, type ViewportBounds } from './view/viewport';

/** The mutable pieces of game/view state that pointer interaction needs to read and update. */
export interface GameInputHost {
  getPuzzle(): Puzzle;
  getRegionMap(): RegionMap;
  getPathState(): PathState;
  /** `ops` records exactly what changed (see `PathOp`), for the undo/redo and replay history — empty for a no-op call. */
  setPathState(state: PathState, ops: PathOp[]): void;
  getLayout(): Layout;
  getView(): Viewport;
  setView(view: Viewport): void;
  /** Reports which region (if any) is about to be toggled by the in-progress press, so it can be highlighted. */
  setFocusedRegion(id: number | null): void;
  bounds: ViewportBounds;
  wrapEl: HTMLElement;
}

/** Pointer movement, in client pixels, below which a press-release counts as a tap rather than a pan. */
const TAP_MOVEMENT_THRESHOLD = 8;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * True for a pointerdown that landed on a real interactive control — the
 * zoom buttons, or (while reviewing/watching a Blitz replay) the review/
 * Blitz-replay bar's buttons/select/scrubber — all of which live inside
 * `wrapEl` as ordinary siblings of the canvas. Listening on `wrapEl` itself
 * (see `attachPointerHandling`'s doc comment) means a tap on any of those
 * now bubbles up to this module's own listeners too, which would otherwise
 * misread it as the start of a board pan/tap; this is the guard that keeps
 * such taps working as plain button/control presses instead.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, select, input, a, label') !== null;
}

interface PinchState {
  startDist: number;
  startScale: number;
  startMidWrap: { x: number; y: number };
  startTx: number;
  startTy: number;
}

interface PanState {
  lastClientX: number;
  lastClientY: number;
}

interface TapCandidate {
  regionId: number;
  downClientX: number;
  downClientY: number;
}

/**
 * Wires unified pointer handling onto `wrapEl` (the whole board viewport,
 * not just the canvas element sitting inside it — see below): a tap on a
 * face (a grid square between vertices) toggles the region it belongs to
 * (marking every unmarked boundary edge and unmarking every marked one),
 * single-finger drags pan the board, and two-finger gestures pinch-zoom.
 * Returns a teardown function.
 *
 * Listening on `wrapEl` rather than the canvas itself is deliberate: an
 * ordinary (non-wraparound) board's canvas is sized to the board's own
 * fixed pixel dimensions (`main.ts`'s `layout()`), not to the viewport, so
 * a small board — or any board zoomed out below 1:1 — leaves empty wrap
 * area the canvas element doesn't actually cover. Binding to `canvas`
 * alone meant a touch/drag landing in that empty margin never reached
 * these handlers at all, so pan/pinch only worked directly on top of the
 * board's own pixels. `wrapEl` always spans the full visible viewport
 * (`layout()` keeps a wraparound board's canvas sized to it too), so
 * binding there makes pan/pinch work anywhere in the game area regardless
 * of how small or zoomed-out the board is. All the coordinate math already
 * went through `host.wrapEl.getBoundingClientRect()` (`wrapLocal`) rather
 * than the canvas's own rect, so nothing else needed to change to support
 * this. The one thing that does need care: `wrapEl` also contains real
 * interactive controls (zoom buttons, the review/Blitz-replay bars) as
 * ordinary sibling elements of the canvas, and listening on their common
 * ancestor means their own pointerdowns now bubble up here too —
 * `isInteractiveTarget` is what keeps those working as plain control
 * presses instead of being misread as a board gesture.
 */
export function attachPointerHandling(wrapEl: HTMLElement, host: GameInputHost): () => void {
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinch: PinchState | null = null;
  let panState: PanState | null = null;
  let tapCandidate: TapCandidate | null = null;

  function wrapLocal(clientX: number, clientY: number): [number, number] {
    const rect = host.wrapEl.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  function startPinch() {
    panState = null;
    tapCandidate = null;
    host.setFocusedRegion(null);
    const pts = [...activePointers.values()];
    const [p1, p2] = pts;
    const [mwx, mwy] = wrapLocal(midpoint(p1, p2).x, midpoint(p1, p2).y);
    const view = host.getView();
    pinch = {
      startDist: Math.max(1, dist(p1, p2)),
      startScale: view.scale,
      startMidWrap: { x: mwx, y: mwy },
      startTx: view.tx,
      startTy: view.ty,
    };
  }

  function resumeSinglePointerAsPan(id: number) {
    const p = activePointers.get(id);
    if (!p) return;
    panState = { lastClientX: p.x, lastClientY: p.y };
  }

  function onPointerDown(evt: PointerEvent) {
    if (isInteractiveTarget(evt.target)) return;
    activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    (evt.target as Element).setPointerCapture?.(evt.pointerId);

    if (activePointers.size >= 2) {
      startPinch();
      return;
    }
    panState = { lastClientX: evt.clientX, lastClientY: evt.clientY };
    if (host.getPathState().won) return;

    const [wx, wy] = wrapLocal(evt.clientX, evt.clientY);
    const [px, py] = toCanvasLocal(wx, wy, host.getView());
    const puzzle = host.getPuzzle();
    const layout = host.getLayout();
    const face = faceAt(px, py, layout, puzzle.W, puzzle.H, puzzle.topology ? topologyFor(puzzle.topology) : undefined);
    const regionId = regionAt(host.getRegionMap(), face);
    if (regionId !== null) {
      tapCandidate = { regionId, downClientX: evt.clientX, downClientY: evt.clientY };
      host.setFocusedRegion(regionId);
    }
  }

  function onPointerMove(evt: PointerEvent) {
    if (!activePointers.has(evt.pointerId)) return;
    activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });

    if (pinch && activePointers.size >= 2) {
      const [p1, p2] = [...activePointers.values()].slice(0, 2);
      const curDist = Math.max(1, dist(p1, p2));
      const curMid = midpoint(p1, p2);
      const [mwx, mwy] = wrapLocal(curMid.x, curMid.y);
      const rawScale = pinch.startScale * (curDist / pinch.startDist);
      const newScale = Math.max(host.bounds.minScale, Math.min(host.bounds.maxScale, rawScale));
      // The canvas point under the *start* midpoint stays fixed under the *current* midpoint as the pinch progresses.
      const localX = (pinch.startMidWrap.x - pinch.startTx) / pinch.startScale;
      const localY = (pinch.startMidWrap.y - pinch.startTy) / pinch.startScale;
      host.setView({ scale: newScale, tx: mwx - localX * newScale, ty: mwy - localY * newScale });
      return;
    }

    if (panState) {
      const dx = evt.clientX - panState.lastClientX;
      const dy = evt.clientY - panState.lastClientY;
      host.setView(computePan(host.getView(), dx, dy));
      panState.lastClientX = evt.clientX;
      panState.lastClientY = evt.clientY;
    }
  }

  function onPointerEnd(evt: PointerEvent) {
    activePointers.delete(evt.pointerId);
    try {
      (evt.target as Element).releasePointerCapture?.(evt.pointerId);
    } catch {
      // pointer capture may already be released; nothing to do
    }

    if (pinch) {
      if (activePointers.size >= 2) {
        startPinch();
      } else if (activePointers.size === 1) {
        pinch = null;
        const remainingId = [...activePointers.keys()][0];
        resumeSinglePointerAsPan(remainingId);
      } else {
        pinch = null;
      }
      return;
    }

    if (tapCandidate && !host.getPathState().won) {
      const moved = dist({ x: evt.clientX, y: evt.clientY }, { x: tapCandidate.downClientX, y: tapCandidate.downClientY });
      if (moved < TAP_MOVEMENT_THRESHOLD) {
        const { state, ops } = toggleRegion(host.getPuzzle(), host.getRegionMap(), host.getPathState(), tapCandidate.regionId);
        host.setPathState(state, ops);
      }
    }

    panState = null;
    tapCandidate = null;
    host.setFocusedRegion(null);
  }

  wrapEl.addEventListener('pointerdown', onPointerDown as EventListener);
  wrapEl.addEventListener('pointermove', onPointerMove as EventListener);
  wrapEl.addEventListener('pointerup', onPointerEnd as EventListener);
  wrapEl.addEventListener('pointercancel', onPointerEnd as EventListener);

  return () => {
    wrapEl.removeEventListener('pointerdown', onPointerDown as EventListener);
    wrapEl.removeEventListener('pointermove', onPointerMove as EventListener);
    wrapEl.removeEventListener('pointerup', onPointerEnd as EventListener);
    wrapEl.removeEventListener('pointercancel', onPointerEnd as EventListener);
  };
}
