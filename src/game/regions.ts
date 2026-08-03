import type { Cell } from './hamiltonianCycle';
import { key, parseKey, type Puzzle } from './puzzle';
import { topologyFor, type Topology } from './topology';

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
 * on every side of it. For a wraparound board every fx/fy in [0, W) x [0, H)
 * is valid too: the last column/row's face wraps its right/bottom side back
 * to column/row 0 (with a coordinate flip for klein/projective, see
 * `topology.ts`).
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
 *  - A wraparound board (`puzzle.topology`) has every face in the full
 *    W x H grid exist (there's no "last column/row" edge to stop at). Which
 *    vertex a face's right/bottom side wraps to — and so which face is its
 *    neighbor — is delegated to `topology.ts`'s `wrapX`/`wrapY`: for a torus
 *    that's a plain wrap (same row/column on the other side); for a Klein
 *    bottle/projective plane one or both directions also flip the other
 *    coordinate, so "the neighbor to the right" isn't simply "column 0,
 *    same row" — see `rightOf`/`belowOf`/`leftOf`/`aboveOf` below, which are
 *    the only places that need to know this.
 */
export function computeRegions(puzzle: Puzzle): RegionMap {
  const { W, H, adj } = puzzle;
  const topology: Topology | null = puzzle.topology ? topologyFor(puzzle.topology) : null;
  const wrapped = topology !== null;
  const FW = wrapped ? W : W - 1;
  const FH = wrapped ? H : H - 1;
  const nFaces = FW * FH;
  const faceId = (fx: number, fy: number) => fy * FW + fx;

  function hasEdge(x1: number, y1: number, x2: number, y2: number): boolean {
    return adj.get(key(x1, y1))?.has(key(x2, y2)) ?? false;
  }

  /** Whether a face exists at all — for a wraparound board, always (it fills the whole rectangle); otherwise all 4 corners must be real graph vertices. */
  function faceExists(fx: number, fy: number): boolean {
    if (wrapped) return true;
    return adj.has(key(fx, fy)) && adj.has(key(fx + 1, fy)) && adj.has(key(fx, fy + 1)) && adj.has(key(fx + 1, fy + 1));
  }

  /**
   * Resolves a vertex that may be out of [0,W) x [0,H) via `topology`'s wrap
   * rule; a no-op for an in-range vertex or an unwrapped board.
   *
   * Deliberately does *not* delegate to `topology.wrapX`/`wrapY` directly:
   * those assume only one axis is ever out of range at a time (true for a
   * single unit step, which is all `wrappedNeighbor` ever needs). But
   * `rightOf`/`belowOf`/`leftOf`/`aboveOf` below each need a face's diagonal
   * corner vertex (e.g. `vertexAt(fx+1, fy+1)`), and at the one face where
   * both fx and fy are already at the board's far edge, that corner is out
   * of range on *both* axes simultaneously. Calling `wrapX` alone there
   * silently leaves the other coordinate unwrapped (e.g. `(0, H)` instead of
   * the correct `(0, 0)`), which breaks wall detection and can even name the
   * wrong neighbor face entirely (this was a real bug: it let a board's
   * corner face silently fuse with a distant, unrelated face). Using the
   * same tile-index + `tileOrientation` math `geometry.ts`'s `cellAt` uses
   * — already proven correct for arbitrary (including negative) tile
   * offsets in `topology.test.ts` — handles any offset uniformly, including
   * both axes wrapping at once.
   */
  function vertexAt(x: number, y: number): Cell {
    if (!wrapped) return [x, y];
    const tileX = Math.floor(x / W);
    const tileY = Math.floor(y / H);
    const localX = x - tileX * W;
    const localY = y - tileY * H;
    const o = topology!.tileOrientation(tileX, tileY);
    return [o.flipX ? W - 1 - localX : localX, o.flipY ? H - 1 - localY : localY];
  }

  interface Neighbor {
    face: Face;
    v1: Cell;
    v2: Cell;
  }

  function wrapIndex(v: number, size: number): number {
    return ((v % size) + size) % size;
  }

  /**
   * The face one step (dx, dy) away from (fx, fy) — exactly one of dx/dy is
   * ±1, the other 0 — wrapping via `topology` if that step falls outside
   * [0,W) x [0,H).
   *
   * Deliberately *not* computed by wrapping (fx+dx, fy+dy) the same way
   * `vertexAt` wraps a vertex: a face's index identifies a unit-width span
   * (fx to fx+1), not a point, so once mirrored by an orientation-reversing
   * seam, its correct image is an *interval* reflection (`W - 2 - local`),
   * one less than the point reflection (`W - 1 - local`) a vertex uses. Confirmed
   * by inverting `render.ts`/`geometry.ts`'s own `faceToScreenTiled` formula
   * (a face's rendered pixel center is at `local + 0.5`, mirrored to
   * `W - 1 - (local + 0.5)` — solving that back to an index lands on
   * `W - 2 - local`, not `W - 1 - local`). Using the vertex-style point
   * reflection here was the second half of a real bug: it made a board's
   * corner face's computed neighbor land on the wrong face (as far as the
   * diagonally-opposite corner, in one case), silently welding unrelated
   * regions together.
   */
  function faceNeighbor(fx: number, fy: number, dx: number, dy: number): Face {
    if (!wrapped) return [fx + dx, fy + dy];
    const rawX = fx + dx;
    const rawY = fy + dy;
    const tileX = Math.floor(rawX / W);
    const tileY = Math.floor(rawY / H);
    const localX = rawX - tileX * W;
    const localY = rawY - tileY * H;
    const o = topology!.tileOrientation(tileX, tileY);
    const gx = o.flipX ? wrapIndex(W - 2 - localX, W) : localX;
    const gy = o.flipY ? wrapIndex(H - 2 - localY, H) : localY;
    return [gx, gy];
  }

  /** The face to the right of (fx,fy) and the two vertices of their shared (vertical) edge — or null if there's no such face (the true, unwrapped board edge). */
  function rightOf(fx: number, fy: number): Neighbor | null {
    if (!wrapped && fx + 1 >= FW) return null;
    return { face: faceNeighbor(fx, fy, 1, 0), v1: vertexAt(fx + 1, fy), v2: vertexAt(fx + 1, fy + 1) };
  }

  /** The face below (fx,fy) and the two vertices of their shared (horizontal) edge — or null if there's no such face. */
  function belowOf(fx: number, fy: number): Neighbor | null {
    if (!wrapped && fy + 1 >= FH) return null;
    return { face: faceNeighbor(fx, fy, 0, 1), v1: vertexAt(fx, fy + 1), v2: vertexAt(fx + 1, fy + 1) };
  }

  /** The face to the left of (fx,fy) and the two vertices of their shared (vertical) edge — or null if there's no such face. */
  function leftOf(fx: number, fy: number): Neighbor | null {
    if (!wrapped && fx - 1 < 0) return null;
    return { face: faceNeighbor(fx, fy, -1, 0), v1: vertexAt(fx - 1, fy), v2: vertexAt(fx - 1, fy + 1) };
  }

  /** The face above (fx,fy) and the two vertices of their shared (horizontal) edge — or null if there's no such face. */
  function aboveOf(fx: number, fy: number): Neighbor | null {
    if (!wrapped && fy - 1 < 0) return null;
    return { face: faceNeighbor(fx, fy, 0, -1), v1: vertexAt(fx, fy - 1), v2: vertexAt(fx + 1, fy - 1) };
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

      const right = rightOf(fx, fy);
      if (right && faceExists(right.face[0], right.face[1]) && !hasEdge(right.v1[0], right.v1[1], right.v2[0], right.v2[1])) {
        union(faceId(fx, fy), faceId(right.face[0], right.face[1]));
      }

      const below = belowOf(fx, fy);
      if (below && faceExists(below.face[0], below.face[1]) && !hasEdge(below.v1[0], below.v1[1], below.v2[0], below.v2[1])) {
        union(faceId(fx, fy), faceId(below.face[0], below.face[1]));
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
   * The face(s) (0, 1, or 2 of them) that a real puzzle-graph edge (ax,ay)-
   * (bx,by) borders. Classifies the edge by testing which of the 4
   * `Neighbor` queries it matches (an X-step, from either endpoint, borders
   * the face above/below; a Y-step borders the face left/right — see the
   * `rightOf`/`belowOf`/`leftOf`/`aboveOf` doc comments) rather than
   * comparing raw coordinates directly, since a klein/projective wraparound
   * edge's endpoints can differ in *both* coordinates at once (the flip),
   * unlike a torus's simple same-row/same-column wrap.
   */
  function facesBordering(ax: number, ay: number, bx: number, by: number): Face[] {
    const faces: Face[] = [];
    const push = (f: Face | null) => {
      if (f && faceExists(f[0], f[1])) faces.push(f);
    };

    const aRight = vertexAt(ax + 1, ay);
    if (aRight[0] === bx && aRight[1] === by) {
      push([ax, ay]);
      push(aboveOf(ax, ay)?.face ?? null);
      return faces;
    }
    const bRight = vertexAt(bx + 1, by);
    if (bRight[0] === ax && bRight[1] === ay) {
      push([bx, by]);
      push(aboveOf(bx, by)?.face ?? null);
      return faces;
    }
    const aDown = vertexAt(ax, ay + 1);
    if (aDown[0] === bx && aDown[1] === by) {
      push([ax, ay]);
      push(leftOf(ax, ay)?.face ?? null);
      return faces;
    }
    // The only remaining possibility for a valid single-step edge: B steps down to A.
    push([bx, by]);
    push(leftOf(bx, by)?.face ?? null);
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
