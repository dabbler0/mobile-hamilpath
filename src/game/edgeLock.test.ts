import { describe, expect, it } from 'vitest';
import { applyHintedEdges, lockEdge } from './edgeLock';
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

/** Three faces, (0,0)/(1,0)/(2,0), on a 4x2 vertex grid, with two independently-lockable real candidate edges — the verticals at x=1 and x=2 — giving three single-face regions in a row (face 1 shares a boundary edge with each of its neighbors). Used to test that `applyHintedEdges` replays more than one lock in order. */
function threeRegionPuzzle(): Puzzle {
  const W = 4;
  const H = 2;
  const adj = new Map<string, Set<string>>();
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
  }
  for (const x of [1, 2]) {
    adj.get(key(x, 0))!.add(key(x, 1));
    adj.get(key(x, 1))!.add(key(x, 0));
  }
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

describe('applyHintedEdges', () => {
  it('is a no-op for an empty list', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const state = createInitialPath();
    const result = applyHintedEdges(puzzle, regionMap, state, [], new Set());
    expect(result.puzzle).toBe(puzzle);
    expect(result.regionMap).toBe(regionMap);
    expect(result.state).toBe(state);
  });

  it('replays a single hint, matching a direct lockEdge call', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const state = { edges: new Set([ek]), won: false }; // already correct, as a resumed save's edges would have it

    const direct = lockEdge(puzzle, regionMap, createInitialPath(), ek, true);
    const replayed = applyHintedEdges(puzzle, regionMap, state, [ek], new Set([ek]));

    expect(replayed.puzzle.lockedEdges).toEqual(direct.puzzle.lockedEdges);
    expect(replayed.regionMap).toEqual(direct.regionMap);
    expect(replayed.state.edges).toEqual(state.edges); // already-correct state isn't disturbed
  });

  it('replays multiple hints in order, reproducing the same lockedEdges/regionMap a sequential lockEdge chain would', () => {
    const puzzle = threeRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek1 = edgeKey([1, 0], [1, 1]);
    const ek2 = edgeKey([2, 0], [2, 1]);
    const solutionEdges = new Set([ek1]); // ek1 correct marked, ek2 correct unmarked

    const step1 = lockEdge(puzzle, regionMap, createInitialPath(), ek1, true);
    const step2 = lockEdge(step1.puzzle, step1.regionMap, step1.state, ek2, false);

    const replayed = applyHintedEdges(puzzle, regionMap, step2.state, [ek1, ek2], solutionEdges);

    expect(replayed.puzzle.lockedEdges).toEqual(step2.puzzle.lockedEdges);
    expect(replayed.regionMap).toEqual(step2.regionMap);
    expect(replayed.state.edges).toEqual(step2.state.edges);
  });

  it('skips an edge already locked, defensively, rather than throwing', () => {
    const puzzle = twoRegionPuzzle();
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const locked = lockEdge(puzzle, regionMap, createInitialPath(), ek, true);

    const result = applyHintedEdges(locked.puzzle, locked.regionMap, locked.state, [ek], new Set([ek]));
    expect(result.puzzle.lockedEdges).toEqual(locked.puzzle.lockedEdges);
  });
});
