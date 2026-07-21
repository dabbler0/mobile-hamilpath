import { describe, expect, it } from 'vitest';
import type { Layout } from './geometry';
import { createInitialPath, tryStartPathDrag, updatePathDrag } from './pathDrag';
import { key, totalCells, type Puzzle } from './puzzle';

const LAYOUT: Layout = { cellSize: 10, pad: 0 };

/** A tiny hand-built 2x2 Hamiltonian cycle: (0,0)-(1,0)-(1,1)-(0,1)-(0,0). */
function makeSquarePuzzle(): Puzzle {
  const adj = new Map<string, Set<string>>();
  const edges: Array<[[number, number], [number, number]]> = [
    [[0, 0], [1, 0]],
    [[1, 0], [1, 1]],
    [[1, 1], [0, 1]],
    [[0, 1], [0, 0]],
  ];
  for (const [[x1, y1], [x2, y2]] of edges) {
    const k1 = key(x1, y1);
    const k2 = key(x2, y2);
    if (!adj.has(k1)) adj.set(k1, new Set());
    if (!adj.has(k2)) adj.set(k2, new Set());
    adj.get(k1)!.add(k2);
    adj.get(k2)!.add(k1);
  }
  return { adj, W: 2, H: 2, startCell: [0, 0] };
}

describe('createInitialPath', () => {
  it('starts as a single-cell path at the puzzle start', () => {
    const puzzle = makeSquarePuzzle();
    expect(createInitialPath(puzzle)).toEqual({ path: [[0, 0]], won: false });
  });
});

describe('tryStartPathDrag', () => {
  it('offers only the tail when the path is a single cell', () => {
    expect(tryStartPathDrag([[0, 0]], 0, 0, LAYOUT)).toBe('tail');
    expect(tryStartPathDrag([[0, 0]], 500, 500, LAYOUT)).toBeNull();
  });

  it('picks whichever endpoint is closer once the path has grown', () => {
    const path: Array<[number, number]> = [
      [0, 0],
      [1, 0],
    ];
    expect(tryStartPathDrag(path, 0, 0, LAYOUT)).toBe('head');
    expect(tryStartPathDrag(path, 10, 0, LAYOUT)).toBe('tail');
    expect(tryStartPathDrag(path, 500, 500, LAYOUT)).toBeNull();
  });
});

describe('updatePathDrag', () => {
  it('extends the tail onto an adjacent, unvisited cell nearest the pointer', () => {
    const puzzle = makeSquarePuzzle();
    const { path } = createInitialPath(puzzle);
    const result = updatePathDrag(puzzle, path, false, 'tail', 10, 0, LAYOUT);
    expect(result).toEqual({
      path: [
        [0, 0],
        [1, 0],
      ],
      won: false,
    });
  });

  it('extends the head symmetrically', () => {
    const puzzle = makeSquarePuzzle();
    const result = updatePathDrag(puzzle, [[0, 0]], false, 'head', 0, 10, LAYOUT);
    expect(result.path).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });

  it('retracts when dragged back over the cell the endpoint came from', () => {
    const puzzle = makeSquarePuzzle();
    const path: Array<[number, number]> = [
      [0, 0],
      [1, 0],
    ];
    const result = updatePathDrag(puzzle, path, false, 'tail', 0, 0, LAYOUT);
    expect(result).toEqual({ path: [[0, 0]], won: false });
  });

  it('does not move when the pointer is not closer to any neighbor', () => {
    const puzzle = makeSquarePuzzle();
    const path: Array<[number, number]> = [[0, 0]];
    const result = updatePathDrag(puzzle, path, false, 'tail', 0, 0, LAYOUT);
    expect(result.path).toEqual([[0, 0]]);
  });

  it('wins once the path visits every cell and closes the loop', () => {
    const puzzle = makeSquarePuzzle();
    const path: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(path.length).toBe(totalCells(puzzle));
    const result = updatePathDrag(puzzle, path, false, 'tail', 0, 0, LAYOUT);
    expect(result.won).toBe(true);
    expect(result.path).toEqual(path);
  });

  it('does not win by closing the loop early, before every cell is visited', () => {
    const puzzle = makeSquarePuzzle();
    const path: Array<[number, number]> = [
      [0, 0],
      [1, 0],
    ];
    // Drag the tail back toward the head without having visited (1,1)/(0,1) yet.
    const result = updatePathDrag(puzzle, path, false, 'tail', 0, 0, LAYOUT);
    expect(result.won).toBe(false);
  });

  it('can walk the whole solution cycle step by step to a win', () => {
    const puzzle = makeSquarePuzzle();
    let state = createInitialPath(puzzle);
    const targets: Array<[number, number]> = [
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    for (const [tx, ty] of targets) {
      state = updatePathDrag(puzzle, state.path, state.won, 'tail', tx * LAYOUT.cellSize, ty * LAYOUT.cellSize, LAYOUT);
    }
    expect(state.won).toBe(true);
    expect(state.path.length).toBe(totalCells(puzzle));
  });
});
