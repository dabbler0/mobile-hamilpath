import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { randSpanningTree } from './spanningTree';

/** Number of undirected edges represented by the (bidirectional) edge set. */
function undirectedEdgeCount(edges: Set<string>): number {
  return edges.size / 2;
}

/** Whether every one of the m*n blocks is reachable from (0,0) via the tree edges. */
function isConnected(edges: Set<string>, m: number, n: number): boolean {
  const visited = new Set<string>(['0,0']);
  const stack = ['0,0'];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const edge of edges) {
      const [from, to] = edge.split('-');
      if (from === cur && !visited.has(to)) {
        visited.add(to);
        stack.push(to);
      }
    }
  }
  return visited.size === m * n;
}

describe('randSpanningTree', () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 9],
  ];

  it.each(sizes)('spans and connects every block for a %i x %i grid', (m, n) => {
    for (const seed of [1, 2, 42, 999]) {
      const tree = randSpanningTree(m, n, mulberry32(seed));
      expect(undirectedEdgeCount(tree)).toBe(m * n - 1);
      expect(isConnected(tree, m, n)).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const treeA = randSpanningTree(6, 9, mulberry32(42));
    const treeB = randSpanningTree(6, 9, mulberry32(42));
    expect(treeA).toEqual(treeB);
  });
});
