import { describe, expect, it } from 'vitest';
import { applyPathOp, computeWin, createInitialPath, toggleRegion, type PathState } from './pathEdit';
import { computeRegions, regionAt } from './regions';
import { buildPuzzle, key, type Puzzle } from './puzzle';
import { mulberry32 } from './rng';

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
  // A 2x2 vertex board has only one face (0,0) — every real edge borders it,
  // so it's a single-region puzzle, good enough for basic toggle mechanics
  // but not for testing multi-region combinations (see the 'reachability'
  // describe block below for that).
  it('marks unmarked boundary edges and unmarks marked ones', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
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
    const regionId = regionAt(regionMap, [0, 0])!;
    const start = createInitialPath();
    const once = toggleRegion(puzzle, regionMap, start, regionId);
    const twice = toggleRegion(puzzle, regionMap, once.state, regionId);
    expect(twice.state.edges).toEqual(start.edges);
  });

  it('applying the recorded op a second time reverses it (self-inverse)', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
    const regionId = regionAt(regionMap, [0, 0])!;
    const start = createInitialPath();
    const { state: toggled, ops } = toggleRegion(puzzle, regionMap, start, regionId);
    const reverted = applyPathOp(toggled, puzzle, ops[0]);
    expect(reverted.edges).toEqual(start.edges);
  });

  it('wins by toggling the single region on a 2x2 board (whose only face already covers the whole cycle)', () => {
    const puzzle = twoByTwoCyclePuzzle();
    const regionMap = computeRegions(puzzle);
    const regionId = regionAt(regionMap, [0, 0])!;
    const { state } = toggleRegion(puzzle, regionMap, createInitialPath(), regionId);
    expect(state.won).toBe(true);
    expect(state.edges.size).toBe(4);
  });
});

describe('toggleRegion reachability (multi-region)', () => {
  it('some combination of region toggles reaches a win, for a real generated multi-face puzzle', () => {
    // m=3,n=4 blocks with no distractors: the puzzle graph is exactly its
    // Hamiltonian cycle, and it splits into several faces/regions, so this
    // actually exercises combining multiple region toggles — this is the
    // property that was broken before regions were redefined as faces
    // (grid squares) instead of graph vertices.
    const puzzle = buildPuzzle(3, 4, 0, mulberry32(12345));
    const regionMap = computeRegions(puzzle);
    const R = regionMap.regions.length;
    expect(R).toBeGreaterThan(1);

    let winningState: PathState | null = null;
    for (let mask = 1; mask < 1 << R && !winningState; mask++) {
      let state = createInitialPath();
      for (let i = 0; i < R; i++) {
        if (mask & (1 << i)) state = toggleRegion(puzzle, regionMap, state, i).state;
      }
      if (state.won) winningState = state;
    }
    expect(winningState).not.toBeNull();
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
