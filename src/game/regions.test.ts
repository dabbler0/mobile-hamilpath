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
  it('fuses cells with no possible edge between them into one region, split by an actual edge', () => {
    // 3x1 strip: (0,0)-(1,0) has no candidate edge (permanent wall-less fuse), (1,0)-(2,0) does.
    const puzzle = puzzleFromEdges(3, 1, [[[1, 0], [2, 0]]]);
    const { cellToRegion, regions } = computeRegions(puzzle);

    expect(cellToRegion.get('0,0')).toBe(cellToRegion.get('1,0'));
    expect(cellToRegion.get('2,0')).not.toBe(cellToRegion.get('1,0'));

    const fusedRegion = regions[cellToRegion.get('0,0')!];
    expect(fusedRegion.cells).toHaveLength(2);
    expect(fusedRegion.boundary).toEqual([edgeKey([1, 0], [2, 0])]);

    const otherRegion = regions[cellToRegion.get('2,0')!];
    expect(otherRegion.cells).toEqual([[2, 0]]);
    expect(otherRegion.boundary).toEqual([edgeKey([1, 0], [2, 0])]);
  });

  it('lists a boundary edge once even when both its cells are already in the same region via a different fused path', () => {
    // 2x3 grid, ring of 6 cells fused everywhere except one candidate edge (0,0)-(1,0);
    // that edge's two endpoints are still connected the long way around via fused pairs.
    const puzzle = puzzleFromEdges(2, 3, [[[0, 0], [1, 0]]]);
    const { cellToRegion, regions } = computeRegions(puzzle);

    const regionIds = new Set(['0,0', '1,0', '0,1', '1,1', '0,2', '1,2'].map((k) => cellToRegion.get(k)));
    expect(regionIds.size).toBe(1);

    const region = regions[[...regionIds][0]!];
    expect(region.cells).toHaveLength(6);
    expect(region.boundary).toEqual([edgeKey([0, 0], [1, 0])]);
  });

  it('regionAt resolves a cell to its region id', () => {
    const puzzle = puzzleFromEdges(3, 1, [[[1, 0], [2, 0]]]);
    const regionMap = computeRegions(puzzle);
    expect(regionAt(regionMap, [0, 0])).toBe(regionAt(regionMap, [1, 0]));
    expect(regionAt(regionMap, [2, 0])).not.toBe(regionAt(regionMap, [0, 0]));
  });

  it('every cell belongs to exactly one region, covering the whole board', () => {
    const puzzle = puzzleFromEdges(3, 1, [[[1, 0], [2, 0]]]);
    const { cellToRegion, regions } = computeRegions(puzzle);
    const totalCells = regions.reduce((sum, r) => sum + r.cells.length, 0);
    expect(totalCells).toBe(3);
    expect(cellToRegion.size).toBe(3);
  });
});
