import { describe, expect, it } from 'vitest';
import { computeRegions, edgeKey, regionAt } from './regions';
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
});
