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
 * Valid range: fx in [0, W-2], fy in [0, H-2] for an ordinary board — one
 * less than the vertex grid in each dimension, since a face needs a vertex
 * on every side of it. For a toroidal board every fx/fy in [0, W) x [0, H)
 * is valid too: the last column/row's face wraps its right/bottom side back
 * to column/row 0.
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
 *
 * Two generalizations beyond a plain rectangle:
 *  - A non-rectangular shaped board simply has some faces that don't exist
 *    at all (any of their 4 corners is a cell outside the shape, so it's not
 *    a graph vertex) — those faces are skipped entirely, never assigned a
 *    region.
 *  - A toroidal board (`puzzle.toroidal`) wraps: every face in the full
 *    W x H grid exists (there's no "last column/row" edge to stop at), and
 *    a face's right/bottom neighbor (and the vertex edges bordering it)
 *    wrap back to column/row 0.
 */
export function computeRegions(puzzle: Puzzle): RegionMap {
  const { W, H, adj, toroidal } = puzzle;
  const FW = toroidal ? W : W - 1;
  const FH = toroidal ? H : H - 1;
  const nFaces = FW * FH;
  const faceId = (fx: number, fy: number) => fy * FW + fx;
  const wrapX = (x: number) => ((x % W) + W) % W;
  const wrapY = (y: number) => ((y % H) + H) % H;

  function hasEdge(x1: number, y1: number, x2: number, y2: number): boolean {
    return adj.get(key(x1, y1))?.has(key(x2, y2)) ?? false;
  }

  /** Whether a face exists at all — for a toroidal board, always (it fills the whole rectangle); otherwise all 4 corners must be real graph vertices. */
  function faceExists(fx: number, fy: number): boolean {
    if (toroidal) return true;
    return adj.has(key(fx, fy)) && adj.has(key(fx + 1, fy)) && adj.has(key(fx, fy + 1)) && adj.has(key(fx + 1, fy + 1));
  }

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

  for (let fx = 0; fx < FW; fx++) {
    for (let fy = 0; fy < FH; fy++) {
      if (!faceExists(fx, fy)) continue;

      const hasRightNeighbor = toroidal || fx + 1 < FW;
      if (hasRightNeighbor) {
        const nfx = toroidal ? wrapX(fx + 1) : fx + 1;
        if (faceExists(nfx, fy)) {
          const vx = fx + 1 === W ? 0 : fx + 1;
          const vy2 = fy + 1 === H ? 0 : fy + 1;
          if (!hasEdge(vx, fy, vx, vy2)) union(faceId(fx, fy), faceId(nfx, fy));
        }
      }

      const hasBelowNeighbor = toroidal || fy + 1 < FH;
      if (hasBelowNeighbor) {
        const nfy = toroidal ? wrapY(fy + 1) : fy + 1;
        if (faceExists(fx, nfy)) {
          const vy = fy + 1 === H ? 0 : fy + 1;
          const vx2 = fx + 1 === W ? 0 : fx + 1;
          if (!hasEdge(fx, vy, vx2, vy)) union(faceId(fx, fy), faceId(fx, nfy));
        }
      }
    }
  }

  const faceToRegion = new Map<FaceKey, number>();
  const rootToRegionId = new Map<number, number>();
  const regions: Region[] = [];

  for (let fx = 0; fx < FW; fx++) {
    for (let fy = 0; fy < FH; fy++) {
      if (!faceExists(fx, fy)) continue;
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

  /**
   * The face(s) (0, 1, or 2 of them) that have this vertex-pair as one of
   * their four sides. Takes the pair in either order — normalizes
   * internally. For a toroidal board, a pair that isn't literally adjacent
   * (e.g. column W-1 to column 0) is the wraparound seam edge, bordering
   * face column W-1 (whose "right" side wraps to column 0) rather than
   * column 0 — so a plain min(ax,bx) would pick the wrong face.
   */
  function facesBordering(ax: number, ay: number, bx: number, by: number): Face[] {
    const faces: Face[] = [];
    if (ay === by) {
      const x = Math.abs(ax - bx) === 1 ? Math.min(ax, bx) : Math.max(ax, bx);
      const y = ay;
      if (faceExists(x, y)) faces.push([x, y]);
      const yAbove = toroidal ? wrapY(y - 1) : y - 1;
      if (faceExists(x, yAbove)) faces.push([x, yAbove]);
    } else {
      const y = Math.abs(ay - by) === 1 ? Math.min(ay, by) : Math.max(ay, by);
      const x = ax;
      if (faceExists(x, y)) faces.push([x, y]);
      const xLeft = toroidal ? wrapX(x - 1) : x - 1;
      if (faceExists(xLeft, y)) faces.push([xLeft, y]);
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
