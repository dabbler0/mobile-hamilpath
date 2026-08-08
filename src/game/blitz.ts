import type { PathOp } from './pathEdit';
import { NO_EDGE_COLLECTIONS } from './puzzle';
import { customSizeKey, sizeOption, SELECTABLE_SHAPE_MODE_OPTIONS, SIZE_OPTIONS, type PuzzleId, type ShapeMode } from './puzzleGen';
import { mulberry32, type Rng } from './rng';

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
  /** How many seconds are credited back per edge of a puzzle's own solution cycle (`totalCells(puzzle)` edges — see `boardEdgeCount`'s doc comment) — i.e. the proportionality constant, not a flat per-puzzle bonus. Credited the instant that puzzle *starts*, not when it's solved — see `BlitzEvent`'s `puzzleStart.timeAwardedMs`. */
  timeBackPerEdgeSec: number;
}

/**
 * The three player-facing "pace" presets, replacing the old free-form
 * starting-time/time-back number inputs — see CLAUDE.md's "Blitz mode".
 * `BLITZ_PACE_PARAMS` is the one place these numbers are defined; every
 * other pace-aware piece of code (the setup screen, the leaderboard's
 * headings) reads through this table rather than hardcoding the numbers
 * again. `'normal'` is the default.
 */
export type BlitzPace = 'slow' | 'normal' | 'fast';

export const DEFAULT_BLITZ_PACE: BlitzPace = 'normal';

export const BLITZ_PACE_PARAMS: Record<BlitzPace, BlitzParams> = {
  slow: { startingTimeSec: 90, timeBackPerEdgeSec: 0.2 },
  normal: { startingTimeSec: 60, timeBackPerEdgeSec: 0.15 },
  fast: { startingTimeSec: 45, timeBackPerEdgeSec: 0.1 },
};

export const BLITZ_PACE_OPTIONS: ReadonlyArray<{ key: BlitzPace; label: string }> = [
  { key: 'slow', label: 'Slow' },
  { key: 'normal', label: 'Normal' },
  { key: 'fast', label: 'Fast' },
];

/**
 * The pace preset a given `BlitzParams` exactly matches, or `null` if it
 * doesn't match any current preset — which happens for a run recorded before
 * the pace presets existed (or, in principle, if the presets are retuned
 * later). Leaderboard display (`formatBlitzParamsLabel` in `main.ts`) falls
 * back to the raw numbers in that case rather than crashing or mislabeling.
 */
export function paceForParams(params: BlitzParams): BlitzPace | null {
  for (const opt of BLITZ_PACE_OPTIONS) {
    const preset = BLITZ_PACE_PARAMS[opt.key];
    if (preset.startingTimeSec === params.startingTimeSec && preset.timeBackPerEdgeSec === params.timeBackPerEdgeSec) return opt.key;
  }
  return null;
}

/**
 * Per-shape difficulty multiplier applied on top of a board's raw edge count
 * (see `boardDifficultyRating`) — a first-pass balance knob, deliberately
 * factored out into one small table so it's easy to retune later without
 * touching the selection logic itself. A non-rectangular random shape reads
 * as *less* difficult than a rectangle of the same size (its distractor
 * edges are the same, but its irregular outline tends to make the hidden
 * loop more forced/obvious), while a toroidal board reads as *more*
 * difficult (no boundary at all to anchor on, and the wraparound rendering
 * itself takes longer to read). `random`'s 0.75x and `toroidal`'s 1.5x are
 * deliberately closer to 1x than they used to be (0.5x/2x) — both shapes
 * were previously locked out for much longer than felt warranted once
 * boards started varying continuously in size (see `chooseBlitzBoard`)
 * rather than jumping between a handful of fixed sizes. Klein bottle /
 * projective plane get a nominal entry too (matching toroidal's multiplier)
 * purely so the table stays total over every `ShapeMode`, even though Blitz
 * never actually offers them (see "Board shapes and topologies" above —
 * same picker restriction as New Game).
 */
export const SHAPE_DIFFICULTY_MULTIPLIER: Record<ShapeMode, number> = {
  rect: 1,
  random: 0.75,
  toroidal: 1.5,
  klein: 1.5,
  projective: 1.5,
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
 * solution to the solved board" wording exactly. Works for both a
 * `SIZE_OPTIONS` key and a Blitz-only `customSizeKey` (see `sizeOption`).
 */
export function boardEdgeCount(sizeKey: string): number {
  const { m, n } = sizeOption(sizeKey);
  return 4 * m * n;
}

/** A size/shape combination's first-pass difficulty rating: its raw edge count times `SHAPE_DIFFICULTY_MULTIPLIER`. Easy to redefine later (e.g. to also weight distractor density) without touching `chooseBlitzBoard`/`createBlitzSequence`, which only ever compare ratings, never assume how they're computed. */
export function boardDifficultyRating(sizeKey: string, shapeMode: ShapeMode): number {
  return boardEdgeCount(sizeKey) * SHAPE_DIFFICULTY_MULTIPLIER[shapeMode];
}

/** Every selectable shape mode Blitz is willing to ever generate — klein/projective stay excluded exactly as they are from New Game's picker (see CLAUDE.md's "Board shapes and topologies"). */
const SELECTABLE_BLITZ_SHAPES: readonly ShapeMode[] = SELECTABLE_SHAPE_MODE_OPTIONS.map((o) => o.key);

/**
 * Smallest board Blitz will ever generate, in blocks per dimension — small
 * enough that even a fresh run's modest initial budget still has real size
 * variety to roll (see `chooseBlitzBoard`), never smaller than a board can
 * meaningfully be (a 1-block-wide board has no real "shape" to speak of).
 */
const MIN_BLITZ_BLOCK_DIM = 2;
const MIN_BLITZ_BOARD_AREA = MIN_BLITZ_BLOCK_DIM * MIN_BLITZ_BLOCK_DIM;

/** A shape mode's own cheapest possible rating — even the smallest board Blitz ever generates (`MIN_BLITZ_BOARD_AREA` blocks) still costs this much of the difficulty budget. `eligibleBlitzShapes` gates on this instead of any one fixed size, now that board size is chosen continuously rather than looked up from a table. */
function minBlitzRating(shapeMode: ShapeMode): number {
  return 4 * MIN_BLITZ_BOARD_AREA * SHAPE_DIFFICULTY_MULTIPLIER[shapeMode];
}

/**
 * One "unit" of difficulty budget — the larger of a `tiny`-sized (3x4, the
 * smallest of the former fixed `SIZE_OPTIONS`) rectangle's and random-shape's
 * own ratings. This is the nominal difficulty step both the starting budget
 * and the per-puzzle budget growth are defined in terms of (see
 * `BLITZ_INITIAL_BUDGET`/`BLITZ_BUDGET_INCREMENT` and `createBlitzSequence`
 * below). Computed from the table rather than hardcoded, so retuning the
 * multipliers keeps both consistent automatically.
 */
const BLITZ_BUDGET_UNIT = Math.max(boardDifficultyRating('tiny', 'rect'), boardDifficultyRating('tiny', 'random'));

/**
 * The amount the difficulty budget grows by after *every* puzzle handed out,
 * regardless of that puzzle's own size — a flat, constant step (one
 * `BLITZ_BUDGET_UNIT`) rather than being proportional to the puzzle's edge
 * count (as it used to be; see git history). Proportional growth compounded:
 * a bigger puzzle grew the budget more, which made the *next* puzzle likely
 * bigger still, racing the run's difficulty upward far faster than felt
 * fair. A constant step keeps difficulty climbing at a steady, predictable
 * pace regardless of how large any single puzzle in the sequence happened to
 * be.
 */
export const BLITZ_BUDGET_INCREMENT = BLITZ_BUDGET_UNIT;

/**
 * The difficulty "budget" a fresh run starts with — twice `BLITZ_BUDGET_UNIT`
 * (i.e. twice `BLITZ_BUDGET_INCREMENT`), so a run opens noticeably harder
 * than its very first puzzle would otherwise be (this used to be exactly one
 * unit; doubled so the opening puzzle already has some real size/shape
 * variety to roll rather than starting right at the cheapest possible
 * board).
 */
export const BLITZ_INITIAL_BUDGET = BLITZ_BUDGET_UNIT * 2;

/** Every shape mode whose cheapest possible board still fits within the current difficulty budget — the continuous-size analogue of the old fixed-size-table `eligibleBlitzOptions`, gating only on shape now that dimensions are chosen separately (see `chooseBlitzBoard`). Always non-empty: the budget only ever grows from `BLITZ_INITIAL_BUDGET`, which already clears every shape's minimum rating. */
export function eligibleBlitzShapes(budget: number): readonly ShapeMode[] {
  return SELECTABLE_BLITZ_SHAPES.filter((shape) => minBlitzRating(shape) <= budget);
}

/**
 * The widest-to-narrowest ratio a Blitz board is ever generated at — random
 * per puzzle (see `chooseBlitzBoard`) but capped so a board is never a more
 * elongated rectangle than the least-square of the (now-removed as a
 * player-facing concept, but still declared for Free Play) fixed
 * `SIZE_OPTIONS` ever was; `large` (10x16, ratio 1.6) is that least-square
 * entry. `MIN_ASPECT_RATIO` (a perfect square) is the other end — "at least
 * as square as the current aspect ratios" per this feature's spec, i.e.
 * from fully square up to that same historical max, never beyond it.
 * `chooseBlitzBoard` enforces this cap directly on the final `long`/`short`
 * pair (not just on the continuous ratio it started from), since rounding
 * `short` *down* to an integer would otherwise silently push the realized
 * ratio above the target — dividing `targetArea` by a smaller-than-intended
 * `short` always yields a larger `long`.
 */
const MIN_ASPECT_RATIO = 1;
const MAX_ASPECT_RATIO = Math.max(...SIZE_OPTIONS.map((s) => Math.max(s.m, s.n) / Math.min(s.m, s.n)));

/**
 * Largest board area (in blocks, `m * n`) Blitz will ever generate — matches
 * the old fixed `huge` size (14x20 = 280 blocks). Without a ceiling, the
 * difficulty budget still grows without bound over a long enough run (it now
 * climbs by a flat `BLITZ_BUDGET_INCREMENT` per puzzle rather than
 * compounding off each puzzle's own size — see `createBlitzSequence` — but
 * "without bound" either way), eventually reaching boards too large to be
 * playable or even to generate in reasonable time. Capping the area a board
 * can ever reach is exactly what the old fixed-size table did implicitly
 * (`huge` was simply the largest entry) — this reproduces that same ceiling
 * now that size is chosen continuously rather than looked up, while
 * everything below it still varies freely with the budget as before.
 */
const MAX_BLITZ_BOARD_AREA = 14 * 20;

/**
 * Picks a board's shape and block dimensions for the current difficulty
 * budget — the continuous-size replacement for the old fixed-size-table
 * lookup (see CLAUDE.md's "Blitz mode"). Shape is chosen uniformly among
 * whatever's affordable at all (`eligibleBlitzShapes`); a random target
 * difficulty *for that shape* is then rolled somewhere between its own
 * cheapest possible board and the full budget ("choose a random difficulty
 * up to the present budget"), capped at `MAX_BLITZ_BOARD_AREA` so an
 * extremely large budget still tops out at a sane board size — which sets
 * the board's area. A random aspect ratio (`MIN_ASPECT_RATIO`..
 * `MAX_ASPECT_RATIO`) splits that area into concrete `m`/`n` block
 * dimensions: `short` is rounded (never floored, which would silently widen
 * the realized ratio — see `MAX_ASPECT_RATIO`'s doc comment) to the nearest
 * integer, `long` is floored down from the area so the resulting board's
 * actual rating never exceeds the rolled target — and so never exceeds
 * `budget` either — and then explicitly re-clamped to the aspect-ratio cap
 * in case rounding still pushed it over. Which of the two dimensions ends
 * up wider is randomly swapped, so boards aren't always elongated in the
 * same direction.
 */
export function chooseBlitzBoard(rng: Rng, budget: number): { shapeMode: ShapeMode; m: number; n: number } {
  const eligible = eligibleBlitzShapes(budget);
  const shapeMode = eligible[Math.floor(rng() * eligible.length)];
  const multiplier = SHAPE_DIFFICULTY_MULTIPLIER[shapeMode];
  const minRating = minBlitzRating(shapeMode);
  const targetRating = minRating + rng() * Math.max(0, budget - minRating);
  const targetArea = Math.min(MAX_BLITZ_BOARD_AREA, targetRating / (4 * multiplier));
  const ratio = MIN_ASPECT_RATIO + rng() * (MAX_ASPECT_RATIO - MIN_ASPECT_RATIO);
  const short = Math.max(MIN_BLITZ_BLOCK_DIM, Math.round(Math.sqrt(targetArea / ratio)));
  let long = Math.max(MIN_BLITZ_BLOCK_DIM, Math.floor(targetArea / short));
  long = Math.min(long, Math.floor(short * MAX_ASPECT_RATIO));
  const [m, n] = rng() < 0.5 ? [short, long] : [long, short];
  return { shapeMode, m, n };
}

/**
 * A live, stepping generator of the puzzle sequence a Blitz run of the given
 * `runSeed` encounters — call `.next()` once per puzzle, in order, starting
 * from the first. Entirely independent of `BlitzParams`: the only state
 * driving each step is the run's own `mulberry32` rng stream plus a running
 * difficulty "budget" that starts at `BLITZ_INITIAL_BUDGET` and grows by the
 * flat `BLITZ_BUDGET_INCREMENT` after every puzzle handed out (not after
 * it's actually *solved*, and — unlike an earlier version of this function —
 * not scaled by that puzzle's own edge count either; the increment is the
 * same regardless of which board `chooseBlitzBoard` picked, so the whole
 * sequence is deterministic and precomputable from `runSeed` alone; live
 * play just happens to reveal it one step at a time). This is what lets two
 * runs sharing a `runSeed` play through the identical sequence of puzzles
 * regardless of their `BlitzParams` — see `BlitzParams`'s doc comment — and
 * what lets a stored run's `events` (each `puzzleStart` recording its own
 * resolved `sizeKey`/`shapeMode`/`seed` explicitly, see `BlitzEvent`) be
 * replayed without needing to re-run this generator at all. Each puzzle's
 * dimensions are encoded into a synthetic `sizeKey` via `customSizeKey` (see
 * its doc comment) rather than needing a second, parallel dimensions field
 * on `PuzzleId`.
 */
export function createBlitzSequence(runSeed: number): { next(): PuzzleId } {
  const rng = mulberry32(runSeed);
  let budget = BLITZ_INITIAL_BUDGET;
  return {
    next(): PuzzleId {
      const { shapeMode, m, n } = chooseBlitzBoard(rng, budget);
      const seed = Math.floor(rng() * 0x100000000);
      budget += BLITZ_BUDGET_INCREMENT;
      return { sizeKey: customSizeKey(m, n), shapeMode, seed, collections: NO_EDGE_COLLECTIONS };
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
 * Replays/review feature already does for a single puzzle. It also carries
 * `timeAwardedMs`: the time-back bonus for *that* puzzle (proportional to
 * its own edge count, `timeBackPerEdgeSec * 1000 * totalCells(puzzle)`) is
 * credited to the clock the instant the puzzle appears, not when it's
 * solved — so `puzzleStart` is where the award lives now, and applying it
 * (live or in replay) means crediting the clock right away, before a single
 * move has been made on that puzzle. `move` reuses `PathOp` verbatim, same
 * compact shape `history.ts` already uses. There is no `jump`/undo entry:
 * Blitz play has no Undo/Redo (see CLAUDE.md), so every state transition
 * within a puzzle is a real forward move. `puzzleSolved` no longer carries
 * an award — solving a puzzle doesn't move the clock at all any more, it
 * only ever unblocks the next `puzzleStart`.
 */
export type BlitzEvent =
  | { kind: 'puzzleStart'; t: number; sizeKey: string; shapeMode: ShapeMode; seed: number; timeAwardedMs: number }
  | { kind: 'move'; t: number; ops: PathOp[] }
  | { kind: 'puzzleSolved'; t: number }
  | { kind: 'runEnd'; t: number; scoreMs: number };
