import type { PathState } from './pathEdit';
import type { EdgeKey } from './regions';

export interface EncodedPathState {
  /** Sorted so encoding is deterministic (needed for `pathStateEquals`) — edge keys are self-describing coordinates, so no puzzle is needed to decode. */
  edges: EdgeKey[];
  won: boolean;
}

export function encodePathState(state: PathState): EncodedPathState {
  return { edges: [...state.edges].sort(), won: state.won };
}

export function decodePathState(encoded: EncodedPathState): PathState {
  return { edges: new Set(encoded.edges), won: encoded.won };
}

export function pathStateEquals(a: PathState, b: PathState): boolean {
  if (a.won !== b.won) return false;
  if (a.edges.size !== b.edges.size) return false;
  for (const e of a.edges) {
    if (!b.edges.has(e)) return false;
  }
  return true;
}
