import { describe, expect, it } from 'vitest';
import {
  customSizeKey,
  generatePuzzle,
  generateSolutionCells,
  generateSolutionEdges,
  LOCKED_EDGE_FRACTION,
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
import { computeWin, createInitialPath, toggleRegion } from './pathEdit';
import { key, NO_EDGE_COLLECTIONS, totalCells, type EdgeCollectionParams } from './puzzle';
import { computeRegions, type EdgeKey } from './regions';

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

describe('locked edges in the puzzle id', () => {
  const base: PuzzleId = { sizeKey: 'mini', shapeMode: 'rect', seed: 5 };

  it('leaves the hash/key untouched when the feature is left off — absent or explicit 0', () => {
    const untouched = puzzleIdKey(base);
    expect(puzzleIdKey({ ...base, lockedEdgeFraction: 0 })).toBe(untouched);
    expect(puzzleSeed({ ...base, lockedEdgeFraction: 0 })).toBe(puzzleSeed(base));
  });

  it('changes the hash/key once the fraction is actually turned on', () => {
    const on = { ...base, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
    expect(puzzleIdKey(on)).not.toBe(puzzleIdKey(base));
    expect(puzzleSeed(on)).not.toBe(puzzleSeed(base));
  });

  it('generatePuzzle attaches no lockedEdges/initialEdges when the fraction is 0/absent', () => {
    const id: PuzzleId = { sizeKey: 'small', shapeMode: 'rect', seed: 1 };
    const puzzle = generatePuzzle(id);
    expect(puzzle.lockedEdges).toBeUndefined();
    expect(puzzle.initialEdges).toBeUndefined();
  });

  it('locks at least the nominal fraction\'s worth of solution edges, plus any edges stranded along the way, each already correctly marked or unmarked', () => {
    const id: PuzzleId = { sizeKey: 'large', shapeMode: 'rect', seed: 1, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
    const puzzle = generatePuzzle(id);
    const solutionEdges = generateSolutionEdges(id);

    expect(puzzle.lockedEdges).toBeDefined();
    // At least the nominal fraction's worth — but can legitimately exceed
    // it: every edge this batch's locks happen to strand (see
    // `applyLockedEdges`'s own doc comment) gets folded into `lockedEdges`
    // too, purely for rendering, not just the ones explicitly chosen as
    // candidates.
    const initialLockCount = Math.floor(solutionEdges.size * LOCKED_EDGE_FRACTION);
    expect(puzzle.lockedEdges!.size).toBeGreaterThanOrEqual(initialLockCount);

    // Every locked edge starts in the state its own role calls for — marked
    // if it's part of the intended solution, unmarked if it's a distractor
    // edge that happened to get swept in as a stranded connector.
    const initialEdges = new Set(puzzle.initialEdges);
    for (const ek of puzzle.lockedEdges!) expect(initialEdges.has(ek)).toBe(solutionEdges.has(ek));
  });

  it('actually exercises stranding on this seed, not just theoretically allowing it — confirming the >= above isn\'t vacuously ==', () => {
    // large/rect/seed=1 (same id as the test above) locks 32 solution edges
    // by nominal count but ends up with 80 total locked edges — 48 extra
    // solution-cycle edges the batch's own toggles happened to strand along
    // the way, plus (in this specific case) one distractor edge stranded
    // unmarked. Pinning the exact numbers here means a future change that
    // accidentally stops folding stranded edges into `lockedEdges` (or
    // starts over-locking) fails loudly, rather than this behavior only
    // being checked by a `>=` bound that a regression could vacuously
    // satisfy by locking nothing extra at all.
    const id: PuzzleId = { sizeKey: 'large', shapeMode: 'rect', seed: 1, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
    const puzzle = generatePuzzle(id);
    const solutionEdges = generateSolutionEdges(id);
    const nominalCount = Math.floor(solutionEdges.size * LOCKED_EDGE_FRACTION);

    expect(nominalCount).toBe(32);
    expect(puzzle.lockedEdges!.size).toBe(80);
    expect(puzzle.lockedEdges!.size).toBeGreaterThan(nominalCount); // the batch really did strand extra edges

    const distractorLocked = [...puzzle.lockedEdges!].filter((ek) => !solutionEdges.has(ek));
    expect(distractorLocked).toHaveLength(1); // a distractor edge, stranded and correctly locked to unmarked
    const initialEdges = new Set(puzzle.initialEdges);
    for (const ek of distractorLocked) expect(initialEdges.has(ek)).toBe(false);
  });

  it('never strands a required (unlocked) solution edge in the wrong mark state — every edge that ends up unreachable, locked or not, is already correctly marked or unmarked', () => {
    // The core correctness guarantee `applyLockedEdges` depends on, and the
    // reason it doesn't need to explicitly re-lock a `strandedEdges` entry
    // (see `edgeLock.ts`'s doc comment): any edge that ends up unreachable
    // as a side effect of locking edge E was, by construction, *already on
    // the boundary of whichever region got toggled to fix E's own mark
    // state* — that's exactly why merging strands it. So the very same
    // toggle that correctly marks E also marks/unmarks every one of its
    // now-stranded siblings correctly, automatically — whether they're
    // other solution edges (need marking) or distractor edges that
    // happened to share the same connector (need to stay unmarked). Checked
    // across every real edge in the graph, not just the ones this puzzle
    // happened to choose as candidates.
    const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];
    for (const shapeMode of shapeModes) {
      for (const seed of [1, 2, 3]) {
        const id: PuzzleId = { sizeKey: 'small', shapeMode, seed, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
        const puzzle = generatePuzzle(id);
        const solutionEdges = generateSolutionEdges(id);
        const regionMap = computeRegions(puzzle);
        const reachable = new Set(regionMap.regions.flatMap((r) => r.boundary));
        const initialEdges = new Set(puzzle.initialEdges);

        const seen = new Set<EdgeKey>();
        for (const [k, neighbors] of puzzle.adj) {
          for (const nk of neighbors) {
            const ek = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
            if (seen.has(ek)) continue;
            seen.add(ek);
            if (puzzle.lockedEdges!.has(ek) || reachable.has(ek)) continue; // formally locked, or still toggleable — not what this test is about
            expect(initialEdges.has(ek)).toBe(solutionEdges.has(ek));
          }
        }
      }
    }
  });

  it('is fully deterministic for the same id', () => {
    const id: PuzzleId = { sizeKey: 'large', shapeMode: 'rect', seed: 1, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
    const a = generatePuzzle(id);
    const b = generatePuzzle(id);
    expect([...a.lockedEdges!].sort()).toEqual([...b.lockedEdges!].sort());
    expect([...a.initialEdges!].sort()).toEqual([...b.initialEdges!].sort());
  });

  it('a locked edge never appears in any region\'s boundary — nothing can toggle it away from its locked state', () => {
    const id: PuzzleId = { sizeKey: 'small', shapeMode: 'rect', seed: 1, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
    const puzzle = generatePuzzle(id);
    const regionMap = computeRegions(puzzle);
    const allBoundary = new Set(regionMap.regions.flatMap((r) => r.boundary));
    for (const ek of puzzle.lockedEdges!) expect(allBoundary.has(ek)).toBe(false);
  });

  it('a locked puzzle is still winnable by marking exactly the intended solution, for every shape mode', () => {
    const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal', 'klein', 'projective'];
    for (const shapeMode of shapeModes) {
      const id: PuzzleId = { sizeKey: 'small', shapeMode, seed: 1, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
      const puzzle = generatePuzzle(id);
      const solutionEdges = generateSolutionEdges(id);
      expect(computeWin(puzzle, solutionEdges)).toBe(true);
    }
  });

  it('the intended solution is actually *reachable* by some real combination of region taps, starting from the locked initial state (not just theoretically valid)', () => {
    // A stronger check than the computeWin check above: computeWin alone
    // doesn't care *how* the marked set was reached, but the whole point of
    // region toggling is that every state has to be reachable through taps
    // alone. Exhaustive over every subset of the puzzle's (small, so this
    // stays fast) toggleable regions — same pattern as `pathEdit.test.ts`'s
    // "toggleRegion reachability" tests.
    const shapeModes: ShapeMode[] = ['rect', 'random', 'toroidal'];
    for (const shapeMode of shapeModes) {
      for (const seed of [1, 2, 3]) {
        const id: PuzzleId = { sizeKey: 'tiny', shapeMode, seed, lockedEdgeFraction: LOCKED_EDGE_FRACTION };
        const puzzle = generatePuzzle(id);
        const solutionEdges = generateSolutionEdges(id);
        const regionMap = computeRegions(puzzle);
        const R = regionMap.regions.length;

        let reachedSolution = false;
        for (let mask = 0; mask < 1 << R && !reachedSolution; mask++) {
          let state = createInitialPath(puzzle);
          for (let i = 0; i < R; i++) {
            if (mask & (1 << i)) state = toggleRegion(puzzle, regionMap, state, i).state;
          }
          if (state.edges.size === solutionEdges.size && [...state.edges].every((ek) => solutionEdges.has(ek))) {
            reachedSolution = true;
          }
        }
        expect(reachedSolution).toBe(true);
      }
    }
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
