import type { Cell } from './hamiltonianCycle';
import { key, parseKey, type CellKey, type Puzzle } from './puzzle';

export type EdgeKey = string;

/** Canonical key for the (undirected) edge between two cells: order-independent. */
export function edgeKey(a: Cell, b: Cell): EdgeKey {
  const ka = key(a[0], a[1]);
  const kb = key(b[0], b[1]);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function parseEdgeKey(k: EdgeKey): [Cell, Cell] {
  const [ka, kb] = k.split('|');
  return [parseKey(ka), parseKey(kb)];
}

export interface Region {
  id: number;
  cells: Cell[];
  /** Every puzzle-graph edge that separates this region from a neighboring cell (possibly another cell of this same region, if it wraps around). Toggling the region flips all of these. */
  boundary: EdgeKey[];
}

export interface RegionMap {
  cellToRegion: Map<CellKey, number>;
  regions: Region[];
}

/**
 * Partitions the full W x H lattice into regions: maximal groups of cells
 * with no possible puzzle-graph edge between any of them anywhere along a
 * path connecting them, i.e. cells joined only through orthogonal-neighbor
 * pairs that are *not* in `puzzle.adj` (a permanent wall never separates
 * them, since no edge could ever be drawn there). This partition is fixed
 * by the puzzle alone and doesn't depend on which edges are currently
 * marked. A region's `boundary` is exactly the puzzle-graph edges that
 * border it, which is what a region toggle flips.
 */
export function computeRegions(puzzle: Puzzle): RegionMap {
  const { W, H, adj } = puzzle;
  const n = W * H;
  const idOf = (x: number, y: number) => y * W + x;

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const k = key(x, y);
      const neighbors = adj.get(k);
      if (x + 1 < W && !neighbors?.has(key(x + 1, y))) union(idOf(x, y), idOf(x + 1, y));
      if (y + 1 < H && !neighbors?.has(key(x, y + 1))) union(idOf(x, y), idOf(x, y + 1));
    }
  }

  const cellToRegion = new Map<CellKey, number>();
  const rootToRegionId = new Map<number, number>();
  const regions: Region[] = [];

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const root = find(idOf(x, y));
      let regionId = rootToRegionId.get(root);
      if (regionId === undefined) {
        regionId = regions.length;
        rootToRegionId.set(root, regionId);
        regions.push({ id: regionId, cells: [], boundary: [] });
      }
      regions[regionId].cells.push([x, y]);
      cellToRegion.set(key(x, y), regionId);
    }
  }

  const seenBoundary = new Set<string>();
  for (const [k, neighbors] of adj) {
    const [x1, y1] = parseKey(k);
    for (const nk of neighbors) {
      const dedupeKey = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
      if (seenBoundary.has(dedupeKey)) continue;
      seenBoundary.add(dedupeKey);
      const [x2, y2] = parseKey(nk);
      const ek = edgeKey([x1, y1], [x2, y2]);
      const region1 = regions[cellToRegion.get(k)!];
      const region2 = regions[cellToRegion.get(nk)!];
      region1.boundary.push(ek);
      if (region2.id !== region1.id) region2.boundary.push(ek);
    }
  }

  return { cellToRegion, regions };
}

export function regionAt(regionMap: RegionMap, cell: Cell): number | null {
  return regionMap.cellToRegion.get(key(cell[0], cell[1])) ?? null;
}
