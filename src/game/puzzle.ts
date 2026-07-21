import type { Rng } from './rng';
import { generateHamiltonianCycle, type Cell } from './hamiltonianCycle';

export type CellKey = string;

export function key(x: number, y: number): CellKey {
  return `${x},${y}`;
}

export function parseKey(k: CellKey): Cell {
  const [x, y] = k.split(',').map(Number);
  return [x, y];
}

export interface Puzzle {
  /** Adjacency list keyed by "x,y", containing the solution cycle plus extra distractor edges. */
  adj: Map<CellKey, Set<CellKey>>;
  W: number;
  H: number;
  startCell: Cell;
}

export function totalCells(puzzle: Puzzle): number {
  return puzzle.W * puzzle.H;
}

/**
 * Builds a puzzle graph: a hidden Hamiltonian cycle over a W x H grid, plus
 * extra "distractor" edges between orthogonal neighbors (added independently
 * with probability `density`) so the solution isn't the only path visible.
 */
export function buildPuzzle(m: number, n: number, density: number, rng: Rng): Puzzle {
  const { cells, W, H } = generateHamiltonianCycle(m, n, rng);
  const adj = new Map<CellKey, Set<CellKey>>();
  const ensure = (k: CellKey) => {
    if (!adj.has(k)) adj.set(k, new Set());
  };
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    ensure(key(x1, y1));
    ensure(key(x2, y2));
    adj.get(key(x1, y1))!.add(key(x2, y2));
    adj.get(key(x2, y2))!.add(key(x1, y1));
  };

  for (let i = 0; i < cells.length; i++) {
    const [x1, y1] = cells[i];
    const [x2, y2] = cells[(i + 1) % cells.length];
    addEdge(x1, y1, x2, y2);
  }

  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      ensure(key(x, y));
      const rightK = key(x + 1, y);
      const downK = key(x, y + 1);
      if (x + 1 < W && !adj.get(key(x, y))!.has(rightK) && rng() < density) addEdge(x, y, x + 1, y);
      if (y + 1 < H && !adj.get(key(x, y))!.has(downK) && rng() < density) addEdge(x, y, x, y + 1);
    }
  }

  return { adj, W, H, startCell: cells[0] };
}
