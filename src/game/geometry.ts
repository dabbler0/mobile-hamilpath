import type { Cell } from './hamiltonianCycle';
import type { Puzzle } from './puzzle';
import type { Face } from './regions';
import type { Orientation, Topology } from './topology';

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
 * ordinary board this clamps to the W x H board. On a wraparound board
 * (`topology` given), the board renders as a seamlessly-repeating,
 * genuinely-unbounded tiling (see `render.ts`) — `px,py` could be anywhere
 * in any repeated tile copy, and each copy past the first may render
 * mirrored (see `topology.tileOrientation`), so resolving it back to a
 * canonical cell means finding which tile it's in, then un-mirroring.
 */
export function cellAt(px: number, py: number, layout: Layout, W: number, H: number, topology?: Topology): Cell {
  const rawX = Math.round((px - layout.pad) / layout.cellSize);
  const rawY = Math.round((py - layout.pad) / layout.cellSize);
  if (!topology) return [Math.max(0, Math.min(W - 1, rawX)), Math.max(0, Math.min(H - 1, rawY))];
  const tileX = Math.floor(rawX / W);
  const tileY = Math.floor(rawY / H);
  const localX = rawX - tileX * W;
  const localY = rawY - tileY * H;
  const o = topology.tileOrientation(tileX, tileY);
  return [o.flipX ? W - 1 - localX : localX, o.flipY ? H - 1 - localY : localY];
}

/** Maps a face (the grid square between four vertices, see `Face`) to the pixel position of its center. */
export function faceToScreen(face: Face, layout: Layout): [number, number] {
  return [layout.pad + (face[0] + 0.5) * layout.cellSize, layout.pad + (face[1] + 0.5) * layout.cellSize];
}

/**
 * Inverse of `faceToScreen`-ish: the face whose square (px, py) falls
 * inside. On an ordinary board this clamps to the (W-1) x (H-1) face grid;
 * on a wraparound board every face in the full W x H grid exists (see
 * `regions.ts`) and the board tiles infinitely, so this resolves the same
 * way `cellAt` does — which (possibly-mirrored) tile, then un-mirror.
 *
 * Two things make this trickier than `cellAt`, both regression-tested
 * below (a real, reported bug: tapping inside a face in a mirrored tile —
 * or the region-highlight that tracks the pointer — resolved to the wrong
 * face, off by one, in Klein bottle/projective tiles of certain parities):
 *
 *  - The un-mirroring is *not* a plain `W - 1 - localFx` point reflection
 *    the way `cellAt`'s is: a vertex is a point, so reflecting it about the
 *    tile's mirror line is exactly that. A face is a unit-width *span*
 *    (`[fx, fx+1)`), so its correctly-mirrored image is the interval
 *    `[W-2-fx, W-1-fx)` — one less than the point reflection — which is
 *    why `faceToScreenTiled` below renders a mirrored face's center at
 *    `W-1-(face+0.5)`, not `W-1-face`.
 *  - That interval shift means a *flipped* tile's faces occupy local slots
 *    `[-1, W-2]` rather than `[0, W)` — so the naive `tileX = floor(rawFx /
 *    W)` can name the wrong tile for a pixel right at that boundary (its
 *    true tile is one more along that axis). Whether a tile is flipped
 *    depends on the *other* axis's tile index (`tileOrientation`'s flipX
 *    depends on tileY and vice versa for projective), so getting tileX
 *    wrong can flip which flipY applies too — there's no way to resolve
 *    the two axes independently. Instead, try the (at most 4) tile
 *    candidates the shift could possibly point to and keep whichever one's
 *    own orientation makes its local coordinates land in its actual
 *    occupied range.
 */
export function faceAt(px: number, py: number, layout: Layout, W: number, H: number, topology?: Topology): Face {
  const rawFx = Math.floor((px - layout.pad) / layout.cellSize);
  const rawFy = Math.floor((py - layout.pad) / layout.cellSize);
  if (!topology) return [Math.max(0, Math.min(W - 2, rawFx)), Math.max(0, Math.min(H - 2, rawFy))];
  const tileX0 = Math.floor(rawFx / W);
  const tileY0 = Math.floor(rawFy / H);
  for (const tileX of [tileX0, tileX0 + 1]) {
    for (const tileY of [tileY0, tileY0 + 1]) {
      const localX = rawFx - tileX * W;
      const localY = rawFy - tileY * H;
      const o = topology.tileOrientation(tileX, tileY);
      const validX = o.flipX ? localX >= -1 && localX <= W - 2 : localX >= 0 && localX < W;
      const validY = o.flipY ? localY >= -1 && localY <= H - 2 : localY >= 0 && localY < H;
      if (!validX || !validY) continue;
      return [o.flipX ? W - 2 - localX : localX, o.flipY ? H - 2 - localY : localY];
    }
  }
  // Unreachable: the four (tileX0 | tileX0+1) x (tileY0 | tileY0+1)
  // candidates always contain exactly one valid decomposition.
  return [tileX0 >= 0 ? 0 : W - 1, tileY0 >= 0 ? 0 : H - 1];
}

/** The full (untransformed) pixel size of a single board tile's grid — the whole canvas for an ordinary board, or one repeated tile's span for a wraparound board (see `render.ts`). */
export function boardPixelSize(puzzle: Pick<Puzzle, 'W' | 'H'>, layout: Layout): { w: number; h: number } {
  return {
    w: (puzzle.W - 1) * layout.cellSize + layout.pad * 2,
    h: (puzzle.H - 1) * layout.cellSize + layout.pad * 2,
  };
}

/**
 * Screen position of a cell within one specific repeated tile copy
 * (`tileX`/`tileY`, 0 = the primary tile, any integer beyond that a further
 * repeat in either direction — see `render.ts`) of a wraparound board,
 * mirrored per `orientation` (identity for a torus, but a Klein
 * bottle/projective plane's tiles alternate — see `topology.ts`).
 */
export function toScreenTiled(cell: Cell, layout: Layout, tileX: number, tileY: number, W: number, H: number, orientation: Orientation): [number, number] {
  const lx = orientation.flipX ? W - 1 - cell[0] : cell[0];
  const ly = orientation.flipY ? H - 1 - cell[1] : cell[1];
  return [layout.pad + (tileX * W + lx) * layout.cellSize, layout.pad + (tileY * H + ly) * layout.cellSize];
}

/** Screen position of a face's center within one specific repeated tile copy of a wraparound board (see `toScreenTiled`). */
export function faceToScreenTiled(face: Face, layout: Layout, tileX: number, tileY: number, W: number, H: number, orientation: Orientation): [number, number] {
  const cx = orientation.flipX ? W - 1 - (face[0] + 0.5) : face[0] + 0.5;
  const cy = orientation.flipY ? H - 1 - (face[1] + 0.5) : face[1] + 0.5;
  return [layout.pad + (tileX * W + cx) * layout.cellSize, layout.pad + (tileY * H + cy) * layout.cellSize];
}
