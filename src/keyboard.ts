import { toggleRegion, type PathOp, type PathState } from './game/pathEdit';
import { regionAt, type Face, type RegionMap } from './game/regions';
import type { Puzzle } from './game/puzzle';

/** The mutable pieces of game/view state that keyboard interaction needs to read and update. */
export interface KeyboardInputHost {
  getPuzzle(): Puzzle;
  getRegionMap(): RegionMap;
  getPathState(): PathState;
  /** `ops` records exactly what changed (see `PathOp`), for the undo/redo and replay history — empty for a no-op call. */
  setPathState(state: PathState, ops: PathOp[]): void;
  /** Reports which region the cursor currently sits in, so it can be highlighted as the one Enter/Space would toggle. */
  setFocusedRegion(id: number | null): void;
  setKeyboardCursor(cursor: Face | null): void;
  /** False while keyboard control shouldn't act at all (e.g. an overlay is open). */
  isEnabled(): boolean;
}

/** How far the cursor jumps on shift+arrow. */
const JUMP = 5;

type Direction = readonly [number, number];

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Tag names for controls that should keep their own native keyboard behavior (form navigation, button activation). */
const NATIVE_CONTROL_TAGS = new Set(['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON']);

/** Clamps a face position to the (W-1) x (H-1) face grid — one less than the vertex grid in each dimension, since a face needs a vertex on every side of it. */
function clampToFaceBoard(face: Face, puzzle: Puzzle): Face {
  return [Math.max(0, Math.min(puzzle.W - 2, face[0])), Math.max(0, Math.min(puzzle.H - 2, face[1]))];
}

/**
 * Wires keyboard-only controls onto `target`: arrow keys move a free cursor
 * around the face grid (shift+arrow jumps `JUMP` faces at once), always
 * sitting inside some region — that region is reported as "focused" so it
 * can be highlighted as the one that will toggle. Pressing the action key
 * (Enter or Space) toggles it: every unmarked boundary edge becomes marked
 * and vice versa. Returns a teardown function.
 */
export function attachKeyboardHandling(target: Window, host: KeyboardInputHost): () => void {
  let cursor: Face | null = null;

  function ensureCursor(): Face {
    if (!cursor) cursor = clampToFaceBoard(host.getPuzzle().startCell, host.getPuzzle());
    return cursor;
  }

  function publishCursor(): void {
    host.setKeyboardCursor(cursor);
    host.setFocusedRegion(cursor ? regionAt(host.getRegionMap(), cursor) : null);
  }

  function handleAction(): void {
    const state = host.getPathState();
    if (state.won) return;
    const c = ensureCursor();
    const regionId = regionAt(host.getRegionMap(), c);
    if (regionId === null) return;
    const { state: next, ops } = toggleRegion(host.getPuzzle(), host.getRegionMap(), state, regionId);
    host.setPathState(next, ops);
  }

  function handleMove(direction: Direction, jump: number): void {
    const c = ensureCursor();
    cursor = clampToFaceBoard([c[0] + direction[0] * jump, c[1] + direction[1] * jump], host.getPuzzle());
  }

  function onKeyDown(evt: KeyboardEvent): void {
    if (!host.isEnabled()) return;
    const targetTag = (evt.target as HTMLElement | null)?.tagName;
    if (targetTag && NATIVE_CONTROL_TAGS.has(targetTag)) return;

    const direction = DIRECTIONS[evt.key];
    if (direction) {
      evt.preventDefault();
      handleMove(direction, evt.shiftKey ? JUMP : 1);
      publishCursor();
      return;
    }

    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      handleAction();
    }
  }

  target.addEventListener('keydown', onKeyDown as EventListener);
  return () => target.removeEventListener('keydown', onKeyDown as EventListener);
}
