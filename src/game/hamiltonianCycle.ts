import type { Rng } from './rng';
import { randSpanningTree, type TreeEdges } from './spanningTree';

export type Cell = readonly [number, number];

export interface HamiltonianCycle {
  /** Cells of the cycle in visiting order, on a (2m x 2n) doubled grid. Does not repeat the start cell at the end. */
  cells: Cell[];
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
 * Traces a Hamiltonian cycle over a 2m x 2n grid derived from a random spanning
 * tree on the m x n block grid: walking around the tree with a "wall follower"
 * (prefer turning right, then straight, then left, then reverse) traces every
 * cell of the doubled grid exactly once and returns to the start.
 */
export function generateHamiltonianCycle(m: number, n: number, rng: Rng): HamiltonianCycle {
  const tree = randSpanningTree(m, n, rng);
  const W = 2 * m;
  const H = 2 * n;
  let cur: Cell = [0, 0];
  let dir = CW[1];
  const cells: Cell[] = [[0, 0]];
  const maxSteps = W * H + 5;
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
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (!blockConnected(cur[0], cur[1], nx, ny, tree)) continue;
      next = cIdx;
      break;
    }
    if (next === -1) throw new Error('stuck');
    dir = CW[next];
    cur = [cur[0] + dir[0], cur[1] + dir[1]];
    cells.push(cur);
  } while (!(cur[0] === 0 && cur[1] === 0));

  cells.pop(); // last entry duplicates the start cell
  return { cells, W, H };
}
