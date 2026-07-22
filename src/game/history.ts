import { decodePathState, encodePathState, type EncodedPathState } from './pathCodec';
import { applyPathOp, type PathOp, type PathState } from './pathDrag';

/** How many steps back Undo can go. Bounds the undo/redo stacks' storage to a fixed size regardless of how long a single game runs — the (unbounded but O(1)-per-entry) move log below is what stays complete for the whole game. */
const MAX_UNDO_DEPTH = 200;

/**
 * One entry in the chronological, append-only move log that drives the
 * replay animation: either the ops applied by a real forward move (compact,
 * O(1) regardless of path length), or a "jump" to a specific state — used
 * for undo/redo, which don't have a forward op to replay (they restore a
 * previously-visited snapshot instead). Because undo/redo append their own
 * entries here rather than removing anything, doing a move and then undoing
 * it both show up in the replay, in the order they actually happened.
 */
export type MoveLogEntry = { kind: 'ops'; ops: PathOp[] } | { kind: 'jump'; state: EncodedPathState };

export interface HistoryState {
  /** Encoded snapshots to restore on Undo, oldest first, capped to `MAX_UNDO_DEPTH`. */
  undoStack: EncodedPathState[];
  /** Encoded snapshots to restore on Redo, most-recently-undone last. Cleared by any fresh (non-undo/redo) move. */
  redoStack: EncodedPathState[];
  /** Every state the path has passed through this game, in order — see `MoveLogEntry`. */
  moveLog: MoveLogEntry[];
}

export function createHistory(): HistoryState {
  return { undoStack: [], redoStack: [], moveLog: [] };
}

export function canUndo(history: HistoryState): boolean {
  return history.undoStack.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.redoStack.length > 0;
}

/**
 * Records a fresh user move (anything other than undo/redo itself): `prev`
 * (the state before the move) goes on the undo stack, the redo stack is
 * cleared (its branch is no longer reachable), and `ops` — however many
 * atomic steps this one move performed — is appended to the move log as a
 * single entry. A no-op call (empty `ops`, e.g. a blocked keyboard step)
 * is ignored so it doesn't clutter either stack.
 */
export function recordMove(history: HistoryState, prev: PathState, ops: PathOp[]): HistoryState {
  if (ops.length === 0) return history;
  const undoStack = [...history.undoStack, encodePathState(prev)].slice(-MAX_UNDO_DEPTH);
  return { undoStack, redoStack: [], moveLog: [...history.moveLog, { kind: 'ops', ops }] };
}

export interface HistoryStepResult {
  history: HistoryState;
  state: PathState;
}

/** Steps back to the previous state, if any is available. */
export function undo(history: HistoryState, current: PathState): HistoryStepResult | null {
  if (history.undoStack.length === 0) return null;
  const target = history.undoStack[history.undoStack.length - 1];
  const nextHistory: HistoryState = {
    undoStack: history.undoStack.slice(0, -1),
    redoStack: [...history.redoStack, encodePathState(current)],
    moveLog: [...history.moveLog, { kind: 'jump', state: target }],
  };
  return { history: nextHistory, state: decodePathState(target) };
}

/** Steps forward to the state that was just undone, if any is available. */
export function redo(history: HistoryState, current: PathState): HistoryStepResult | null {
  if (history.redoStack.length === 0) return null;
  const target = history.redoStack[history.redoStack.length - 1];
  const nextHistory: HistoryState = {
    undoStack: [...history.undoStack, encodePathState(current)].slice(-MAX_UNDO_DEPTH),
    redoStack: history.redoStack.slice(0, -1),
    moveLog: [...history.moveLog, { kind: 'jump', state: target }],
  };
  return { history: nextHistory, state: decodePathState(target) };
}

/**
 * Expands a move log back into the full sequence of states the path
 * actually passed through, starting from `initial` (always
 * `createInitialPath(puzzle)` — never itself stored, since it's cheaply
 * reconstructible and the same for every game of a given puzzle). Drives
 * the replay animation frame-by-frame.
 */
export function decodeMoveLog(initial: PathState, moveLog: readonly MoveLogEntry[]): PathState[] {
  const frames: PathState[] = [initial];
  let current = initial;
  for (const entry of moveLog) {
    if (entry.kind === 'jump') {
      current = decodePathState(entry.state);
      frames.push(current);
      continue;
    }
    for (const op of entry.ops) {
      const applied = applyPathOp(current.segments, current.won, op);
      current = { segments: applied.segments, won: applied.won };
      frames.push(current);
    }
  }
  return frames;
}
