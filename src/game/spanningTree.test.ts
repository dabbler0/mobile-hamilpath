import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { randomShape, randomToroidalShape, rectShape, type Shape } from './shape';
import { randSpanningTree } from './spanningTree';

/** Number of undirected edges represented by the (bidirectional) edge set. */
function undirectedEdgeCount(edges: Set<string>): number {
  return edges.size / 2;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Whether every one of the shape's blocks is reachable from its start via the
 * tree edges. Looks edges up by reconstructing the "i,j-i2,j2" key directly
 * (rather than splitting it apart) since block coordinates can be negative
 * for a toroidal shape's raw representation, which makes the '-' separator
 * ambiguous with a coordinate's own sign.
 */
function isConnected(edges: Set<string>, shape: Shape): boolean {
  const start = `${shape.start[0]},${shape.start[1]}`;
  const visited = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    const [i, j] = cur.split(',').map(Number);
    for (const [di, dj] of DIRS) {
      const next = `${i + di},${j + dj}`;
      if (edges.has(`${cur}-${next}`) && !visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return visited.size === shape.blocks.size;
}

describe('randSpanningTree', () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 9],
  ];

  it.each(sizes)('spans and connects every block for a %i x %i rectangle', (m, n) => {
    for (const seed of [1, 2, 42, 999]) {
      const shape = rectShape(m, n);
      const tree = randSpanningTree(shape, mulberry32(seed));
      expect(undirectedEdgeCount(tree)).toBe(m * n - 1);
      expect(isConnected(tree, shape)).toBe(true);
    }
  });

  it.each(sizes)('also spans and connects a random polyomino shape of the same area (%i x %i)', (m, n) => {
    for (const seed of [1, 2, 42]) {
      const shape = randomShape(m, n, mulberry32(seed + 500));
      const tree = randSpanningTree(shape, mulberry32(seed));
      expect(undirectedEdgeCount(tree)).toBe(shape.blocks.size - 1);
      expect(isConnected(tree, shape)).toBe(true);
    }
  });

  it('spans and connects a toroidal fundamental-domain shape', () => {
    for (const seed of [1, 2, 42]) {
      const shape = randomToroidalShape(6, 5, mulberry32(seed + 500));
      const tree = randSpanningTree(shape, mulberry32(seed));
      expect(undirectedEdgeCount(tree)).toBe(shape.blocks.size - 1);
      expect(isConnected(tree, shape)).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const shape = rectShape(6, 9);
    const treeA = randSpanningTree(shape, mulberry32(42));
    const treeB = randSpanningTree(shape, mulberry32(42));
    expect(treeA).toEqual(treeB);
  });
});
