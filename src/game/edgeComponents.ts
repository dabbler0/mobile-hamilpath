import { key, type CellKey } from './puzzle';
import { parseEdgeKey, type EdgeKey } from './regions';

/**
 * Groups marked edges into connected components (segments/cycles joined by a
 * shared cell), so the renderer can color each one differently — otherwise
 * it's hard to tell at a glance whether two marked edges belong to the same
 * in-progress path or two unrelated ones. Returns a component id per edge;
 * ids are small non-negative integers assigned in iteration order of
 * `edges`, meaningful only for distinguishing components within one call
 * (not stable across edits — a merge/split changes ids).
 */
export function computeEdgeComponents(edges: ReadonlySet<EdgeKey>): Map<EdgeKey, number> {
  const parent = new Map<CellKey, CellKey>();

  function find(k: CellKey): CellKey {
    let root = k;
    while (parent.has(root)) root = parent.get(root)!;
    let cur = k;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: CellKey, b: CellKey): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    union(key(a[0], a[1]), key(b[0], b[1]));
  }

  const rootToComponent = new Map<CellKey, number>();
  const edgeToComponent = new Map<EdgeKey, number>();
  for (const ek of edges) {
    const [a] = parseEdgeKey(ek);
    const root = find(key(a[0], a[1]));
    let component = rootToComponent.get(root);
    if (component === undefined) {
      component = rootToComponent.size;
      rootToComponent.set(root, component);
    }
    edgeToComponent.set(ek, component);
  }
  return edgeToComponent;
}
