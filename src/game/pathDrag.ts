import { cellDist2, type Layout } from './geometry';
import type { Cell } from './hamiltonianCycle';
import { key, parseKey, totalCells, type CellKey, type Puzzle } from './puzzle';

export type DragEnd = 'head' | 'tail';

export interface PathState {
  path: Cell[];
  won: boolean;
}

export function createInitialPath(puzzle: Puzzle): PathState {
  return { path: [puzzle.startCell], won: false };
}

/**
 * Decides whether a pointer-down near (px, py) grabs the path's head, tail,
 * or neither. When the path is a single cell, only "tail" is offered (there's
 * no distinct head yet).
 */
export function tryStartPathDrag(path: readonly Cell[], px: number, py: number, layout: Layout): DragEnd | null {
  const head = path[0];
  const tail = path[path.length - 1];
  const dHead = cellDist2(head, px, py, layout);
  const dTail = cellDist2(tail, px, py, layout);
  const pickRadius = layout.cellSize * 0.9;
  const pickRadius2 = pickRadius * pickRadius;

  if (path.length === 1) {
    return dHead < pickRadius2 ? 'tail' : null;
  }
  if (dHead < dTail && dHead < pickRadius2) return 'head';
  if (dTail <= dHead && dTail < pickRadius2) return 'tail';
  return null;
}

/**
 * Advances the dragged endpoint towards the pointer, one adjacent cell at a
 * time: extends onto new cells, retracts back over the cell it just came
 * from, and detects a win when the other endpoint is reached having visited
 * every cell. Repeats until the pointer no longer pulls the endpoint any
 * closer to a neighbor than staying put.
 */
export function updatePathDrag(
  puzzle: Puzzle,
  path: readonly Cell[],
  won: boolean,
  dragEnd: DragEnd,
  px: number,
  py: number,
  layout: Layout,
): PathState {
  const workingPath = path.map((c): Cell => [c[0], c[1]]);
  let nextWon = won;
  let progressed = true;
  let guard = 0;

  while (progressed && guard < 400) {
    progressed = false;
    guard++;
    const isHead = dragEnd === 'head';
    const endpoint = isHead ? workingPath[0] : workingPath[workingPath.length - 1];
    const endpointKey = key(endpoint[0], endpoint[1]);
    const neighbors = puzzle.adj.get(endpointKey);
    if (!neighbors) break;

    let bestKey: CellKey = endpointKey;
    let bestDist = cellDist2(endpoint, px, py, layout);
    for (const nk of neighbors) {
      const d = cellDist2(parseKey(nk), px, py, layout);
      if (d < bestDist) {
        bestDist = d;
        bestKey = nk;
      }
    }
    if (bestKey === endpointKey) break;

    const [bx, by] = parseKey(bestKey);
    const inPathIdx = workingPath.findIndex((c) => c[0] === bx && c[1] === by);

    if (inPathIdx === -1) {
      if (isHead) workingPath.unshift([bx, by]);
      else workingPath.push([bx, by]);
      progressed = true;
    } else {
      const predIdx = isHead ? 1 : workingPath.length - 2;
      if (predIdx >= 0 && inPathIdx === predIdx) {
        if (isHead) workingPath.shift();
        else workingPath.pop();
        progressed = true;
      } else {
        const otherEndIdx = isHead ? workingPath.length - 1 : 0;
        if (inPathIdx === otherEndIdx && workingPath.length === totalCells(puzzle)) {
          nextWon = true;
        }
      }
    }
  }

  return { path: workingPath, won: nextWon };
}
