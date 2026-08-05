import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { rectShape, randomShape, randomToroidalShape } from './shape';
import {
  buildKleinBottlePuzzle,
  buildProjectivePlanePuzzle,
  buildPuzzle,
  buildRandomShapePuzzle,
  buildToroidalPuzzle,
  countCollectionEdges,
  generateEdgeCollections,
  key,
  NO_EDGE_COLLECTIONS,
  parseKey,
  totalCells,
  type EdgeCollectionParams,
} from './puzzle';
import { KLEIN_BOTTLE, PROJECTIVE_PLANE, type Topology } from './topology';

function manhattan(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** Manhattan distance treating a wraparound edge (near a torus seam) as distance 1 too. */
function toroidalManhattan(a: readonly [number, number], b: readonly [number, number], W: number, H: number): number {
  const dx = Math.min(Math.abs(a[0] - b[0]), W - Math.abs(a[0] - b[0]));
  const dy = Math.min(Math.abs(a[1] - b[1]), H - Math.abs(a[1] - b[1]));
  return dx + dy;
}

/** Whether `b` is reachable from `a` by a single step in one of the 4 directions, wrapping (with any flip) per `topology`. */
function isValidWrapStep(a: readonly [number, number], b: readonly [number, number], topology: Topology, W: number, H: number): boolean {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    let nx = a[0] + dx;
    let ny = a[1] + dy;
    if (nx < 0 || nx >= W) {
      const r = topology.wrapX(nx, ny, W, H);
      nx = r.x;
      ny = r.y;
    } else if (ny < 0 || ny >= H) {
      const r = topology.wrapY(nx, ny, W, H);
      nx = r.x;
      ny = r.y;
    }
    if (nx === b[0] && ny === b[1]) return true;
  }
  return false;
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
    expect(puzzle.topology).toBe('torus');
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

describe.each([
  ['buildKleinBottlePuzzle', buildKleinBottlePuzzle, KLEIN_BOTTLE] as const,
  ['buildProjectivePlanePuzzle', buildProjectivePlanePuzzle, PROJECTIVE_PLANE] as const,
])('%s', (_name, build, topology) => {
  it('fills the whole m x n rectangle exactly (every canonical cell exists)', () => {
    const puzzle = build(5, 4, 0, mulberry32(1));
    expect(puzzle.topology).toBe(topology.kind);
    expect(totalCells(puzzle)).toBe(puzzle.W * puzzle.H);
    expect(puzzle.W).toBe(10);
    expect(puzzle.H).toBe(8);
  });

  it('every edge is a wraparound-aware (flip-aware) orthogonal step', () => {
    const puzzle = build(6, 5, 0.35, mulberry32(2));
    for (const [k, neighbors] of puzzle.adj) {
      const a = parseKey(k);
      for (const nk of neighbors) {
        expect(isValidWrapStep(a, parseKey(nk), topology, puzzle.W, puzzle.H)).toBe(true);
      }
    }
  });

  it('includes at least one distractor edge that crosses the wraparound at high density', () => {
    let sawWrap = false;
    for (let seed = 0; seed < 10 && !sawWrap; seed++) {
      const puzzle = build(5, 4, 0.9, mulberry32(seed));
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
    const puzzle = build(5, 4, 0, mulberry32(1));
    for (const neighbors of puzzle.adj.values()) {
      expect(neighbors.size).toBe(2);
    }
  });

  it('adjacency is symmetric', () => {
    const puzzle = build(6, 5, 0.4, mulberry32(3));
    for (const [k, neighbors] of puzzle.adj) {
      for (const nk of neighbors) {
        expect(puzzle.adj.get(nk)?.has(k)).toBe(true);
      }
    }
  });

  it('succeeds across many seeds and sizes without ever throwing', () => {
    for (const [m, n] of [
      [3, 4],
      [4, 6],
      [6, 9],
      [8, 12],
    ] as const) {
      for (let seed = 0; seed < 20; seed++) {
        expect(() => build(m, n, 0.28, mulberry32(seed))).not.toThrow();
      }
    }
  });
});

describe('edge collections', () => {
  it('defaults to no collections at all (NO_EDGE_COLLECTIONS)', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(1));
    expect(puzzle.edgeCollections).toEqual([]);
  });

  it('leaves adjacency byte-identical whether or not NO_EDGE_COLLECTIONS is passed explicitly (consumes no rng calls when off)', () => {
    const withDefault = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(7));
    const explicit = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(7), NO_EDGE_COLLECTIONS);
    expect([...withDefault.adj.entries()].map(([k, v]) => [k, [...v].sort()])).toEqual([...explicit.adj.entries()].map(([k, v]) => [k, [...v].sort()]));
  });

  it('produces between 0 and maxCollections collections, each within [minSize, maxSize], for many seeds', () => {
    const params: EdgeCollectionParams = { maxCollections: 4, minSize: 2, maxSize: 4 };
    for (let seed = 0; seed < 30; seed++) {
      const puzzle = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(seed), params);
      const collections = puzzle.edgeCollections!;
      expect(collections.length).toBeLessThanOrEqual(params.maxCollections);
      for (const c of collections) {
        expect(c.edges.length).toBeGreaterThanOrEqual(params.minSize);
        expect(c.edges.length).toBeLessThanOrEqual(params.maxSize);
        expect(c.required).toBeGreaterThanOrEqual(Math.floor(c.edges.length / 2));
        expect(c.required).toBeLessThanOrEqual(Math.ceil(c.edges.length / 2));
      }
    }
  });

  it('every collection edge is a real edge of the puzzle graph', () => {
    const puzzle = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(3), { maxCollections: 4, minSize: 2, maxSize: 4 });
    for (const collection of puzzle.edgeCollections!) {
      for (const ek of collection.edges) {
        const [ka, kb] = ek.split('|');
        expect(puzzle.adj.get(ka)?.has(kb)).toBe(true);
      }
    }
  });

  it('never reuses an edge across two different collections', () => {
    const puzzle = buildPuzzle(rectShape(6, 9), 0.35, mulberry32(11), { maxCollections: 4, minSize: 2, maxSize: 4 });
    const seen = new Set<string>();
    for (const collection of puzzle.edgeCollections!) {
      for (const ek of collection.edges) {
        expect(seen.has(ek)).toBe(false);
        seen.add(ek);
      }
    }
  });

  it('is deterministic for the same seed and params', () => {
    const params: EdgeCollectionParams = { maxCollections: 3, minSize: 2, maxSize: 4 };
    const a = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(42), params);
    const b = buildPuzzle(rectShape(4, 6), 0.3, mulberry32(42), params);
    expect(a.edgeCollections).toEqual(b.edgeCollections);
  });

  it('generateEdgeCollections returns [] when maxCollections is 0, regardless of size bounds', () => {
    expect(generateEdgeCollections(['a|b', 'b|c'], ['a|c'], { maxCollections: 0, minSize: 2, maxSize: 8 }, mulberry32(1))).toEqual([]);
  });

  it('countCollectionEdges counts only currently-marked edges of one collection', () => {
    const collection = { id: 0, edges: ['a|b', 'b|c', 'c|d'], required: 2 };
    expect(countCollectionEdges(collection, new Set(['a|b', 'c|d', 'x|y']))).toBe(2);
    expect(countCollectionEdges(collection, new Set())).toBe(0);
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
