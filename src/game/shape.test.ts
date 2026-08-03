import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { hasBlock, parseBlockKey, randomShape, randomToroidalShape, rectShape, shapeBoundingBox, type Shape } from './shape';

function isConnected(shape: Shape): boolean {
  const start = `${shape.start[0]},${shape.start[1]}`;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    const [i, j] = parseBlockKey(cur);
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nj = j + dj;
      const nk = `${ni},${nj}`;
      if (hasBlock(shape, ni, nj) && !seen.has(nk)) {
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  return seen.size === shape.blocks.size;
}

describe('rectShape', () => {
  it('contains exactly the m x n grid, starting at (0,0)', () => {
    const shape = rectShape(3, 4);
    expect(shape.blocks.size).toBe(12);
    expect(shape.start).toEqual([0, 0]);
    expect(hasBlock(shape, 2, 3)).toBe(true);
    expect(hasBlock(shape, 3, 0)).toBe(false);
  });
});

describe('randomShape', () => {
  it('produces a connected shape of exactly m * n blocks, normalized to (0,0)', () => {
    for (const seed of [1, 2, 42]) {
      const shape = randomShape(5, 6, mulberry32(seed));
      expect(shape.blocks.size).toBe(30);
      expect(hasBlock(shape, shape.start[0], shape.start[1])).toBe(true);
      expect(isConnected(shape)).toBe(true);

      let minI = Infinity;
      let minJ = Infinity;
      for (const k of shape.blocks) {
        const [i, j] = parseBlockKey(k);
        minI = Math.min(minI, i);
        minJ = Math.min(minJ, j);
      }
      expect(minI).toBe(0);
      expect(minJ).toBe(0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = randomShape(4, 5, mulberry32(7));
    const b = randomShape(4, 5, mulberry32(7));
    expect([...a.blocks].sort()).toEqual([...b.blocks].sort());
    expect(a.start).toEqual(b.start);
  });

  it('is generally not a plain rectangle', () => {
    const shape = randomShape(6, 6, mulberry32(1));
    const { m, n } = shapeBoundingBox(shape);
    // A 6x6 rectangle would have exactly 36 blocks and bounding box 6x6;
    // an organic random growth almost never lands on that exact box.
    expect(m * n === 36 && shape.blocks.size === m * n).toBe(false);
  });
});

describe('randomToroidalShape', () => {
  it('is a valid transversal of Z^2 / (mZ x nZ): exactly one block per residue class', () => {
    for (const seed of [1, 2, 42]) {
      const shape = randomToroidalShape(5, 4, mulberry32(seed));
      expect(shape.blocks.size).toBe(20);
      const seenClasses = new Set<string>();
      for (const k of shape.blocks) {
        const [i, j] = parseBlockKey(k);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(5);
        const cls = `${i},${((j % 4) + 4) % 4}`;
        expect(seenClasses.has(cls)).toBe(false);
        seenClasses.add(cls);
      }
      expect(seenClasses.size).toBe(20);
    }
  });

  it('is orthogonally connected', () => {
    for (const seed of [1, 2, 42, 99]) {
      const shape = randomToroidalShape(6, 5, mulberry32(seed));
      expect(isConnected(shape)).toBe(true);
    }
  });

  it('column 0 always starts at row 0 (no shift applied)', () => {
    const shape = randomToroidalShape(4, 3, mulberry32(5));
    expect(hasBlock(shape, 0, 0)).toBe(true);
    expect(shape.start).toEqual([0, 0]);
  });

  it('is deterministic for a given seed', () => {
    const a = randomToroidalShape(5, 4, mulberry32(3));
    const b = randomToroidalShape(5, 4, mulberry32(3));
    expect([...a.blocks].sort()).toEqual([...b.blocks].sort());
  });
});
