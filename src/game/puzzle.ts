import type { Rng } from './rng';
import { generateHamiltonianCycle, generateShapeAndCycle, type Cell, type HamiltonianCycle } from './hamiltonianCycle';
import type { EdgeKey } from './regions';
import { hasBlock, randomShape, randomToroidalShape, rectShape, type Shape } from './shape';
import { KLEIN_BOTTLE, PROJECTIVE_PLANE, type Topology, type TopologyKind } from './topology';

export type CellKey = string;

export function key(x: number, y: number): CellKey {
  return `${x},${y}`;
}

export function parseKey(k: CellKey): Cell {
  const [x, y] = k.split(',').map(Number);
  return [x, y];
}

export interface Puzzle {
  /** Adjacency list keyed by "x,y", containing the solution cycle plus extra distractor edges. */
  adj: Map<CellKey, Set<CellKey>>;
  W: number;
  H: number;
  startCell: Cell;
  /** Which wraparound surface the board is glued into (torus/klein/projective) — the last column/row wraps back to the first (with a coordinate flip for klein/projective, see `topology.ts`), both for adjacency and for face regions. Absent (falsy) for an ordinary rectangular or shaped board with no wraparound. */
  topology?: TopologyKind;
  /**
   * Extra constraints layered on top of the plain "visit every cell" rule:
   * each collection names a handful of `adj` edges (a mix of hidden-solution
   * and distractor edges — see `generateEdgeCollections`) and a `required`
   * count that the player's finished loop must mark *exactly* that many of,
   * no more, no fewer (`pathEdit.ts`'s `computeWin` enforces this; `render.ts`
   * draws each collection in its own color with a badge showing `required`,
   * turning error-colored when the current marked count doesn't match).
   * Absent or empty for a puzzle generated with collections turned off
   * (`NO_EDGE_COLLECTIONS`, the default) — every puzzle before this feature
   * existed behaves exactly as if this were `[]`.
   */
  edgeCollections?: EdgeCollection[];
  /**
   * Edges locked into a fixed marked/unmarked state (see
   * `game/edgeLock.ts`'s `lockEdge`). Once an edge is locked,
   * `regions.ts`'s `computeRegions` treats it exactly like a permanent wall
   * (a real board edge with no candidate edge at all): both of its
   * neighboring faces merge into the same region, and the edge itself is
   * excluded from every region's boundary, so nothing that goes through
   * `toggleRegion` — a tap, a keyboard toggle, a future hint — can ever
   * flip it again. The edge is otherwise a completely ordinary member of
   * `adj`: still drawn, still counted toward win-detection's degree check,
   * still part of any edge collection it happened to land in. Locking only
   * removes it from future *toggles*, not from the graph. Absent for every
   * puzzle without any locked edges — which is every puzzle from before
   * this feature existed.
   */
  lockedEdges?: Set<EdgeKey>;
  /**
   * Edges that must already be marked the instant a fresh game on this
   * puzzle begins — currently only ever the "marked" side of a generation-
   * time locked edge (see `lockedEdges` above): since a locked edge is
   * permanently excluded from every region's boundary, a player could never
   * mark it themselves, so a locked edge that belongs to the intended
   * solution has to start out already marked or the puzzle would be
   * unwinnable. `pathEdit.ts`'s `createInitialPath(puzzle)` is what actually
   * seeds a fresh `PathState` from this. Absent/empty for every puzzle
   * without any locked-and-marked edges — which is every puzzle from before
   * this feature existed.
   */
  initialEdges?: EdgeKey[];
}

export interface EdgeCollection {
  id: number;
  /** The `adj` edges belonging to this collection — disjoint from every other collection's edges. */
  edges: EdgeKey[];
  /** Exactly how many of `edges` the finished loop must mark — see `Puzzle.edgeCollections`. */
  required: number;
}

/**
 * Tunable knobs for random edge-collection generation (see
 * `generateEdgeCollections`). Part of `PuzzleId` (`dailyPuzzle.ts`) so a
 * puzzle stays fully reproducible from its id alone.
 */
export interface EdgeCollectionParams {
  /** Upper bound (inclusive) on how many collections a puzzle gets — the actual count is uniformly random in `[0, maxCollections]`. `0` disables the feature entirely: no collections are ever added, regardless of `minSize`/`maxSize`. */
  maxCollections: number;
  /** Inclusive bounds on how many edges land in each collection (usually 2-4). */
  minSize: number;
  maxSize: number;
}

/** The feature turned off — every puzzle generated before edge collections existed behaves exactly as if this were passed. */
export const NO_EDGE_COLLECTIONS: EdgeCollectionParams = { maxCollections: 0, minSize: 2, maxSize: 4 };

/** Sane input-range clamps for the UI controls that let a player set `EdgeCollectionParams` themselves (see `main.ts`). */
export const EDGE_COLLECTION_LIMITS = {
  maxCollections: { min: 0, max: 6 },
  size: { min: 2, max: 8 },
} as const;

/** Sums how many of a collection's edges are currently marked — used both by `pathEdit.ts`'s win check (must equal `required` exactly) and by `render.ts` (to decide whether to draw the collection's badge in its normal or error color). */
export function countCollectionEdges(collection: EdgeCollection, edges: ReadonlySet<EdgeKey>): number {
  let n = 0;
  for (const ek of collection.edges) {
    if (edges.has(ek)) n++;
  }
  return n;
}

function edgeKeyOf(a: Cell, b: Cell): EdgeKey {
  const ka = key(a[0], a[1]);
  const kb = key(b[0], b[1]);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Exactly half of `size` when that's a whole number; otherwise floor or ceil with equal probability. */
function pickRequiredCount(size: number, rng: Rng): number {
  const lo = Math.floor(size / 2);
  const hi = Math.ceil(size / 2);
  return lo === hi ? lo : rng() < 0.5 ? lo : hi;
}

/**
 * Picks a `size`-edge collection whose cycle/distractor split is *forced* to
 * match `required`: exactly `required` not-yet-`used` edges drawn from the
 * cycle pool, and `size - required` from the distractor pool, shuffled
 * together after. This is what guarantees the generated solution — which
 * marks all and only its own cycle edges — always marks exactly `required`
 * of this collection's edges: `required` isn't a number picked independently
 * of the collection's actual contents (the earlier bug), it's the exact
 * count of cycle edges the collection is built out of.
 *
 * Falls back to fewer edges on either side if a pool has run dry (e.g. a
 * zero-density puzzle has no distractor edges at all, or an earlier
 * collection already claimed the last unused cycle edge) rather than padding
 * from the other side — padding would reintroduce the same mismatch this
 * fix removes, since a padded-in edge from the "wrong" pool would throw off
 * the cycle-edge count without changing `required` to match. The caller
 * reports back how many cycle edges actually made it in (`required`), which
 * may be less than requested when a pool ran short.
 */
function pickCollectionEdges(cyclePool: readonly EdgeKey[], distractorPool: readonly EdgeKey[], used: ReadonlySet<EdgeKey>, size: number, required: number, rng: Rng): { edges: EdgeKey[]; required: number } {
  const cycleAvail = shuffled(cyclePool.filter((e) => !used.has(e)), rng);
  const distractorAvail = shuffled(distractorPool.filter((e) => !used.has(e)), rng);
  const nCycle = Math.min(required, cycleAvail.length);
  const nDistractor = Math.min(size - required, distractorAvail.length);
  const edges = shuffled([...cycleAvail.slice(0, nCycle), ...distractorAvail.slice(0, nDistractor)], rng);
  return { edges, required: nCycle };
}

/**
 * Builds `Puzzle.edgeCollections`: a random number (uniform in
 * `[0, params.maxCollections]`) of collections, each a random size (uniform
 * in `[params.minSize, params.maxSize]`). For each, `required` is rolled
 * first (roughly half of `size`, see `pickRequiredCount`), then
 * `pickCollectionEdges` builds the collection *to match* — drawing exactly
 * `required` edges from the hidden solution cycle and the rest from
 * distractor edges — rather than mixing freely and hoping `required` lines
 * up with whatever composition resulted. This is what guarantees the
 * generated solution always satisfies every collection, regardless of luck:
 * the collection's cycle-edge count and its `required` are now the same
 * number by construction. Every edge is used in at most one collection —
 * `used` accumulates across the whole call — so a color/badge on the board
 * is never ambiguous about which collection it belongs to. Stops early
 * (returning fewer than `count` collections) once there aren't enough
 * unused edges left for a meaningful (>=2 edge) collection.
 * `params.maxCollections <= 0` (`NO_EDGE_COLLECTIONS`, the default) always
 * returns `[]` without consuming any `rng` calls, so puzzles generated with
 * the feature off are byte-identical to puzzles from before it existed.
 */
export function generateEdgeCollections(cycleEdges: readonly EdgeKey[], distractorEdges: readonly EdgeKey[], params: EdgeCollectionParams, rng: Rng): EdgeCollection[] {
  if (params.maxCollections <= 0) return [];
  const count = Math.floor(rng() * (params.maxCollections + 1));
  const collections: EdgeCollection[] = [];
  const used = new Set<EdgeKey>();
  for (let i = 0; i < count; i++) {
    const lo = Math.min(params.minSize, params.maxSize);
    const hi = Math.max(params.minSize, params.maxSize);
    const size = lo + Math.floor(rng() * (hi - lo + 1));
    const requiredGoal = pickRequiredCount(size, rng);
    const { edges, required } = pickCollectionEdges(cycleEdges, distractorEdges, used, size, requiredGoal, rng);
    if (edges.length < 2) break; // not enough unused edges left for a meaningful collection
    for (const e of edges) used.add(e);
    collections.push({ id: collections.length, edges, required });
  }
  return collections;
}

/** The number of cells actually in the puzzle — not `W * H`, which is only a bounding box for a non-rectangular shape (some cells inside it may not exist). */
export function totalCells(puzzle: Puzzle): number {
  return puzzle.adj.size;
}

function makeAdjBuilder() {
  const adj = new Map<CellKey, Set<CellKey>>();
  const ensure = (k: CellKey) => {
    if (!adj.has(k)) adj.set(k, new Set());
  };
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    ensure(key(x1, y1));
    ensure(key(x2, y2));
    adj.get(key(x1, y1))!.add(key(x2, y2));
    adj.get(key(x2, y2))!.add(key(x1, y1));
  };
  return { adj, ensure, addEdge };
}

/**
 * Builds a puzzle graph from an already-generated shape + Hamiltonian cycle:
 * the cycle's edges, plus extra "distractor" edges between orthogonal
 * neighbors that both exist in the shape (added independently with
 * probability `density`), so the hidden solution isn't the only path
 * visible.
 */
function assemblePuzzle(shape: Shape, cycle: HamiltonianCycle, density: number, rng: Rng, collectionParams: EdgeCollectionParams): Puzzle {
  const { cells, W, H } = cycle;
  const { adj, ensure, addEdge } = makeAdjBuilder();
  const cycleEdges: EdgeKey[] = [];

  for (let i = 0; i < cells.length; i++) {
    const [x1, y1] = cells[i];
    const [x2, y2] = cells[(i + 1) % cells.length];
    addEdge(x1, y1, x2, y2);
    cycleEdges.push(edgeKeyOf([x1, y1], [x2, y2]));
  }

  const exists = (x: number, y: number) => hasBlock(shape, x >> 1, y >> 1);
  const distractorEdges: EdgeKey[] = [];

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (!exists(x, y)) continue;
      ensure(key(x, y));
      const rightK = key(x + 1, y);
      const downK = key(x, y + 1);
      if (x + 1 < W && exists(x + 1, y) && !adj.get(key(x, y))!.has(rightK) && rng() < density) {
        addEdge(x, y, x + 1, y);
        distractorEdges.push(edgeKeyOf([x, y], [x + 1, y]));
      }
      if (y + 1 < H && exists(x, y + 1) && !adj.get(key(x, y))!.has(downK) && rng() < density) {
        addEdge(x, y, x, y + 1);
        distractorEdges.push(edgeKeyOf([x, y], [x, y + 1]));
      }
    }
  }

  const edgeCollections = generateEdgeCollections(cycleEdges, distractorEdges, collectionParams, rng);
  return { adj, W, H, startCell: cells[0], edgeCollections };
}

/**
 * Builds a puzzle graph on an arbitrary (already-built) shape: a hidden
 * Hamiltonian cycle over its doubled cell grid, plus distractor edges. Used
 * directly for a plain rectangle (`rectShape`, via `dailyPuzzle.ts`), which
 * never fails; for a randomly-generated shape, prefer
 * `buildRandomShapePuzzle`, which retries on the rare unlucky shape (see
 * `generateShapeAndCycle`).
 */
export function buildPuzzle(shape: Shape, density: number, rng: Rng, collectionParams: EdgeCollectionParams = NO_EDGE_COLLECTIONS): Puzzle {
  const cycle = generateHamiltonianCycle(shape, rng);
  return assemblePuzzle(shape, cycle, density, rng, collectionParams);
}

/** Builds a puzzle on a random connected polyomino of `m * n` blocks (see `randomShape`). */
export function buildRandomShapePuzzle(m: number, n: number, density: number, rng: Rng, collectionParams: EdgeCollectionParams = NO_EDGE_COLLECTIONS): Puzzle {
  const { shape, cycle } = generateShapeAndCycle((r) => randomShape(m, n, r), rng);
  return assemblePuzzle(shape, cycle, density, rng, collectionParams);
}

/**
 * Builds a toroidal-wraparound puzzle of size m x n blocks (2m x 2n cells):
 * generates a random shape that tiles the plane with translational symmetry
 * (m, n) — a fundamental domain of the torus Z^2 / (mZ x nZ), see
 * `randomToroidalShape` — traces a Hamiltonian cycle on it, then places that
 * solution into the m x n rectangle by reducing every cell's coordinates mod
 * (2m, 2n). Since the shape is a genuine fundamental domain, this reduction
 * is a bijection onto the whole rectangle (it "fills the rectangle since it
 * tiles the plane" — every canonical cell exists, unlike a non-toroidal
 * shaped board). Distractor edges are then added between every orthogonal
 * neighbor pair including the wraparound ones (column W-1 to column 0, row
 * H-1 to row 0), so some of the extra paths cross the wraparound too.
 */
export function buildToroidalPuzzle(m: number, n: number, density: number, rng: Rng, collectionParams: EdgeCollectionParams = NO_EDGE_COLLECTIONS): Puzzle {
  const { cycle } = generateShapeAndCycle((r) => randomToroidalShape(m, n, r), rng);
  const W = 2 * m;
  const H = 2 * n;
  const wrapX = (x: number) => ((x % W) + W) % W;
  const wrapY = (y: number) => ((y % H) + H) % H;

  const { adj, ensure, addEdge } = makeAdjBuilder();
  const cycleEdges: EdgeKey[] = [];

  for (let i = 0; i < cycle.cells.length; i++) {
    const [x1, y1] = cycle.cells[i];
    const [x2, y2] = cycle.cells[(i + 1) % cycle.cells.length];
    const a: Cell = [wrapX(x1), wrapY(y1)];
    const b: Cell = [wrapX(x2), wrapY(y2)];
    addEdge(a[0], a[1], b[0], b[1]);
    cycleEdges.push(edgeKeyOf(a, b));
  }

  // The reduction fills the whole rectangle, so every canonical cell exists — no shape-membership check needed here.
  const distractorEdges: EdgeKey[] = [];
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      ensure(key(x, y));
      const rx = (x + 1) % W;
      const ry = (y + 1) % H;
      if (!adj.get(key(x, y))!.has(key(rx, y)) && rng() < density) {
        addEdge(x, y, rx, y);
        distractorEdges.push(edgeKeyOf([x, y], [rx, y]));
      }
      if (!adj.get(key(x, y))!.has(key(x, ry)) && rng() < density) {
        addEdge(x, y, x, ry);
        distractorEdges.push(edgeKeyOf([x, y], [x, ry]));
      }
    }
  }

  const [sx, sy] = cycle.cells[0];
  const edgeCollections = generateEdgeCollections(cycleEdges, distractorEdges, collectionParams, rng);
  return { adj, W, H, startCell: [wrapX(sx), wrapY(sy)], topology: 'torus', edgeCollections };
}

/**
 * Builds a Klein bottle or projective plane wraparound puzzle of size m x n
 * blocks (2m x 2n cells). Unlike the toroidal case, this does *not* trace
 * the Hamiltonian cycle on some cleverly-shaped infinite/periodic cover: a
 * torus is the quotient of the flat plane by a translation-only group, so
 * generating on a large flat patch and folding at the end works — but
 * gluing a wraparound with a *flip* (klein) or *two* flips (projective)
 * changes which local direction is "clockwise" on the far side of the seam,
 * and empirically, building the spanning tree with those wrap edges present
 * from the start (even for a plain torus, with no flip at all) breaks the
 * wall-follower — it can close a small sub-loop instead of tracing the
 * whole board (confirmed by direct trace debugging; see the git history for
 * this function). So instead: trace an ordinary flat Hamiltonian cycle on
 * the plain m x n rectangle (`generateHamiltonianCycle`, already proven
 * correct — no wraparound involved in generation at all), and add the
 * wraparound purely as distractor edges on top of that finished graph,
 * using `topology`'s wrap rule to find each boundary cell's far neighbor
 * (including the coordinate flip). The hidden seed cycle itself never
 * crosses the wraparound, but the actual solvable graph (cycle edges +
 * distractor edges together, which is what regions/rendering/solving all
 * operate on) very much does, including in a way that can require crossing
 * it to solve — same as this project's general philosophy that the
 * original seed cycle is just *a* Hamiltonian cycle in the graph, not
 * necessarily *the* one the player ends up tracing.
 */
function buildWrappedRectPuzzle(m: number, n: number, density: number, rng: Rng, topology: Topology, collectionParams: EdgeCollectionParams): Puzzle {
  const cycle = generateHamiltonianCycle(rectShape(m, n), rng);
  const { cells, W, H } = cycle;
  const { adj, ensure, addEdge } = makeAdjBuilder();
  const cycleEdges: EdgeKey[] = [];

  for (let i = 0; i < cells.length; i++) {
    const [x1, y1] = cells[i];
    const [x2, y2] = cells[(i + 1) % cells.length];
    addEdge(x1, y1, x2, y2);
    cycleEdges.push(edgeKeyOf([x1, y1], [x2, y2]));
  }

  const distractorEdges: EdgeKey[] = [];
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      ensure(key(x, y));
      const right = x + 1 < W ? { x: x + 1, y } : topology.wrapX(x + 1, y, W, H);
      const rightK = key(right.x, right.y);
      if (!adj.get(key(x, y))!.has(rightK) && rng() < density) {
        addEdge(x, y, right.x, right.y);
        distractorEdges.push(edgeKeyOf([x, y], [right.x, right.y]));
      }

      const down = y + 1 < H ? { x, y: y + 1 } : topology.wrapY(x, y + 1, W, H);
      const downK = key(down.x, down.y);
      if (!adj.get(key(x, y))!.has(downK) && rng() < density) {
        addEdge(x, y, down.x, down.y);
        distractorEdges.push(edgeKeyOf([x, y], [down.x, down.y]));
      }
    }
  }

  const edgeCollections = generateEdgeCollections(cycleEdges, distractorEdges, collectionParams, rng);
  return { adj, W, H, startCell: cells[0], topology: topology.kind, edgeCollections };
}

export function buildKleinBottlePuzzle(m: number, n: number, density: number, rng: Rng, collectionParams: EdgeCollectionParams = NO_EDGE_COLLECTIONS): Puzzle {
  return buildWrappedRectPuzzle(m, n, density, rng, KLEIN_BOTTLE, collectionParams);
}

export function buildProjectivePlanePuzzle(m: number, n: number, density: number, rng: Rng, collectionParams: EdgeCollectionParams = NO_EDGE_COLLECTIONS): Puzzle {
  return buildWrappedRectPuzzle(m, n, density, rng, PROJECTIVE_PLANE, collectionParams);
}
