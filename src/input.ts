import type { Layout } from './game/geometry';
import { tryStartPathDrag, updatePathDrag, type DragEnd, type PathState } from './game/pathDrag';
import type { Puzzle } from './game/puzzle';
import { computePan, toCanvasLocal, type Viewport, type ViewportBounds } from './view/viewport';

/** The mutable pieces of game/view state that pointer interaction needs to read and update. */
export interface GameInputHost {
  getPuzzle(): Puzzle;
  getPathState(): PathState;
  setPathState(state: PathState): void;
  getLayout(): Layout;
  getView(): Viewport;
  setView(view: Viewport): void;
  bounds: ViewportBounds;
  wrapEl: HTMLElement;
}

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

/**
 * Wires unified pointer handling onto `canvas`: single-finger drags near a
 * path endpoint edit the path, single-finger drags elsewhere pan the board,
 * and two-finger gestures pinch-zoom. Returns a teardown function.
 */
export function attachPointerHandling(canvas: HTMLElement, host: GameInputHost): () => void {
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinch: PinchState | null = null;
  let panState: PanState | null = null;
  let dragEnd: DragEnd | null = null;

  function wrapLocal(clientX: number, clientY: number): [number, number] {
    const rect = host.wrapEl.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  function startPinch() {
    dragEnd = null;
    panState = null;
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
    const { won, path } = host.getPathState();
    if (won) {
      panState = { lastClientX: evt.clientX, lastClientY: evt.clientY };
      return;
    }
    const [wx, wy] = wrapLocal(evt.clientX, evt.clientY);
    const [px, py] = toCanvasLocal(wx, wy, host.getView());
    const mode = tryStartPathDrag(path, px, py, host.getLayout());
    if (mode) {
      dragEnd = mode;
    } else {
      panState = { lastClientX: evt.clientX, lastClientY: evt.clientY };
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

    if (dragEnd && !host.getPathState().won) {
      const [wx, wy] = wrapLocal(evt.clientX, evt.clientY);
      const [px, py] = toCanvasLocal(wx, wy, host.getView());
      const { path, won } = host.getPathState();
      host.setPathState(updatePathDrag(host.getPuzzle(), path, won, dragEnd, px, py, host.getLayout()));
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
    dragEnd = null;
    panState = null;
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
