import { describe, expect, it } from 'vitest';
import { scrambleHamiltonianCycle } from './backbite';
import type { Cell } from './hamiltonianCycle';
import { mulberry32 } from './rng';

/**
 * A simple, hand-constructed Hamiltonian cycle over the full W x H grid
 * (W, H both even, W >= 2, H >= 2) — a "comb": row 0 straight across, then a
 * boustrophedon over columns [1, W-1] for every other row, then straight
 * back down column 0. Used as test input independent of the real
 * wall-follower, so these tests exercise `scrambleHamiltonianCycle` in
 * isolation rather than via `generateHamiltonianCycle`.
 */
function combCycle(W: number, H: number): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < W; x++) cells.push([x, 0]);
  for (let y = 1; y < H; y++) {
    if (y % 2 === 1) {
      for (let x = W - 1; x >= 1; x--) cells.push([x, y]);
    } else {
      for (let x = 1; x < W; x++) cells.push([x, y]);
    }
  }
  cells.push([0, H - 1]);
  for (let y = H - 2; y >= 1; y--) cells.push([0, y]);
  return cells;
}

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function cellSet(cells: readonly Cell[]): Set<string> {
  return new Set(cells.map(([x, y]) => `${x},${y}`));
}

function assertValidCycle(cells: readonly Cell[], expectedCount: number) {
  expect(cells.length).toBe(expectedCount);
  expect(cellSet(cells).size).toBe(expectedCount);
  for (let i = 0; i < cells.length; i++) {
    expect(manhattan(cells[i], cells[(i + 1) % cells.length])).toBe(1);
  }
}

describe('combCycle (test fixture)', () => {
  it('is itself a valid Hamiltonian cycle over the full grid', () => {
    for (const [W, H] of [
      [2, 2],
      [4, 4],
      [6, 8],
    ] as const) {
      assertValidCycle(combCycle(W, H), W * H);
    }
  });
});

describe('scrambleHamiltonianCycle', () => {
  const inFullGrid = (W: number, H: number) => (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H;

  it('returns a valid Hamiltonian cycle over the same cell set', () => {
    const W = 10;
    const H = 12;
    const cycle = combCycle(W, H);
    for (const seed of [1, 2, 3, 42]) {
      const scrambled = scrambleHamiltonianCycle(cycle, inFullGrid(W, H), mulberry32(seed));
      assertValidCycle(scrambled, cycle.length);
      expect(cellSet(scrambled)).toEqual(cellSet(cycle));
    }
  });

  it('is deterministic for a given seed', () => {
    const cycle = combCycle(8, 10);
    const inShape = inFullGrid(8, 10);
    const a = scrambleHamiltonianCycle(cycle, inShape, mulberry32(7));
    const b = scrambleHamiltonianCycle(cycle, inShape, mulberry32(7));
    expect(a).toEqual(b);
  });

  it('different seeds scramble differently', () => {
    const cycle = combCycle(10, 12);
    const inShape = inFullGrid(10, 12);
    const a = scrambleHamiltonianCycle(cycle, inShape, mulberry32(1));
    const b = scrambleHamiltonianCycle(cycle, inShape, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('actually perturbs the input cycle rather than returning it unchanged', () => {
    const cycle = combCycle(10, 12);
    const inShape = inFullGrid(10, 12);
    const scrambled = scrambleHamiltonianCycle(cycle, inShape, mulberry32(5));
    expect(scrambled).not.toEqual(cycle);
  });

  it('breaks up the comb fixture’s regular structure: far fewer long straight runs than the original', () => {
    function runCount(cells: readonly Cell[]): number {
      let runs = 0;
      let lastDir: string | null = null;
      for (let i = 0; i < cells.length; i++) {
        const [x1, y1] = cells[i];
        const [x2, y2] = cells[(i + 1) % cells.length];
        const dir = `${x2 - x1},${y2 - y1}`;
        if (dir !== lastDir) runs++;
        lastDir = dir;
      }
      return runs;
    }
    const W = 12;
    const H = 14;
    const cycle = combCycle(W, H);
    const originalRuns = runCount(cycle); // a comb only ever turns at row/column ends — very few runs
    const scrambled = scrambleHamiltonianCycle(cycle, inFullGrid(W, H), mulberry32(11));
    expect(runCount(scrambled)).toBeGreaterThan(originalRuns * 2);
  });

  it('leaves a too-small cycle (fewer than 4 cells) unchanged', () => {
    const tiny: Cell[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    // 4 is the boundary — exercise the actual smallest real board (a single doubled 2x2 block).
    const inShape = inFullGrid(2, 2);
    const scrambled = scrambleHamiltonianCycle(tiny, inShape, mulberry32(1));
    assertValidCycle(scrambled, 4);
  });

  it('never throws and always returns a valid cycle on a narrow (width-2) corridor, where almost every cell has no spare backbite candidate at all', () => {
    const W = 2;
    const H = 20;
    const inShape = inFullGrid(W, H);
    const cycle = combCycle(W, H);
    for (let seed = 0; seed < 10; seed++) {
      const scrambled = scrambleHamiltonianCycle(cycle, inShape, mulberry32(seed));
      assertValidCycle(scrambled, cycle.length);
      for (const [x, y] of scrambled) expect(inShape(x, y)).toBe(true);
    }
  });
});
