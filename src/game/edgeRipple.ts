import type { Cell } from './hamiltonianCycle';
import { key, parseKey, type CellKey } from './puzzle';
import { parseEdgeKey, type EdgeKey } from './regions';

export interface RippleEdge {
  edge: EdgeKey;
  /** Hop count (in marked edges of the post-toggle graph) from the nearest toggled-edge endpoint. */
  distance: number;
}

/** `RippleEdge` used to be named `RecoloredEdge` — kept as an alias so nothing importing the old name breaks. */
export type RecoloredEdge = RippleEdge;

/**
 * BFS hop-distance (in cells), seeded at every toggled edge's endpoints,
 * over the post-toggle graph (`nextEdges`) — the shared traversal behind
 * both ripple functions below: how far a wave starting at the toggle
 * location has to travel to reach any other cell.
 */
function cellDistancesFromToggle(nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>): Map<CellKey, number> {
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
  return dist;
}

/** An edge's distance from the toggle: the closer of its two endpoints', or `undefined` if neither endpoint is reachable at all. */
function edgeDistance(dist: ReadonlyMap<CellKey, number>, ek: EdgeKey): number | undefined {
  const [a, b] = parseEdgeKey(ek);
  const da = dist.get(key(a[0], a[1]));
  const db = dist.get(key(b[0], b[1]));
  return da === undefined ? db : db === undefined ? da : Math.min(da, db);
}

/**
 * Given a region toggle's before/after edge sets plus each one's *actual
 * persistent display color* per edge (`componentColors.ts`'s
 * `snapshotEdgeColors`/`previewComponentColors` — not `edgeComponents.ts`'s
 * raw, iteration-order-assigned ids, see below), finds every *other*
 * still-marked edge (present both before and after — a toggled edge itself
 * is handled separately, as a grow/shrink, not a recolor) whose color
 * actually changed as a side effect of the toggle (a merge or split),
 * together with how many marked-edge hops it sits from the toggle location
 * in the post-toggle graph.
 *
 * This deliberately compares *persistent* colors rather than recomputing
 * `computeEdgeComponents` fresh on `prevEdges`/`nextEdges` and comparing
 * *those* raw ids, which is what an earlier version of this function did.
 * That raw-id comparison was only a proxy for "did this edge's component
 * identity change" — `computeEdgeComponents`'s ids are assigned purely by
 * Set-iteration order within each call (see its doc comment), which has no
 * necessary relationship to which side of a merge `componentColors.ts`'s
 * "blue (lowest color) wins" rule (or which side of a split its "larger
 * piece keeps the color" rule) actually keeps unchanged. Whenever a
 * puzzle's edges `Set` had been edited enough times that its current
 * insertion order no longer lined up with the order colors were originally
 * assigned in, the raw-id comparison could flag the *wrong* side of a
 * merge/split — rippling the component that already had the right color
 * while the one that actually changed silently snapped with no animation
 * at all. Comparing the real persistent colors instead has no such failure
 * mode, since it's exactly the same color assignment `render()` goes on to
 * display, not an independent stand-in for it.
 *
 * Only edges actually graph-reachable from the toggle are returned — this
 * naturally excludes an entirely unrelated component whose raw
 * `computeEdgeComponents` numbering might shift as an incidental side
 * effect of the merge/split elsewhere (its persistent color can't actually
 * change unless it's connected to the toggle, so the reachability check is
 * mostly a redundant safety net now, not the primary filter it used to be).
 */
export function computeRecoloredEdges(
  prevEdges: ReadonlySet<EdgeKey>,
  nextEdges: ReadonlySet<EdgeKey>,
  toggledEdges: ReadonlySet<EdgeKey>,
  prevColors: ReadonlyMap<EdgeKey, number>,
  nextColors: ReadonlyMap<EdgeKey, number>,
): RippleEdge[] {
  const dist = cellDistancesFromToggle(nextEdges, toggledEdges);

  const result: RippleEdge[] = [];
  for (const ek of nextEdges) {
    if (toggledEdges.has(ek) || !prevEdges.has(ek)) continue;
    const prevColor = prevColors.get(ek);
    const nextColor = nextColors.get(ek);
    if (prevColor === undefined || nextColor === undefined || prevColor === nextColor) continue;
    const distance = edgeDistance(dist, ek);
    if (distance === undefined) continue; // unreachable from the toggle -> shouldn't happen for a genuine color change, but keep the guard
    result.push({ edge: ek, distance });
  }
  return result;
}

/**
 * Every already-marked edge (present both before and after the toggle,
 * same as `computeRecoloredEdges`) that's graph-reachable from the toggle
 * location in the post-toggle graph, together with its hop distance —
 * *without* filtering by whether its component id happened to change.
 *
 * Used for the "whole loop turns green" celebration ripple on the winning
 * move: a win means the post-toggle graph is one single component covering
 * the entire board, so literally every previously-marked edge is about to
 * switch to the solved color regardless of its prior per-component
 * identity — `computeRecoloredEdges`'s id-comparison filter would (by
 * incidental id-numbering luck, not by design) skip whichever pre-existing
 * segment happens to keep component id 0, leaving a chunk of the board
 * jumping straight to green with no animation instead of rippling like the
 * rest.
 */
export function computeReachableEdges(prevEdges: ReadonlySet<EdgeKey>, nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>): RippleEdge[] {
  const dist = cellDistancesFromToggle(nextEdges, toggledEdges);

  const result: RippleEdge[] = [];
  for (const ek of nextEdges) {
    if (toggledEdges.has(ek) || !prevEdges.has(ek)) continue;
    const distance = edgeDistance(dist, ek);
    if (distance === undefined) continue;
    result.push({ edge: ek, distance });
  }
  return result;
}

export interface FarthestCell {
  cell: Cell;
  distance: number;
}

/**
 * The cell farthest (in marked-edge hops) from the toggle location, in the
 * post-toggle graph — i.e. where an outward ripple starting at the toggle
 * arrives last. Used to seed `main.ts`'s win-comet animation exactly where
 * the winning move's ripple (`computeReachableEdges`) finishes, once it
 * finishes. Returns `null` only if `toggledEdges` is empty (nothing to
 * measure distance from).
 */
export function computeFarthestCell(nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>): FarthestCell | null {
  const dist = cellDistancesFromToggle(nextEdges, toggledEdges);
  let best: FarthestCell | null = null;
  for (const [ck, d] of dist) {
    if (!best || d > best.distance) best = { cell: parseKey(ck), distance: d };
  }
  return best;
}
