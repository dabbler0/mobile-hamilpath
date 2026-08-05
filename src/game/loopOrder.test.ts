import { describe, expect, it } from 'vitest';
import { edgeKey } from './regions';
import { orderLoopCells } from './loopOrder';

describe('orderLoopCells', () => {
  it('returns null for an empty edge set', () => {
    expect(orderLoopCells(new Set())).toBeNull();
  });

  it('orders a small square cycle into a walkable sequence', () => {
    const cycle = new Set([edgeKey([0, 0], [1, 0]), edgeKey([1, 0], [1, 1]), edgeKey([1, 1], [0, 1]), edgeKey([0, 1], [0, 0])]);
    const ordered = orderLoopCells(cycle);
    expect(ordered).not.toBeNull();
    expect(ordered).toHaveLength(4);

    // Every consecutive pair (wrapping around) must be one of the cycle's edges.
    const seen = new Set<string>();
    for (let i = 0; i < ordered!.length; i++) {
      const a = ordered![i];
      const b = ordered![(i + 1) % ordered!.length];
      const ek = edgeKey(a, b);
      expect(cycle.has(ek)).toBe(true);
      seen.add(ek);
    }
    expect(seen.size).toBe(cycle.size);
  });

  it('returns null when a cell has the wrong marked-degree (not a simple cycle)', () => {
    // A "Y" shape: (1,0) has three marked edges, so no cell has degree exactly 2 throughout a simple cycle.
    const notACycle = new Set([edgeKey([0, 0], [1, 0]), edgeKey([1, 0], [2, 0]), edgeKey([1, 0], [1, 1])]);
    expect(orderLoopCells(notACycle)).toBeNull();
  });

  it('returns null for two disjoint cycles (not a single loop)', () => {
    const twoCycles = new Set([
      edgeKey([0, 0], [1, 0]),
      edgeKey([1, 0], [1, 1]),
      edgeKey([1, 1], [0, 1]),
      edgeKey([0, 1], [0, 0]),
      edgeKey([5, 5], [6, 5]),
      edgeKey([6, 5], [6, 6]),
      edgeKey([6, 6], [5, 6]),
      edgeKey([5, 6], [5, 5]),
    ]);
    expect(orderLoopCells(twoCycles)).toBeNull();
  });

  it('handles a larger rectangular-loop cycle', () => {
    // Perimeter of a 3x3 grid of cells (a ring, not a full Hamiltonian fill, but still one simple cycle).
    const cells: Array<[number, number]> = [
      [0, 0], [1, 0], [2, 0],
      [2, 1],
      [2, 2], [1, 2], [0, 2],
      [0, 1],
    ];
    const cycle = new Set<string>();
    for (let i = 0; i < cells.length; i++) {
      cycle.add(edgeKey(cells[i], cells[(i + 1) % cells.length]));
    }
    const ordered = orderLoopCells(cycle);
    expect(ordered).not.toBeNull();
    expect(ordered).toHaveLength(cells.length);
  });
});
