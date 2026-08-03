import type { Cell } from './hamiltonianCycle';
import { key, parseKey, type Puzzle } from './puzzle';

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

/**
 * A face: the unit grid square enclosed by the four graph vertices
 * (fx,fy)-(fx+1,fy)-(fx,fy+1)-(fx+1,fy+1). This is what a player actually
 * taps — the everyday sense of "cell" (a grid square), as opposed to a
 * graph vertex (`Cell` elsewhere in this codebase, which the path visits).
 * Valid range: fx in [0, W-2], fy in [0, H-2] — one less than the vertex
 * grid in each dimension, since a face needs a vertex on every side of it.
 */
export type Face = readonly [number, number];
type FaceKey = string;

export interface Region {
  id: number;
  /** The faces (grid squares) that make up this region. */
  faces: Face[];
  /** Every puzzle-graph edge that separates this region's faces from a neighboring face in a different region (or from the outside the board, where there's no neighboring face at all). Toggling the region flips all of these. */
  boundary: EdgeKey[];
}

export interface RegionMap {
  faceToRegion: Map<FaceKey, number>;
  regions: Region[];
}

/**
 * Partitions the board's faces (grid squares between vertices — see `Face`)
 * into regions: maximal groups of faces with no possible puzzle-graph edge
 * between any of them anywhere along a path connecting them, i.e. faces
 * joined only through shared sides that are *not* an edge in `puzzle.adj`
 * (a permanent wall never separates them, since no edge could ever be drawn
 * there). This partition is fixed by the puzzle alone and doesn't depend on
 * which edges are currently marked.
 *
 * This is the geometric structure the puzzle generator actually produces:
 * with no distractor edges, the puzzle graph's Hamiltonian cycle is exactly
 * the outer boundary of the "thickened" block spanning tree, so the faces
 * split into just a couple of regions (the tree's thickened corridor, and
 * whatever's left outside it) whose toggle reaches the cycle exactly. This
 * does *not* hold for a partition of graph vertices instead of faces (an
 * earlier, incorrect version of this function did that, and regions came
 * out badly fragmented with no combination able to reach the cycle).
 */
export function computeRegions(puzzle: Puzzle): RegionMap {
  const { W, H, adj } = puzzle;
  const FW = W - 1;
  const FH = H - 1;
  const nFaces = FW * FH;
  const faceId = (fx: number, fy: number) => fy * FW + fx;

  const parent = new Int32Array(nFaces);
  for (let i = 0; i < nFaces; i++) parent[i] = i;
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

  function hasEdge(x1: number, y1: number, x2: number, y2: number): boolean {
    return adj.get(key(x1, y1))?.has(key(x2, y2)) ?? false;
  }

  for (let fx = 0; fx < FW; fx++) {
    for (let fy = 0; fy < FH; fy++) {
      // Right neighbor face shares the vertical edge (fx+1,fy)-(fx+1,fy+1).
      if (fx + 1 < FW && !hasEdge(fx + 1, fy, fx + 1, fy + 1)) union(faceId(fx, fy), faceId(fx + 1, fy));
      // Below neighbor face shares the horizontal edge (fx,fy+1)-(fx+1,fy+1).
      if (fy + 1 < FH && !hasEdge(fx, fy + 1, fx + 1, fy + 1)) union(faceId(fx, fy), faceId(fx, fy + 1));
    }
  }

  const faceToRegion = new Map<FaceKey, number>();
  const rootToRegionId = new Map<number, number>();
  const regions: Region[] = [];

  for (let fx = 0; fx < FW; fx++) {
    for (let fy = 0; fy < FH; fy++) {
      const root = find(faceId(fx, fy));
      let regionId = rootToRegionId.get(root);
      if (regionId === undefined) {
        regionId = regions.length;
        rootToRegionId.set(root, regionId);
        regions.push({ id: regionId, faces: [], boundary: [] });
      }
      regions[regionId].faces.push([fx, fy]);
      faceToRegion.set(key(fx, fy), regionId);
    }
  }

  /** The face(s) (0, 1, or 2 of them) that have this vertex-pair as one of their four sides. Takes the pair in either order — normalizes internally. */
  function facesBordering(ax: number, ay: number, bx: number, by: number): Face[] {
    const faces: Face[] = [];
    if (ay === by) {
      // Horizontal edge (x,y)-(x+1,y): the top side of face (x,y), the bottom side of face (x,y-1).
      const x = Math.min(ax, bx);
      const y = ay;
      if (y < FH) faces.push([x, y]);
      if (y - 1 >= 0) faces.push([x, y - 1]);
    } else {
      // Vertical edge (x,y)-(x,y+1): the left side of face (x,y), the right side of face (x-1,y).
      const x = ax;
      const y = Math.min(ay, by);
      if (x < FW) faces.push([x, y]);
      if (x - 1 >= 0) faces.push([x - 1, y]);
    }
    return faces;
  }

  const seenEdges = new Set<string>();
  for (const [k, neighbors] of adj) {
    const [x1, y1] = parseKey(k);
    for (const nk of neighbors) {
      const dedupeKey = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
      if (seenEdges.has(dedupeKey)) continue;
      seenEdges.add(dedupeKey);
      const [x2, y2] = parseKey(nk);
      const ek = edgeKey([x1, y1], [x2, y2]);
      const bordering = facesBordering(x1, y1, x2, y2);
      const touchedRegionIds = new Set(bordering.map(([fx, fy]) => faceToRegion.get(key(fx, fy))!));
      for (const rid of touchedRegionIds) regions[rid].boundary.push(ek);
    }
  }

  return { faceToRegion, regions };
}

export function regionAt(regionMap: RegionMap, face: Face): number | null {
  return regionMap.faceToRegion.get(key(face[0], face[1])) ?? null;
}
