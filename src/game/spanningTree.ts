import type { Rng } from './rng';

/** Edges are stored as directed "i,j-i2,j2" strings, added in both directions. */
export type TreeEdges = Set<string>;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Builds a random spanning tree over an m x n grid of "blocks" via randomized
 * depth-first search. This tree determines which walls get knocked down when
 * we later trace a Hamiltonian cycle on the doubled (2m x 2n) grid.
 */
export function randSpanningTree(m: number, n: number, rng: Rng): TreeEdges {
  const visited: boolean[][] = Array.from({ length: m }, () => Array(n).fill(false));
  const edges: TreeEdges = new Set();
  const addEdge = (a: number, b: number, c: number, d: number) => edges.add(`${a},${b}-${c},${d}`);

  const stack: Array<[number, number]> = [[0, 0]];
  visited[0][0] = true;

  while (stack.length) {
    const [i, j] = stack[stack.length - 1];
    const opts: Array<[number, number]> = [];
    for (const [dx, dy] of DIRS) {
      const ni = i + dx;
      const nj = j + dy;
      if (ni >= 0 && ni < m && nj >= 0 && nj < n && !visited[ni][nj]) opts.push([ni, nj]);
    }
    if (opts.length === 0) {
      stack.pop();
      continue;
    }
    const [ni, nj] = opts[Math.floor(rng() * opts.length)];
    visited[ni][nj] = true;
    addEdge(i, j, ni, nj);
    addEdge(ni, nj, i, j);
    stack.push([ni, nj]);
  }
  return edges;
}
