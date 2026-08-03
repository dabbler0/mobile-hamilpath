import type { Rng } from './rng';
import { hasBlock, shapeBoundingBox, type Shape } from './shape';
import { randSpanningTree, type TreeEdges } from './spanningTree';

export type Cell = readonly [number, number];

export interface HamiltonianCycle {
  /** Cells of the cycle in visiting order, on the shape's doubled cell grid. Does not repeat the start cell at the end. */
  cells: Cell[];
  /** Bounding box of the doubled cell grid actually used (the shape's block bounding box, doubled). */
  W: number;
  H: number;
}

/** Clockwise directions: N, E, S, W. */
const CW: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Right-hand-rule turn preference: try right, straight, left, then U-turn as a last resort. */
const TURN_OFFSETS = [1, 0, -1, 2];

function dirIndex(d: readonly [number, number]): number {
  for (let k = 0; k < 4; k++) if (CW[k][0] === d[0] && CW[k][1] === d[1]) return k;
  throw new Error('bad dir');
}

/** Two adjacent doubled-grid cells are connected iff they share a block, or their blocks are joined by a tree edge. */
function blockConnected(x1: number, y1: number, x2: number, y2: number, treeEdges: TreeEdges): boolean {
  const bi1 = x1 >> 1;
  const bj1 = y1 >> 1;
  const bi2 = x2 >> 1;
  const bj2 = y2 >> 1;
  if (bi1 === bi2 && bj1 === bj2) return true;
  return treeEdges.has(`${bi1},${bj1}-${bi2},${bj2}`);
}

/**
 * Traces a Hamiltonian cycle over an arbitrary shape's doubled cell grid,
 * derived from a random spanning tree on the shape's blocks: walking around
 * the tree with a "wall follower" (prefer turning right, then straight, then
 * left, then reverse) traces every cell of the doubled grid exactly once and
 * returns to the start.
 */
export function generateHamiltonianCycle(shape: Shape, rng: Rng): HamiltonianCycle {
  const tree = randSpanningTree(shape, rng);
  const totalCells = shape.blocks.size * 4;
  const start: Cell = [2 * shape.start[0], 2 * shape.start[1]];

  /** Whether a doubled-grid cell belongs to the shape (its parent block is part of it). */
  const inShape = (x: number, y: number) => hasBlock(shape, x >> 1, y >> 1);

  let cur: Cell = start;
  let dir = CW[1];
  const cells: Cell[] = [start];
  const maxSteps = totalCells + 5;
  let steps = 0;

  do {
    steps++;
    if (steps > maxSteps) throw new Error('generation failed');
    const idx = dirIndex(dir);
    let next = -1;
    for (const off of TURN_OFFSETS) {
      const cIdx = (idx + off + 400) % 4;
      const [dx, dy] = CW[cIdx];
      const nx = cur[0] + dx;
      const ny = cur[1] + dy;
      if (!inShape(nx, ny)) continue;
      if (!blockConnected(cur[0], cur[1], nx, ny, tree)) continue;
      next = cIdx;
      break;
    }
    if (next === -1) throw new Error('stuck');
    dir = CW[next];
    cur = [cur[0] + dir[0], cur[1] + dir[1]];
    cells.push(cur);
  } while (!(cur[0] === start[0] && cur[1] === start[1]));

  cells.pop(); // last entry duplicates the start cell

  // For a full rectangle this can never happen (proven by exhaustive tests),
  // but an irregular polyomino can have a "notch" where the right-turn-first
  // wall follower closes a small sub-loop without ever reaching the rest of
  // the shape — the classic thickened-spanning-tree construction assumes a
  // topology this rare configuration violates. Rather than silently
  // returning a broken (non-Hamiltonian, multi-component) result, fail
  // loudly so a caller building a random shape can just regenerate a
  // different one (see `puzzle.ts`'s retry loop).
  if (cells.length !== totalCells) {
    throw new Error(`generateHamiltonianCycle: incomplete cycle (${cells.length} of ${totalCells} cells) — shape has a notch the wall-follower can't trace`);
  }

  const { m, n } = shapeBoundingBox(shape);
  return { cells, W: 2 * m, H: 2 * n };
}

/**
 * Builds a shape (via `makeShape`) and traces a Hamiltonian cycle on it,
 * retrying with a freshly-generated shape (still deterministic — it just
 * consumes more of the same `rng` stream) if the shape turns out to have a
 * notch the wall-follower can't trace. Rectangles never need this (they
 * never fail); it exists for `randomShape`/`randomToroidalShape` callers,
 * where an unlucky shape is rare but possible, especially at small sizes.
 */
export function generateShapeAndCycle(makeShape: (rng: Rng) => Shape, rng: Rng, maxAttempts = 50): { shape: Shape; cycle: HamiltonianCycle } {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shape = makeShape(rng);
    try {
      return { shape, cycle: generateHamiltonianCycle(shape, rng) };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`generateShapeAndCycle: no valid shape found after ${maxAttempts} attempts (${String(lastErr)})`);
}
