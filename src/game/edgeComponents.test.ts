import { describe, expect, it } from 'vitest';
import { computeEdgeComponents } from './edgeComponents';
import { edgeKey } from './regions';

describe('computeEdgeComponents', () => {
  it('returns an empty map for no edges', () => {
    expect(computeEdgeComponents(new Set())).toEqual(new Map());
  });

  it('groups edges that share a cell into the same component', () => {
    const e1 = edgeKey([0, 0], [1, 0]);
    const e2 = edgeKey([1, 0], [1, 1]);
    const components = computeEdgeComponents(new Set([e1, e2]));
    expect(components.get(e1)).toBe(components.get(e2));
  });

  it('gives edges with no shared cell different components', () => {
    const e1 = edgeKey([0, 0], [1, 0]);
    const e2 = edgeKey([5, 5], [6, 5]);
    const components = computeEdgeComponents(new Set([e1, e2]));
    expect(components.get(e1)).not.toBe(components.get(e2));
  });

  it('separates two multi-edge paths that never touch, even when their edges interleave in the set', () => {
    const pathA = [edgeKey([0, 0], [1, 0]), edgeKey([1, 0], [2, 0])];
    const pathB = [edgeKey([0, 5], [0, 6]), edgeKey([0, 6], [0, 7])];
    const components = computeEdgeComponents(new Set([pathA[0], pathB[0], pathA[1], pathB[1]]));

    const idsA = new Set(pathA.map((e) => components.get(e)));
    const idsB = new Set(pathB.map((e) => components.get(e)));
    expect(idsA.size).toBe(1);
    expect(idsB.size).toBe(1);
    expect([...idsA][0]).not.toBe([...idsB][0]);
  });

  it('keeps a closed cycle as a single component', () => {
    const cycle = [
      edgeKey([0, 0], [1, 0]),
      edgeKey([1, 0], [1, 1]),
      edgeKey([1, 1], [0, 1]),
      edgeKey([0, 1], [0, 0]),
    ];
    const components = computeEdgeComponents(new Set(cycle));
    const ids = new Set(cycle.map((e) => components.get(e)));
    expect(ids.size).toBe(1);
  });
});
