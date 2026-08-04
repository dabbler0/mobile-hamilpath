import { describe, expect, it } from 'vitest';
import { computeRegions, edgeKey, regionAt, type EdgeKey } from './regions';
import { buildKleinBottlePuzzle, buildProjectivePlanePuzzle, buildRandomShapePuzzle, buildToroidalPuzzle, key, type Puzzle } from './puzzle';
import { mulberry32 } from './rng';
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

  it('lists a boundary edge once even when both its faces are already in the same region via a different fused path', () => {
    // 3x4 vertex grid: a 2x3 grid of faces. The only real edge is the shared
    // side between face (0,0) and face (1,0); every other face-to-face side
    // has no candidate edge (a permanent fuse). That ring of fuses connects
    // (0,0) and (1,0) back together the long way around, through every other
    // face, even though a real edge directly separates them too.
    const puzzle = puzzleFromEdges(3, 4, [[[1, 0], [1, 1]]]);
    const { faceToRegion, regions } = computeRegions(puzzle);

    const faceKeys = ['0,0', '1,0', '0,1', '1,1', '0,2', '1,2'];
    const regionIds = new Set(faceKeys.map((k) => faceToRegion.get(k)));
    expect(regionIds.size).toBe(1);

    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(6);
    expect(region.boundary).toEqual([edgeKey([1, 0], [1, 1])]);
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
    // shape as the rectangular "boundary edge listed once" test above.
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
    expect(region.boundary).toEqual([edgeKey([0, 0], [0, 3])]);
  });

  it('wraps face adjacency across a flip seam on a Klein bottle board', () => {
    // 4x4 Klein bottle board: klein wraps x straight but y with an x-flip.
    // The only real edge is the wraparound one crossing the y-seam: (1,3)
    // steps down to KLEIN_BOTTLE.wrapY(1, 4, 4, 4) = (4-1-1, 0) = (2,0).
    // Every other adjacent face pair (including other wraps) has no
    // candidate edge, so — same shape as the torus test above — they all
    // fuse into one region the long way around.
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
    expect(region.boundary).toEqual([edgeKey([1, 3], [2, 0])]);
  });

  it('wraps face adjacency across a flip seam on a projective plane board', () => {
    // 4x4 projective plane board: both directions flip. The only real edge
    // crosses the x-seam: (3,1) steps right to
    // PROJECTIVE_PLANE.wrapX(4, 1, 4, 4) = (0, 4-1-1) = (0,2).
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
    expect(region.boundary).toEqual([edgeKey([3, 1], [0, 2])]);
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
