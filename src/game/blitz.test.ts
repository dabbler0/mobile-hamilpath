import { describe, expect, it } from 'vitest';
import {
  BLITZ_BUDGET_INCREMENT,
  BLITZ_INITIAL_BUDGET,
  BLITZ_PACE_OPTIONS,
  BLITZ_PACE_PARAMS,
  boardDifficultyRating,
  boardEdgeCount,
  chooseBlitzBoard,
  createBlitzSequence,
  DEFAULT_BLITZ_PACE,
  eligibleBlitzOptions,
  LOCKED_EDGE_DIFFICULTY_MULTIPLIER,
  paceForParams,
  SHAPE_DIFFICULTY_MULTIPLIER,
} from './blitz';
import { mulberry32 } from './rng';
import { totalCells } from './puzzle';
import { generatePuzzle, LOCKED_EDGE_FRACTION, sizeOption, SIZE_OPTIONS, type ShapeMode } from './puzzleGen';

describe('BLITZ_PACE_PARAMS', () => {
  it('matches the three specified pace presets exactly', () => {
    expect(BLITZ_PACE_PARAMS.slow).toEqual({ startingTimeSec: 90, timeBackPerEdgeSec: 0.2 });
    expect(BLITZ_PACE_PARAMS.normal).toEqual({ startingTimeSec: 60, timeBackPerEdgeSec: 0.15 });
    expect(BLITZ_PACE_PARAMS.fast).toEqual({ startingTimeSec: 45, timeBackPerEdgeSec: 0.1 });
  });

  it('defaults to normal', () => {
    expect(DEFAULT_BLITZ_PACE).toBe('normal');
  });

  it('lists all three presets, matching BLITZ_PACE_PARAMS', () => {
    const keys = BLITZ_PACE_OPTIONS.map((o) => o.key).sort();
    expect(keys).toEqual(['fast', 'normal', 'slow']);
  });
});

describe('paceForParams', () => {
  it('resolves every preset back to its own key', () => {
    for (const opt of BLITZ_PACE_OPTIONS) {
      expect(paceForParams(BLITZ_PACE_PARAMS[opt.key])).toBe(opt.key);
    }
  });

  it('returns null for params that match no current preset', () => {
    expect(paceForParams({ startingTimeSec: 60, timeBackPerEdgeSec: 0.3 })).toBeNull();
  });
});

describe('customSizeKey / sizeOption round trip (Blitz\'s continuously-sized boards)', () => {
  it('resolves a synthetic custom size key back to its own m/n', () => {
    expect(sizeOption('custom:5x7')).toEqual({ key: 'custom:5x7', label: '5×7', m: 5, n: 7 });
  });
});

describe('boardEdgeCount', () => {
  it('matches 4 * m * n for every declared size', () => {
    for (const size of SIZE_OPTIONS) {
      expect(boardEdgeCount(size.key)).toBe(4 * size.m * size.n);
    }
  });

  it('works for a synthetic custom size key too (Blitz\'s continuously-sized boards)', () => {
    expect(boardEdgeCount('custom:5x7')).toBe(4 * 5 * 7);
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

  it('rates a random-shape board as 0.75x as difficult, and a toroidal one as 1.5x as difficult, as the same-size rectangle', () => {
    const rating = (shapeMode: ShapeMode) => boardDifficultyRating('small', shapeMode);
    expect(rating('random')).toBeCloseTo(rating('rect') * 0.75);
    expect(rating('toroidal')).toBeCloseTo(rating('rect') * 1.5);
  });
});

describe('eligibleBlitzOptions', () => {
  it('at the initial budget, allows every selectable shape (rect/random/toroidal), locked and unlocked alike', () => {
    const eligible = eligibleBlitzOptions(BLITZ_INITIAL_BUDGET);
    const shapes = [...new Set(eligible.map((o) => o.shapeMode))];
    expect(shapes.sort()).toEqual(['random', 'rect', 'toroidal']);
    for (const shapeMode of shapes) {
      expect(eligible).toContainEqual({ shapeMode, hasLockedEdges: false });
      expect(eligible).toContainEqual({ shapeMode, hasLockedEdges: true });
    }
  });

  it('never offers klein or projective (matching the New Game picker restriction)', () => {
    const eligible = eligibleBlitzOptions(Number.MAX_SAFE_INTEGER);
    const shapes = eligible.map((o) => o.shapeMode);
    expect(shapes).not.toContain('klein');
    expect(shapes).not.toContain('projective');
  });

  it('a locked variant is never *more* expensive than its unlocked counterpart, so it never lags it into eligibility', () => {
    for (let budget = 0; budget <= BLITZ_INITIAL_BUDGET; budget += 5) {
      const eligible = eligibleBlitzOptions(budget);
      for (const shapeMode of ['rect', 'random', 'toroidal'] as const) {
        const unlockedEligible = eligible.some((o) => o.shapeMode === shapeMode && !o.hasLockedEdges);
        const lockedEligible = eligible.some((o) => o.shapeMode === shapeMode && o.hasLockedEdges);
        if (unlockedEligible) expect(lockedEligible).toBe(true);
      }
    }
  });

  it('grows monotonically: a strictly larger budget never loses an option that was already eligible', () => {
    const small = eligibleBlitzOptions(4);
    const big = eligibleBlitzOptions(BLITZ_INITIAL_BUDGET);
    for (const opt of small) expect(big).toContainEqual(opt);
  });

  it('is empty for a budget below every combination\'s cheapest possible rating', () => {
    expect(eligibleBlitzOptions(0)).toEqual([]);
  });
});

describe('chooseBlitzBoard', () => {
  it('never picks a board whose (shape- and lock-adjusted) rating exceeds the given budget', () => {
    const rng = mulberry32(456);
    for (let i = 0; i < 500; i++) {
      const budget = BLITZ_INITIAL_BUDGET + i * 11;
      const { shapeMode, m, n, lockedEdgeFraction } = chooseBlitzBoard(rng, budget);
      const rating = 4 * m * n * SHAPE_DIFFICULTY_MULTIPLIER[shapeMode] * (lockedEdgeFraction !== undefined ? LOCKED_EDGE_DIFFICULTY_MULTIPLIER : 1);
      expect(rating).toBeLessThanOrEqual(budget);
    }
  });

  it('always produces dimensions of at least 2x2', () => {
    const rng = mulberry32(789);
    for (let i = 0; i < 300; i++) {
      const { m, n } = chooseBlitzBoard(rng, BLITZ_INITIAL_BUDGET);
      expect(m).toBeGreaterThanOrEqual(2);
      expect(n).toBeGreaterThanOrEqual(2);
    }
  });

  it('never produces an aspect ratio more elongated than the least-square of the old fixed sizes (large, 1.6)', () => {
    const rng = mulberry32(321);
    const maxLegacyRatio = Math.max(...SIZE_OPTIONS.map((s) => Math.max(s.m, s.n) / Math.min(s.m, s.n)));
    for (let i = 0; i < 500; i++) {
      const budget = BLITZ_INITIAL_BUDGET * 5;
      const { m, n } = chooseBlitzBoard(rng, budget);
      const ratio = Math.max(m, n) / Math.min(m, n);
      expect(ratio).toBeLessThanOrEqual(maxLegacyRatio + 1e-9);
    }
  });

  it('produces a genuine variety of areas at a fixed budget, not just the same size every time', () => {
    const rng = mulberry32(654);
    const areas = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const { m, n } = chooseBlitzBoard(rng, BLITZ_INITIAL_BUDGET * 3);
      areas.add(m * n);
    }
    expect(areas.size).toBeGreaterThan(5);
  });

  it('never offers klein or projective', () => {
    const rng = mulberry32(111);
    for (let i = 0; i < 200; i++) {
      const { shapeMode } = chooseBlitzBoard(rng, BLITZ_INITIAL_BUDGET * 4);
      expect(shapeMode).not.toBe('klein');
      expect(shapeMode).not.toBe('projective');
    }
  });

  it('produces both locked and unlocked boards at a comfortably high budget, roughly half the time each', () => {
    const rng = mulberry32(999);
    const n = 400;
    let locked = 0;
    for (let i = 0; i < n; i++) {
      const { lockedEdgeFraction } = chooseBlitzBoard(rng, BLITZ_INITIAL_BUDGET * 6);
      if (lockedEdgeFraction !== undefined) locked++;
    }
    expect(locked / n).toBeGreaterThan(0.35);
    expect(locked / n).toBeLessThan(0.65);
  });

  it('a locked board\'s lockedEdgeFraction is always exactly LOCKED_EDGE_FRACTION', () => {
    const rng = mulberry32(222);
    let sawLocked = false;
    for (let i = 0; i < 200; i++) {
      const { lockedEdgeFraction } = chooseBlitzBoard(rng, BLITZ_INITIAL_BUDGET * 3);
      if (lockedEdgeFraction !== undefined) {
        expect(lockedEdgeFraction).toBe(LOCKED_EDGE_FRACTION);
        sawLocked = true;
      }
    }
    expect(sawLocked).toBe(true);
  });
});

describe('LOCKED_EDGE_DIFFICULTY_MULTIPLIER', () => {
  it('is 0.9 — a locked board rates 90% as difficult as the same board unlocked', () => {
    expect(LOCKED_EDGE_DIFFICULTY_MULTIPLIER).toBe(0.9);
  });

  it('scales boardDifficultyRating multiplicatively on top of the shape multiplier', () => {
    for (const shapeMode of ['rect', 'random', 'toroidal'] as const) {
      const unlocked = boardDifficultyRating('small', shapeMode);
      const locked = boardDifficultyRating('small', shapeMode, true);
      expect(locked).toBeCloseTo(unlocked * LOCKED_EDGE_DIFFICULTY_MULTIPLIER);
    }
  });

  it('a locked toroidal board rates 90% of 150% (135%) of the same-size unlocked rectangle, per CLAUDE.md\'s spec', () => {
    const rect = boardDifficultyRating('small', 'rect');
    const lockedToroidal = boardDifficultyRating('small', 'toroidal', true);
    expect(lockedToroidal).toBeCloseTo(rect * 1.5 * 0.9);
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

  it('starts within the initial budget and never generates edge collections', () => {
    const seq = createBlitzSequence(999);
    const first = seq.next();
    expect(boardDifficultyRating(first.sizeKey, first.shapeMode, Boolean(first.lockedEdgeFraction))).toBeLessThanOrEqual(BLITZ_INITIAL_BUDGET);
    expect(first.collections).toEqual({ maxCollections: 0, minSize: 2, maxSize: 4 });
  });

  it('produces puzzles whose declared dimensions actually generate (custom size keys resolve correctly)', () => {
    const seq = createBlitzSequence(2024);
    for (let i = 0; i < 20; i++) {
      const id = seq.next();
      const puzzle = generatePuzzle(id);
      // `random` shape's Eden-growth construction can very occasionally push
      // the actual block count slightly above m*n (see shape.ts's
      // `randomShape` doc comment) — every other shape mode matches exactly.
      if (id.shapeMode === 'random') {
        expect(totalCells(puzzle)).toBeGreaterThanOrEqual(boardEdgeCount(id.sizeKey));
      } else {
        expect(totalCells(puzzle)).toBe(boardEdgeCount(id.sizeKey));
      }
    }
  });

  it('board sizes grow on average as the run progresses', () => {
    const seq = createBlitzSequence(4242);
    const early: number[] = [];
    const late: number[] = [];
    for (let i = 0; i < 300; i++) {
      const id = seq.next();
      const edges = boardEdgeCount(id.sizeKey);
      if (i < 20) early.push(edges);
      if (i >= 280) late.push(edges);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(late)).toBeGreaterThan(avg(early));
  });

  it('never produces a puzzle whose rating exceeds the budget available at that step, growing the budget by a flat BLITZ_BUDGET_INCREMENT each time (not proportionally to that puzzle\'s own edge count)', () => {
    // Reimplements the budget bookkeeping independently to cross-check createBlitzSequence's internal invariant.
    // If the real generator instead grew the budget proportionally to each
    // puzzle's own size (as it used to), this recomputed `budget` would
    // eventually diverge from the generator's own and this assertion would
    // start failing once puzzles grow large enough.
    const seq = createBlitzSequence(77);
    let budget = BLITZ_INITIAL_BUDGET;
    for (let i = 0; i < 200; i++) {
      const id = seq.next();
      expect(boardDifficultyRating(id.sizeKey, id.shapeMode, Boolean(id.lockedEdgeFraction))).toBeLessThanOrEqual(budget);
      budget += BLITZ_BUDGET_INCREMENT;
    }
  });

  it('produces both locked and unlocked puzzles over a long run, every locked one at exactly LOCKED_EDGE_FRACTION', () => {
    const seq = createBlitzSequence(77);
    let sawLocked = false;
    let sawUnlocked = false;
    for (let i = 0; i < 300; i++) {
      const id = seq.next();
      if (id.lockedEdgeFraction !== undefined) {
        expect(id.lockedEdgeFraction).toBe(LOCKED_EDGE_FRACTION);
        sawLocked = true;
      } else {
        sawUnlocked = true;
      }
    }
    expect(sawLocked).toBe(true);
    expect(sawUnlocked).toBe(true);
  });

  it('locks roughly half of puzzles once the budget comfortably clears every (shape, lock) combination\'s minimum rating', () => {
    const seq = createBlitzSequence(4321);
    // Burn through enough puzzles that the budget grows well past the point
    // every shape's locked *and* unlocked variant is eligible (see
    // `eligibleBlitzOptions`) before sampling.
    for (let i = 0; i < 60; i++) seq.next();
    const n = 300;
    let locked = 0;
    for (let i = 0; i < n; i++) {
      if (seq.next().lockedEdgeFraction !== undefined) locked++;
    }
    expect(locked / n).toBeGreaterThan(0.35);
    expect(locked / n).toBeLessThan(0.65);
  });
});
