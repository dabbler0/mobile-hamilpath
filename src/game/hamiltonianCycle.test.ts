import { describe, expect, it } from 'vitest';
import { generateHamiltonianCycle, generateShapeAndCycle } from './hamiltonianCycle';
import { mulberry32 } from './rng';
import { randomShape, rectShape } from './shape';

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

  it.each(sizes)('visits every cell of the doubled %i x %i rectangle exactly once', (m, n) => {
    for (const seed of [1, 7, 42, 123456]) {
      const { cells, W, H } = generateHamiltonianCycle(rectShape(m, n), mulberry32(seed));
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

  it.each(sizes)('also visits every cell exactly once on a random polyomino shape of the same area (%i x %i)', (m, n) => {
    for (const seed of [1, 7, 42]) {
      const { shape, cycle } = generateShapeAndCycle((rng) => randomShape(m, n, rng), mulberry32(seed));
      const { cells } = cycle;
      expect(cells.length).toBe(shape.blocks.size * 4);
      const seen = new Set(cells.map(([x, y]) => `${x},${y}`));
      expect(seen.size).toBe(cells.length);
      for (const [x, y] of cells) {
        expect(shape.blocks.has(`${x >> 1},${y >> 1}`)).toBe(true);
      }
    }
  });

  it('connects every consecutive pair (including wraparound) with a single orthogonal step', () => {
    const { cells } = generateHamiltonianCycle(rectShape(6, 9), mulberry32(7));
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      const b = cells[(i + 1) % cells.length];
      expect(manhattan(a, b)).toBe(1);
    }
  });

  it('starts at the shape start (doubled)', () => {
    const { cells } = generateHamiltonianCycle(rectShape(4, 6), mulberry32(3));
    expect(cells[0]).toEqual([0, 0]);
  });

  it('is deterministic for a given seed', () => {
    const a = generateHamiltonianCycle(rectShape(6, 9), mulberry32(42));
    const b = generateHamiltonianCycle(rectShape(6, 9), mulberry32(42));
    expect(a.cells).toEqual(b.cells);
  });
});
