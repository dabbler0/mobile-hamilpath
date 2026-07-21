import { describe, expect, it } from 'vitest';
import { generateHamiltonianCycle } from './hamiltonianCycle';
import { mulberry32 } from './rng';

function manhattan(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

describe('generateHamiltonianCycle', () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 9],
  ];

  it.each(sizes)('visits every cell of the doubled %i x %i grid exactly once', (m, n) => {
    for (const seed of [1, 7, 42, 123456]) {
      const { cells, W, H } = generateHamiltonianCycle(m, n, mulberry32(seed));
      expect(W).toBe(2 * m);
      expect(H).toBe(2 * n);
      expect(cells.length).toBe(W * H);

      const seen = new Set(cells.map(([x, y]) => `${x},${y}`));
      expect(seen.size).toBe(cells.length);

      for (const [x, y] of cells) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(W);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(H);
      }
    }
  });

  it('connects every consecutive pair (including wraparound) with a single orthogonal step', () => {
    const { cells } = generateHamiltonianCycle(6, 9, mulberry32(7));
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      const b = cells[(i + 1) % cells.length];
      expect(manhattan(a, b)).toBe(1);
    }
  });

  it('starts at the origin', () => {
    const { cells } = generateHamiltonianCycle(4, 6, mulberry32(3));
    expect(cells[0]).toEqual([0, 0]);
  });

  it('is deterministic for a given seed', () => {
    const a = generateHamiltonianCycle(6, 9, mulberry32(42));
    const b = generateHamiltonianCycle(6, 9, mulberry32(42));
    expect(a.cells).toEqual(b.cells);
  });
});
