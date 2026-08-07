import { describe, expect, it } from 'vitest';
import {
  customSizeKey,
  generatePuzzle,
  generateSolutionCells,
  generateSolutionEdges,
  PUZZLE_DENSITY,
  puzzleIdKey,
  puzzleSeed,
  randomSeed,
  SHAPE_MODE_OPTIONS,
  shapeModeOption,
  SIZE_OPTIONS,
  sizeOption,
  type PuzzleId,
  type ShapeMode,
} from './puzzleGen';
import { key, NO_EDGE_COLLECTIONS, totalCells, type EdgeCollectionParams } from './puzzle';

describe('sizeOption', () => {
  it('finds every declared size by key', () => {
    for (const opt of SIZE_OPTIONS) {
      expect(sizeOption(opt.key)).toEqual(opt);
    }
  });

  it('throws for an unknown key', () => {
    expect(() => sizeOption('nonexistent')).toThrow();
  });

  it('resolves a synthetic customSizeKey (Blitz\'s continuously-sized boards) to its own m/n, without a SIZE_OPTIONS entry', () => {
    expect(sizeOption(customSizeKey(5, 9))).toEqual({ key: 'custom:5x9', label: '5×9', m: 5, n: 9 });
  });

  it('still throws for a key that merely looks custom-ish but is malformed', () => {
    expect(() => sizeOption('custom:5xNaN')).toThrow();
    expect(() => sizeOption('custom:5')).toThrow();
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

describe('randomSeed', () => {
  it('produces a non-negative 32-bit integer', () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(0x100000000);
    }
  });

  it('is not the same value every call (overwhelmingly likely with 32 bits of entropy)', () => {
    const seeds = new Set(Array.from({ length: 10 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe('puzzleSeed / puzzleIdKey', () => {
  it('is deterministic for the same id', () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: 'rect', seed: 12345 };
    expect(puzzleSeed(id)).toBe(puzzleSeed({ ...id }));
    expect(puzzleIdKey(id)).toBe(puzzleIdKey({ ...id }));
  });

  it('differs when the size, shape mode, or seed differs', () => {
    const base: PuzzleId = { sizeKey: 'mini', shapeMode: 'rect', seed: 12345 };
    const seeds = new Set([
      puzzleSeed(base),
      puzzleSeed({ ...base, sizeKey: 'small' }),
      puzzleSeed({ ...base, shapeMode: 'random' }),
      puzzleSeed({ ...base, seed: 12346 }),
    ]);
    expect(seeds.size).toBe(4);
  });
});

describe('generatePuzzle', () => {
  const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];

  it.each(shapeModes)('is fully deterministic for shape mode %s: the same (size, shape, seed) always yields the same puzzle', (shapeMode) => {
    const id: PuzzleId = { sizeKey: 'tiny', shapeMode, seed: 42 };
    const a = generatePuzzle(id);
    const b = generatePuzzle(id);
    expect(a.W).toBe(b.W);
    expect(a.H).toBe(b.H);
    expect(a.startCell).toEqual(b.startCell);
    expect([...a.adj.entries()].map(([k, v]) => [k, [...v].sort()])).toEqual([...b.adj.entries()].map(([k, v]) => [k, [...v].sort()]));
  });

  it('produces a valid, fully-connected puzzle at the declared size (rect)', () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: 'rect', seed: 1 };
    const puzzle = generatePuzzle(id);
    const { m, n } = sizeOption('mini');
    expect(puzzle.W).toBe(2 * m);
    expect(puzzle.H).toBe(2 * n);
    expect(puzzle.adj.size).toBe(totalCells(puzzle));
  });

  it('produces a toroidal puzzle that fills the whole rectangle', () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: 'toroidal', seed: 1 };
    const puzzle = generatePuzzle(id);
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
    const id: PuzzleId = { sizeKey: 'mini', shapeMode, seed: 1 };
    const puzzle = generatePuzzle(id);
    const { m, n } = sizeOption('mini');
    expect(puzzle.topology).toBe(expectedTopology);
    expect(puzzle.W).toBe(2 * m);
    expect(puzzle.H).toBe(2 * n);
    expect(totalCells(puzzle)).toBe(puzzle.W * puzzle.H);
  });

  it('uses the fixed puzzle density, not a user-chosen one', () => {
    expect(PUZZLE_DENSITY).toBeGreaterThan(0);
    expect(PUZZLE_DENSITY).toBeLessThan(1);
  });

  it.each(shapeModes)('gives different seeds of the same size/shape different puzzles (%s)', (shapeMode) => {
    const serialize = (p: ReturnType<typeof generatePuzzle>) => JSON.stringify([...p.adj.entries()].map(([k, v]) => [k, [...v].sort()]));
    const a = generatePuzzle({ sizeKey: 'tiny', shapeMode, seed: 1 });
    const b = generatePuzzle({ sizeKey: 'tiny', shapeMode, seed: 2 });
    expect(serialize(a)).not.toBe(serialize(b));
  });
});

describe('edge collections in the puzzle id', () => {
  const base: PuzzleId = { sizeKey: 'mini', shapeMode: 'rect', seed: 5 };

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

  it('generatePuzzle attaches edgeCollections respecting the given params, deterministically', () => {
    const id: PuzzleId = { sizeKey: 'small', shapeMode: 'rect', seed: 1, collections: { maxCollections: 3, minSize: 2, maxSize: 4 } };
    const a = generatePuzzle(id);
    const b = generatePuzzle(id);
    expect(a.edgeCollections).toEqual(b.edgeCollections);
    expect(a.edgeCollections!.length).toBeLessThanOrEqual(3);
    for (const c of a.edgeCollections!) {
      expect(c.edges.length).toBeGreaterThanOrEqual(2);
      expect(c.edges.length).toBeLessThanOrEqual(4);
    }
  });

  it('generatePuzzle gives no collections when the field is omitted', () => {
    const id: PuzzleId = { sizeKey: 'small', shapeMode: 'rect', seed: 1 };
    expect(generatePuzzle(id).edgeCollections).toEqual([]);
  });
});

describe('generateSolutionCells / generateSolutionEdges', () => {
  const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];

  it.each(shapeModes)('is deterministic for shape mode %s', (shapeMode) => {
    const id: PuzzleId = { sizeKey: 'tiny', shapeMode, seed: 3 };
    expect(generateSolutionCells(id)).toEqual(generateSolutionCells(id));
    expect(generateSolutionEdges(id)).toEqual(generateSolutionEdges(id));
  });

  it.each(shapeModes)('visits every cell of the matching puzzle exactly once, all as real edges of its adj graph (%s)', (shapeMode) => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode, seed: 2 };
    const puzzle = generatePuzzle(id);
    const cells = generateSolutionCells(id);
    expect(cells.length).toBe(totalCells(puzzle));
    expect(new Set(cells.map(([x, y]) => key(x, y))).size).toBe(cells.length);

    const edges = generateSolutionEdges(id);
    expect(edges.size).toBe(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const [x1, y1] = cells[i];
      const [x2, y2] = cells[(i + 1) % cells.length];
      expect(puzzle.adj.get(key(x1, y1))?.has(key(x2, y2))).toBe(true);
    }
  });

  it('agrees with the CLAUDE.md-documented shortcut for a plain rectangle: cell order is a valid win path', () => {
    const id: PuzzleId = { sizeKey: 'small', shapeMode: 'rect', seed: 1 };
    const puzzle = generatePuzzle(id);
    // every cell has exactly two solution-edge neighbors — the hallmark of a single cycle
    const degree = new Map<string, number>();
    for (const ek of generateSolutionEdges(id)) {
      const [a, b] = ek.split('|');
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    expect(degree.size).toBe(totalCells(puzzle));
    for (const d of degree.values()) expect(d).toBe(2);
  });
});
