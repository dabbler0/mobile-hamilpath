import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordHint, recordMove, redo, resetPath, undo, type HistoryState } from './history';
import { applyPathOp, createInitialPath, type PathOp, type PathState } from './pathEdit';
import type { Puzzle } from './puzzle';

/** A 2-cell, 1-edge puzzle — enough to exercise toggling without ever satisfying `computeWin`. */
const PUZZLE: Puzzle = {
  adj: new Map([
    ['0,0', new Set(['1,0'])],
    ['1,0', new Set(['0,0'])],
  ]),
  W: 2,
  H: 1,
  startCell: [0, 0],
};

const START: PathState = createInitialPath();

function toggle(edges: string[]): PathOp {
  return { op: 'toggleRegion', region: 0, edges };
}

function afterToggle(prev: PathState, op: PathOp): PathState {
  return applyPathOp(prev, PUZZLE, op);
}

describe('recordMove', () => {
  it('is a no-op for an empty ops list', () => {
    const history = createHistory();
    expect(recordMove(history, START, [])).toBe(history);
  });

  it('pushes prev onto the undo stack and appends ops to the move log', () => {
    const op = toggle(['0,0|1,0']);
    const history = recordMove(createHistory(), START, [op]);
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);
    expect(history.moveLog).toEqual([{ kind: 'ops', ops: [op] }]);
  });

  it('caps the undo stack depth', () => {
    let history = createHistory();
    let state = START;
    for (let i = 0; i < 250; i++) {
      // Toggling the same single edge back and forth is enough to generate 250 distinct moves.
      const op = toggle(['0,0|1,0']);
      const next = afterToggle(state, op);
      history = recordMove(history, state, [op]);
      state = next;
    }
    expect(history.undoStack.length).toBe(200);
    // The move log, unlike the undo stack, is never capped.
    expect(history.moveLog.length).toBe(250);
  });
});

describe('undo / redo', () => {
  it('returns null when there is nothing to undo or redo', () => {
    const history = createHistory();
    expect(undo(history, START)).toBeNull();
    expect(redo(history, START)).toBeNull();
  });

  it('undo restores the previous state and enables redo', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    const history = recordMove(createHistory(), START, [op]);

    const result = undo(history, afterMove);
    expect(result).not.toBeNull();
    expect(result!.state).toEqual(START);
    expect(canUndo(result!.history)).toBe(false);
    expect(canRedo(result!.history)).toBe(true);
  });

  it('redo restores the state that was just undone', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;

    const redone = redo(history, undone.state);
    expect(redone).not.toBeNull();
    expect(redone!.state).toEqual(afterMove);
    expect(canRedo(redone!.history)).toBe(false);
    expect(canUndo(redone!.history)).toBe(true);
  });

  it('a fresh move after an undo clears the redo stack', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    expect(canRedo(history)).toBe(true);

    history = recordMove(history, undone.state, [op]);
    expect(canRedo(history)).toBe(false);
  });
});

describe('decodeMoveLog', () => {
  it('reconstructs every state a straightforward sequence of moves passed through', () => {
    let history = createHistory();
    const opOn = toggle(['0,0|1,0']);
    const opOff = toggle(['0,0|1,0']);
    const afterFirst = afterToggle(START, opOn);
    const afterSecond = afterToggle(afterFirst, opOff);
    history = recordMove(history, START, [opOn]);
    history = recordMove(history, afterFirst, [opOff]);

    const frames = decodeMoveLog(PUZZLE, START, history.moveLog);
    expect(frames).toEqual([START, afterFirst, afterSecond]);
  });

  it('shows an undo as its own frame, not as if the move never happened', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;

    const frames = decodeMoveLog(PUZZLE, START, history.moveLog);
    // The movie shows the toggle happening, then the undo jumping back — both are present.
    expect(frames).toEqual([START, afterMove, START]);
  });

  it('shows an undo followed by a new diverging move, in that real order', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    // Diverges by toggling the same op again (only edge this fixture has) — still a distinct move from the undo.
    const diverged = afterToggle(undone.state, op);
    history = recordMove(history, undone.state, [op]);

    const frames = decodeMoveLog(PUZZLE, START, history.moveLog);
    // The movie shows the first move, the undo back to the start, and then the different move actually taken.
    expect(frames).toEqual([START, afterMove, START, diverged]);
  });
});

describe('recordHint', () => {
  it('is a no-op for an empty ops list', () => {
    const history = createHistory();
    expect(recordHint(history, [])).toBe(history);
  });

  it('appends to the move log like recordMove, but clears the undo/redo stacks instead of pushing onto them', () => {
    const op = toggle(['0,0|1,0']);
    let history = recordMove(createHistory(), START, [op]);
    expect(canUndo(history)).toBe(true);

    const hintOp = toggle(['0,0|1,0']);
    history = recordHint(history, [hintOp]);

    expect(history.moveLog).toEqual([{ kind: 'ops', ops: [op] }, { kind: 'ops', ops: [hintOp] }]);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('clears an existing redo branch too, exactly like a fresh recordMove would', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    expect(canRedo(history)).toBe(true);

    history = recordHint(history, [op]);
    expect(canRedo(history)).toBe(false);
  });

  it('a hint\'s edges show up in decodeMoveLog exactly like an ordinary move\'s would', () => {
    const op = toggle(['0,0|1,0']);
    const afterHint = afterToggle(START, op);
    const history = recordHint(createHistory(), [op]);

    const frames = decodeMoveLog(PUZZLE, START, history.moveLog);
    expect(frames).toEqual([START, afterHint]);
  });
});

describe('resetPath', () => {
  it('returns initial as the new state and pushes current onto the undo stack', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    const history = recordMove(createHistory(), START, [op]);

    const result = resetPath(history, afterMove, START);
    expect(result.state).toEqual(START);
    expect(canUndo(result.history)).toBe(true);
  });

  it('clears the redo stack, exactly like a fresh recordMove would', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    expect(canRedo(history)).toBe(true);

    const result = resetPath(history, undone.state, START);
    expect(canRedo(result.history)).toBe(false);
  });

  it('a reset can itself be undone back to the pre-reset state', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    const history = recordMove(createHistory(), START, [op]);

    const reset = resetPath(history, afterMove, START);
    const undone = undo(reset.history, reset.state);
    expect(undone).not.toBeNull();
    expect(undone!.state).toEqual(afterMove);
  });

  it('shows up in decodeMoveLog as a jump -- the moves before it, the clear itself, and the moves after all appear in order', () => {
    const op = toggle(['0,0|1,0']);
    const afterMove = afterToggle(START, op);
    let history = recordMove(createHistory(), START, [op]);

    const reset = resetPath(history, afterMove, START);
    history = reset.history;
    // A move made after the reset (re-toggling the same, only edge here).
    const afterSecondMove = afterToggle(reset.state, op);
    history = recordMove(history, reset.state, [op]);

    const frames = decodeMoveLog(PUZZLE, START, history.moveLog);
    expect(frames).toEqual([START, afterMove, START, afterSecondMove]);
  });
});

describe('HistoryState shape is storage-friendly', () => {
  it('round-trips through JSON (a stand-in for IndexedDB structured clone)', () => {
    const op = toggle(['0,0|1,0']);
    let history: HistoryState = recordMove(createHistory(), START, [op]);
    const roundTripped = JSON.parse(JSON.stringify(history)) as HistoryState;
    expect(roundTripped).toEqual(history);
  });
});
