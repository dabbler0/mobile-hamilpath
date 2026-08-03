import { describe, expect, it } from 'vitest';
import { computeRegions, edgeKey, regionAt } from './regions';
import { buildRandomShapePuzzle, buildToroidalPuzzle, key, type Puzzle } from './puzzle';
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
    const puzzle: Puzzle = { adj, W, H, startCell: [0, 0], toroidal: true };

    const { faceToRegion, regions } = computeRegions(puzzle);
    // Toroidal: every face in the full W x H grid exists.
    expect(faceToRegion.size).toBe(W * H);

    const regionIds = new Set(faceToRegion.values());
    expect(regionIds.size).toBe(1);
    const region = regions[[...regionIds][0]!];
    expect(region.faces).toHaveLength(W * H);
    expect(region.boundary).toEqual([edgeKey([0, 0], [0, 3])]);
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
});
