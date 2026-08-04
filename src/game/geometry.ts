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
 * Unlike `cellAt`, un-mirroring a *face* index isn't a plain point
 * reflection: a face identifies a unit-width span (fx to fx+1), not a
 * point, so once mirrored by an orientation-reversing seam its correct
 * image is an *interval* reflection (`W - 2 - local`), one less than the
 * point reflection (`W - 1 - local`) a vertex uses — see `regions.ts`'s
 * `faceNeighbor` doc comment, which derives this from inverting
 * `faceToScreenTiled`'s own forward formula. Using the vertex-style point
 * reflection here was a real bug: every tap on a mirrored tile (i.e. every
 * tile except the primary one) resolved to a face shifted over by one,
 * so the highlighted/toggled region didn't match what was tapped.
 */
export function faceAt(px: number, py: number, layout: Layout, W: number, H: number, topology?: Topology): Face {
  const rawFx = Math.floor((px - layout.pad) / layout.cellSize);
  const rawFy = Math.floor((py - layout.pad) / layout.cellSize);
  if (!topology) return [Math.max(0, Math.min(W - 2, rawFx)), Math.max(0, Math.min(H - 2, rawFy))];
  const tileX = Math.floor(rawFx / W);
  const tileY = Math.floor(rawFy / H);
  const localFx = rawFx - tileX * W;
  const localFy = rawFy - tileY * H;
  const o = topology.tileOrientation(tileX, tileY);
  return [o.flipX ? wrapIndex(W - 2 - localFx, W) : localFx, o.flipY ? wrapIndex(H - 2 - localFy, H) : localFy];
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

/**
 * The tile a wrap edge's far endpoint actually renders in, given the
 * orientation of the tile its *near* endpoint (`from`) is drawn in and the
 * `tileDX`/`tileDY` `render.ts`'s `classifyEdge` computed for that edge.
 *
 * `classifyEdge`'s `tileDX`/`tileDY` are computed once, independent of any
 * particular tile, in terms of the puzzle's *canonical* (unmirrored) wrap
 * direction — e.g. `tileDX` is `+1` for a rightward wrap because that's the
 * direction the puzzle's own coordinates cross the seam in. But if the near
 * endpoint is actually being drawn in a tile that's mirrored along that
 * axis, canonical "rightward" renders going *left* on screen, so the far
 * endpoint's tile is the mirror image of what `tileDX`/`tileDY` naively
 * suggest — it's `tileX - tileDX`, not `tileX + tileDX`. Skipping this
 * correction was a real bug: on any tile row/column whose orientation is
 * flipped, a wrap edge's far endpoint landed many cells away instead of
 * one, rendering as a long, obviously-wrong line (this is what produced
 * spurious-looking candidate/marked edges on Klein bottle and projective
 * plane boards away from the primary, unmirrored tile — see
 * `geometry.test.ts`'s `wrapToTile` tests for the concrete numbers).
 */
export function wrapToTile(fromOrientation: Orientation, tileX: number, tileY: number, tileDX: number, tileDY: number): [number, number] {
  return [tileX + (fromOrientation.flipX ? -tileDX : tileDX), tileY + (fromOrientation.flipY ? -tileDY : tileDY)];
}
