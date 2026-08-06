import { describe, expect, it } from 'vitest';
import { BLITZ_INITIAL_BUDGET, boardDifficultyRating, boardEdgeCount, createBlitzSequence, eligibleBlitzOptions, SHAPE_DIFFICULTY_MULTIPLIER } from './blitz';
import { totalCells } from './puzzle';
import { generatePuzzle, SIZE_OPTIONS, type ShapeMode } from './puzzleGen';

describe('boardEdgeCount', () => {
  it('matches 4 * m * n for every declared size', () => {
    for (const size of SIZE_OPTIONS) {
      expect(boardEdgeCount(size.key)).toBe(4 * size.m * size.n);
    }
  });

  it('matches the actual generated puzzle cell count for every shape mode (same size, same total cells)', () => {
    const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal'];
    for (const size of SIZE_OPTIONS.slice(0, 3)) {
      for (const shapeMode of shapeModes) {
        const puzzle = generatePuzzle({ sizeKey: size.key, shapeMode, seed: 7 });
        expect(totalCells(puzzle)).toBe(boardEdgeCount(size.key));
      }
    }
  });
});

describe('boardDifficultyRating', () => {
  it('applies the shape multiplier on top of the raw edge count', () => {
    for (const size of SIZE_OPTIONS) {
      const raw = boardEdgeCount(size.key);
      expect(boardDifficultyRating(size.key, 'rect')).toBe(raw * SHAPE_DIFFICULTY_MULTIPLIER.rect);
      expect(boardDifficultyRating(size.key, 'random')).toBe(raw * SHAPE_DIFFICULTY_MULTIPLIER.random);
      expect(boardDifficultyRating(size.key, 'toroidal')).toBe(raw * SHAPE_DIFFICULTY_MULTIPLIER.toroidal);
    }
  });

  it('rates a random-shape board as half as difficult, and a toroidal one as twice as difficult, as the same-size rectangle', () => {
    const rating = (shapeMode: ShapeMode) => boardDifficultyRating('small', shapeMode);
    expect(rating('random')).toBe(rating('rect') / 2);
    expect(rating('toroidal')).toBe(rating('rect') * 2);
  });
});

describe('eligibleBlitzOptions', () => {
  it('at the initial budget, allows both tiny options (and anything else that happens to rate no higher)', () => {
    const eligible = eligibleBlitzOptions(BLITZ_INITIAL_BUDGET);
    const keys = eligible.map((o) => `${o.sizeKey}::${o.shapeMode}`);
    expect(keys).toContain('tiny::rect');
    expect(keys).toContain('tiny::random');
    // Everything eligible must rate no higher than the initial budget, by construction.
    for (const opt of eligible) expect(boardDifficultyRating(opt.sizeKey, opt.shapeMode)).toBeLessThanOrEqual(BLITZ_INITIAL_BUDGET);
  });

  it('never offers klein or projective (matching the New Game picker restriction)', () => {
    const eligible = eligibleBlitzOptions(Number.MAX_SAFE_INTEGER);
    expect(eligible.every((o) => o.shapeMode !== 'klein' && o.shapeMode !== 'projective')).toBe(true);
  });

  it('grows monotonically: a strictly larger budget never loses an option that was already eligible', () => {
    const small = eligibleBlitzOptions(BLITZ_INITIAL_BUDGET);
    const big = eligibleBlitzOptions(BLITZ_INITIAL_BUDGET * 10);
    const bigKeys = new Set(big.map((o) => `${o.sizeKey}::${o.shapeMode}`));
    for (const opt of small) expect(bigKeys.has(`${opt.sizeKey}::${opt.shapeMode}`)).toBe(true);
    expect(big.length).toBeGreaterThan(small.length);
  });

  it('eventually offers every declared size/shape combination (rect/random/toroidal) given a large enough budget', () => {
    const eligible = eligibleBlitzOptions(Number.MAX_SAFE_INTEGER);
    expect(eligible.length).toBe(SIZE_OPTIONS.length * 3);
  });
});

describe('createBlitzSequence', () => {
  it('is fully deterministic for the same seed', () => {
    const a = createBlitzSequence(12345);
    const b = createBlitzSequence(12345);
    for (let i = 0; i < 30; i++) {
      expect(a.next()).toEqual(b.next());
    }
  });

  it('produces different sequences for different seeds (overwhelmingly likely)', () => {
    const a = createBlitzSequence(1);
    const b = createBlitzSequence(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('starts within the initial-budget option set and never generates edge collections', () => {
    const seq = createBlitzSequence(999);
    const first = seq.next();
    expect(boardDifficultyRating(first.sizeKey, first.shapeMode)).toBeLessThanOrEqual(BLITZ_INITIAL_BUDGET);
    expect(first.shapeMode).not.toBe('toroidal'); // toroidal always rates above the initial budget
    expect(first.collections).toEqual({ maxCollections: 0, minSize: 2, maxSize: 4 });
  });

  it('eventually unlocks larger/toroidal boards as puzzles accumulate', () => {
    const seq = createBlitzSequence(4242);
    const seen = new Set<string>();
    // Plenty of steps: each step's budget grows by at least the smallest
    // board's edge count, so this comfortably exceeds every size's rating.
    for (let i = 0; i < 500; i++) {
      const id = seq.next();
      seen.add(`${id.sizeKey}::${id.shapeMode}`);
    }
    expect(seen.has('huge::toroidal')).toBe(true);
  });

  it('never produces a puzzle whose rating exceeds the budget available at that step', () => {
    // Reimplements the budget bookkeeping independently to cross-check createBlitzSequence's internal invariant.
    const seq = createBlitzSequence(77);
    let budget = BLITZ_INITIAL_BUDGET;
    for (let i = 0; i < 100; i++) {
      const id = seq.next();
      expect(boardDifficultyRating(id.sizeKey, id.shapeMode)).toBeLessThanOrEqual(budget);
      budget += boardEdgeCount(id.sizeKey);
    }
  });
});
