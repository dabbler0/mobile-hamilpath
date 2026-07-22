import { cellDist2, toScreen, type Layout } from './geometry';
import type { Cell } from './hamiltonianCycle';
import { key, parseKey, totalCells, type CellKey, type Puzzle } from './puzzle';

/** A simple path: a sequence of graph-adjacent, non-repeating cells. Its two ends (index 0 and length-1, equal when length is 1) can be dragged. */
export type Segment = Cell[];

export interface PathState {
  segments: Segment[];
  won: boolean;
}

export function createInitialPath(puzzle: Puzzle): PathState {
  return { segments: [[puzzle.startCell]], won: false };
}

export function totalVisitedCells(state: PathState): number {
  return state.segments.reduce((sum, seg) => sum + seg.length, 0);
}

interface CellLocation {
  segmentIndex: number;
  cellIndex: number;
}

export function locateCell(segments: readonly Segment[], k: CellKey): CellLocation | null {
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const seg = segments[segmentIndex];
    for (let cellIndex = 0; cellIndex < seg.length; cellIndex++) {
      if (key(seg[cellIndex][0], seg[cellIndex][1]) === k) return { segmentIndex, cellIndex };
    }
  }
  return null;
}

/**
 * Finds whichever segment endpoint (across all segments) is nearest a
 * pointer-down at (px, py), if any is within pick radius. Single-cell
 * segments offer their one cell just once.
 */
export function tryStartPathDrag(segments: readonly Segment[], px: number, py: number, layout: Layout): Cell | null {
  const pickRadius = layout.cellSize * 0.9;
  const pickRadius2 = pickRadius * pickRadius;
  let best: Cell | null = null;
  let bestDist = Infinity;

  for (const seg of segments) {
    const candidates = seg.length === 1 ? [seg[0]] : [seg[0], seg[seg.length - 1]];
    for (const c of candidates) {
      const d = cellDist2(c, px, py, layout);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
  }

  return best && bestDist < pickRadius2 ? best : null;
}

/**
 * Finds whichever segment *interior* cell (neither of its two ends) is
 * nearest a pointer at (px, py), if any is within pick radius. Tapping this
 * spot is how a segment gets split in two.
 */
export function findInteriorNodeAt(segments: readonly Segment[], px: number, py: number, layout: Layout): CellLocation | null {
  const pickRadius = layout.cellSize * 0.9;
  const pickRadius2 = pickRadius * pickRadius;
  let best: CellLocation | null = null;
  let bestDist = Infinity;

  segments.forEach((seg, segmentIndex) => {
    for (let cellIndex = 1; cellIndex < seg.length - 1; cellIndex++) {
      const d = cellDist2(seg[cellIndex], px, py, layout);
      if (d < bestDist) {
        bestDist = d;
        best = { segmentIndex, cellIndex };
      }
    }
  });

  return best && bestDist < pickRadius2 ? best : null;
}

/** Splits one segment into two by removing the edge right after `cellIndex`. */
export function splitSegmentAtCell(segments: readonly Segment[], segmentIndex: number, cellIndex: number): Segment[] {
  const seg = segments[segmentIndex];
  const before = seg.slice(0, cellIndex + 1);
  const after = seg.slice(cellIndex + 1);
  return [...segments.slice(0, segmentIndex), before, after, ...segments.slice(segmentIndex + 1)];
}

/**
 * A single atomic mutation applied to `segments`/`won`, as produced by one
 * iteration of `updatePathDrag`'s hill-climbing loop (or a direct split).
 * This is the compact, replayable unit the game-history feature logs: each
 * op is O(1) regardless of how long the segments involved are, so a whole
 * game's move history stays small no matter the board size. `applyPathOp`
 * is the forward-only inverse of however each op was produced — replaying
 * a game's recorded ops through it from `createInitialPath` reconstructs
 * every state the path ever passed through.
 */
export type PathOp =
  | { op: 'extend'; seg: number; end: 'head' | 'tail'; cell: Cell }
  | { op: 'retract'; seg: number; end: 'head' | 'tail' }
  | { op: 'merge'; seg: number; end: 'head' | 'tail'; otherSeg: number; otherEnd: 'head' | 'tail' }
  | { op: 'split'; seg: number; cellIndex: number }
  | { op: 'win' };

/**
 * Applies one `PathOp` to `segments`/`won`, mirroring exactly the mutation
 * `updatePathDrag` (or a direct split call) performed when the op was
 * recorded. Used to reconstruct intermediate states for the replay
 * animation and is the one place that logic must stay in sync with
 * `updatePathDrag`'s own extend/retract/merge/split/win handling below.
 */
export function applyPathOp(segments: readonly Segment[], won: boolean, op: PathOp): { segments: Segment[]; won: boolean } {
  const working: Segment[] = segments.map((seg) => seg.map((c): Cell => [c[0], c[1]]));
  switch (op.op) {
    case 'extend': {
      const seg = working[op.seg];
      if (op.end === 'head') seg.unshift(op.cell);
      else seg.push(op.cell);
      return { segments: working, won };
    }
    case 'retract': {
      const seg = working[op.seg];
      if (op.end === 'head') seg.shift();
      else seg.pop();
      return { segments: working, won };
    }
    case 'split':
      return { segments: splitSegmentAtCell(working, op.seg, op.cellIndex), won };
    case 'merge': {
      const seg = working[op.seg];
      const otherSeg = working[op.otherSeg];
      const mySide = op.end === 'head' ? [...seg].reverse() : seg;
      const otherSide = op.otherEnd === 'head' ? otherSeg : [...otherSeg].reverse();
      const merged = [...mySide, ...otherSide];
      const filtered = working.filter((_, idx) => idx !== op.seg && idx !== op.otherSeg);
      filtered.push(merged);
      return { segments: filtered, won };
    }
    case 'win':
      return { segments: working, won: true };
  }
}

export interface DragStepResult {
  segments: Segment[];
  won: boolean;
  /** The cell the caller should keep treating as "the dragged endpoint" on the next pointer move. */
  draggedCell: Cell;
  /** Every atomic mutation this call performed, in order — see `PathOp`. Empty if the call was a no-op (pointer/target didn't pull the endpoint anywhere new). */
  ops: PathOp[];
}

/**
 * Advances a dragged endpoint towards the pointer, one adjacent cell at a
 * time. Each step can: extend onto a fresh cell, retract back over the cell
 * it just came from, close the last remaining segment into a winning loop,
 * or merge with a different segment when it reaches one of *that* segment's
 * ends. Reaching into the middle of another segment, or into an arbitrary
 * non-adjacent cell of its own segment, is blocked. Repeats until the
 * pointer no longer pulls the endpoint any closer to a neighbor than staying
 * put — except a merge always stops the call right there: the newly
 * attached segment's far end becomes the endpoint for the *next* call,
 * rather than immediately re-evaluating it against a pointer position that
 * was only ever aimed at the join, which would otherwise unravel the merge
 * step by step back through the segment we just joined.
 */
export function updatePathDrag(
  puzzle: Puzzle,
  segments: readonly Segment[],
  won: boolean,
  draggedCell: Cell,
  px: number,
  py: number,
  layout: Layout,
): DragStepResult {
  let workingSegments: Segment[] = segments.map((seg) => seg.map((c): Cell => [c[0], c[1]]));
  let nextWon = won;
  let dragged = draggedCell;
  let progressed = true;
  let guard = 0;
  const ops: PathOp[] = [];

  while (progressed && guard < 400) {
    progressed = false;
    guard++;

    const draggedKey = key(dragged[0], dragged[1]);
    const loc = locateCell(workingSegments, draggedKey);
    if (!loc) break;
    const seg = workingSegments[loc.segmentIndex];
    // A lone cell's one "endpoint" is treated as a tail (appends), matching a
    // fresh segment's natural growth direction; only a genuine two-ended
    // segment distinguishes its head from its tail.
    const isHead = loc.cellIndex === 0 && seg.length > 1;
    if (!isHead && loc.cellIndex !== seg.length - 1) break;

    const neighbors = puzzle.adj.get(draggedKey);
    if (!neighbors) break;

    let bestKey: CellKey = draggedKey;
    let bestDist = cellDist2(dragged, px, py, layout);
    for (const nk of neighbors) {
      const d = cellDist2(parseKey(nk), px, py, layout);
      if (d < bestDist) {
        bestDist = d;
        bestKey = nk;
      }
    }
    if (bestKey === draggedKey) break;

    const bestCell = parseKey(bestKey);
    const bestLoc = locateCell(workingSegments, bestKey);

    if (!bestLoc) {
      if (isHead) seg.unshift(bestCell);
      else seg.push(bestCell);
      ops.push({ op: 'extend', seg: loc.segmentIndex, end: isHead ? 'head' : 'tail', cell: bestCell });
      dragged = bestCell;
      progressed = true;
      continue;
    }

    if (bestLoc.segmentIndex === loc.segmentIndex) {
      const predIdx = isHead ? 1 : seg.length - 2;
      if (predIdx >= 0 && bestLoc.cellIndex === predIdx) {
        if (isHead) seg.shift();
        else seg.pop();
        ops.push({ op: 'retract', seg: loc.segmentIndex, end: isHead ? 'head' : 'tail' });
        dragged = isHead ? seg[0] : seg[seg.length - 1];
        progressed = true;
        continue;
      }
      const otherEndIdx = isHead ? seg.length - 1 : 0;
      if (bestLoc.cellIndex === otherEndIdx && seg.length === totalCells(puzzle)) {
        nextWon = true;
        ops.push({ op: 'win' });
      }
      break;
    }

    const otherSeg = workingSegments[bestLoc.segmentIndex];
    const otherIsHead = bestLoc.cellIndex === 0;
    const otherIsTail = bestLoc.cellIndex === otherSeg.length - 1;
    if (!otherIsHead && !otherIsTail) break;

    const mySide = isHead ? [...seg].reverse() : seg;
    const otherSide = otherIsHead ? otherSeg : [...otherSeg].reverse();
    const farEnd = otherIsHead ? otherSeg[otherSeg.length - 1] : otherSeg[0];
    const merged = [...mySide, ...otherSide];

    ops.push({ op: 'merge', seg: loc.segmentIndex, end: isHead ? 'head' : 'tail', otherSeg: bestLoc.segmentIndex, otherEnd: otherIsHead ? 'head' : 'tail' });
    workingSegments = workingSegments.filter((_, idx) => idx !== loc.segmentIndex && idx !== bestLoc.segmentIndex);
    workingSegments.push(merged);
    dragged = farEnd;
    break;
  }

  return { segments: workingSegments, won: nextWon, draggedCell: dragged, ops };
}

/** A grid direction as (dx, dy); only the four orthogonal directions are meaningful since every puzzle edge connects lattice-adjacent cells. */
export type Direction = readonly [number, number];

export interface DirectionStepResult extends DragStepResult {
  /**
   * The other segment's endpoint actually reached, when this step merged
   * into it — otherwise null. Distinct from `draggedCell`, which (matching
   * `updatePathDrag`'s convention for continued pointer drags) becomes the
   * merged segment's *far* end instead. Keyboard controls use this to leave
   * the cursor sitting at the join rather than jumping it across the
   * segment it just merged with.
   */
  mergeJoinCell: Cell | null;
}

/**
 * Steps a held endpoint exactly one cell in a fixed grid direction, reusing
 * `updatePathDrag`'s extend/retract/merge/win rules but aimed at one specific
 * neighbor rather than hill-climbing toward a pointer position. Used by
 * keyboard controls, where an arrow key press should move by exactly one
 * cell (or not at all, if there's no edge that way).
 */
export function stepPathEndDirection(
  puzzle: Puzzle,
  segments: readonly Segment[],
  won: boolean,
  draggedCell: Cell,
  direction: Direction,
  layout: Layout,
): DirectionStepResult {
  const target: Cell = [draggedCell[0] + direction[0], draggedCell[1] + direction[1]];
  const [px, py] = toScreen(target, layout);
  const result = updatePathDrag(puzzle, segments, won, draggedCell, px, py, layout);
  const merged = result.segments.length < segments.length;
  return { ...result, mergeJoinCell: merged ? target : null };
}

export interface RunStepResult extends DragStepResult {
  /** Whether the run stopped because it merged into another segment (as opposed to a fork/dead end/no-edge). */
  merged: boolean;
  /** See `DirectionStepResult.mergeJoinCell` — the join cell reached, if `merged`, else null. */
  mergeJoinCell: Cell | null;
}

/**
 * Repeats `stepPathEndDirection` in a fixed direction, for as long as each
 * newly-reached cell is a plain 2-degree corridor node, stopping the moment
 * it reaches a fork (degree > 2), a dead end (degree 1), a merge into
 * another segment, a win, or simply has no edge to continue. This is the
 * keyboard "run" behavior: shift+arrow while holding a path end skips ahead
 * to the next cell that actually requires a decision.
 */
export function runPathEndDirection(
  puzzle: Puzzle,
  segments: readonly Segment[],
  won: boolean,
  draggedCell: Cell,
  direction: Direction,
  layout: Layout,
): RunStepResult {
  let workingSegments: Segment[] = segments as Segment[];
  let nextWon = won;
  let dragged = draggedCell;
  let merged = false;
  let mergeJoinCell: Cell | null = null;
  let guard = 0;
  const ops: PathOp[] = [];

  while (guard++ < 400) {
    const step = stepPathEndDirection(puzzle, workingSegments, nextWon, dragged, direction, layout);
    const didMerge = step.segments.length < workingSegments.length;
    // A winning close doesn't move `draggedCell` (the endpoint conceptually stays put once
    // the loop is closed), so a win must be detected before falling back to the "didn't
    // move, so we're blocked" check below.
    const justWon = step.won && !nextWon;
    const moved = step.draggedCell[0] !== dragged[0] || step.draggedCell[1] !== dragged[1];

    workingSegments = step.segments;
    nextWon = step.won;
    dragged = step.draggedCell;
    ops.push(...step.ops);

    if (didMerge) {
      merged = true;
      mergeJoinCell = step.mergeJoinCell;
      break;
    }
    if (justWon) break;
    if (!moved) break;

    const degree = puzzle.adj.get(key(dragged[0], dragged[1]))?.size ?? 0;
    if (degree !== 2) break;
  }

  return { segments: workingSegments, won: nextWon, draggedCell: dragged, merged, mergeJoinCell, ops };
}
