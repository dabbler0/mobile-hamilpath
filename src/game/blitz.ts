import type { PathOp } from './pathEdit';
import { NO_EDGE_COLLECTIONS } from './puzzle';
import { SELECTABLE_SHAPE_MODE_OPTIONS, sizeOption, SIZE_OPTIONS, type PuzzleId, type ShapeMode } from './puzzleGen';
import { mulberry32 } from './rng';

/**
 * The two player-facing knobs that define a Blitz run's difficulty — see
 * CLAUDE.md's "Blitz mode" section. Deliberately *not* part of `PuzzleId`
 * generation at all: the sequence of puzzles a run encounters is a pure
 * function of its `seed` alone (`createBlitzSequence`), so two runs with the
 * same seed but different `BlitzParams` play the exact same puzzles in the
 * exact same order, just against a different clock. This is what makes the
 * leaderboard's per-difficulty grouping meaningful — comparing scores across
 * runs with the same params is comparing how players did against the same
 * pacing rules, not against different puzzle sequences.
 */
export interface BlitzParams {
  /** How much time (seconds) the run's clock starts with. */
  startingTimeSec: number;
  /** How many seconds are credited back per edge of a solved puzzle's solution cycle (`totalCells(puzzle)` edges — see `boardEdgeCount`'s doc comment) — i.e. the proportionality constant, not a flat per-puzzle bonus. */
  timeBackPerEdgeSec: number;
}

/** Sane input-range clamps + defaults for the Blitz setup screen's number inputs (mirrors `puzzle.ts`'s `EDGE_COLLECTION_LIMITS` pattern). */
export const BLITZ_PARAM_LIMITS = {
  startingTimeSec: { min: 10, max: 900, default: 60 },
  timeBackPerEdgeSec: { min: 0.05, max: 5, default: 0.3 },
} as const;

/**
 * Per-shape difficulty multiplier applied on top of a board's raw edge count
 * (see `boardDifficultyRating`) — a first-pass balance knob, deliberately
 * factored out into one small table so it's easy to retune later without
 * touching the selection logic itself. A non-rectangular random shape reads
 * as *less* difficult than a rectangle of the same size (its distractor
 * edges are the same, but its irregular outline tends to make the hidden
 * loop more forced/obvious), while a toroidal board reads as *more*
 * difficult (no boundary at all to anchor on, and the wraparound rendering
 * itself takes longer to read). Klein bottle / projective plane are never
 * offered in Blitz (they're disabled from the picker entirely — see
 * CLAUDE.md's "Board shapes and topologies" — but keep an entry here so this
 * table stays total over every `ShapeMode`, matching whichever wraparound
 * multiplier toroidal uses in case they're ever revisited together).
 */
export const SHAPE_DIFFICULTY_MULTIPLIER: Record<ShapeMode, number> = {
  rect: 1,
  random: 0.5,
  toroidal: 2,
  klein: 2,
  projective: 2,
};

/**
 * A board's raw edge count for difficulty purposes: `4 * m * n`, the total
 * number of cells (and so, since a Hamiltonian cycle has exactly one edge
 * per cell, the total number of *solution* edges too) for the given size
 * key. This is identical across every shape mode of the same size — a
 * random shape is "a random connected polyomino of the *same area*" and a
 * toroidal board is generated on the same `m x n` block grid — so it's a
 * property of `sizeKey` alone, computable without generating any actual
 * puzzle graph. `boardDifficultyRating` and the run's time-back award both
 * build on this same number, matching CLAUDE.md's "number of edges in the
 * solution to the solved board" wording exactly.
 */
export function boardEdgeCount(sizeKey: string): number {
  const { m, n } = sizeOption(sizeKey);
  return 4 * m * n;
}

/** A size/shape combination's first-pass difficulty rating: its raw edge count times `SHAPE_DIFFICULTY_MULTIPLIER`. Easy to redefine later (e.g. to also weight distractor density) without touching `eligibleBlitzOptions`/`createBlitzSequence`, which only ever compare ratings, never assume how they're computed. */
export function boardDifficultyRating(sizeKey: string, shapeMode: ShapeMode): number {
  return boardEdgeCount(sizeKey) * SHAPE_DIFFICULTY_MULTIPLIER[shapeMode];
}

/** Every size/shape combination Blitz is willing to ever generate — every declared size, crossed with every *selectable* shape mode (klein/projective stay excluded from Blitz exactly as they are from New Game's picker — see CLAUDE.md's "Board shapes and topologies"). */
const ALL_BLITZ_OPTIONS: ReadonlyArray<{ sizeKey: string; shapeMode: ShapeMode }> = SIZE_OPTIONS.flatMap((size) => SELECTABLE_SHAPE_MODE_OPTIONS.map((shape) => ({ sizeKey: size.key, shapeMode: shape.key })));

/**
 * The difficulty "budget" a fresh run starts with — set to the larger of
 * `tiny`+`rect` and `tiny`+`random`'s own ratings, so both (and only those
 * two, on a freshly-generated `SIZE_OPTIONS`/multiplier table) are eligible
 * from the very first puzzle, matching CLAUDE.md's "The run starts only
 * capable of generating tiny rectangular and tiny random-shape boards".
 * Computed from the table rather than hardcoded, so resizing `tiny` or
 * retuning the multipliers keeps this consistent automatically.
 */
export const BLITZ_INITIAL_BUDGET = Math.max(boardDifficultyRating('tiny', 'rect'), boardDifficultyRating('tiny', 'random'));

/** Every size/shape combination whose rating fits within the current difficulty budget — always non-empty, since the budget only ever grows from `BLITZ_INITIAL_BUDGET` (see `createBlitzSequence`). */
export function eligibleBlitzOptions(budget: number): ReadonlyArray<{ sizeKey: string; shapeMode: ShapeMode }> {
  return ALL_BLITZ_OPTIONS.filter((opt) => boardDifficultyRating(opt.sizeKey, opt.shapeMode) <= budget);
}

/**
 * A live, stepping generator of the puzzle sequence a Blitz run of the given
 * `runSeed` encounters — call `.next()` once per puzzle, in order, starting
 * from the first. Entirely independent of `BlitzParams`: the only state
 * driving each step is the run's own `mulberry32` rng stream plus a running
 * difficulty "budget" that starts at `BLITZ_INITIAL_BUDGET` and grows by
 * `boardEdgeCount(sizeKey)` after every puzzle handed out (not after it's
 * actually *solved* — `boardEdgeCount` only depends on which size was
 * picked, not on anything the player does, so the whole sequence is
 * deterministic and precomputable from `runSeed` alone; live play just
 * happens to reveal it one step at a time). This is what lets two runs
 * sharing a `runSeed` play through the identical sequence of puzzles
 * regardless of their `startingTimeSec`/`timeBackPerEdgeSec` — see
 * `BlitzParams`'s doc comment — and what lets a stored run's `events` (each
 * `puzzleStart` recording its own resolved `sizeKey`/`shapeMode`/`seed`
 * explicitly, see `BlitzEvent`) be replayed without needing to re-run this
 * generator at all.
 */
export function createBlitzSequence(runSeed: number): { next(): PuzzleId } {
  const rng = mulberry32(runSeed);
  let budget = BLITZ_INITIAL_BUDGET;
  return {
    next(): PuzzleId {
      const eligible = eligibleBlitzOptions(budget);
      const choice = eligible[Math.floor(rng() * eligible.length)];
      const seed = Math.floor(rng() * 0x100000000);
      budget += boardEdgeCount(choice.sizeKey);
      return { sizeKey: choice.sizeKey, shapeMode: choice.shapeMode, seed, collections: NO_EDGE_COLLECTIONS };
    },
  };
}

/**
 * The chronological, append-only recording of one Blitz run, timestamped by
 * `t` (milliseconds elapsed since the run's own start, i.e. since its first
 * `puzzleStart`) rather than a frame/step counter — the same reasoning as
 * `history.ts`'s `MoveLogEntry`, except a Blitz run's replay needs to
 * reproduce *pacing* (how long the player actually spent on each puzzle),
 * not just an ordered sequence of states, hence real timestamps instead of
 * "one entry per frame". `main.ts`'s live-play recorder appends one of these
 * per meaningful event; `blitzReplay.ts` (or `main.ts`'s own replay
 * machinery — see CLAUDE.md) walks the same log back in `t` order to
 * reconstruct the run's state at any point, live or scrubbed.
 *
 * `puzzleStart` carries its own resolved `sizeKey`/`shapeMode`/`seed`
 * (rather than just an index into `createBlitzSequence`'s output) so replay
 * never needs to re-run the sequence generator — it just regenerates that
 * exact `PuzzleId` via `generatePuzzle`, exactly like the ordinary
 * Replays/review feature already does for a single puzzle. `move` reuses
 * `PathOp` verbatim, same compact shape `history.ts` already uses. There is
 * no `jump`/undo entry: Blitz play has no Undo/Redo (see CLAUDE.md), so
 * every state transition within a puzzle is a real forward move.
 */
export type BlitzEvent =
  | { kind: 'puzzleStart'; t: number; sizeKey: string; shapeMode: ShapeMode; seed: number }
  | { kind: 'move'; t: number; ops: PathOp[] }
  | { kind: 'puzzleSolved'; t: number; timeAwardedMs: number }
  | { kind: 'runEnd'; t: number; scoreMs: number };
