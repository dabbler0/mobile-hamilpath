import { describe, expect, it } from 'vitest';
import { buildPuzzle, key, parseKey, totalCells } from './puzzle';
import { mulberry32 } from './rng';

function manhattan(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

describe('key / parseKey', () => {
  it('round-trips coordinates', () => {
    expect(parseKey(key(3, 5))).toEqual([3, 5]);
    expect(parseKey(key(0, 0))).toEqual([0, 0]);
  });
});

describe('buildPuzzle', () => {
  it('contains exactly one node per cell of the doubled grid', () => {
    const puzzle = buildPuzzle(4, 6, 0, mulberry32(1));
    expect(puzzle.adj.size).toBe(totalCells(puzzle));
    expect(totalCells(puzzle)).toBe(8 * 12);
  });

  it('with zero density, forms a pure cycle: every node has degree exactly 2', () => {
    const puzzle = buildPuzzle(4, 6, 0, mulberry32(1));
    for (const neighbors of puzzle.adj.values()) {
      expect(neighbors.size).toBe(2);
    }
  });

  it('only connects orthogonally-adjacent cells', () => {
    const puzzle = buildPuzzle(4, 6, 0.4, mulberry32(2));
    for (const [k, neighbors] of puzzle.adj) {
      const a = parseKey(k);
      for (const nk of neighbors) {
        expect(manhattan(a, parseKey(nk))).toBe(1);
      }
    }
  });

  it('adjacency is symmetric', () => {
    const puzzle = buildPuzzle(4, 6, 0.4, mulberry32(3));
    for (const [k, neighbors] of puzzle.adj) {
      for (const nk of neighbors) {
        expect(puzzle.adj.get(nk)?.has(k)).toBe(true);
      }
    }
  });

  it('higher density never produces fewer edges than zero density (same seed prefix)', () => {
    const low = buildPuzzle(6, 9, 0, mulberry32(5));
    const high = buildPuzzle(6, 9, 0.45, mulberry32(5));
    let lowEdges = 0;
    let highEdges = 0;
    for (const n of low.adj.values()) lowEdges += n.size;
    for (const n of high.adj.values()) highEdges += n.size;
    expect(highEdges).toBeGreaterThanOrEqual(lowEdges);
  });

  it('startCell is always a node in the graph', () => {
    const puzzle = buildPuzzle(3, 4, 0.2, mulberry32(9));
    expect(puzzle.adj.has(key(...puzzle.startCell))).toBe(true);
  });
});
