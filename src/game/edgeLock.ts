import { computeWin, toggleRegion, type PathState } from './pathEdit';
import type { Puzzle } from './puzzle';
import { lockEdgeInRegionMap, regionsForEdge, type EdgeKey, type RegionMap } from './regions';

export interface LockEdgeResult {
  puzzle: Puzzle;
  regionMap: RegionMap;
  state: PathState;
  /**
   * Every edge that just became interior to a merged region (see
   * `regions.ts`'s `lockEdgeInRegionMap`) as a side effect of locking
   * `edge` — reported for informational/verification purposes, not
   * something every caller necessarily needs to act on: whenever step 1 of
   * this function's own doc comment actually performs a toggle, a stranded
   * edge was, by construction, on that same toggled region's boundary, so
   * it gets flipped by the very same toggle too — whether that lands it in
   * the *correct* final state depends on what state it was already in
   * beforehand, which this function has no way to know for an edge other
   * than the one it was actually asked to lock. `puzzleGen.ts`'s
   * `applyLockedEdges` doesn't read this field at all; its own doc comment
   * explains the specific structural reason its batch-of-solution-edges
   * usage never needs to (verified by `puzzleGen.test.ts`'s "never strands
   * a required solution edge" test) — that reasoning is particular to
   * *that* usage pattern (virgin, from-empty-state, solution-edges-to-
   * marked locking), not a general guarantee of `lockEdge` itself, so a
   * different future caller (e.g. a live hint applied to an
   * already-partially-solved board) should check this rather than assume
   * the same thing holds for it. Always empty unless this lock happened to
   * merge two distinct regions that shared more than one real edge between
   * them.
   */
  strandedEdges: EdgeKey[];
}

/**
 * Locks `edge` into `puzzle`: the general-purpose "lock an edge" capability
 * this module exists for, usable both at generation time (see
 * `puzzleGen.ts`'s `PuzzleId.lockedEdgeFraction`) and — eventually — as a
 * live in-game hint. Per its own definition:
 *
 * 1. If `edge`'s current marked state in `state` doesn't already match
 *    `markedInSolution`, toggle one of its two neighboring regions (see
 *    `regionsForEdge`) — the same `toggleRegion` a tap or keypress would
 *    perform, since a single edge can't be flipped any other way in this
 *    game. This necessarily flips `edge` itself into the right state,
 *    along with whatever else that region's boundary happens to include —
 *    when `edge` borders two different regions, the *smaller* of the two
 *    (fewer boundary edges) is toggled, to keep that collateral flipping as
 *    small as possible; a real puzzle's regions vary hugely in size (a
 *    large board can have some regions boundaried by dozens of edges), so
 *    this matters for keeping a "lock a few edges" hint from incidentally
 *    pre-marking a much bigger chunk of the board than intended.
 *    `regionsForEdge`'s doc comment covers the one-region case (the true
 *    board edge). If `edge` isn't on *any* region's boundary at all — it's
 *    a `strandedEdges` entry from an earlier lock, already excluded from
 *    every boundary without ever having been locked itself (see
 *    `lockEdgeInRegionMap`'s doc comment) — there's no region left to
 *    toggle through, so its marked state is set directly instead; safe
 *    precisely because nothing else can ever touch it either, before or
 *    after this call.
 * 2. Add `edge` to `puzzle.lockedEdges` and update `regionMap` to match
 *    (`lockEdgeInRegionMap` — an incremental update, not a full
 *    `computeRegions` recompute, since this runs once per locked edge and a
 *    full board recompute on every one of them is measurably slow on a big
 *    board; see that function's own doc comment) — from this point on,
 *    `edge`'s two neighboring faces are permanently merged into one region
 *    and `edge` itself never appears in any region's boundary again (see
 *    `regions.ts`'s `isLocked`), so nothing going through `toggleRegion` can
 *    ever flip it a second time. Any *other* edge this merge stranded is
 *    reported back via `strandedEdges` (see its own doc comment) — it was
 *    touched by step 1's toggle too, so it may already be in whatever state
 *    a caller wants it in, but that's not guaranteed in general.
 *
 * None of `puzzle`/`regionMap`/`state` are mutated in place — a fresh
 * `puzzle`/`regionMap`/`state` is returned, matching every other edit
 * function in this codebase (`applyPathOp` et al).
 *
 * Throws if `edge` is already locked (`puzzle.lockedEdges.has(edge)`) — a
 * caller error, not something a batch lock loop should ever hit as long as
 * it never re-enqueues an edge it's already processed.
 */
export function lockEdge(puzzle: Puzzle, regionMap: RegionMap, state: PathState, edge: EdgeKey, markedInSolution: boolean): LockEdgeResult {
  if (puzzle.lockedEdges?.has(edge)) {
    throw new Error(`lockEdge: edge ${edge} is already locked`);
  }

  let nextState = state;
  if (state.edges.has(edge) !== markedInSolution) {
    const candidates = regionsForEdge(regionMap, edge);
    if (candidates.length > 0) {
      // Smallest boundary first, so a two-sided edge toggles whichever
      // neighboring region disturbs fewer other edges (see the doc comment).
      const regionId = candidates.reduce((smallest, id) => (regionMap.regions[id].boundary.length < regionMap.regions[smallest].boundary.length ? id : smallest));
      nextState = toggleRegion(puzzle, regionMap, state, regionId).state;
    } else {
      // Already stranded (interior to some other merged region) without
      // ever having been locked itself — no tap can reach it, so set its
      // marked state directly rather than trying to toggle a region that
      // doesn't include it.
      const edges = new Set(state.edges);
      if (markedInSolution) edges.add(edge);
      else edges.delete(edge);
      nextState = { edges, won: computeWin(puzzle, edges) };
    }
  }

  const lockedEdges = new Set(puzzle.lockedEdges ?? []);
  lockedEdges.add(edge);
  const nextPuzzle: Puzzle = { ...puzzle, lockedEdges };
  const { regionMap: nextRegionMap, strandedEdges } = lockEdgeInRegionMap(regionMap, edge);
  return { puzzle: nextPuzzle, regionMap: nextRegionMap, state: nextState, strandedEdges };
}

/**
 * Replays an ordered sequence of previously-applied edge locks against a
 * freshly-built `puzzle`/`regionMap`/`state` — used to reconstruct a live
 * "Hint me" session (`main.ts`'s `hintMe`) on resume
 * (`InProgressRecord.hintedEdges`) and in review/replay
 * (`CompletedRecord.hintedEdges`). A hint is a live, session-only action —
 * nothing about `PuzzleId` records that it happened (unlike
 * `puzzleGen.ts`'s generation-time `lockedEdgeFraction`), so the puzzle's
 * `lockedEdges`/region merges have to be rebuilt by replaying the same
 * `lockEdge` calls in the same order, not regenerated from the id alone.
 * Order matters: a later hint's own region toggle depends on the regions
 * left behind by every earlier one — see `lockEdge`'s own doc comment.
 *
 * `solutionEdges` (`puzzleGen.ts`'s `generateSolutionEdges(id)`) is passed
 * in rather than recomputed per edge: every hint's `markedInSolution` is
 * simply "was this edge part of the intended solution", regardless of
 * whether the original hint corrected a still-unmarked solution edge or a
 * wrongly-marked distractor edge (see `main.ts`'s `hintMe` doc comment) —
 * that direction doesn't need to be stored separately, since it's fully
 * determined by `edge` and `solutionEdges` alone.
 *
 * `state` should already reflect every edge exactly as it ended up live
 * (a resume's saved `edges`, or a completed record's final `edges`) — with
 * that precondition, each replayed `lockEdge` call's own step 1 (see its
 * doc comment) never actually needs to toggle anything, since the edge is
 * already in its correct, locked-in state; only the structural
 * `lockedEdges`/region-merge side effects need reconstructing here.
 */
export function applyHintedEdges(puzzle: Puzzle, regionMap: RegionMap, state: PathState, hintedEdges: readonly EdgeKey[], solutionEdges: ReadonlySet<EdgeKey>): LockEdgeResult {
  let result: LockEdgeResult = { puzzle, regionMap, state, strandedEdges: [] };
  for (const edge of hintedEdges) {
    if (result.puzzle.lockedEdges?.has(edge)) continue; // defensive: shouldn't happen for a well-formed record
    const { puzzle: p, regionMap: rm, state: s, strandedEdges } = lockEdge(result.puzzle, result.regionMap, result.state, edge, solutionEdges.has(edge));
    result = { puzzle: p, regionMap: rm, state: s, strandedEdges: [...result.strandedEdges, ...strandedEdges] };
  }
  return result;
}
