import type { Rng } from './rng';
import { generateHamiltonianCycle, generateShapeAndCycle, type Cell, type HamiltonianCycle } from './hamiltonianCycle';
import { hasBlock, randomShape, randomToroidalShape, type Shape } from './shape';

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
  /** True for a toroidal-wraparound board: the last column/row wraps back to the first, both for adjacency and for face regions. Absent (falsy) for ordinary rectangular or shaped boards. */
  toroidal?: boolean;
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
  return { adj, W, H, startCell: [wrapX(sx), wrapY(sy)], toroidal: true };
}
