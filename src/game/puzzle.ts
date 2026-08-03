import type { Rng } from './rng';
import { generateHamiltonianCycle, generateShapeAndCycle, type Cell, type HamiltonianCycle } from './hamiltonianCycle';
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
function assemblePuzzle(shape: Shape, cycle: HamiltonianCycle, density: number, rng: Rng): Puzzle {
  const { cells, W, H } = cycle;
  const { adj, ensure, addEdge } = makeAdjBuilder();

  for (let i = 0; i < cells.length; i++) {
    const [x1, y1] = cells[i];
    const [x2, y2] = cells[(i + 1) % cells.length];
    addEdge(x1, y1, x2, y2);
  }

  const exists = (x: number, y: number) => hasBlock(shape, x >> 1, y >> 1);

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (!exists(x, y)) continue;
      ensure(key(x, y));
      const rightK = key(x + 1, y);
      const downK = key(x, y + 1);
      if (x + 1 < W && exists(x + 1, y) && !adj.get(key(x, y))!.has(rightK) && rng() < density) addEdge(x, y, x + 1, y);
      if (y + 1 < H && exists(x, y + 1) && !adj.get(key(x, y))!.has(downK) && rng() < density) addEdge(x, y, x, y + 1);
    }
  }

  return { adj, W, H, startCell: cells[0] };
}

/**
 * Builds a puzzle graph on an arbitrary (already-built) shape: a hidden
 * Hamiltonian cycle over its doubled cell grid, plus distractor edges. Used
 * directly for a plain rectangle (`rectShape`, via `dailyPuzzle.ts`), which
 * never fails; for a randomly-generated shape, prefer
 * `buildRandomShapePuzzle`, which retries on the rare unlucky shape (see
 * `generateShapeAndCycle`).
 */
export function buildPuzzle(shape: Shape, density: number, rng: Rng): Puzzle {
  const cycle = generateHamiltonianCycle(shape, rng);
  return assemblePuzzle(shape, cycle, density, rng);
}

/** Builds a puzzle on a random connected polyomino of `m * n` blocks (see `randomShape`). */
export function buildRandomShapePuzzle(m: number, n: number, density: number, rng: Rng): Puzzle {
  const { shape, cycle } = generateShapeAndCycle((r) => randomShape(m, n, r), rng);
  return assemblePuzzle(shape, cycle, density, rng);
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
export function buildToroidalPuzzle(m: number, n: number, density: number, rng: Rng): Puzzle {
  const { cycle } = generateShapeAndCycle((r) => randomToroidalShape(m, n, r), rng);
  const W = 2 * m;
  const H = 2 * n;
  const wrapX = (x: number) => ((x % W) + W) % W;
  const wrapY = (y: number) => ((y % H) + H) % H;

  const { adj, ensure, addEdge } = makeAdjBuilder();

  for (let i = 0; i < cycle.cells.length; i++) {
    const [x1, y1] = cycle.cells[i];
    const [x2, y2] = cycle.cells[(i + 1) % cycle.cells.length];
    addEdge(wrapX(x1), wrapY(y1), wrapX(x2), wrapY(y2));
  }

  // The reduction fills the whole rectangle, so every canonical cell exists — no shape-membership check needed here.
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      ensure(key(x, y));
      const rx = (x + 1) % W;
      const ry = (y + 1) % H;
      if (!adj.get(key(x, y))!.has(key(rx, y)) && rng() < density) addEdge(x, y, rx, y);
      if (!adj.get(key(x, y))!.has(key(x, ry)) && rng() < density) addEdge(x, y, x, ry);
    }
  }

  const [sx, sy] = cycle.cells[0];
  return { adj, W, H, startCell: [wrapX(sx), wrapY(sy)], topology: 'torus' };
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
function buildWrappedRectPuzzle(m: number, n: number, density: number, rng: Rng, topology: Topology): Puzzle {
  const cycle = generateHamiltonianCycle(rectShape(m, n), rng);
  const { cells, W, H } = cycle;
  const { adj, ensure, addEdge } = makeAdjBuilder();

  for (let i = 0; i < cells.length; i++) {
    const [x1, y1] = cells[i];
    const [x2, y2] = cells[(i + 1) % cells.length];
    addEdge(x1, y1, x2, y2);
  }

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      ensure(key(x, y));
      const right = x + 1 < W ? { x: x + 1, y } : topology.wrapX(x + 1, y, W, H);
      const rightK = key(right.x, right.y);
      if (!adj.get(key(x, y))!.has(rightK) && rng() < density) addEdge(x, y, right.x, right.y);

      const down = y + 1 < H ? { x, y: y + 1 } : topology.wrapY(x, y + 1, W, H);
      const downK = key(down.x, down.y);
      if (!adj.get(key(x, y))!.has(downK) && rng() < density) addEdge(x, y, down.x, down.y);
    }
  }

  return { adj, W, H, startCell: cells[0], topology: topology.kind };
}

export function buildKleinBottlePuzzle(m: number, n: number, density: number, rng: Rng): Puzzle {
  return buildWrappedRectPuzzle(m, n, density, rng, KLEIN_BOTTLE);
}

export function buildProjectivePlanePuzzle(m: number, n: number, density: number, rng: Rng): Puzzle {
  return buildWrappedRectPuzzle(m, n, density, rng, PROJECTIVE_PLANE);
}
