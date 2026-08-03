import type { Cell } from './hamiltonianCycle';
import type { Puzzle } from './puzzle';
import type { Face } from './regions';

export interface Layout {
  cellSize: number;
  pad: number;
}

/** Maps a grid vertex to its pixel position within the (unscaled, unpanned) canvas. */
export function toScreen(cell: Cell, layout: Layout): [number, number] {
  return [layout.pad + cell[0] * layout.cellSize, layout.pad + cell[1] * layout.cellSize];
}

export function cellDist2(cell: Cell, px: number, py: number, layout: Layout): number {
  const [sx, sy] = toScreen(cell, layout);
  const dx = sx - px;
  const dy = sy - py;
  return dx * dx + dy * dy;
}

/** Inverse of `toScreen`: the vertex whose center is nearest (px, py), clamped to the W x H board. */
export function cellAt(px: number, py: number, layout: Layout, W: number, H: number): Cell {
  const x = Math.round((px - layout.pad) / layout.cellSize);
  const y = Math.round((py - layout.pad) / layout.cellSize);
  return [Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y))];
}

/** Maps a face (the grid square between four vertices, see `Face`) to the pixel position of its center. */
export function faceToScreen(face: Face, layout: Layout): [number, number] {
  return [layout.pad + (face[0] + 0.5) * layout.cellSize, layout.pad + (face[1] + 0.5) * layout.cellSize];
}

/** Inverse of `faceToScreen`-ish: the face whose square (px, py) falls inside, clamped to the (W-1) x (H-1) face grid. */
export function faceAt(px: number, py: number, layout: Layout, W: number, H: number): Face {
  const fx = Math.floor((px - layout.pad) / layout.cellSize);
  const fy = Math.floor((py - layout.pad) / layout.cellSize);
  return [Math.max(0, Math.min(W - 2, fx)), Math.max(0, Math.min(H - 2, fy))];
}

/** The full (untransformed) pixel size of the canvas needed to render a puzzle's grid. */
export function boardPixelSize(puzzle: Pick<Puzzle, 'W' | 'H'>, layout: Layout): { w: number; h: number } {
  return {
    w: (puzzle.W - 1) * layout.cellSize + layout.pad * 2,
    h: (puzzle.H - 1) * layout.cellSize + layout.pad * 2,
  };
}
