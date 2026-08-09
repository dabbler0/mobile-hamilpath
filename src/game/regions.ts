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

  /** Whether `ek` has been locked (`puzzle.lockedEdges` — see its doc comment): a locked edge is a real `adj` edge but is treated exactly like a permanent wall for region purposes below — merged across, and excluded from every boundary. */
  function isLocked(ek: EdgeKey): boolean {
    return puzzle.lockedEdges?.has(ek) ?? false;
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
        // A locked edge merges its two faces exactly like a permanent wall
        // (no candidate edge) does — see `isLocked`'s doc comment.
        if (!hasEdge(wall.v1[0], wall.v1[1], wall.v2[0], wall.v2[1]) || isLocked(edgeKey(wall.v1, wall.v2))) {
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
        if (isLocked(ek)) continue; // locked — permanently excluded from every region's boundary, so nothing can toggle it again (see `isLocked`'s doc comment)
        if (!wall.neighbor) {
          boundarySets[selfRegion].add(ek);
          continue;
        }
        const neighborRegion = faceToRegion.get(key(wall.neighbor[0], wall.neighbor[1]))!;
        // Both faces already the same region (connected some other way
        // around, without crossing this edge) — this edge is *interior* to
        // the region, not a boundary of it, and must be excluded from the
        // toggle: a region's toggle needs to be exactly equivalent to
        // toggling every one of its still-distinguishable sub-pieces in
        // turn (see `lockEdgeInRegionMap`'s doc comment, which relies on
        // this same rule for a locked-edge-driven merge), and a real edge
        // that borders the *same* region on both sides would then be
        // toggled twice by that equivalent sequence — a net no-op — so it
        // must never appear in this region's boundary at all. (An earlier
        // version of this function added it once here regardless, which
        // is wrong: it let a single tap unmark an edge that had nothing to
        // do with the face the player actually meant to toggle, any time
        // two originally-different regions had happened to merge — see git
        // history and `regions.test.ts` for the regression this fixes.)
        if (selfRegion === neighborRegion) continue;
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

/**
 * Every region whose boundary includes `edge` — normally one (an edge on
 * the true board border) or two (an edge separating two distinct regions).
 * Empty for an edge that isn't in any region's boundary at all: either it's
 * already locked (`Puzzle.lockedEdges`), it isn't a real puzzle-graph edge
 * to begin with, or (see `computeRegions`'s own doc comment) both its faces
 * are already in the *same* region, which makes it interior rather than a
 * boundary of anything — a real, unlocked edge can still be unreachable
 * this way, without ever having been explicitly locked itself; see
 * `lockEdgeInRegionMap`'s `strandedEdges`. Used by `game/edgeLock.ts`'s
 * `lockEdge` to find a region it can toggle to flip one specific edge.
 */
export function regionsForEdge(regionMap: RegionMap, edge: EdgeKey): number[] {
  const ids: number[] = [];
  for (const region of regionMap.regions) {
    if (region.boundary.includes(edge)) ids.push(region.id);
  }
  return ids;
}

export interface LockEdgeInRegionMapResult {
  regionMap: RegionMap;
  /**
   * Real, still-*unlocked* edges that just became interior to the merged
   * region (both their faces now in the very same region) as a side effect
   * of merging in `edge` — i.e. every *other* edge that directly bordered
   * both of the two regions being merged (a "multi-edge shared border"
   * between them). Always empty unless this lock actually merged two
   * distinct regions. Such an edge is now permanently unreachable by any
   * tap (see `computeRegions`'s doc comment on why an interior edge must be
   * excluded from every boundary) without itself ever having been locked —
   * a caller locking a whole batch of edges (`puzzleGen.ts`'s
   * `applyLockedEdges`) needs to explicitly lock each of these too (to
   * whichever state is actually correct for it), or a stranded edge that
   * happens to be *required* for the solution would silently become
   * impossible to ever mark.
   */
  strandedEdges: EdgeKey[];
}

/**
 * Incrementally updates `regionMap` to reflect one more locked edge, without
 * recomputing the whole board from scratch. `computeRegions` costs O(board
 * size) *every* call — fine once per puzzle, but `game/edgeLock.ts`'s
 * `lockEdge` needs a fresh regionMap after every single lock, and locking a
 * whole batch of edges at once (`puzzleGen.ts`'s experimental "lock some
 * solution edges" generation step, or a future run of several live hints)
 * would otherwise cost O(locks × board size) — measured at the better part
 * of a second on the largest boards, a real stutter. This costs only
 * O(the size of the one or two regions `edge` actually touches), which is
 * what `lockEdge` uses instead.
 *
 * Three cases, chosen to produce exactly what a from-scratch `computeRegions`
 * recompute (with `edge` newly added to `puzzle.lockedEdges`) would:
 *  - `edge` is already excluded from every region's boundary (empty
 *    `regionsForEdge`) — nothing to do; returns `regionMap` unchanged. This
 *    covers both "already locked" (a caller error `lockEdge` itself guards
 *    against before ever calling this) and the legitimate case of locking a
 *    `strandedEdges` entry reported by an *earlier* call: both its faces
 *    are already in the same region, so it was never on any boundary to
 *    begin with, and adding it to `lockedEdges` doesn't change that.
 *  - `edge` borders one region on both sides already (the true, one-sided
 *    board edge) — nothing merges; `edge` is simply dropped from that one
 *    region's boundary.
 *  - `edge` borders two *different* regions — they merge into one (the
 *    lower id survives; the higher one becomes an empty, permanently
 *    unreachable tombstone at its old index, so every other region's id
 *    stays stable and safe to keep referencing): faces concatenate, and the
 *    merged boundary is the *symmetric difference* of both regions' own
 *    boundaries (not their union) — matching `computeRegions`'s "both faces
 *    already the same region" exclusion rule above: any edge that directly
 *    bordered *both* A and B (including `edge` itself, which is why no
 *    separate delete step is needed for it) now has both its faces inside
 *    the single merged region, so it's interior and must drop out; an edge
 *    unique to one side stays a live boundary edge of the merged region.
 *    Every edge that drops out this way *other* than `edge` itself is
 *    reported back via `strandedEdges`.
 */
export function lockEdgeInRegionMap(regionMap: RegionMap, edge: EdgeKey): LockEdgeInRegionMapResult {
  const ids = regionsForEdge(regionMap, edge);
  if (ids.length === 0) {
    return { regionMap, strandedEdges: [] };
  }

  const faceToRegion = new Map(regionMap.faceToRegion);
  const regions = [...regionMap.regions];

  if (ids.length === 1) {
    const id = ids[0];
    regions[id] = { ...regions[id], boundary: regions[id].boundary.filter((ek) => ek !== edge) };
    return { regionMap: { faceToRegion, regions }, strandedEdges: [] };
  }

  const [idA, idB] = [...ids].sort((a, b) => a - b);
  const regionA = regions[idA];
  const regionB = regions[idB];
  const boundaryA = new Set(regionA.boundary);
  const boundaryB = new Set(regionB.boundary);
  const mergedBoundary = new Set<EdgeKey>();
  const strandedEdges: EdgeKey[] = [];
  for (const ek of boundaryA) {
    if (boundaryB.has(ek)) {
      if (ek !== edge) strandedEdges.push(ek);
    } else {
      mergedBoundary.add(ek);
    }
  }
  for (const ek of boundaryB) {
    if (!boundaryA.has(ek)) mergedBoundary.add(ek);
  }
  regions[idA] = { id: idA, faces: [...regionA.faces, ...regionB.faces], boundary: [...mergedBoundary] };
  regions[idB] = { id: idB, faces: [], boundary: [] }; // tombstone: unreachable, since every face that pointed here now points to idA below
  for (const face of regionB.faces) {
    faceToRegion.set(key(face[0], face[1]), idA);
  }
  return { regionMap: { faceToRegion, regions }, strandedEdges };
}
