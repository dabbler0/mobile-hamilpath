import type { Layout } from './game/geometry';
import type { Cell } from './game/hamiltonianCycle';
import { findInteriorNodeAt, locateCell, splitSegmentAtCell, tryStartPathDrag, updatePathDrag, type PathOp, type PathState, type Segment } from './game/pathDrag';
import { key, type Puzzle } from './game/puzzle';
import { computePan, toCanvasLocal, type Viewport, type ViewportBounds } from './view/viewport';

/** The mutable pieces of game/view state that pointer interaction needs to read and update. */
export interface GameInputHost {
  getPuzzle(): Puzzle;
  getPathState(): PathState;
  /** `ops` records exactly what changed (see `PathOp`), for the undo/redo and replay history — empty for a no-op call. */
  setPathState(state: PathState, ops: PathOp[]): void;
  getLayout(): Layout;
  getView(): Viewport;
  setView(view: Viewport): void;
  /** Reports which segment (if any) is currently being dragged, so it can be highlighted while edited. */
  setActiveSegment(index: number | null): void;
  bounds: ViewportBounds;
  wrapEl: HTMLElement;
}

function segmentIndexOfCell(segments: readonly Segment[], cell: Cell): number | null {
  return locateCell(segments, key(cell[0], cell[1]))?.segmentIndex ?? null;
}

/** Pointer movement, in client pixels, below which a press-release counts as a tap rather than a pan. */
const TAP_MOVEMENT_THRESHOLD = 8;

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
  segmentIndex: number;
  cellIndex: number;
  downClientX: number;
  downClientY: number;
}

/**
 * Wires unified pointer handling onto `canvas`: single-finger drags near a
 * segment endpoint extend/retract/merge it, a tap on a segment's interior
 * cell splits it in two, single-finger drags elsewhere pan the board, and
 * two-finger gestures pinch-zoom. Returns a teardown function.
 */
export function attachPointerHandling(canvas: HTMLElement, host: GameInputHost): () => void {
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinch: PinchState | null = null;
  let panState: PanState | null = null;
  let draggedCell: Cell | null = null;
  let tapCandidate: TapCandidate | null = null;

  function wrapLocal(clientX: number, clientY: number): [number, number] {
    const rect = host.wrapEl.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  function startPinch() {
    draggedCell = null;
    panState = null;
    tapCandidate = null;
    host.setActiveSegment(null);
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
    activePointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    (evt.target as Element).setPointerCapture?.(evt.pointerId);

    if (activePointers.size >= 2) {
      startPinch();
      return;
    }
    const { won, segments } = host.getPathState();
    if (won) {
      panState = { lastClientX: evt.clientX, lastClientY: evt.clientY };
      return;
    }
    const [wx, wy] = wrapLocal(evt.clientX, evt.clientY);
    const [px, py] = toCanvasLocal(wx, wy, host.getView());
    const layout = host.getLayout();

    const endpoint = tryStartPathDrag(segments, px, py, layout);
    if (endpoint) {
      draggedCell = endpoint;
      host.setActiveSegment(segmentIndexOfCell(segments, endpoint));
      return;
    }

    panState = { lastClientX: evt.clientX, lastClientY: evt.clientY };
    const interior = findInteriorNodeAt(segments, px, py, layout);
    if (interior) {
      tapCandidate = { ...interior, downClientX: evt.clientX, downClientY: evt.clientY };
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

    if (draggedCell && !host.getPathState().won) {
      tapCandidate = null;
      const [wx, wy] = wrapLocal(evt.clientX, evt.clientY);
      const [px, py] = toCanvasLocal(wx, wy, host.getView());
      const { segments, won } = host.getPathState();
      const result = updatePathDrag(host.getPuzzle(), segments, won, draggedCell, px, py, host.getLayout());
      // A merge that just happened stops the drag here: if we kept tracking the
      // joined segment's far end, further movement toward the join itself (the
      // common case — that's where the finger was already headed) would hill-climb
      // straight back through it, silently un-merging what was just joined.
      const merged = result.segments.length < segments.length;
      draggedCell = merged ? null : result.draggedCell;
      host.setActiveSegment(merged ? null : segmentIndexOfCell(result.segments, result.draggedCell));
      host.setPathState({ segments: result.segments, won: result.won }, result.ops);
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

    if (tapCandidate && !draggedCell && !host.getPathState().won) {
      const moved = dist({ x: evt.clientX, y: evt.clientY }, { x: tapCandidate.downClientX, y: tapCandidate.downClientY });
      if (moved < TAP_MOVEMENT_THRESHOLD) {
        const { segments, won } = host.getPathState();
        const { segmentIndex, cellIndex } = tapCandidate;
        host.setPathState({ segments: splitSegmentAtCell(segments, segmentIndex, cellIndex), won }, [{ op: 'split', seg: segmentIndex, cellIndex }]);
      }
    }

    draggedCell = null;
    panState = null;
    tapCandidate = null;
    host.setActiveSegment(null);
  }

  canvas.addEventListener('pointerdown', onPointerDown as EventListener);
  canvas.addEventListener('pointermove', onPointerMove as EventListener);
  canvas.addEventListener('pointerup', onPointerEnd as EventListener);
  canvas.addEventListener('pointercancel', onPointerEnd as EventListener);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown as EventListener);
    canvas.removeEventListener('pointermove', onPointerMove as EventListener);
    canvas.removeEventListener('pointerup', onPointerEnd as EventListener);
    canvas.removeEventListener('pointercancel', onPointerEnd as EventListener);
  };
}
