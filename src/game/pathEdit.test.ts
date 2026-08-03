import { describe, expect, it } from 'vitest';
import { applyPathOp, computeWin, createInitialPath, toggleRegion } from './pathEdit';
import { computeRegions, regionAt } from './regions';
import { key, type Puzzle } from './puzzle';

function puzzleFromEdges(W: number, H: number, edges: [[number, number], [number, number]][]): Puzzle {
  const adj = new Map<string, Set<string>>();
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
  }
  for (const [a, b] of edges) {
    adj.get(key(a[0], a[1]))!.add(key(b[0], b[1]));
    adj.get(key(b[0], b[1]))!.add(key(a[0], a[1]));
  }
  return { adj, W, H, startCell: [0, 0] };
}

/** A 2x2 board (4 cells) whose puzzle graph is exactly the 4-cycle around the square. */
function twoByTwoCyclePuzzle(): Puzzle {
  return puzzleFromEdges(2, 2, [
    [[0, 0], [1, 0]],
    [[1, 0], [1, 1]],
    [[1, 1], [0, 1]],
    [[0, 1], [0, 0]],
  ]);
}

describe('createInitialPath', () => {
  it('starts with no marked edges and not won', () => {
    const state = createInitialPath();
    expect(state.edges.size).toBe(0);
    expect(state.won).toBe(false);
  });
});

describe('toggleRegion', () => {
  it('marks unmarked boundary edges and unmarks marked ones', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle); // every cell is its own region here (fully connected by real edges)
    const regionId = regionAt(regionMap, [0, 0])!;

    const first = toggleRegion(puzzle, regionMap, createInitialPath(), regionId);
    expect(first.state.edges.size).toBeGreaterThan(0);
    expect(first.ops).toHaveLength(1);
    expect(first.ops[0]).toEqual({ op: 'toggleRegion', region: regionId, edges: regionMap.regions[regionId].boundary });

    const second = toggleRegion(puzzle, regionMap, first.state, regionId);
    expect(second.state.edges.size).toBe(0);
  });

  it('toggling the same region twice is a no-op on the edge set', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
    const regionId = regionAt(regionMap, [1, 1])!;
    const start = createInitialPath();
    const once = toggleRegion(puzzle, regionMap, start, regionId);
    const twice = toggleRegion(puzzle, regionMap, once.state, regionId);
    expect(twice.state.edges).toEqual(start.edges);
  });

  it('applying the recorded op a second time reverses it (self-inverse)', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
    const regionId = regionAt(regionMap, [0, 1])!;
    const start = createInitialPath();
    const { state: toggled, ops } = toggleRegion(puzzle, regionMap, start, regionId);
    const reverted = applyPathOp(toggled, puzzle, ops[0]);
    expect(reverted.edges).toEqual(start.edges);
  });

  it('wins once toggling opposite-corner regions covers every edge exactly once', () => {
    // Each edge of the 4-cycle borders exactly two cell-regions (its endpoints), so
    // toggling a diagonal pair of corners flips every edge exactly once — toggling
    // all four would cancel back to empty, since each edge would flip twice.
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
    let state = createInitialPath();
    for (const cell of [[0, 0], [1, 1]] as const) {
      const regionId = regionAt(regionMap, cell)!;
      state = toggleRegion(puzzle, regionMap, state, regionId).state;
    }
    expect(state.won).toBe(true);
    expect(state.edges.size).toBe(4);
  });
});

describe('computeWin', () => {
  it('is false when the marked edges do not cover every cell', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const edges = new Set(['0,0|1,0']);
    expect(computeWin(puzzle, edges)).toBe(false);
  });

  it('is false for two disjoint sub-loops that each individually satisfy degree 2', () => {
    // 2x4 board: two separate 4-cycles (a "figure-8" without the crossing), not one Hamiltonian cycle.
    const puzzle = puzzleFromEdges(2, 4, [
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
      [[0, 2], [1, 2]],
      [[1, 2], [1, 3]],
      [[1, 3], [0, 3]],
      [[0, 3], [0, 2]],
    ]);
    const edges = new Set([
      '0,0|1,0',
      '1,0|1,1',
      '0,1|1,1',
      '0,0|0,1',
      '0,2|1,2',
      '1,2|1,3',
      '0,3|1,3',
      '0,2|0,3',
    ]);
    expect(computeWin(puzzle, edges)).toBe(false);
  });

  it('is true for a full single Hamiltonian cycle', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const edges = new Set(['0,0|1,0', '1,0|1,1', '0,1|1,1', '0,0|0,1']);
    expect(computeWin(puzzle, edges)).toBe(true);
  });
});
