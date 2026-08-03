import { describe, expect, it } from 'vitest';
import { cellAt, faceAt, faceToScreen, faceToScreenTiled, toScreen, toScreenTiled, type Layout } from './geometry';
import { IDENTITY_ORIENTATION, KLEIN_BOTTLE, PROJECTIVE_PLANE, TORUS } from './topology';

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

describe('cellAt (torus board)', () => {
  it('wraps instead of clamping', () => {
    // One tile-width to the left of the board (x = -6) should wrap to column 0.
    const [x, y] = cellAt(5 - 6 * 10, 5, layout, 6, 8, TORUS);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('a pixel one tile over resolves to the same canonical cell as the primary tile (no mirroring, torus)', () => {
    const primary = cellAt(5 + 2 * 10, 5 + 3 * 10, layout, 6, 8, TORUS);
    const nextTile = cellAt(5 + (2 + 6) * 10, 5 + (3 + 8) * 10, layout, 6, 8, TORUS);
    expect(nextTile).toEqual(primary);
  });
});

describe('cellAt (klein/projective board — mirrored tiles)', () => {
  it('a pixel one tile down resolves to the x-mirrored cell for a Klein bottle board', () => {
    const primary = cellAt(5 + 2 * 10, 5 + 3 * 10, layout, 6, 8, KLEIN_BOTTLE);
    // Tile (0,1) has orientation flipX per KLEIN_BOTTLE.tileOrientation(0,1).
    const oneTileDown = cellAt(5 + 2 * 10, 5 + (3 + 8) * 10, layout, 6, 8, KLEIN_BOTTLE);
    expect(oneTileDown).toEqual([6 - 1 - primary[0], primary[1]]);
  });

  it('a pixel one tile right resolves to the y-mirrored cell for a projective plane board', () => {
    const primary = cellAt(5 + 2 * 10, 5 + 3 * 10, layout, 6, 8, PROJECTIVE_PLANE);
    const oneTileRight = cellAt(5 + (2 + 6) * 10, 5 + 3 * 10, layout, 6, 8, PROJECTIVE_PLANE);
    expect(oneTileRight).toEqual([primary[0], 8 - 1 - primary[1]]);
  });
});

describe('faceAt (ordinary board)', () => {
  it('clamps to the (W-1) x (H-1) face grid', () => {
    expect(faceAt(-100, -100, layout, 6, 8)).toEqual([0, 0]);
    expect(faceAt(1000, 1000, layout, 6, 8)).toEqual([4, 6]);
  });
});

describe('faceAt (torus board)', () => {
  it('wraps over the full W x H face grid', () => {
    expect(faceAt(5 - 6 * 10, 5, layout, 6, 8, TORUS)).toEqual([0, 0]);
    expect(faceAt(5 + (5 + 6) * 10, 5, layout, 6, 8, TORUS)).toEqual([5, 0]);
  });
});

describe('toScreenTiled / faceToScreenTiled', () => {
  it('matches toScreen/faceToScreen at tile index (0,0) with identity orientation', () => {
    expect(toScreenTiled([2, 3], layout, 0, 0, 6, 8, IDENTITY_ORIENTATION)).toEqual(toScreen([2, 3], layout));
    expect(faceToScreenTiled([2, 3], layout, 0, 0, 6, 8, IDENTITY_ORIENTATION)).toEqual(faceToScreen([2, 3], layout));
  });

  it('shifts by exactly one tile period per tile index', () => {
    const a = toScreenTiled([1, 1], layout, 0, 0, 6, 8, IDENTITY_ORIENTATION);
    const b = toScreenTiled([1, 1], layout, 1, 1, 6, 8, IDENTITY_ORIENTATION);
    expect(b[0] - a[0]).toBe(6 * layout.cellSize);
    expect(b[1] - a[1]).toBe(8 * layout.cellSize);
  });

  it('mirrors within the tile when given a flipped orientation', () => {
    const unflipped = toScreenTiled([1, 3], layout, 0, 0, 6, 8, IDENTITY_ORIENTATION);
    const flippedX = toScreenTiled([1, 3], layout, 0, 0, 6, 8, { flipX: true, flipY: false });
    // Mirrored around the tile's x-midline: local x=1 maps to local x=6-1-1=4.
    expect(flippedX[0]).toBe(layout.pad + 4 * layout.cellSize);
    expect(flippedX[1]).toBe(unflipped[1]);
  });

  it('is consistent between toScreenTiled and faceToScreenTiled: a mirrored cell and mirrored face agree on direction', () => {
    const cellA = toScreenTiled([0, 0], layout, 0, 0, 6, 8, { flipX: true, flipY: false });
    const cellB = toScreenTiled([5, 0], layout, 0, 0, 6, 8, { flipX: true, flipY: false });
    // Flipping x should reverse which endpoint is further right.
    expect(cellA[0]).toBeGreaterThan(cellB[0]);
  });
});
