import { cellDist2, type Layout } from './geometry';
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

function locateCell(segments: readonly Segment[], k: CellKey): CellLocation | null {
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

export interface DragStepResult {
  segments: Segment[];
  won: boolean;
  /** The cell the caller should keep treating as "the dragged endpoint" on the next pointer move. */
  draggedCell: Cell;
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
      dragged = bestCell;
      progressed = true;
      continue;
    }

    if (bestLoc.segmentIndex === loc.segmentIndex) {
      const predIdx = isHead ? 1 : seg.length - 2;
      if (predIdx >= 0 && bestLoc.cellIndex === predIdx) {
        if (isHead) seg.shift();
        else seg.pop();
        dragged = isHead ? seg[0] : seg[seg.length - 1];
        progressed = true;
        continue;
      }
      const otherEndIdx = isHead ? seg.length - 1 : 0;
      if (bestLoc.cellIndex === otherEndIdx && seg.length === totalCells(puzzle)) {
        nextWon = true;
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

    workingSegments = workingSegments.filter((_, idx) => idx !== loc.segmentIndex && idx !== bestLoc.segmentIndex);
    workingSegments.push(merged);
    dragged = farEnd;
    break;
  }

  return { segments: workingSegments, won: nextWon, draggedCell: dragged };
}
