import { describe, expect, it } from 'vitest';
import type { Layout } from './geometry';
import {
  createInitialPath,
  findInteriorNodeAt,
  splitSegmentAtCell,
  totalVisitedCells,
  tryStartPathDrag,
  updatePathDrag,
  type Segment,
} from './pathDrag';
import { key, totalCells, type Puzzle } from './puzzle';

const LAYOUT: Layout = { cellSize: 10, pad: 0 };

function buildAdj(cycle: Array<[number, number]>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const ensure = (k: string) => {
    if (!adj.has(k)) adj.set(k, new Set());
  };
  for (let i = 0; i < cycle.length; i++) {
    const [x1, y1] = cycle[i];
    const [x2, y2] = cycle[(i + 1) % cycle.length];
    const k1 = key(x1, y1);
    const k2 = key(x2, y2);
    ensure(k1);
    ensure(k2);
    adj.get(k1)!.add(k2);
    adj.get(k2)!.add(k1);
  }
  return adj;
}

/** A tiny hand-built 2x2 Hamiltonian cycle: (0,0)-(1,0)-(1,1)-(0,1)-(0,0). */
function makeSquarePuzzle(): Puzzle {
  const cycle: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  return { adj: buildAdj(cycle), W: 2, H: 2, startCell: [0, 0] };
}

/** A 6-cell ring: (0,0)-(1,0)-(2,0)-(2,1)-(1,1)-(0,1)-(0,0), 3x2 cells. */
function makeRingPuzzle(): Puzzle {
  const cycle: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [0, 1],
  ];
  return { adj: buildAdj(cycle), W: 3, H: 2, startCell: [0, 0] };
}

describe('createInitialPath', () => {
  it('starts as a single one-cell segment at the puzzle start', () => {
    const puzzle = makeSquarePuzzle();
    expect(createInitialPath(puzzle)).toEqual({ segments: [[[0, 0]]], won: false });
  });
});

describe('totalVisitedCells', () => {
  it('sums cells across every segment', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
      ],
      [[2, 2]],
    ];
    expect(totalVisitedCells({ segments, won: false })).toBe(3);
  });
});

describe('tryStartPathDrag', () => {
  it('offers the single cell of a one-cell segment', () => {
    expect(tryStartPathDrag([[[0, 0]]], 0, 0, LAYOUT)).toEqual([0, 0]);
    expect(tryStartPathDrag([[[0, 0]]], 500, 500, LAYOUT)).toBeNull();
  });

  it('picks whichever endpoint, of any segment, is closest', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
      ],
      [[2, 2]],
    ];
    expect(tryStartPathDrag(segments, 0, 0, LAYOUT)).toEqual([0, 0]);
    expect(tryStartPathDrag(segments, 10, 0, LAYOUT)).toEqual([1, 0]);
    expect(tryStartPathDrag(segments, 20, 20, LAYOUT)).toEqual([2, 2]);
    expect(tryStartPathDrag(segments, 500, 500, LAYOUT)).toBeNull();
  });
});

describe('findInteriorNodeAt', () => {
  it('finds no interior node in segments shorter than 3 cells', () => {
    expect(findInteriorNodeAt([[[0, 0]]], 0, 0, LAYOUT)).toBeNull();
    expect(
      findInteriorNodeAt(
        [
          [
            [0, 0],
            [1, 0],
          ],
        ],
        0,
        0,
        LAYOUT,
      ),
    ).toBeNull();
  });

  it('finds the interior cell of a longer segment', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
      ],
    ];
    expect(findInteriorNodeAt(segments, 10, 0, LAYOUT)).toEqual({ segmentIndex: 0, cellIndex: 1 });
    expect(findInteriorNodeAt(segments, 20, 0, LAYOUT)).toEqual({ segmentIndex: 0, cellIndex: 2 });
    expect(findInteriorNodeAt(segments, 500, 500, LAYOUT)).toBeNull();
  });

  it('picks the closest interior node across multiple segments', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [5, 5],
        [6, 5],
        [7, 5],
      ],
    ];
    expect(findInteriorNodeAt(segments, 60, 50, LAYOUT)).toEqual({ segmentIndex: 1, cellIndex: 1 });
  });
});

describe('splitSegmentAtCell', () => {
  it('splits a segment into two at the given interior cell', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
      ],
    ];
    expect(splitSegmentAtCell(segments, 0, 1)).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [2, 0],
        [2, 1],
      ],
    ]);
  });

  it('splitting right after the head produces a single-cell segment', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ];
    expect(splitSegmentAtCell(segments, 0, 0)).toEqual([
      [[0, 0]],
      [
        [1, 0],
        [2, 0],
      ],
    ]);
  });

  it('leaves other segments untouched', () => {
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [[9, 9]],
    ];
    const result = splitSegmentAtCell(segments, 0, 1);
    expect(result[2]).toEqual([[9, 9]]);
  });
});

describe('updatePathDrag', () => {
  it('extends onto an adjacent, unvisited cell nearest the pointer', () => {
    const puzzle = makeSquarePuzzle();
    const { segments } = createInitialPath(puzzle);
    const result = updatePathDrag(puzzle, segments, false, [0, 0], 10, 0, LAYOUT);
    expect(result.segments).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    expect(result.won).toBe(false);
    expect(result.draggedCell).toEqual([1, 0]);
  });

  it('retracts when dragged back over the cell it came from', () => {
    const puzzle = makeSquarePuzzle();
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
      ],
    ];
    const result = updatePathDrag(puzzle, segments, false, [1, 0], 0, 0, LAYOUT);
    expect(result.segments).toEqual([[[0, 0]]]);
    expect(result.won).toBe(false);
    expect(result.draggedCell).toEqual([0, 0]);
  });

  it('wins once the sole segment visits every cell and closes the loop', () => {
    const puzzle = makeSquarePuzzle();
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    ];
    expect(segments[0].length).toBe(totalCells(puzzle));
    const result = updatePathDrag(puzzle, segments, false, [0, 1], 0, 0, LAYOUT);
    expect(result.won).toBe(true);
    expect(result.segments).toEqual(segments);
  });

  it('does not win by closing early, before every cell is visited', () => {
    const puzzle = makeSquarePuzzle();
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
      ],
    ];
    const result = updatePathDrag(puzzle, segments, false, [1, 0], 0, 0, LAYOUT);
    expect(result.won).toBe(false);
  });

  it('merges into a different segment reached at one of its ends, stopping right at the join', () => {
    const puzzle = makeRingPuzzle();
    // Two disjoint arcs of the ring, cut at the (2,0)-(2,1) and (0,1)-(0,0) edges.
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [2, 1],
        [1, 1],
        [0, 1],
      ],
    ];
    // Drag the tail of segment 0 (2,0) exactly onto (2,1), the head of segment 1.
    const result = updatePathDrag(puzzle, segments, false, [2, 0], 20, 10, LAYOUT);
    expect(result.segments).toEqual([
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [0, 1],
      ],
    ]);
    expect(result.won).toBe(false);
    // The far end of the segment we just joined becomes the endpoint for the next move.
    expect(result.draggedCell).toEqual([0, 1]);
  });

  it('a merge stops at the join instead of unraveling back through the joined segment', () => {
    const puzzle = makeRingPuzzle();
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [2, 1],
        [1, 1],
        [0, 1],
      ],
    ];
    // Pointer sits exactly at the join point (2,1). A naive "keep hill-climbing towards
    // the pointer" would then retract all the way back through the newly-joined
    // segment (since every one of its cells is closer to (2,1) than its far end is),
    // silently deleting it. The merge must stop here instead, leaving all 6 cells intact.
    const result = updatePathDrag(puzzle, segments, false, [2, 0], 20, 10, LAYOUT);
    expect(totalVisitedCells({ segments: result.segments, won: result.won })).toBe(6);
  });

  it('continuing to drag after a merge, in a second call, can go on to close the loop', () => {
    const puzzle = makeRingPuzzle();
    const segments: Segment[] = [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [2, 1],
        [1, 1],
        [0, 1],
      ],
    ];
    const merged = updatePathDrag(puzzle, segments, false, [2, 0], 20, 10, LAYOUT);
    expect(merged.won).toBe(false);
    // The finger keeps moving to (0,0), the merged segment's other end: this closes the loop.
    const closed = updatePathDrag(puzzle, merged.segments, merged.won, merged.draggedCell, 0, 0, LAYOUT);
    expect(closed.won).toBe(true);
    expect(closed.segments).toHaveLength(1);
    expect(totalVisitedCells({ segments: closed.segments, won: closed.won })).toBe(6);
  });

  it('does not merge into the interior of another segment', () => {
    // A(0,0) -- X(1,0) -- {Y(2,0), Z(1,1)}: X has degree 3, so dragging A towards X
    // reaches an interior cell of the other segment [Y, X, Z], which must be blocked.
    const adj = new Map<string, Set<string>>([
      [key(0, 0), new Set([key(1, 0)])],
      [key(1, 0), new Set([key(0, 0), key(2, 0), key(1, 1)])],
      [key(2, 0), new Set([key(1, 0)])],
      [key(1, 1), new Set([key(1, 0)])],
    ]);
    const puzzle: Puzzle = { adj, W: 4, H: 1, startCell: [0, 0] };
    const segments: Segment[] = [
      [[0, 0]],
      [
        [2, 0],
        [1, 0],
        [1, 1],
      ],
    ];
    const result = updatePathDrag(puzzle, segments, false, [0, 0], 10, 0, LAYOUT);
    expect(result.segments).toEqual(segments);
    expect(result.won).toBe(false);
  });
});
