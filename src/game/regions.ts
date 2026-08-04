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
 *    same row" — see `faceWalls` below, the only place that needs to know
 *    this.
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

  function wrapIndex(v: number, size: number): number {
    return ((v % size) + size) % size;
  }

  /**
   * Resolves a vertex that may be out of [0,W) x [0,H) via `topology`'s wrap
   * rule; a no-op for an in-range vertex or an unwrapped board.
   *
   * Deliberately does *not* delegate to `topology.wrapX`/`wrapY` directly:
   * those assume only one axis is ever out of range at a time (true for a
   * single unit step, which is all `wrappedNeighbor` ever needs). But
   * `faceWalls` below needs a face's diagonal corner vertex (e.g.
   * `vertexAt(fx+1, fy+1)`), and at the one face where both fx and fy are
   * already at the board's far edge, that corner is out of range on *both*
   * axes simultaneously. Calling `wrapX` alone there silently leaves the
   * other coordinate unwrapped (e.g. `(0, H)` instead of the correct
   * `(0, 0)`), which breaks wall detection and can even name the wrong
   * neighbor face entirely. Using the same tile-index + `tileOrientation`
   * math `geometry.ts`'s `cellAt` uses — already proven correct for
   * arbitrary (including negative) tile offsets in `topology.test.ts` —
   * handles any offset uniformly, including both axes wrapping at once.
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

  /**
   * The face one step (dx, dy) away from (fx, fy) — exactly one of dx/dy is
   * ±1, the other 0 — wrapping via `topology` if that step falls outside
   * [0,W) x [0,H).
   *
   * Deliberately *not* computed by wrapping (fx+dx, fy+dy) the same way
   * `vertexAt` wraps a vertex: a face's index identifies a unit-width span
   * (fx to fx+1), not a point, so once mirrored by an orientation-reversing
   * seam, its correct image is an *interval* reflection (`W - 2 - local`),
   * one less than the point reflection (`W - 1 - local`) a vertex uses.
   * Confirmed by inverting `render.ts`/`geometry.ts`'s own
   * `faceToScreenTiled` formula (a face's rendered pixel center is at
   * `local + 0.5`, mirrored to `W - 1 - (local + 0.5)` — solving that back
   * to an index lands on `W - 2 - local`, not `W - 1 - local`).
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

  interface Wall {
    v1: Cell;
    v2: Cell;
    /** The face sharing this wall, or null if there's none (the true, unwrapped board edge). */
    neighbor: Face | null;
  }

  /**
   * All 4 walls of face (fx,fy) — right, below, left, above, in that order
   * — each computed purely from *this* face's own 4 corners
   * (`vertexAt(fx,fy)`, `vertexAt(fx+1,fy)`, `vertexAt(fx,fy+1)`,
   * `vertexAt(fx+1,fy+1)`), never by re-deriving a neighbor's own corners
   * with an offset coordinate (e.g. computing the left wall via
   * `vertexAt(fx-1, ...)`, as if it were "the right wall of the face at
   * fx-1"). That distinction matters — and is the reason this function
   * exists at all — because those two routes can disagree near a Klein
   * bottle/projective plane board's degenerate corners: `vertexAt` wraps
   * each corner of a face independently by floor-dividing its *own* raw
   * coordinate into a tile, and two faces that `faceNeighbor` calls mutual
   * neighbors don't necessarily each land their own two shared-wall corners
   * in that computation the same way the other does. Concretely (found via
   * this exact case, see `regions.test.ts`): on a projective plane board,
   * face (0, H-1)'s own left wall is the vertex pair
   * (`vertexAt(0,H-1)`, `vertexAt(0,H)`) — a well-defined, real candidate
   * edge — but `faceNeighbor`'s independently-computed reflection for "the
   * right wall of face (0,H-1)'s left neighbor" lands on a *different*
   * vertex pair entirely, because that neighbor is the one face on the
   * board whose own far corner is degenerate (its own two independently-
   * wrapped corners collapse onto its near corner — confirmed three
   * independent ways: the tile-index math itself, and composing the
   * board's two axis wraps in either order, all agree on the same landing
   * vertex). A caller that only ever asked each face for its own right and
   * below walls (as this function's two predecessors, `rightOf`/`belowOf`,
   * did) would silently never test this specific left-wall vertex pair at
   * all — from *either* side — since the degenerate neighbor's own
   * corresponding wall names a different pair. That produced two distinct,
   * observed failure modes: a wall that should have been a permanent, ever-
   * present separator (no candidate edge exists there) never got a chance
   * to union the two faces it separates, and — when a real candidate edge
   * *does* exist there — neither face's region ever learned about it,
   * leaving a region's boundary short by exactly that edge (a marked loop
   * that didn't close). Iterating all 4 of a face's own walls, from every
   * face, guarantees every real edge gets discovered as *someone's* own
   * wall (redundantly from both sides away from the degenerate corners,
   * which is harmless — union and the `Set`-based boundary below are both
   * naturally idempotent).
   */
  function faceWalls(fx: number, fy: number): Wall[] {
    const tl = vertexAt(fx, fy);
    const tr = vertexAt(fx + 1, fy);
    const bl = vertexAt(fx, fy + 1);
    const br = vertexAt(fx + 1, fy + 1);

    const wall = (v1: Cell, v2: Cell, atBoardEdge: boolean, dx: number, dy: number): Wall => {
      if (!wrapped && atBoardEdge) return { v1, v2, neighbor: null };
      const n = faceNeighbor(fx, fy, dx, dy);
      return { v1, v2, neighbor: faceExists(n[0], n[1]) ? n : null };
    };

    return [
      wall(tr, br, fx + 1 >= FW, 1, 0), // right
      wall(bl, br, fy + 1 >= FH, 0, 1), // below
      wall(tl, bl, fx - 1 < 0, -1, 0), // left
      wall(tl, tr, fy - 1 < 0, 0, -1), // above
    ];
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
      for (const wall of faceWalls(fx, fy)) {
        if (!wall.neighbor) continue;
        if (!hasEdge(wall.v1[0], wall.v1[1], wall.v2[0], wall.v2[1])) {
          union(faceId(fx, fy), faceId(wall.neighbor[0], wall.neighbor[1]));
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

  // Built as a Set per region (not pushed straight into `regions[i].boundary`)
  // because `faceWalls` reports every real wall redundantly from both faces
  // it borders (see its doc comment) — a plain array would double up most
  // edges, and `toggleRegion` flips every edge in `boundary` by presence, so
  // a duplicate would toggle it there and back, a silent no-op that would
  // leave that edge stuck exactly the opposite of every other edge the
  // player just drew.
  const boundarySets: Set<EdgeKey>[] = regions.map(() => new Set());

  for (let fx = 0; fx < FW; fx++) {
    for (let fy = 0; fy < FH; fy++) {
      if (!faceExists(fx, fy)) continue;
      const selfRegion = faceToRegion.get(key(fx, fy))!;
      for (const wall of faceWalls(fx, fy)) {
        if (!hasEdge(wall.v1[0], wall.v1[1], wall.v2[0], wall.v2[1])) continue; // no candidate edge here at all — not a boundary, not even a wall to toggle
        const ek = edgeKey(wall.v1, wall.v2);
        if (!wall.neighbor) {
          boundarySets[selfRegion].add(ek);
          continue;
        }
        const neighborRegion = faceToRegion.get(key(wall.neighbor[0], wall.neighbor[1]))!;
        // Add to both sides' boundaries even when they're the same region
        // (the two faces are connected some other way around too, without
        // crossing this edge) — the region can still be shaped so this real
        // edge is the only thing separating two of its own faces along one
        // path between them (see `regions.test.ts`'s "lists a boundary edge
        // once even when both its faces are already in the same region"),
        // and toggling the region should still flip it.
        boundarySets[selfRegion].add(ek);
        boundarySets[neighborRegion].add(ek);
      }
    }
  }

  for (let i = 0; i < regions.length; i++) regions[i].boundary = [...boundarySets[i]];

  return { faceToRegion, regions };
}

export function regionAt(regionMap: RegionMap, face: Face): number | null {
  return regionMap.faceToRegion.get(key(face[0], face[1])) ?? null;
}
