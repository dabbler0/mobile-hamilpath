import { describe, expect, it } from 'vitest';
import { edgeKey } from './regions';
import { computeFarthestCell, computeReachableEdges, computeRecoloredEdges } from './edgeRipple';

describe('computeRecoloredEdges', () => {
  it('reports no ripple when nothing recolors', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const prev = new Set([eA]);
    const eT = edgeKey([1, 0], [2, 0]); // grown, extends the same component
    const next = new Set([eA, eT]);
    expect(computeRecoloredEdges(prev, next, new Set([eT]))).toEqual([]);
  });

  it('finds edges reachable from the toggle whose color changed, and excludes an unrelated far-away renumbering', () => {
    // A path (0,0)-(1,0)-(2,0)-(3,0), plus a totally unrelated distant edge.
    const eA = edgeKey([0, 0], [1, 0]);
    const eT = edgeKey([1, 0], [2, 0]); // this edge is toggled off, splitting the path
    const eB = edgeKey([2, 0], [3, 0]);
    const eC = edgeKey([20, 20], [21, 20]); // unrelated, never touches the path

    const prev = new Set([eA, eT, eB, eC]); // eA/eT/eB all one component; eC its own
    const next = new Set([eA, eB, eC]); // removing eT splits eA and eB apart

    const recolored = computeRecoloredEdges(prev, next, new Set([eT]));
    const edges = recolored.map((r) => r.edge);

    // eB is right next to the split and visibly changes component/color -> rippled.
    expect(edges).toContain(eB);
    const eBEntry = recolored.find((r) => r.edge === eB)!;
    expect(eBEntry.distance).toBe(0);

    // eC's component id also shifts (pure renumbering side effect) but it isn't
    // reachable from the toggle location, so it must not be reported.
    expect(edges).not.toContain(eC);

    // The toggled edge itself is never reported (grow/shrink handles it separately).
    expect(edges).not.toContain(eT);
  });

  it('returns an empty array for no toggled edges', () => {
    const eA = edgeKey([0, 0], [1, 0]);
    const edges = new Set([eA]);
    expect(computeRecoloredEdges(edges, edges, new Set())).toEqual([]);
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
