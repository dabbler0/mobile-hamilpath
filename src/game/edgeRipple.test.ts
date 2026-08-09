import { describe, expect, it } from 'vitest';
import { edgeKey } from './regions';
import { computeFarthestCell, computeReachableEdges, computeRecoloredEdges } from './edgeRipple';

describe('computeRecoloredEdges', () => {
  it('reports no ripple when nothing recolors', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const prev = new Set([eA]);
    const eT = edgeKey([1, 0], [2, 0]); // grown, extends the same component
    const next = new Set([eA, eT]);
    const prevColors = new Map([[eA, 0]]);
    const nextColors = new Map([[eA, 0]]); // eA's own persistent color is unaffected by the grow
    expect(computeRecoloredEdges(prev, next, new Set([eT]), prevColors, nextColors)).toEqual([]);
  });

  it('finds edges reachable from the toggle whose color changed, and excludes an unrelated far-away edge', () => {
    // A path (0,0)-(1,0)-(2,0)-(3,0), plus a totally unrelated distant edge.
    const eA = edgeKey([0, 0], [1, 0]);
    const eT = edgeKey([1, 0], [2, 0]); // this edge is toggled off, splitting the path
    const eB = edgeKey([2, 0], [3, 0]);
    const eC = edgeKey([20, 20], [21, 20]); // unrelated, never touches the path

    const prev = new Set([eA, eT, eB, eC]); // eA/eT/eB all one component; eC its own
    const next = new Set([eA, eB, eC]); // removing eT splits eA and eB apart

    // eA/eT/eB start out color 0, eC its own color 1. After the split, eA
    // (the larger remaining piece, per componentColors.ts's "larger half
    // keeps the old color" rule) stays 0; eB gets a fresh color 2; eC is
    // untouched.
    const prevColors = new Map([[eA, 0], [eT, 0], [eB, 0], [eC, 1]]);
    const nextColors = new Map([[eA, 0], [eB, 2], [eC, 1]]);

    const recolored = computeRecoloredEdges(prev, next, new Set([eT]), prevColors, nextColors);
    const edges = recolored.map((r) => r.edge);

    // eB is right next to the split and visibly changes color -> rippled.
    expect(edges).toContain(eB);
    const eBEntry = recolored.find((r) => r.edge === eB)!;
    expect(eBEntry.distance).toBe(0);

    // eA's own color didn't change, so it must not ripple even though it's
    // right next to the split too.
    expect(edges).not.toContain(eA);

    // eC's color is unchanged and it isn't reachable from the toggle either way.
    expect(edges).not.toContain(eC);

    // The toggled edge itself is never reported (grow/shrink handles it separately).
    expect(edges).not.toContain(eT);
  });

  it('flags the side of a merge whose persistent color actually changed, even when the edge sets iterate in the opposite order (regression: a raw-component-id comparison gets this backwards)', () => {
    // Two components: A (a single edge) and B (two edges). A is the
    // persistently *lower*-colored ("blue wins") side, but the edge sets
    // below deliberately iterate B's edges before A's -- exactly the kind
    // of order/color mismatch that can arise once a puzzle's edges Set has
    // been toggled off and back on enough times that its insertion order no
    // longer lines up with the order colors were originally assigned in.
    const aE = edgeKey([0, 0], [1, 0]);
    const b1 = edgeKey([5, 0], [6, 0]);
    const b2 = edgeKey([6, 0], [7, 0]);
    const bridge = edgeKey([1, 0], [5, 0]); // newly toggled on, merges A and B

    const prev = new Set([b1, b2, aE]);
    const next = new Set([b1, b2, aE, bridge]);

    // Established persistent colors going into the merge: A = 0, B = 1.
    const prevColors = new Map([[aE, 0], [b1, 1], [b2, 1]]);
    // Blue (0) wins the merge -- B's edges are the ones that actually
    // change color; A's own color is unchanged.
    const nextColors = new Map([[aE, 0], [b1, 0], [b2, 0], [bridge, 0]]);

    const recolored = computeRecoloredEdges(prev, next, new Set([bridge]), prevColors, nextColors);
    const edges = recolored.map((r) => r.edge);

    expect(edges).toContain(b1);
    expect(edges).toContain(b2);
    expect(edges).not.toContain(aE);
  });

  it('returns an empty array for no toggled edges', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const edges = new Set([eA]);
    const colors = new Map([[eA, 0]]);
    expect(computeRecoloredEdges(edges, edges, new Set(), colors, colors)).toEqual([]);
  });
});

describe('computeReachableEdges', () => {
  it('includes every pre-existing edge merged in by the toggle, unlike computeRecoloredEdges which only catches the ones whose component id happened to change', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const eB = edgeKey([2, 0], [3, 0]);
    const eT = edgeKey([1, 0], [2, 0]); // newly added, joins eA and eB into one component
    const eC = edgeKey([20, 20], [21, 20]); // unrelated, never touches the joined path

    const prev = new Set([eA, eB, eC]); // eA and eB start as two separate components
    const next = new Set([eA, eB, eT, eC]);

    const reachable = computeReachableEdges(prev, next, new Set([eT]));
    const edges = reachable.map((r) => r.edge);

    expect(edges).toContain(eA);
    expect(edges).toContain(eB);
    expect(edges).not.toContain(eT); // the toggled edge itself is handled as a grow, not a ripple
    expect(edges).not.toContain(eC); // unreachable from the toggle

    expect(reachable.find((r) => r.edge === eA)!.distance).toBe(0);
    expect(reachable.find((r) => r.edge === eB)!.distance).toBe(0);
  });

  it('returns an empty array for no toggled edges', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const edges = new Set([eA]);
    expect(computeReachableEdges(edges, edges, new Set())).toEqual([]);
  });
});

describe('computeFarthestCell', () => {
  it('finds the cell at the far end of a straight path from the toggle', () => {
    // A path (0,0)-(1,0)-(2,0)-(3,0)-(4,0), toggled at the (0,0)-(1,0) end.
    // Both of the toggled edge's endpoints seed the BFS at distance 0, so
    // (1,0) starts at 0 too -- (4,0) is 3 hops from there, not 4.
    const edges = new Set([edgeKey([0, 0], [1, 0]), edgeKey([1, 0], [2, 0]), edgeKey([2, 0], [3, 0]), edgeKey([3, 0], [4, 0])]);
    const toggled = new Set([edgeKey([0, 0], [1, 0])]);
    const farthest = computeFarthestCell(edges, toggled);
    expect(farthest).not.toBeNull();
    expect(farthest!.cell).toEqual([4, 0]);
    expect(farthest!.distance).toBe(3);
  });

  it('finds the meeting point on the far side of a cycle from the toggle', () => {
    // An 8-cell ring; toggling one edge seeds both its endpoints at distance 0,
    // so the ripple spreading both ways around the ring meets at the two cells
    // directly opposite the toggled edge, each 3 hops away.
    const cells: Array<[number, number]> = [
      [0, 0], [1, 0], [2, 0], [2, 1],
      [2, 2], [1, 2], [0, 2], [0, 1],
    ];
    const edges = new Set<string>();
    for (let i = 0; i < cells.length; i++) edges.add(edgeKey(cells[i], cells[(i + 1) % cells.length]));
    const toggled = new Set([edgeKey(cells[0], cells[1])]);

    const farthest = computeFarthestCell(edges, toggled);
    expect(farthest).not.toBeNull();
    expect(farthest!.distance).toBe(3);
  });

  it('returns null when there are no toggled edges', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    expect(computeFarthestCell(new Set([eA]), new Set())).toBeNull();
  });
});
