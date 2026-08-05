import { describe, expect, it } from 'vitest';
import {
  DAILY_PUZZLE_DENSITY,
  generateDailyPuzzle,
  generateDailySolutionCells,
  generateDailySolutionEdges,
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
import { key, NO_EDGE_COLLECTIONS, totalCells, type EdgeCollectionParams } from './puzzle';

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

describe('edge collections in the puzzle id', () => {
  const base: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode: 'rect', index: 5 };

  it('leaves the hash/key untouched when collections are left off — absent, explicit NO_EDGE_COLLECTIONS, or maxCollections 0 with any size bounds all agree', () => {
    const untouched = puzzleIdKey(base);
    const explicitOff: EdgeCollectionParams = { ...NO_EDGE_COLLECTIONS };
    const zeroWithOtherBounds: EdgeCollectionParams = { maxCollections: 0, minSize: 3, maxSize: 7 };
    expect(puzzleIdKey({ ...base, collections: explicitOff })).toBe(untouched);
    expect(puzzleIdKey({ ...base, collections: zeroWithOtherBounds })).toBe(untouched);
    expect(puzzleSeed({ ...base, collections: explicitOff })).toBe(puzzleSeed(base));
  });

  it('changes the hash/key once collections are actually turned on', () => {
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    expect(puzzleIdKey({ ...base, collections: on })).not.toBe(puzzleIdKey(base));
    expect(puzzleSeed({ ...base, collections: on })).not.toBe(puzzleSeed(base));
  });

  it('distinguishes different active collection params from each other', () => {
    const a: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    const b: EdgeCollectionParams = { maxCollections: 3, minSize: 2, maxSize: 4 };
    const c: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 5 };
    const keys = new Set([a, b, c].map((collections) => puzzleIdKey({ ...base, collections })));
    expect(keys.size).toBe(3);
  });

  it('generateDailyPuzzle attaches edgeCollections respecting the given params, deterministically', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'small', shapeMode: 'rect', index: 0, collections: { maxCollections: 3, minSize: 2, maxSize: 4 } };
    const a = generateDailyPuzzle(id);
    const b = generateDailyPuzzle(id);
    expect(a.edgeCollections).toEqual(b.edgeCollections);
    expect(a.edgeCollections!.length).toBeLessThanOrEqual(3);
    for (const c of a.edgeCollections!) {
      expect(c.edges.length).toBeGreaterThanOrEqual(2);
      expect(c.edges.length).toBeLessThanOrEqual(4);
    }
  });

  it('generateDailyPuzzle gives no collections when the field is omitted', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'small', shapeMode: 'rect', index: 0 };
    expect(generateDailyPuzzle(id).edgeCollections).toEqual([]);
  });
});

describe('generateDailySolutionCells / generateDailySolutionEdges', () => {
  const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];

  it.each(shapeModes)('is deterministic for shape mode %s', (shapeMode) => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'tiny', shapeMode, index: 3 };
    expect(generateDailySolutionCells(id)).toEqual(generateDailySolutionCells(id));
    expect(generateDailySolutionEdges(id)).toEqual(generateDailySolutionEdges(id));
  });

  it.each(shapeModes)('visits every cell of the matching puzzle exactly once, all as real edges of its adj graph (%s)', (shapeMode) => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'mini', shapeMode, index: 2 };
    const puzzle = generateDailyPuzzle(id);
    const cells = generateDailySolutionCells(id);
    expect(cells.length).toBe(totalCells(puzzle));
    expect(new Set(cells.map(([x, y]) => key(x, y))).size).toBe(cells.length);

    const edges = generateDailySolutionEdges(id);
    expect(edges.size).toBe(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const [x1, y1] = cells[i];
      const [x2, y2] = cells[(i + 1) % cells.length];
      expect(puzzle.adj.get(key(x1, y1))?.has(key(x2, y2))).toBe(true);
    }
  });

  it('agrees with the CLAUDE.md-documented shortcut for a plain rectangle: cell order is a valid win path', () => {
    const id: PuzzleId = { day: '2026-07-10', sizeKey: 'small', shapeMode: 'rect', index: 1 };
    const puzzle = generateDailyPuzzle(id);
    // every cell has exactly two solution-edge neighbors — the hallmark of a single cycle
    const degree = new Map<string, number>();
    for (const ek of generateDailySolutionEdges(id)) {
      const [a, b] = ek.split('|');
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    expect(degree.size).toBe(totalCells(puzzle));
    for (const d of degree.values()) expect(d).toBe(2);
  });
});
