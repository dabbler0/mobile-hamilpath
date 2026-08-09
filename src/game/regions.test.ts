import { describe, expect, it } from 'vitest';
import { computeRegions, edgeKey, lockEdgeInRegionMap, regionAt, regionsForEdge, type EdgeKey, type RegionMap } from './regions';
import { buildKleinBottlePuzzle, buildProjectivePlanePuzzle, buildPuzzle, buildRandomShapePuzzle, buildToroidalPuzzle, key, parseKey, type Puzzle } from './puzzle';
import { mulberry32 } from './rng';
import { rectShape } from './shape';
import { KLEIN_BOTTLE, PROJECTIVE_PLANE, topologyFor, type TopologyKind } from './topology';

/**
 * A wraparound board with *every* possible unit-step edge present except
 * `omit` — i.e. every face is walled off from every other, so no two faces
 * ever fuse "the long way around" (which is otherwise expected and correct
 * — see the tests above). This isolates exactly one adjacency at a time,
 * which is what the diagonal-corner regression tests below need: with a
 * highly-connected wraparound board, blocking only *one* wall still leaves
 * every other path around the torus/Klein bottle/projective plane intact,
 * so two faces can fuse into the same region despite a real wall directly
 * between them — that's correct behavior, not a bug, but it makes "does
 * this one wall separate these two faces" untestable without removing
 * every alternate path first.
 */
function fullyWalledWrappedPuzzle(W: number, H: number, topologyKind: TopologyKind, omit?: EdgeKey): Puzzle {
  const topology = topologyFor(topologyKind);
  const adj = new Map<string, Set<string>>();
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
  }
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const ek = edgeKey([ax, ay], [bx, by]);
    if (ek === omit) return;
    adj.get(key(ax, ay))!.add(key(bx, by));
    adj.get(key(bx, by))!.add(key(ax, ay));
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const right = x + 1 < W ? { x: x + 1, y } : topology.wrapX(x + 1, y, W, H);
      addEdge(x, y, right.x, right.y);
      const down = y + 1 < H ? { x, y: y + 1 } : topology.wrapY(x, y + 1, W, H);
      addEdge(x, y, down.x, down.y);
    }
  }
  return { adj, W, H, startCell: [0, 0], topology: topologyKind };
}

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

describe('computeRegions', () => {
  it('fuses faces with no possible edge between them into one region, split by an actual edge', () => {
    // 3x2 vertex grid: two faces side by side, (0,0) and (1,0), sharing the
    // vertical edge (1,0)-(1,1). That edge is the only real puzzle edge, so
    // it's a permanent wall between the two faces — they stay separate.
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const { faceToRegion, regions } = computeRegions(puzzle);

    expect(faceToRegion.get('0,0')).not.toBe(faceToRegion.get('1,0'));

    const region0 = regions[faceToRegion.get('0,0')!];
    expect(region0.faces).toEqual([[0, 0]]);
    expect(region0.boundary).toEqual([edgeKey([1, 0], [1, 1])]);

    const region1 = regions[faceToRegion.get('1,0')!];
    expect(region1.faces).toEqual([[1, 0]]);
    expect(region1.boundary).toEqual([edgeKey([1, 0], [1, 1])]);
  });

  it('excludes an edge from the boundary once both its faces are already in the same region via a different fused path', () => {
    // 3x4 vertex grid: a 2x3 grid of faces. The only real edge is the shared
    // side between face (0,0) and face (1,0); every other face-to-face side
    // has no candidate edge (a permanent fuse). That ring of fuses connects
    // (0,0) and (1,0) back together the long way around, through every other
    // face, even though a real edge directly separates them too. Since both
    // its faces land in the same region, this edge is *interior* to it, not
    // a boundary — toggling the region must never touch it (see
    // `computeRegions`'s own doc comment on why: it would let a merged
    // region's tap unmark an edge that has nothing to do with the tapped
    // face, as a pure side effect of the merge).
    const puzzle = puzzleFromEdges(3, 4, [[[1, 0], [1, 1]]]);
    const { faceToRegion, regions } = computeRegions(puzzle);

    const faceKeys = ['0,0', '1,0', '0,1', '1,1', '0,2', '1,2'];
    const regionIds = new Set(faceKeys.map((k) => faceToRegion.get(k)));
    expect(regionIds.size).toBe(1);

    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(6);
    expect(region.boundary).toEqual([]);
  });

  it('regionAt resolves a face to its region id', () => {
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const regionMap = computeRegions(puzzle);
    expect(regionAt(regionMap, [0, 0])).not.toBe(regionAt(regionMap, [1, 0]));
  });

  it('gives the same regions regardless of which direction an edge was inserted in (adj iteration order is not guaranteed canonical)', () => {
    // Same puzzle as the first test, but the wall/cycle edge is inserted
    // "backwards" (from the higher-coordinate vertex to the lower one) —
    // this is exactly what the real generator does, since a Hamiltonian
    // cycle crosses each edge in whichever direction it happens to be
    // walking, not always low-to-high.
    const W = 3;
    const H = 2;
    const adj = new Map<string, Set<string>>();
    // Insert (1,1) before (1,0) in the Map, so computeRegions' iteration
    // over `adj` encounters the higher-coordinate vertex of this edge first.
    adj.set('1,1', new Set());
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (!adj.has(key(x, y))) adj.set(key(x, y), new Set());
      }
    }
    adj.get('1,1')!.add('1,0');
    adj.get('1,0')!.add('1,1');
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0] };

    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('0,0')).not.toBe(faceToRegion.get('1,0'));
    const region0 = regions[faceToRegion.get('0,0')!];
    expect(region0.boundary).toEqual([edgeKey([1, 0], [1, 1])]);
  });

  it('every face belongs to exactly one region, covering the whole (W-1) x (H-1) face grid', () => {
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const { faceToRegion, regions } = computeRegions(puzzle);
    const totalFaces = regions.reduce((sum, r) => sum + r.faces.length, 0);
    expect(totalFaces).toBe(2); // (3-1) x (2-1)
    expect(faceToRegion.size).toBe(2);
  });

  it('skips faces that do not exist on a shaped (non-rectangular) board — any of their 4 corners missing', () => {
    // 4x4 vertex grid with vertex (2,2) entirely absent (as if that cell were
    // outside the board's shape). The 4 faces that would need (2,2) as a
    // corner — (1,1), (2,1), (1,2), (2,2) — don't exist; the other 5 do.
    const W = 4;
    const H = 4;
    const adj = new Map<string, Set<string>>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (x === 2 && y === 2) continue;
        adj.set(key(x, y), new Set());
      }
    }
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0] };
    const { faceToRegion, regions } = computeRegions(puzzle);

    const missing: [number, number][] = [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ];
    for (const [fx, fy] of missing) expect(faceToRegion.has(key(fx, fy))).toBe(false);

    const totalFaces = regions.reduce((sum, r) => sum + r.faces.length, 0);
    expect(totalFaces).toBe(9 - 4); // (4-1) x (4-1) faces, minus the 4 touching the hole
    expect(faceToRegion.size).toBe(5);
  });

  it('wraps face adjacency across the seam on a toroidal board', () => {
    // 4x4 toroidal board: the only real edge is a wraparound one, between
    // (0,0) and (0,3) — connecting row 3 back to row 0. Every other
    // adjacent face pair (including other wraps) has no candidate edge, so
    // they all fuse into one region the long way around the torus — same
    // shape as the rectangular "excludes an edge... via a different fused
    // path" test above, so the one real edge ends up interior (excluded),
    // not a boundary edge.
    const W = 4;
    const H = 4;
    const adj = new Map<string, Set<string>>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
    }
    adj.get(key(0, 0))!.add(key(0, 3));
    adj.get(key(0, 3))!.add(key(0, 0));
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0], topology: 'torus' };

    const { faceToRegion, regions } = computeRegions(puzzle);
    // Toroidal: every face in the full W x H grid exists.
    expect(faceToRegion.size).toBe(W * H);

    const regionIds = new Set(faceToRegion.values());
    expect(regionIds.size).toBe(1);
    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(W * H);
    expect(region.boundary).toEqual([]);
  });

  it('wraps face adjacency across a flip seam on a Klein bottle board', () => {
    // 4x4 Klein bottle board: klein wraps x straight but y with an x-flip.
    // The only real edge is the wraparound one crossing the y-seam: (1,3)
    // steps down to KLEIN_BOTTLE.wrapY(1, 4, 4, 4) = (4-1-1, 0) = (2,0).
    // Every other adjacent face pair (including other wraps) has no
    // candidate edge, so — same shape as the torus test above — they all
    // fuse into one region the long way around, leaving the one real edge
    // interior (excluded from the boundary).
    const W = 4;
    const H = 4;
    const adj = new Map<string, Set<string>>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
    }
    adj.get(key(1, 3))!.add(key(2, 0));
    adj.get(key(2, 0))!.add(key(1, 3));
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0], topology: 'klein' };

    expect(KLEIN_BOTTLE.wrapY(1, 4, 4, 4)).toEqual({ x: 2, y: 0, flip: { flipX: true, flipY: false } });

    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(W * H);
    const regionIds = new Set(faceToRegion.values());
    expect(regionIds.size).toBe(1);
    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(W * H);
    expect(region.boundary).toEqual([]);
  });

  it('wraps face adjacency across a flip seam on a projective plane board', () => {
    // 4x4 projective plane board: both directions flip. The only real edge
    // crosses the x-seam: (3,1) steps right to
    // PROJECTIVE_PLANE.wrapX(4, 1, 4, 4) = (0, 4-1-1) = (0,2). Same shape as
    // the torus/Klein tests above — the one real edge ends up interior.
    const W = 4;
    const H = 4;
    const adj = new Map<string, Set<string>>();
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) adj.set(key(x, y), new Set());
    }
    adj.get(key(3, 1))!.add(key(0, 2));
    adj.get(key(0, 2))!.add(key(3, 1));
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0], topology: 'projective' };

    expect(PROJECTIVE_PLANE.wrapX(4, 1, 4, 4)).toEqual({ x: 0, y: 2, flip: { flipX: false, flipY: true } });

    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(W * H);
    const regionIds = new Set(faceToRegion.values());
    expect(regionIds.size).toBe(1);
    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(W * H);
    expect(region.boundary).toEqual([]);
  });
});

describe('computeRegions with locked edges', () => {
  it('treats a locked edge exactly like a permanent wall: fuses its two faces and excludes it from every boundary', () => {
    // Same setup as the very first `computeRegions` test above, where this
    // edge being a real (unlocked) candidate edge is exactly what keeps the
    // two faces in separate regions. Locking it should flip that: the two
    // faces fuse into one region, and the edge disappears from every
    // boundary (nothing can ever toggle it again).
    const base = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const lockedEk = edgeKey([1, 0], [1, 1]);
    const puzzle: Puzzle = { ...base, lockedEdges: new Set([lockedEk]) };
    const { faceToRegion, regions } = computeRegions(puzzle);

    expect(faceToRegion.get('0,0')).toBe(faceToRegion.get('1,0'));
    const region = regions[faceToRegion.get('0,0')!];
    expect(region.faces).toHaveLength(2);
    expect(region.boundary).toEqual([]);
  });

  it('a puzzle with no lockedEdges field behaves exactly as before this feature existed', () => {
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    expect(puzzle.lockedEdges).toBeUndefined();
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('0,0')).not.toBe(faceToRegion.get('1,0'));
    expect(regions.some((r) => r.boundary.length > 0)).toBe(true);
  });
});

describe('regionsForEdge', () => {
  it('finds both regions sharing a boundary edge', () => {
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const regionMap = computeRegions(puzzle);
    const ek = edgeKey([1, 0], [1, 1]);
    const ids = regionsForEdge(regionMap, ek).sort();
    expect(ids).toEqual([regionMap.faceToRegion.get('0,0'), regionMap.faceToRegion.get('1,0')].sort());
  });

  it('returns nothing for an edge that is not on any boundary (already locked)', () => {
    const base = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const ek = edgeKey([1, 0], [1, 1]);
    const puzzle: Puzzle = { ...base, lockedEdges: new Set([ek]) };
    const regionMap = computeRegions(puzzle);
    expect(regionsForEdge(regionMap, ek)).toEqual([]);
  });

  it('returns nothing for a coordinate pair that was never a real puzzle-graph edge at all', () => {
    const puzzle = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const regionMap = computeRegions(puzzle);
    expect(regionsForEdge(regionMap, edgeKey([0, 0], [1, 0]))).toEqual([]);
  });
});

/** Sorted, comparable snapshot of a `RegionMap`'s actual partition — which faces group together and what each group's boundary is — independent of the specific ids/ordering `computeRegions` vs. `lockEdgeInRegionMap` happen to assign, since only the grouping/boundary content should agree between the two, not the incidental numbering (`lockEdgeInRegionMap` deliberately reuses/tombstones ids for stability, which `computeRegions` has no reason to reproduce from scratch). */
function regionMapFingerprint(regionMap: RegionMap): string {
  const groups = regionMap.regions
    .filter((r) => r.faces.length > 0)
    .map((r) => ({
      faces: [...r.faces].map(([x, y]) => `${x},${y}`).sort(),
      boundary: [...r.boundary].sort(),
    }))
    .sort((a, b) => a.faces[0]!.localeCompare(b.faces[0]!));
  return JSON.stringify(groups);
}

/**
 * Two 2-face columns (A = {(0,0),(0,1)}, B = {(1,0),(1,1)}) on a 3x3 vertex
 * grid, connected by *two* separate real edges instead of just one: E1 =
 * (1,0)-(1,1) (between (0,0) and (1,0)) and E2 = (1,1)-(1,2) (between (0,1)
 * and (1,1)). Every other wall — including each column's own internal wall
 * — is a non-edge, so (0,0)/(0,1) fuse into region A and (1,0)/(1,1) fuse
 * into region B, leaving E1 and E2 as A and B's *only* two direct
 * connectors. This is the shape that exposes the regression this module's
 * tests are guarding against: naively unioning A's and B's boundaries when
 * locking E1 would wrongly leave E2 toggleable even though both its faces
 * are now inside the same merged region.
 */
function twoConnectorPuzzle(): { puzzle: Puzzle; e1: EdgeKey; e2: EdgeKey } {
  const puzzle = puzzleFromEdges(3, 3, [
    [[1, 0], [1, 1]],
    [[1, 1], [1, 2]],
  ]);
  return { puzzle, e1: edgeKey([1, 0], [1, 1]), e2: edgeKey([1, 1], [1, 2]) };
}

describe('lockEdgeInRegionMap', () => {
  it('matches a from-scratch computeRegions recompute after locking a single edge', () => {
    const base = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const ek = edgeKey([1, 0], [1, 1]);
    const regionMap0 = computeRegions(base);

    const { regionMap: incremental } = lockEdgeInRegionMap(regionMap0, ek);
    const fromScratch = computeRegions({ ...base, lockedEdges: new Set([ek]) });
    expect(regionMapFingerprint(incremental)).toBe(regionMapFingerprint(fromScratch));
  });

  it('matches a from-scratch recompute after locking a whole batch of edges, one at a time, on a real generated puzzle', () => {
    const puzzle = buildPuzzle(rectShape(6, 9), 0.28, mulberry32(2024));
    const solutionAndDistractorEdges = [...new Set([...puzzle.adj.entries()].flatMap(([a, bs]) => [...bs].map((b) => edgeKey(parseKey(a), parseKey(b)))))];
    const toLock = solutionAndDistractorEdges.slice(0, 12);

    let regionMap = computeRegions(puzzle);
    for (const ek of toLock) {
      ({ regionMap } = lockEdgeInRegionMap(regionMap, ek));
    }
    const fromScratch = computeRegions({ ...puzzle, lockedEdges: new Set(toLock) });
    expect(regionMapFingerprint(regionMap)).toBe(regionMapFingerprint(fromScratch));
  });

  it('returns the regionMap unchanged (no throw) for an edge already excluded from every boundary', () => {
    const base = puzzleFromEdges(3, 2, [[[1, 0], [1, 1]]]);
    const ek = edgeKey([1, 0], [1, 1]);
    const { regionMap: locked } = lockEdgeInRegionMap(computeRegions(base), ek);
    const result = lockEdgeInRegionMap(locked, ek);
    expect(result.strandedEdges).toEqual([]);
    expect(regionMapFingerprint(result.regionMap)).toBe(regionMapFingerprint(locked));
  });

  it('every region id still matches its own array index (an invariant computeRegions also holds)', () => {
    const puzzle = buildPuzzle(rectShape(6, 9), 0.28, mulberry32(7));
    let regionMap = computeRegions(puzzle);
    const edges = [...new Set([...puzzle.adj.entries()].flatMap(([a, bs]) => [...bs].map((b) => edgeKey(parseKey(a), parseKey(b)))))].slice(0, 8);
    for (const ek of edges) ({ regionMap } = lockEdgeInRegionMap(regionMap, ek));
    regionMap.regions.forEach((r, i) => expect(r.id).toBe(i));
  });

  describe('merging two regions that share more than one real edge (regression coverage)', () => {
    it('excludes every shared connector from the merged boundary, not just the one being locked — symmetric difference, not union', () => {
      const { puzzle, e1, e2 } = twoConnectorPuzzle();
      const regionMap0 = computeRegions(puzzle);
      // Sanity-check the fixture: both e1 and e2 separate the same two regions before locking.
      expect(regionsForEdge(regionMap0, e1).sort()).toEqual(regionsForEdge(regionMap0, e2).sort());

      const { regionMap: merged, strandedEdges } = lockEdgeInRegionMap(regionMap0, e1);
      expect(strandedEdges).toEqual([e2]);

      const mergedRegionId = merged.faceToRegion.get('0,0')!;
      expect(merged.faceToRegion.get('1,0')).toBe(mergedRegionId); // A and B are now one region
      // Neither connector is toggleable any more: e1 because it's locked,
      // e2 because it's now interior (both faces in the same region).
      expect(merged.regions[mergedRegionId].boundary).toEqual([]);
    });

    it('matches a from-scratch recompute once the stranded edge is also locked (the real-world sequence puzzleGen.ts follows)', () => {
      const { puzzle, e1, e2 } = twoConnectorPuzzle();
      const regionMap0 = computeRegions(puzzle);
      const { regionMap: afterE1, strandedEdges } = lockEdgeInRegionMap(regionMap0, e1);
      expect(strandedEdges).toEqual([e2]);

      // e2 is already excluded everywhere, so locking it too is a no-op on the regionMap shape (see the "returns unchanged" test above) but still needs recording in `lockedEdges` for a real caller.
      const { regionMap: afterBoth } = lockEdgeInRegionMap(afterE1, e2);
      const fromScratch = computeRegions({ ...puzzle, lockedEdges: new Set([e1, e2]) });
      expect(regionMapFingerprint(afterBoth)).toBe(regionMapFingerprint(fromScratch));
    });

    it('keeps a connector edge unique to one side in the merged boundary (only *shared* connectors get excluded)', () => {
      // Same two-column fixture, plus a third edge E3 bordering region A's
      // own outer (true board) edge — E3 has nothing to do with region B at
      // all, so merging A into B by locking E1 must leave E3 exactly as
      // toggleable as it always was.
      const { puzzle: base, e1 } = twoConnectorPuzzle();
      const e3 = edgeKey([0, 0], [1, 0]); // (0,0)'s own top wall — a true board edge, unique to region A
      const adj = new Map(base.adj);
      const addEdge = (a: [number, number], b: [number, number]) => {
        adj.set(key(...a), new Set(adj.get(key(...a))));
        adj.set(key(...b), new Set(adj.get(key(...b))));
        adj.get(key(...a))!.add(key(...b));
        adj.get(key(...b))!.add(key(...a));
      };
      addEdge([0, 0], [1, 0]);
      const puzzle: Puzzle = { ...base, adj };

      const regionMap0 = computeRegions(puzzle);
      expect(regionsForEdge(regionMap0, e3)).toHaveLength(1); // only region A borders it

      const { regionMap: merged, strandedEdges } = lockEdgeInRegionMap(regionMap0, e1);
      expect(strandedEdges).not.toContain(e3);
      const mergedRegionId = merged.faceToRegion.get('0,0')!;
      expect(merged.regions[mergedRegionId].boundary).toEqual([e3]);
    });
  });
});

describe('computeRegions at the diagonal-wrap corner (regression: face-adjacency used to break down where both axes wrap at once)', () => {
  // Computing the corner face (3,3)'s right- and below-neighbors requires
  // the vertex diagonally across from it, (4,4), which needs *both* axes
  // wrapped at once — every other face's adjacency only ever needs one
  // axis wrapped. On a highly-connected wraparound board, blocking just
  // *one* wall isn't enough to test this in isolation (there's always a
  // path the long way around — see the tests above, where that's the
  // correct, intended behavior) — so these use `fullyWalledWrappedPuzzle`
  // to wall off every adjacency except one at a time, isolating exactly
  // the corner's own right- and below-neighbor checks.
  const rightEdge: Record<TopologyKind, EdgeKey> = {
    torus: edgeKey([0, 3], [0, 0]),
    klein: edgeKey([0, 3], [3, 0]),
    projective: edgeKey([0, 0], [3, 3]),
  };
  const belowEdge: Record<TopologyKind, EdgeKey> = {
    torus: edgeKey([3, 0], [0, 0]),
    klein: edgeKey([0, 0], [3, 0]),
    projective: edgeKey([0, 0], [3, 3]),
  };
  const rightFace: Record<TopologyKind, string> = { torus: '0,3', klein: '0,3', projective: '0,3' };
  const belowFace: Record<TopologyKind, string> = { torus: '3,0', klein: '3,0', projective: '3,0' };

  it.each(['torus', 'klein', 'projective'] as const)('a fully-walled %s board keeps every face — including the corner — its own singleton region', (topology) => {
    const puzzle = fullyWalledWrappedPuzzle(4, 4, topology);
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(16);
    expect(regions).toHaveLength(16);
    for (const region of regions) expect(region.faces).toHaveLength(1);
  });

  it.each(['torus', 'klein'] as const)('omitting just the corner face\'s right-wall lets it (only) fuse with its true right-neighbor on a %s board', (topology) => {
    const puzzle = fullyWalledWrappedPuzzle(4, 4, topology, rightEdge[topology]);
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('3,3')).toBe(faceToRegion.get(rightFace[topology]));
    const region = regions[faceToRegion.get('3,3')!];
    expect(region.faces).toHaveLength(2);
    expect(regions).toHaveLength(15);
  });

  it.each(['torus', 'klein'] as const)('omitting just the corner face\'s below-wall lets it (only) fuse with its true below-neighbor on a %s board', (topology) => {
    const puzzle = fullyWalledWrappedPuzzle(4, 4, topology, belowEdge[topology]);
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('3,3')).toBe(faceToRegion.get(belowFace[topology]));
    const region = regions[faceToRegion.get('3,3')!];
    expect(region.faces).toHaveLength(2);
    expect(regions).toHaveLength(15);
  });

  it('on a projective plane board, the corner face\'s (0,0)-(3,3) wall is shared by four face-adjacency checks at once', () => {
    // PROJECTIVE_PLANE's antipodal-style gluing means vertex (3,3) is the
    // wall-check vertex for more than just the corner face's own right/below
    // neighbors: rightOf(3,3), belowOf(3,3), rightOf(2,3), and belowOf(3,2)
    // all reduce to this exact same vertex pair, (0,0)-(3,3) — unlike
    // torus/klein, where the corner's right-wall and below-wall are two
    // distinct edges. So omitting this one edge fuses all five faces these
    // four checks touch — (3,3), (0,3), (3,0), (2,3), (3,2) — into a single
    // region, not just the corner with one neighbor.
    expect(rightEdge.projective).toBe(belowEdge.projective);
    const puzzle = fullyWalledWrappedPuzzle(4, 4, 'projective', rightEdge.projective);
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('3,3')).toBe(faceToRegion.get(rightFace.projective));
    expect(faceToRegion.get('3,3')).toBe(faceToRegion.get(belowFace.projective));
    const region = regions[faceToRegion.get('3,3')!];
    expect(new Set(region.faces.map(([x, y]) => key(x, y)))).toEqual(new Set(['3,3', '0,3', '3,0', '2,3', '3,2']));
    expect(regions).toHaveLength(12);
  });

  it("a non-corner face's own left wall can independently reach the degenerate corner face on a projective plane board", () => {
    // On a 6x8 projective plane board, face (0,7)'s own left wall — the
    // vertex pair `vertexAt(0,7)`-`vertexAt(0,8)` — reduces to (0,7)-(5,0),
    // which is a real candidate edge in its own right (unrelated to the
    // corner face (5,7)'s own degenerate self-pairing tested above). Its
    // wrapped neighbor across that wall, `faceNeighbor(0,7,-1,0)`, is the
    // corner face (5,7) — but `rightOf`/`belowOf`, checked from *every*
    // face on the board, never happen to test this exact vertex pair from
    // *either* side (the corner's own degenerate right/below walls reduce
    // to a *different* pair, (0,0)-(5,7) — see the projective test above).
    // A version of `computeRegions` that only ever asked each face for its
    // own right and below walls would never discover this merge at all —
    // omitting this one edge should fuse face (0,7) with the corner face
    // regardless.
    const puzzle = fullyWalledWrappedPuzzle(6, 8, 'projective', edgeKey([0, 7], [5, 0]));
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.get('0,7')).toBe(faceToRegion.get('5,7'));
    const region = regions[faceToRegion.get('0,7')!];
    expect(region.faces.map(([x, y]) => key(x, y))).toContain('5,7');
  });
});

describe('computeRegions on real generated puzzles', () => {
  it('covers every existing face on a random-shape puzzle, none of them phantom', () => {
    const puzzle = buildRandomShapePuzzle(6, 9, 0.3, mulberry32(7));
    const { faceToRegion, regions } = computeRegions(puzzle);
    for (const region of regions) {
      for (const [fx, fy] of region.faces) {
        expect(puzzle.adj.has(key(fx, fy))).toBe(true);
        expect(puzzle.adj.has(key(fx + 1, fy))).toBe(true);
        expect(puzzle.adj.has(key(fx, fy + 1))).toBe(true);
        expect(puzzle.adj.has(key(fx + 1, fy + 1))).toBe(true);
      }
    }
    expect(faceToRegion.size).toBeGreaterThan(0);
  });

  it('covers the full W x H face grid on a toroidal puzzle', () => {
    const puzzle = buildToroidalPuzzle(5, 4, 0.3, mulberry32(3));
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(puzzle.W * puzzle.H);
    const totalFaces = regions.reduce((sum, r) => sum + r.faces.length, 0);
    expect(totalFaces).toBe(puzzle.W * puzzle.H);
  });

  it('covers the full W x H face grid on a Klein bottle puzzle', () => {
    const puzzle = buildKleinBottlePuzzle(5, 4, 0.3, mulberry32(3));
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(puzzle.W * puzzle.H);
    const totalFaces = regions.reduce((sum, r) => sum + r.faces.length, 0);
    expect(totalFaces).toBe(puzzle.W * puzzle.H);
  });

  it('covers the full W x H face grid on a projective plane puzzle', () => {
    const puzzle = buildProjectivePlanePuzzle(5, 4, 0.3, mulberry32(3));
    const { faceToRegion, regions } = computeRegions(puzzle);
    expect(faceToRegion.size).toBe(puzzle.W * puzzle.H);
    const totalFaces = regions.reduce((sum, r) => sum + r.faces.length, 0);
    expect(totalFaces).toBe(puzzle.W * puzzle.H);
  });
});
