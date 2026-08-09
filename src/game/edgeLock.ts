import { toggleRegion, type PathState } from './pathEdit';
import type { Puzzle } from './puzzle';
import { lockEdgeInRegionMap, regionsForEdge, type EdgeKey, type RegionMap } from './regions';

export interface LockEdgeResult {
  puzzle: Puzzle;
  regionMap: RegionMap;
  state: PathState;
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
 *    board edge) and the degenerate "same region on both sides" case, where
 *    there's no real choice to make either way.
 * 2. Add `edge` to `puzzle.lockedEdges` and update `regionMap` to match
 *    (`lockEdgeInRegionMap` — an incremental update, not a full
 *    `computeRegions` recompute, since this runs once per locked edge and a
 *    full board recompute on every one of them is measurably slow on a big
 *    board; see that function's own doc comment) — from this point on,
 *    `edge`'s two neighboring faces are permanently merged into one region
 *    and `edge` itself never appears in any region's boundary again (see
 *    `regions.ts`'s `isLocked`), so nothing going through `toggleRegion` can
 *    ever flip it a second time.
 *
 * None of `puzzle`/`regionMap`/`state` are mutated in place — a fresh
 * `puzzle`/`regionMap`/`state` is returned, matching every other edit
 * function in this codebase (`applyPathOp` et al).
 *
 * Throws if `edge` needs toggling but isn't on any region's boundary at
 * all — i.e. it's already locked, or it was never a real puzzle-graph edge
 * to begin with. A caller locking a fresh, never-before-locked real edge
 * (the only way this is used today — see `puzzleGen.ts`) never hits this.
 */
export function lockEdge(puzzle: Puzzle, regionMap: RegionMap, state: PathState, edge: EdgeKey, markedInSolution: boolean): LockEdgeResult {
  let nextState = state;
  if (state.edges.has(edge) !== markedInSolution) {
    const candidates = regionsForEdge(regionMap, edge);
    if (candidates.length === 0) {
      throw new Error(`lockEdge: edge ${edge} is not on any region's boundary — already locked, or not a real puzzle-graph edge`);
    }
    // Smallest boundary first, so a two-sided edge toggles whichever
    // neighboring region disturbs fewer other edges (see the doc comment).
    const regionId = candidates.reduce((smallest, id) => (regionMap.regions[id].boundary.length < regionMap.regions[smallest].boundary.length ? id : smallest));
    nextState = toggleRegion(puzzle, regionMap, state, regionId).state;
  }

  const lockedEdges = new Set(puzzle.lockedEdges ?? []);
  lockedEdges.add(edge);
  const nextPuzzle: Puzzle = { ...puzzle, lockedEdges };
  const nextRegionMap = lockEdgeInRegionMap(regionMap, edge);
  return { puzzle: nextPuzzle, regionMap: nextRegionMap, state: nextState };
}
