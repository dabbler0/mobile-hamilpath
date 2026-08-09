import { describe, expect, it } from 'vitest';
import { lockEdge } from './edgeLock';
import { createInitialPath, toggleRegion } from './pathEdit';
import { key, type Puzzle } from './puzzle';
import { computeRegions, edgeKey, regionsForEdge } from './regions';

/** Two faces, (0,0) and (1,0), on a 3x2 vertex grid, sharing exactly one real candidate edge — the vertical edge (1,0)-(1,1) — so without locking they're two separate single-face regions each boundaried by just that edge. Mirrors `regions.test.ts`'s own helper/setup. */
function twoRegionPuzzle(): Puzzle {
  const W = 3;
  const H = 2;
  const adj = new Map<string, Set<string>>();
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
  }
  adj.get(key(1, 0))!.add(key(1, 1));
  adj.get(key(1, 1))!.add(key(1, 0));
  return { adj, W, H, startCell: [0, 0] };
}

describe('lockEdge', () => {
  it('marks the edge, merges its two regions into one, and removes it from every boundary', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const state = createInitialPath();
    expect(state.edges.has(ek)).toBe(false);

    const result = lockEdge(puzzle, regionMap, state, ek, true);

    expect(result.state.edges.has(ek)).toBe(true);
    expect(result.puzzle.lockedEdges).toEqual(new Set([ek]));

    const { faceToRegion, regions } = result.regionMap;
    expect(faceToRegion.get('0,0')).toBe(faceToRegion.get('1,0'));
    expect(regions[faceToRegion.get('0,0')!].boundary).toEqual([]);
  });

  it('locking to unmarked leaves the edge unmarked — "equivalent to deleting it" at game start, per this feature\'s spec', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);

    const result = lockEdge(puzzle, regionMap, createInitialPath(), ek, false);

    expect(result.state.edges.has(ek)).toBe(false);
    const allBoundary = new Set(result.regionMap.regions.flatMap((r) => r.boundary));
    expect(allBoundary.has(ek)).toBe(false); // never toggleable again, so the player could never mark it either
  });

  it('is a no-op on the mark state (but still locks) when the edge is already in the target state', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const [regionId] = regionsForEdge(regionMap, ek);
    const alreadyMarked = toggleRegion(puzzle, regionMap, createInitialPath(), regionId).state;

    const result = lockEdge(puzzle, regionMap, alreadyMarked, ek, true);

    expect(result.state.edges).toEqual(alreadyMarked.edges);
    expect(result.puzzle.lockedEdges).toEqual(new Set([ek]));
  });

  it('preserves the rest of a region\'s boundary — a toggle to fix this edge still flips its region-mates, exactly like an ordinary tap would', () => {
    // A 2x2 single-face board: all 4 cycle edges are one region's boundary.
    // Locking one of them still has to go through toggleRegion, so the
    // other 3 come along for the ride.
    const W = 2;
    const H = 2;
    const adj = new Map<string, Set<string>>();
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
    const cycleEdges: [[number, number], [number, number]][] = [
      [[0, 0], [1, 0]],
      [[1, 0], [1, 1]],
      [[1, 1], [0, 1]],
      [[0, 1], [0, 0]],
    ];
    for (const [a, b] of cycleEdges) {
      adj.get(key(a[0], a[1]))!.add(key(b[0], b[1]));
      adj.get(key(b[0], b[1]))!.add(key(a[0], a[1]));
    }
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0] };
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([0, 0], [1, 0]);

    const result = lockEdge(puzzle, regionMap, createInitialPath(), ek, true);
    expect(result.state.edges.size).toBe(4); // toggling the region's whole boundary marked everything, not just `ek`
  });

  it('throws when the edge needs toggling but is not on any boundary (already locked)', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const first = lockEdge(puzzle, regionMap, createInitialPath(), ek, true);
    expect(() => lockEdge(first.puzzle, first.regionMap, first.state, ek, false)).toThrow();
  });
});
