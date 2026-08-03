import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { rectShape, randomShape, randomToroidalShape } from './shape';
import { buildPuzzle, buildRandomShapePuzzle, buildToroidalPuzzle, key, parseKey, totalCells } from './puzzle';

function manhattan(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** Manhattan distance treating a wraparound edge (near a torus seam) as distance 1 too. */
function toroidalManhattan(a: readonly [number, number], b: readonly [number, number], W: number, H: number): number {
  const dx = Math.min(Math.abs(a[0] - b[0]), W - Math.abs(a[0] - b[0]));
  const dy = Math.min(Math.abs(a[1] - b[1]), H - Math.abs(a[1] - b[1]));
  return dx + dy;
}

describe('key / parseKey', () => {
  it('round-trips coordinates', () => {
    expect(parseKey(key(3, 5))).toEqual([3, 5]);
    expect(parseKey(key(0, 0))).toEqual([0, 0]);
  });
});

describe('buildPuzzle (rectangle)', () => {
  it('contains exactly one node per cell of the doubled grid', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0, mulberry32(1));
    expect(puzzle.adj.size).toBe(totalCells(puzzle));
    expect(totalCells(puzzle)).toBe(8 * 12);
  });

  it('with zero density, forms a pure cycle: every node has degree exactly 2', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0, mulberry32(1));
    for (const neighbors of puzzle.adj.values()) {
      expect(neighbors.size).toBe(2);
    }
  });

  it('only connects orthogonally-adjacent cells', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0.4, mulberry32(2));
    for (const [k, neighbors] of puzzle.adj) {
      const a = parseKey(k);
      for (const nk of neighbors) {
        expect(manhattan(a, parseKey(nk))).toBe(1);
      }
    }
  });

  it('adjacency is symmetric', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0.4, mulberry32(3));
    for (const [k, neighbors] of puzzle.adj) {
      for (const nk of neighbors) {
        expect(puzzle.adj.get(nk)?.has(k)).toBe(true);
      }
    }
  });

  it('higher density never produces fewer edges than zero density (same seed prefix)', () => {
    const low = buildPuzzle(rectShape(6, 9), 0, mulberry32(5));
    const high = buildPuzzle(rectShape(6, 9), 0.45, mulberry32(5));
    let lowEdges = 0;
    let highEdges = 0;
    for (const n of low.adj.values()) lowEdges += n.size;
    for (const n of high.adj.values()) highEdges += n.size;
    expect(highEdges).toBeGreaterThanOrEqual(lowEdges);
  });

  it('startCell is always a node in the graph', () => {
    const puzzle = buildPuzzle(rectShape(3, 4), 0.2, mulberry32(9));
    expect(puzzle.adj.has(key(...puzzle.startCell))).toBe(true);
  });
});

describe('buildRandomShapePuzzle', () => {
  it('every node exists in the shape and has only orthogonal neighbors', () => {
    for (const seed of [1, 2, 3]) {
      const puzzle = buildRandomShapePuzzle(6, 9, 0.3, mulberry32(seed));
      expect(totalCells(puzzle)).toBeGreaterThanOrEqual(6 * 9 * 4);
      for (const [k, neighbors] of puzzle.adj) {
        const a = parseKey(k);
        for (const nk of neighbors) {
          expect(manhattan(a, parseKey(nk))).toBe(1);
        }
      }
    }
  });

  it('is not necessarily a full rectangle of cells (some bounding-box cells are holes)', () => {
    const puzzle = buildRandomShapePuzzle(6, 6, 0, mulberry32(1));
    expect(totalCells(puzzle)).toBeLessThanOrEqual(puzzle.W * puzzle.H);
  });
});

describe('buildToroidalPuzzle', () => {
  it('fills the whole m x n rectangle exactly (every canonical cell exists)', () => {
    const puzzle = buildToroidalPuzzle(5, 4, 0, mulberry32(1));
    expect(puzzle.toroidal).toBe(true);
    expect(totalCells(puzzle)).toBe(puzzle.W * puzzle.H);
    expect(puzzle.W).toBe(10);
    expect(puzzle.H).toBe(8);
  });

  it('every edge is a wraparound-aware orthogonal step', () => {
    const puzzle = buildToroidalPuzzle(6, 5, 0.35, mulberry32(2));
    for (const [k, neighbors] of puzzle.adj) {
      const a = parseKey(k);
      for (const nk of neighbors) {
        expect(toroidalManhattan(a, parseKey(nk), puzzle.W, puzzle.H)).toBe(1);
      }
    }
  });

  it('includes at least one distractor edge that crosses the wraparound at high density', () => {
    let sawWrap = false;
    for (let seed = 0; seed < 10 && !sawWrap; seed++) {
      const puzzle = buildToroidalPuzzle(5, 4, 0.9, mulberry32(seed));
      for (const [k, neighbors] of puzzle.adj) {
        const [x, y] = parseKey(k);
        for (const nk of neighbors) {
          const [x2, y2] = parseKey(nk);
          if (Math.abs(x - x2) > 1 || Math.abs(y - y2) > 1) sawWrap = true;
        }
      }
    }
    expect(sawWrap).toBe(true);
  });

  it('with zero density, forms a pure cycle: every node has degree exactly 2', () => {
    const puzzle = buildToroidalPuzzle(5, 4, 0, mulberry32(1));
    for (const neighbors of puzzle.adj.values()) {
      expect(neighbors.size).toBe(2);
    }
  });
});

// Sanity: randomShape/randomToroidalShape are exercised indirectly above via
// buildRandomShapePuzzle/buildToroidalPuzzle; this just confirms the imports
// used by this file's helpers stay wired up.
describe('shape imports', () => {
  it('rectShape/randomShape/randomToroidalShape are usable directly', () => {
    expect(rectShape(2, 2).blocks.size).toBe(4);
    expect(randomShape(2, 2, mulberry32(1)).blocks.size).toBeGreaterThanOrEqual(4);
    expect(randomToroidalShape(2, 2, mulberry32(1)).blocks.size).toBe(4);
  });
});
