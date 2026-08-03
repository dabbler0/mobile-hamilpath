import { describe, expect, it } from 'vitest';
import {
  boardPixelSize,
  cellAt,
  faceAt,
  faceToScreen,
  faceToScreenTiled,
  isWithinToroidalPrimaryTile,
  toroidalCanvasPixelSize,
  toroidalPrimaryTileOrigin,
  toScreen,
  toScreenTiled,
  TOROIDAL_TILE_COPIES,
  type Layout,
} from './geometry';

const layout: Layout = { cellSize: 10, pad: 5 };

describe('cellAt (ordinary board)', () => {
  it('clamps to the W x H board', () => {
    expect(cellAt(-100, -100, layout, 6, 8)).toEqual([0, 0]);
    expect(cellAt(1000, 1000, layout, 6, 8)).toEqual([5, 7]);
  });

  it('rounds to the nearest vertex', () => {
    expect(cellAt(5 + 3 * 10, 5 + 3 * 10, layout, 6, 8)).toEqual([3, 3]);
  });
});

describe('cellAt (toroidal board)', () => {
  it('wraps instead of clamping', () => {
    // One tile-width to the left of the board (x = -6) should wrap to column 0.
    const [x, y] = cellAt(5 - 6 * 10, 5, layout, 6, 8, true);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('a pixel inside the halo one tile over resolves to the same canonical cell as its primary-tile counterpart', () => {
    const primary = cellAt(5 + 2 * 10, 5 + 3 * 10, layout, 6, 8, true);
    const haloed = cellAt(5 + (2 + 6) * 10, 5 + (3 + 8) * 10, layout, 6, 8, true);
    expect(haloed).toEqual(primary);
  });
});

describe('faceAt (ordinary board)', () => {
  it('clamps to the (W-1) x (H-1) face grid', () => {
    expect(faceAt(-100, -100, layout, 6, 8)).toEqual([0, 0]);
    expect(faceAt(1000, 1000, layout, 6, 8)).toEqual([4, 6]);
  });
});

describe('faceAt (toroidal board)', () => {
  it('wraps over the full W x H face grid', () => {
    expect(faceAt(5 - 6 * 10, 5, layout, 6, 8, true)).toEqual([0, 0]);
    expect(faceAt(5 + (5 + 6) * 10, 5, layout, 6, 8, true)).toEqual([5, 0]);
  });
});

describe('toScreenTiled / faceToScreenTiled', () => {
  it('matches toScreen/faceToScreen at tile index (0,0)', () => {
    expect(toScreenTiled([2, 3], layout, 0, 0, 6, 8)).toEqual(toScreen([2, 3], layout));
    expect(faceToScreenTiled([2, 3], layout, 0, 0, 6, 8)).toEqual(faceToScreen([2, 3], layout));
  });

  it('shifts by exactly one tile period per tile index', () => {
    const a = toScreenTiled([1, 1], layout, 0, 0, 6, 8);
    const b = toScreenTiled([1, 1], layout, 1, 1, 6, 8);
    expect(b[0] - a[0]).toBe(6 * layout.cellSize);
    expect(b[1] - a[1]).toBe(8 * layout.cellSize);
  });
});

describe('toroidalCanvasPixelSize / toroidalPrimaryTileOrigin', () => {
  it('is TOROIDAL_TILE_COPIES times the single-tile span (minus double-counted padding)', () => {
    const puzzle = { W: 6, H: 8 };
    const single = boardPixelSize(puzzle, layout);
    const haloed = toroidalCanvasPixelSize(puzzle, layout);
    expect(haloed.w).toBe((TOROIDAL_TILE_COPIES * puzzle.W - 1) * layout.cellSize + layout.pad * 2);
    expect(haloed.w).toBeGreaterThan(single.w);
  });

  it('centers the primary tile at the middle tile index', () => {
    const puzzle = { W: 6, H: 8 };
    const origin = toroidalPrimaryTileOrigin(puzzle, layout);
    expect(origin.x).toBe(1 * puzzle.W * layout.cellSize);
    expect(origin.y).toBe(1 * puzzle.H * layout.cellSize);
  });
});

describe('isWithinToroidalPrimaryTile', () => {
  const puzzle = { W: 6, H: 8 };

  it('is true for a pixel inside the primary (middle) tile copy', () => {
    const [sx, sy] = toScreenTiled([2, 3], layout, 1, 1, puzzle.W, puzzle.H);
    expect(isWithinToroidalPrimaryTile(sx, sy, layout, puzzle)).toBe(true);
    // Just inside the primary tile's near edge.
    const origin = toroidalPrimaryTileOrigin(puzzle, layout);
    expect(isWithinToroidalPrimaryTile(layout.pad + origin.x, layout.pad + origin.y, layout, puzzle)).toBe(true);
  });

  it('is false for a pixel in a neighboring halo copy', () => {
    const [sx, sy] = toScreenTiled([2, 3], layout, 0, 1, puzzle.W, puzzle.H);
    expect(isWithinToroidalPrimaryTile(sx, sy, layout, puzzle)).toBe(false);
    const [sx2, sy2] = toScreenTiled([2, 3], layout, 2, 1, puzzle.W, puzzle.H);
    expect(isWithinToroidalPrimaryTile(sx2, sy2, layout, puzzle)).toBe(false);
  });

  it('is false exactly at the primary tile boundary (one period past its origin)', () => {
    const origin = toroidalPrimaryTileOrigin(puzzle, layout);
    const rightEdge = layout.pad + origin.x + puzzle.W * layout.cellSize;
    expect(isWithinToroidalPrimaryTile(rightEdge, layout.pad + origin.y, layout, puzzle)).toBe(false);
  });
});
