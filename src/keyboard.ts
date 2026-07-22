import type { Layout } from './game/geometry';
import type { Cell } from './game/hamiltonianCycle';
import { locateCell, runPathEndDirection, splitSegmentAtCell, stepPathEndDirection, type Direction, type PathOp, type PathState } from './game/pathDrag';
import { key, type Puzzle } from './game/puzzle';

/** The mutable pieces of game/view state that keyboard interaction needs to read and update. */
export interface KeyboardInputHost {
  getPuzzle(): Puzzle;
  getPathState(): PathState;
  /** `ops` records exactly what changed (see `PathOp`), for the undo/redo and replay history — empty for a no-op call. */
  setPathState(state: PathState, ops: PathOp[]): void;
  getLayout(): Layout;
  setActiveSegment(index: number | null): void;
  setKeyboardCursor(cursor: Cell | null, held: boolean): void;
  /** False while keyboard control shouldn't act at all (e.g. an overlay is open). */
  isEnabled(): boolean;
}

/** How far a free (not-holding-an-end) cursor jumps on shift+arrow. */
const FREE_JUMP = 5;

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Tag names for controls that should keep their own native keyboard behavior (form navigation, button activation). */
const NATIVE_CONTROL_TAGS = new Set(['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON']);

function clampToBoard(cell: Cell, puzzle: Puzzle): Cell {
  return [Math.max(0, Math.min(puzzle.W - 1, cell[0])), Math.max(0, Math.min(puzzle.H - 1, cell[1]))];
}

/**
 * Wires keyboard-only controls onto `target`: arrow keys move a free cursor
 * around the lattice; pressing the action key on an endpoint "picks it up",
 * after which arrow keys move that endpoint along graph edges (extend/
 * retract/merge/win, same rules as a pointer drag) instead of moving the
 * cursor freely; pressing the action key again drops it. Pressing the
 * action key on an *interior* cell splits the segment there instead.
 * Shift+arrow jumps 5 cells at once when browsing freely, or runs to the
 * next fork/dead end when holding an endpoint. Returns a teardown function.
 */
export function attachKeyboardHandling(target: Window, host: KeyboardInputHost): () => void {
  let cursor: Cell | null = null;
  let held = false;

  function ensureCursor(): Cell {
    if (!cursor) cursor = host.getPuzzle().startCell;
    return cursor;
  }

  function publishCursor(): void {
    host.setKeyboardCursor(cursor, held);
  }

  function drop(): void {
    held = false;
    host.setActiveSegment(null);
  }

  function handleAction(): void {
    const { segments, won } = host.getPathState();
    if (won) return;
    const c = ensureCursor();

    if (held) {
      drop();
      publishCursor();
      return;
    }

    const loc = locateCell(segments, key(c[0], c[1]));
    if (!loc) return;
    const seg = segments[loc.segmentIndex];
    const isEndpoint = loc.cellIndex === 0 || loc.cellIndex === seg.length - 1;
    if (isEndpoint) {
      held = true;
      host.setActiveSegment(loc.segmentIndex);
      publishCursor();
      return;
    }

    host.setPathState({ segments: splitSegmentAtCell(segments, loc.segmentIndex, loc.cellIndex), won }, [
      { op: 'split', seg: loc.segmentIndex, cellIndex: loc.cellIndex },
    ]);
  }

  function handleHeldStep(direction: Direction): void {
    const { segments, won } = host.getPathState();
    const c = ensureCursor();
    const result = stepPathEndDirection(host.getPuzzle(), segments, won, c, direction, host.getLayout());
    host.setPathState({ segments: result.segments, won: result.won }, result.ops);
    const merged = result.mergeJoinCell !== null;
    // Unlike a pointer drag (which keeps tracking the merged segment's far end so a
    // continued drag gesture can keep going), the keyboard cursor should simply stay
    // put at the join — the user pressed one direction key, so it should look like
    // they moved one cell, not teleported across the segment they just merged with.
    const next: Cell = merged ? result.mergeJoinCell! : result.draggedCell;
    cursor = next;
    if (merged || result.won) {
      drop();
    } else {
      host.setActiveSegment(locateCell(result.segments, key(next[0], next[1]))?.segmentIndex ?? null);
    }
  }

  function handleHeldRun(direction: Direction): void {
    const { segments, won } = host.getPathState();
    const c = ensureCursor();
    const result = runPathEndDirection(host.getPuzzle(), segments, won, c, direction, host.getLayout());
    host.setPathState({ segments: result.segments, won: result.won }, result.ops);
    const next: Cell = result.merged ? result.mergeJoinCell! : result.draggedCell;
    cursor = next;
    if (result.merged || result.won) {
      drop();
    } else {
      host.setActiveSegment(locateCell(result.segments, key(next[0], next[1]))?.segmentIndex ?? null);
    }
  }

  function handleFreeMove(direction: Direction, jump: number): void {
    const c = ensureCursor();
    cursor = clampToBoard([c[0] + direction[0] * jump, c[1] + direction[1] * jump], host.getPuzzle());
  }

  function onKeyDown(evt: KeyboardEvent): void {
    if (!host.isEnabled()) return;
    const targetTag = (evt.target as HTMLElement | null)?.tagName;
    if (targetTag && NATIVE_CONTROL_TAGS.has(targetTag)) return;

    const direction = DIRECTIONS[evt.key];
    if (direction) {
      evt.preventDefault();
      if (held) {
        if (evt.shiftKey) handleHeldRun(direction);
        else handleHeldStep(direction);
      } else {
        handleFreeMove(direction, evt.shiftKey ? FREE_JUMP : 1);
      }
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
