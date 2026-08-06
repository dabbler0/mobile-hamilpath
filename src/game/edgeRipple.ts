import { computeEdgeComponents } from './edgeComponents';
import { key, type CellKey } from './puzzle';
import { parseEdgeKey, type EdgeKey } from './regions';

export interface RecoloredEdge {
  edge: EdgeKey;
  /** Hop count (in marked edges of the post-toggle graph) from the nearest toggled-edge endpoint. */
  distance: number;
}

/**
 * Given a region toggle's before/after edge sets, finds every *other*
 * still-marked edge (present both before and after — a toggled edge itself
 * is handled separately, as a grow/shrink, not a recolor) whose connected
 * component changed identity as a side effect of the toggle (a merge or
 * split), together with how many marked-edge hops it sits from the toggle
 * location in the post-toggle graph.
 *
 * Only edges actually graph-reachable from the toggle are returned. A
 * split or merge can also renumber an entirely unrelated component simply
 * because `computeEdgeComponents`'s ids are assigned by iteration order,
 * not identity — see its doc comment — and that reordering is deliberately
 * excluded here (main.ts's caller lets it recolor instantly instead of
 * animating a "ripple" that has nowhere real to travel from).
 */
export function computeRecoloredEdges(prevEdges: ReadonlySet<EdgeKey>, nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>): RecoloredEdge[] {
  const prevComponents = computeEdgeComponents(prevEdges);
  const nextComponents = computeEdgeComponents(nextEdges);

  const adjacency = new Map<CellKey, CellKey[]>();
  for (const ek of nextEdges) {
    const [a, b] = parseEdgeKey(ek);
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    if (!adjacency.has(ka)) adjacency.set(ka, []);
    if (!adjacency.has(kb)) adjacency.set(kb, []);
    adjacency.get(ka)!.push(kb);
    adjacency.get(kb)!.push(ka);
  }

  // BFS distance (in cells/hops), seeded at every toggled edge's endpoints, over the post-toggle graph.
  const dist = new Map<CellKey, number>();
  const queue: CellKey[] = [];
  for (const ek of toggledEdges) {
    const [a, b] = parseEdgeKey(ek);
    for (const c of [key(a[0], a[1]), key(b[0], b[1])]) {
      if (!dist.has(c)) {
        dist.set(c, 0);
        queue.push(c);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(cur)!;
    for (const to of adjacency.get(cur) ?? []) {
      if (!dist.has(to)) {
        dist.set(to, d + 1);
        queue.push(to);
      }
    }
  }

  const result: RecoloredEdge[] = [];
  for (const ek of nextEdges) {
    if (toggledEdges.has(ek) || !prevEdges.has(ek)) continue;
    const prevId = prevComponents.get(ek);
    const nextId = nextComponents.get(ek);
    if (prevId === undefined || nextId === undefined || prevId === nextId) continue;
    const [a, b] = parseEdgeKey(ek);
    const da = dist.get(key(a[0], a[1]));
    const db = dist.get(key(b[0], b[1]));
    const distance = da === undefined ? db : db === undefined ? da : Math.min(da, db);
    if (distance === undefined) continue; // unreachable from the toggle -> unrelated renumbering, no ripple
    result.push({ edge: ek, distance });
  }
  return result;
}
