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

export function wrapIndex(v: number, size: number): number {
  return ((v % size) + size) % size;
}

/**
 * Inverse of `toScreen`: the vertex whose center is nearest (px, py). On an
 * ordinary board this clamps to the W x H board; on a toroidal board there's
 * no edge to clamp to — any pixel position (including one inside the
 * repeated-tile halo, see `toScreenTiled`) wraps back onto the canonical
 * W x H board via modulo instead.
 */
export function cellAt(px: number, py: number, layout: Layout, W: number, H: number, toroidal = false): Cell {
  const x = Math.round((px - layout.pad) / layout.cellSize);
  const y = Math.round((py - layout.pad) / layout.cellSize);
  if (toroidal) return [wrapIndex(x, W), wrapIndex(y, H)];
  return [Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y))];
}

/** Maps a face (the grid square between four vertices, see `Face`) to the pixel position of its center. */
export function faceToScreen(face: Face, layout: Layout): [number, number] {
  return [layout.pad + (face[0] + 0.5) * layout.cellSize, layout.pad + (face[1] + 0.5) * layout.cellSize];
}

/**
 * Inverse of `faceToScreen`-ish: the face whose square (px, py) falls
 * inside. On an ordinary board this clamps to the (W-1) x (H-1) face grid;
 * on a toroidal board every face in the full W x H grid exists (see
 * `regions.ts`), so it wraps via modulo instead.
 */
export function faceAt(px: number, py: number, layout: Layout, W: number, H: number, toroidal = false): Face {
  const fx = Math.floor((px - layout.pad) / layout.cellSize);
  const fy = Math.floor((py - layout.pad) / layout.cellSize);
  if (toroidal) return [wrapIndex(fx, W), wrapIndex(fy, H)];
  return [Math.max(0, Math.min(W - 2, fx)), Math.max(0, Math.min(H - 2, fy))];
}

/** The full (untransformed) pixel size of the canvas needed to render a single (non-toroidal) puzzle's grid. */
export function boardPixelSize(puzzle: Pick<Puzzle, 'W' | 'H'>, layout: Layout): { w: number; h: number } {
  return {
    w: (puzzle.W - 1) * layout.cellSize + layout.pad * 2,
    h: (puzzle.H - 1) * layout.cellSize + layout.pad * 2,
  };
}

/**
 * A toroidal board is rendered as the one playable primary tile surrounded
 * by its 8 neighboring copies, dimmed and non-interactive (see `render.ts`,
 * `isWithinToroidalPrimaryTile`) — there just to make the wraparound and the
 * board's true size legible at a glance, not to imply an actually-infinite
 * scrolling board. `TOROIDAL_TILE_COPIES` tile copies are drawn per axis
 * (a halo of copies around the one primary tile), indexed
 * 0..TOROIDAL_TILE_COPIES-1 with the primary tile at the middle index.
 */
export const TOROIDAL_TILE_COPIES = 3;

/** 0-indexed tile-copy coordinate of the one interactive, full-opacity tile — see `TOROIDAL_TILE_COPIES`. */
export const TOROIDAL_PRIMARY_TILE_INDEX = Math.floor(TOROIDAL_TILE_COPIES / 2);

/** Screen position of a cell within one specific repeated tile copy (`tileX`/`tileY`, 0-indexed — see `TOROIDAL_TILE_COPIES`) of a toroidal board. */
export function toScreenTiled(cell: Cell, layout: Layout, tileX: number, tileY: number, W: number, H: number): [number, number] {
  return [layout.pad + (tileX * W + cell[0]) * layout.cellSize, layout.pad + (tileY * H + cell[1]) * layout.cellSize];
}

/** Screen position of a face's center within one specific repeated tile copy of a toroidal board (see `toScreenTiled`). */
export function faceToScreenTiled(face: Face, layout: Layout, tileX: number, tileY: number, W: number, H: number): [number, number] {
  return [layout.pad + (tileX * W + face[0] + 0.5) * layout.cellSize, layout.pad + (tileY * H + face[1] + 0.5) * layout.cellSize];
}

/** The full pixel size of the haloed canvas needed to render a toroidal puzzle's repeated tiling (see `TOROIDAL_TILE_COPIES`). */
export function toroidalCanvasPixelSize(puzzle: Pick<Puzzle, 'W' | 'H'>, layout: Layout): { w: number; h: number } {
  const n = TOROIDAL_TILE_COPIES;
  return {
    w: (n * puzzle.W - 1) * layout.cellSize + layout.pad * 2,
    h: (n * puzzle.H - 1) * layout.cellSize + layout.pad * 2,
  };
}

/** The pixel offset, within the haloed toroidal canvas, of the primary (center) tile copy's origin — what a toroidal board's view should be fit/centered on, rather than the whole haloed canvas. */
export function toroidalPrimaryTileOrigin(puzzle: Pick<Puzzle, 'W' | 'H'>, layout: Layout): { x: number; y: number } {
  return { x: TOROIDAL_PRIMARY_TILE_INDEX * puzzle.W * layout.cellSize, y: TOROIDAL_PRIMARY_TILE_INDEX * puzzle.H * layout.cellSize };
}

/** Whether a canvas-local pixel position falls within the one interactive primary tile of a toroidal board (as opposed to its dimmed, non-interactive halo) — see `TOROIDAL_TILE_COPIES`. */
export function isWithinToroidalPrimaryTile(px: number, py: number, layout: Layout, puzzle: Pick<Puzzle, 'W' | 'H'>): boolean {
  const origin = toroidalPrimaryTileOrigin(puzzle, layout);
  const left = layout.pad + origin.x;
  const top = layout.pad + origin.y;
  return px >= left && px < left + puzzle.W * layout.cellSize && py >= top && py < top + puzzle.H * layout.cellSize;
}
