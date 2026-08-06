import { describe, expect, it } from 'vitest';
import { edgeKey } from './regions';
import { computeRecoloredEdges } from './edgeRipple';

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
