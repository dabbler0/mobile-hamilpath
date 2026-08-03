import type { Rng } from './rng';
import { blockKey, hasBlock, type Shape } from './shape';

/** Edges are stored as directed "i,j-i2,j2" strings, added in both directions. */
export type TreeEdges = Set<string>;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Builds a random spanning tree over an arbitrary shape's blocks via
 * randomized depth-first search, starting from `shape.start`. This tree
 * determines which walls get knocked down when we later trace a Hamiltonian
 * cycle on the doubled cell grid.
 */
export function randSpanningTree(shape: Shape, rng: Rng): TreeEdges {
  const visited = new Set<string>();
  const edges: TreeEdges = new Set();
  const addEdge = (a: number, b: number, c: number, d: number) => edges.add(`${a},${b}-${c},${d}`);

  const start = shape.start;
  visited.add(blockKey(start[0], start[1]));
  const stack: Array<[number, number]> = [[start[0], start[1]]];

  while (stack.length) {
    const [i, j] = stack[stack.length - 1];
    const opts: Array<[number, number]> = [];
    for (const [dx, dy] of DIRS) {
      const ni = i + dx;
      const nj = j + dy;
      if (hasBlock(shape, ni, nj) && !visited.has(blockKey(ni, nj))) opts.push([ni, nj]);
    }
    if (opts.length === 0) {
      stack.pop();
      continue;
    }
    const [ni, nj] = opts[Math.floor(rng() * opts.length)];
    visited.add(blockKey(ni, nj));
    addEdge(i, j, ni, nj);
    addEdge(ni, nj, i, j);
    stack.push([ni, nj]);
  }
  return edges;
}
