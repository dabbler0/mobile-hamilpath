import { countCollectionEdges, key, totalCells, type CellKey, type Puzzle } from './puzzle';
import { parseEdgeKey, type EdgeKey, type RegionMap } from './regions';

export type { EdgeKey } from './regions';

export interface PathState {
  edges: Set<EdgeKey>;
  won: boolean;
}

export function createInitialPath(): PathState {
  return { edges: new Set(), won: false };
}

/**
 * A win is auto-detected the instant the marked-edge set is exactly one
 * Hamiltonian cycle: every cell has marked-degree 2, and (since toggling
 * regions can freely create branch points or leave the board fragmented)
 * all cells are reachable from one another via marked edges — this last
 * check is what rules out e.g. two disjoint sub-loops that would otherwise
 * each satisfy the degree-2 check — *and*, if the puzzle has any edge
 * collections (see `puzzle.ts`'s `EdgeCollection`), each one's marked count
 * matches its `required` count exactly, not just "a valid loop exists".
 */
export function computeWin(puzzle: Puzzle, edges: ReadonlySet<EdgeKey>): boolean {
  const total = totalCells(puzzle);
  if (edges.size !== total) return false;

  const neighbors = new Map<CellKey, CellKey[]>();
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    if (!neighbors.has(ka)) neighbors.set(ka, []);
    if (!neighbors.has(kb)) neighbors.set(kb, []);
    neighbors.get(ka)!.push(kb);
    neighbors.get(kb)!.push(ka);
  }
  if (neighbors.size !== total) return false;
  for (const list of neighbors.values()) {
    if (list.length !== 2) return false;
  }

  const start = neighbors.keys().next().value!;
  const seen = new Set<CellKey>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const nb of neighbors.get(cur)!) {
      if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }
  if (seen.size !== total) return false;

  for (const collection of puzzle.edgeCollections ?? []) {
    if (countCollectionEdges(collection, edges) !== collection.required) return false;
  }
  return true;
}

/**
 * A region toggle, as produced by `toggleRegion`: the exact set of edges
 * flipped. Self-inverse — applying the same op a second time flips them
 * right back — which is what makes undo/redo and replay simple: there's
 * no separate "inverse op" to compute, `applyPathOp` is its own undo.
 */
export type PathOp = { op: 'toggleRegion'; region: number; edges: EdgeKey[] };

/** Flips the presence of every edge in `op.edges` and recomputes `won`. */
export function applyPathOp(state: PathState, puzzle: Puzzle, op: PathOp): PathState {
  const edges = new Set(state.edges);
  for (const ek of op.edges) {
    if (edges.has(ek)) edges.delete(ek);
    else edges.add(ek);
  }
  return { edges, won: computeWin(puzzle, edges) };
}

export interface ToggleRegionResult {
  state: PathState;
  ops: PathOp[];
}

/** Toggles every boundary edge of `regionId`, marking any unmarked and unmarking any marked. */
export function toggleRegion(puzzle: Puzzle, regionMap: RegionMap, state: PathState, regionId: number): ToggleRegionResult {
  const region = regionMap.regions[regionId];
  const op: PathOp = { op: 'toggleRegion', region: regionId, edges: region.boundary };
  return { state: applyPathOp(state, puzzle, op), ops: [op] };
}
