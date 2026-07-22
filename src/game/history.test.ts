import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordMove, redo, undo, type HistoryState } from './history';
import type { PathOp, PathState, Segment } from './pathDrag';

const START: PathState = { segments: [[[0, 0]]], won: false };

function extend(seg: number, cell: [number, number]): PathOp {
  return { op: 'extend', seg, end: 'tail', cell };
}

function afterExtend(prev: PathState, cell: [number, number]): PathState {
  const segments: Segment[] = prev.segments.map((s) => s.map((c) => [...c] as [number, number]));
  segments[0].push(cell);
  return { segments, won: false };
}

describe('recordMove', () => {
  it('is a no-op for an empty ops list', () => {
    const history = createHistory();
    expect(recordMove(history, START, [])).toBe(history);
  });

  it('pushes prev onto the undo stack and appends ops to the move log', () => {
    const history = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);
    expect(history.moveLog).toEqual([{ kind: 'ops', ops: [extend(0, [1, 0])] }]);
  });

  it('caps the undo stack depth', () => {
    let history = createHistory();
    let state = START;
    for (let i = 0; i < 250; i++) {
      const next = afterExtend(state, [i + 1, 0]);
      history = recordMove(history, state, [extend(0, [i + 1, 0])]);
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
    const afterMove = afterExtend(START, [1, 0]);
    const history = recordMove(createHistory(), START, [extend(0, [1, 0])]);

    const result = undo(history, afterMove);
    expect(result).not.toBeNull();
    expect(result!.state).toEqual(START);
    expect(canUndo(result!.history)).toBe(false);
    expect(canRedo(result!.history)).toBe(true);
  });

  it('redo restores the state that was just undone', () => {
    const afterMove = afterExtend(START, [1, 0]);
    let history = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    const undone = undo(history, afterMove)!;
    history = undone.history;

    const redone = redo(history, undone.state);
    expect(redone).not.toBeNull();
    expect(redone!.state).toEqual(afterMove);
    expect(canRedo(redone!.history)).toBe(false);
    expect(canUndo(redone!.history)).toBe(true);
  });

  it('a fresh move after an undo clears the redo stack', () => {
    const afterMove = afterExtend(START, [1, 0]);
    let history = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    expect(canRedo(history)).toBe(true);

    history = recordMove(history, undone.state, [extend(0, [0, 1])]);
    expect(canRedo(history)).toBe(false);
  });
});

describe('decodeMoveLog', () => {
  it('reconstructs every state a straightforward sequence of moves passed through', () => {
    let history = createHistory();
    const afterFirst = afterExtend(START, [1, 0]);
    const afterSecond = afterExtend(afterFirst, [2, 0]);
    history = recordMove(history, START, [extend(0, [1, 0])]);
    history = recordMove(history, afterFirst, [extend(0, [2, 0])]);

    const frames = decodeMoveLog(START, history.moveLog);
    expect(frames).toEqual([START, afterFirst, afterSecond]);
  });

  it('shows an undo as its own frame, not as if the move never happened', () => {
    const afterMove = afterExtend(START, [1, 0]);
    let history = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    const undone = undo(history, afterMove)!;
    history = undone.history;

    const frames = decodeMoveLog(START, history.moveLog);
    // The movie shows the extend happening, then the undo jumping back — both are present.
    expect(frames).toEqual([START, afterMove, START]);
  });

  it('shows an undo followed by a new diverging move, in that real order', () => {
    const afterMove = afterExtend(START, [1, 0]);
    const diverged = afterExtend(START, [0, 1]);
    let history = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    const undone = undo(history, afterMove)!;
    history = undone.history;
    history = recordMove(history, undone.state, [{ op: 'extend', seg: 0, end: 'tail', cell: [0, 1] }]);

    const frames = decodeMoveLog(START, history.moveLog);
    // The movie shows the first move, the undo back to the start, and then the different move actually taken.
    expect(frames).toEqual([START, afterMove, START, diverged]);
  });
});

describe('HistoryState shape is storage-friendly', () => {
  it('round-trips through JSON (a stand-in for IndexedDB structured clone)', () => {
    let history: HistoryState = recordMove(createHistory(), START, [extend(0, [1, 0])]);
    const roundTripped = JSON.parse(JSON.stringify(history)) as HistoryState;
    expect(roundTripped).toEqual(history);
  });
});
