import { describe, expect, it } from 'vitest';
import {
  DAILY_PUZZLE_DENSITY,
  generateDailyPuzzle,
  puzzleIdKey,
  puzzleSeed,
  SHAPE_MODE_OPTIONS,
  shapeModeOption,
  SIZE_OPTIONS,
  sizeOption,
  todayKey,
  type PuzzleId,
  type ShapeMode,
} from './dailyPuzzle';
import { totalCells } from './puzzle';

describe('todayKey', () => {
  it('formats as local YYYY-MM-DD', () => {
    expect(todayKey(new Date(2026, 6, 10))).toBe('2026-07-10');
    expect(todayKey(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('zero-pads single-digit months and days', () => {
    expect(todayKey(new Date(2026, 2, 5))).toBe('2026-03-05');
  });
});

describe('sizeOption', () => {
  it('finds every declared size by key', () => {
    for (const opt of SIZE_OPTIONS) {
      expect(sizeOption(opt.key)).toEqual(opt);
    }
  });

  it('throws for an unknown key', () => {
    expect(() => sizeOption('nonexistent')).toThrow();
  });
});

describe('shapeModeOption', () => {
  it('finds every declared shape mode by key', () => {
    for (const opt of SHAPE_MODE_OPTIONS) {
      expect(shapeModeOption(opt.key)).toEqual(opt);
    }
  });

  it('throws for an unknown key', () => {
    expect(() => shapeModeOption('nonexistent')).toThrow();
  });
});

describe('puzzleSeed / puzzleIdKey', () => {
  it('is deterministic for the same id', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode: 'rect', index: 5 };
    expect(puzzleSeed(id)).toBe(puzzleSeed({ ...id }));
    expect(puzzleIdKey(id)).toBe(puzzleIdKey({ ...id }));
  });

  it('differs when the day, size, shape mode, or index differs', () => {
    const base: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode: 'rect', index: 5 };
    const seeds = new Set([
      puzzleSeed(base),
      puzzleSeed({ ...base, day: '2026-07-11' }),
      puzzleSeed({ ...base, sizeKey: 'small' }),
      puzzleSeed({ ...base, shapeMode: 'random' }),
      puzzleSeed({ ...base, index: 6 }),
    ]);
    expect(seeds.size).toBe(5);
  });
});

describe('generateDailyPuzzle', () => {
  const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];

  it.each(shapeModes)('is fully deterministic for shape mode %s: the same (day, size, shape, index) always yields the same puzzle', (shapeMode) => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'tiny', shapeMode, index: 4 };
    const a = generateDailyPuzzle(id);
    const b = generateDailyPuzzle(id);
    expect(a.W).toBe(b.W);
    expect(a.H).toBe(b.H);
    expect(a.startCell).toEqual(b.startCell);
    expect([...a.adj.entries()].map(([k, v]) => [k, [...v].sort()])).toEqual([...b.adj.entries()].map(([k, v]) => [k, [...v].sort()]));
  });

  it('produces a valid, fully-connected puzzle at the declared size (rect)', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode: 'rect', index: 0 };
    const puzzle = generateDailyPuzzle(id);
    const { m, n } = sizeOption('mini');
    expect(puzzle.W).toBe(2 * m);
    expect(puzzle.H).toBe(2 * n);
    expect(puzzle.adj.size).toBe(totalCells(puzzle));
  });

  it('produces a toroidal puzzle that fills the whole rectangle', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode: 'toroidal', index: 0 };
    const puzzle = generateDailyPuzzle(id);
    const { m, n } = sizeOption('mini');
    expect(puzzle.topology).toBe('torus');
    expect(puzzle.W).toBe(2 * m);
    expect(puzzle.H).toBe(2 * n);
    expect(totalCells(puzzle)).toBe(puzzle.W * puzzle.H);
  });

  it.each([
    ['klein', 'klein'],
    ['projective', 'projective'],
  ] as const)('produces a %s puzzle that fills the whole rectangle', (shapeMode, expectedTopology) => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode, index: 0 };
    const puzzle = generateDailyPuzzle(id);
    const { m, n } = sizeOption('mini');
    expect(puzzle.topology).toBe(expectedTopology);
    expect(puzzle.W).toBe(2 * m);
    expect(puzzle.H).toBe(2 * n);
    expect(totalCells(puzzle)).toBe(puzzle.W * puzzle.H);
  });

  it('uses the fixed daily density, not a user-chosen one', () => {
    expect(DAILY_PUZZLE_DENSITY).toBeGreaterThan(0);
    expect(DAILY_PUZZLE_DENSITY).toBeLessThan(1);
  });

  it.each(shapeModes)('gives consecutive indices of the same day/size/shape different puzzles (%s)', (shapeMode) => {
    const serialize = (p: ReturnType<typeof generateDailyPuzzle>) =>
      JSON.stringify([...p.adj.entries()].map(([k, v]) => [k, [...v].sort()]));
    const a = generateDailyPuzzle({ day: '2026-07-10', sizeKey: 'tiny', shapeMode, index: 0 });
    const b = generateDailyPuzzle({ day: '2026-07-10', sizeKey: 'tiny', shapeMode, index: 1 });
    expect(serialize(a)).not.toBe(serialize(b));
  });
});
