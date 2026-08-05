import type { Cell } from './hamiltonianCycle';
import { key, type CellKey } from './puzzle';
import { parseEdgeKey, type EdgeKey } from './regions';

/**
 * Walks a marked-edge set that forms exactly one Hamiltonian cycle (as
 * guaranteed by `pathEdit.ts`'s `computeWin` before this is ever called —
 * every cell has marked-degree exactly 2, and all cells are mutually
 * reachable) into a single ordered list of cells: `cells[i]` is joined to
 * `cells[i + 1]` by a marked edge, and the last entry closes back to the
 * first the same way. This is the traversal order `render.ts`'s win-loop
 * dot animation walks along, computed once per completed puzzle rather
 * than every animation frame.
 *
 * Returns `null` if `edges` doesn't actually form one simple cycle
 * (defensive — shouldn't happen for anything that's already passed
 * `computeWin`, but cheap to check rather than assume).
 */
export function orderLoopCells(edges: ReadonlySet<EdgeKey>): Cell[] | null {
  if (edges.size === 0) return null;

  const cellByKey = new Map<CellKey, Cell>();
  const adj = new Map<CellKey, CellKey[]>();
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    cellByKey.set(ka, a);
    cellByKey.set(kb, b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(kb);
    adj.get(kb)!.push(ka);
  }

  const total = adj.size;
  const start = adj.keys().next().value!;
  const ordered: Cell[] = [];
  const visited = new Set<CellKey>();
  let prev: CellKey | null = null;
  let cur = start;
  for (let i = 0; i < total; i++) {
    const cell = cellByKey.get(cur);
    const neighborsOfCur = adj.get(cur);
    // A duplicate visit before covering every cell means `edges` is more than
    // one disjoint cycle (or has a branch point) rather than a single loop.
    if (!cell || !neighborsOfCur || neighborsOfCur.length !== 2 || visited.has(cur)) return null;
    visited.add(cur);
    ordered.push(cell);
    const [n0, n1] = neighborsOfCur;
    const next = n0 === prev ? n1 : n0;
    prev = cur;
    cur = next;
  }
  return cur === start ? ordered : null;
}
