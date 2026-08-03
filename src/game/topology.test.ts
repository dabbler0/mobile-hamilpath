import { describe, expect, it } from 'vitest';
import { composeOrientation, IDENTITY_ORIENTATION, KLEIN_BOTTLE, PROJECTIVE_PLANE, TORUS, topologyFor, wrappedNeighbor, type Orientation, type Topology } from './topology';

const W = 6;
const H = 8;

describe('TORUS', () => {
  it('wraps straight with no orientation change, both axes', () => {
    expect(TORUS.wrapX(W, 3, W, H)).toEqual({ x: 0, y: 3, flip: IDENTITY_ORIENTATION });
    expect(TORUS.wrapX(-1, 3, W, H)).toEqual({ x: W - 1, y: 3, flip: IDENTITY_ORIENTATION });
    expect(TORUS.wrapY(2, H, W, H)).toEqual({ x: 2, y: 0, flip: IDENTITY_ORIENTATION });
    expect(TORUS.wrapY(2, -1, W, H)).toEqual({ x: 2, y: H - 1, flip: IDENTITY_ORIENTATION });
  });

  it('every tile copy has identity orientation', () => {
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [3, -2],
      [5, 7],
    ]) {
      expect(TORUS.tileOrientation(tx, ty)).toEqual(IDENTITY_ORIENTATION);
    }
  });
});

describe('KLEIN_BOTTLE', () => {
  it('wraps x straight (like a torus)', () => {
    expect(KLEIN_BOTTLE.wrapX(W, 3, W, H)).toEqual({ x: 0, y: 3, flip: IDENTITY_ORIENTATION });
    expect(KLEIN_BOTTLE.wrapX(-1, 3, W, H)).toEqual({ x: W - 1, y: 3, flip: IDENTITY_ORIENTATION });
  });

  it('wraps y with an x-flip', () => {
    const down = KLEIN_BOTTLE.wrapY(2, H, W, H);
    expect(down).toEqual({ x: W - 1 - 2, y: 0, flip: { flipX: true, flipY: false } });
    const up = KLEIN_BOTTLE.wrapY(2, -1, W, H);
    expect(up).toEqual({ x: W - 1 - 2, y: H - 1, flip: { flipX: true, flipY: false } });
  });

  it('crossing the y-seam twice (down then back up) returns to the original position with identity orientation', () => {
    const x0 = 2;
    const y0 = H - 1;
    const down = KLEIN_BOTTLE.wrapY(x0, H, W, H); // steps off the bottom
    const back = KLEIN_BOTTLE.wrapY(down.x, -1, W, H); // steps off the top from there
    expect(back.x).toBe(x0);
    expect(back.y).toBe(y0);
    expect(composeOrientation(down.flip, back.flip)).toEqual(IDENTITY_ORIENTATION);
  });

  it("tileOrientation depends only on tileY's parity", () => {
    expect(KLEIN_BOTTLE.tileOrientation(0, 0)).toEqual(IDENTITY_ORIENTATION);
    expect(KLEIN_BOTTLE.tileOrientation(5, 0)).toEqual(IDENTITY_ORIENTATION);
    expect(KLEIN_BOTTLE.tileOrientation(0, 1)).toEqual({ flipX: true, flipY: false });
    expect(KLEIN_BOTTLE.tileOrientation(3, 1)).toEqual({ flipX: true, flipY: false });
    expect(KLEIN_BOTTLE.tileOrientation(0, 2)).toEqual(IDENTITY_ORIENTATION);
    expect(KLEIN_BOTTLE.tileOrientation(0, -1)).toEqual({ flipX: true, flipY: false });
  });
});

describe('PROJECTIVE_PLANE', () => {
  it('wraps x with a y-flip', () => {
    const right = PROJECTIVE_PLANE.wrapX(W, 3, W, H);
    expect(right).toEqual({ x: 0, y: H - 1 - 3, flip: { flipX: false, flipY: true } });
  });

  it('wraps y with an x-flip', () => {
    const down = PROJECTIVE_PLANE.wrapY(2, H, W, H);
    expect(down).toEqual({ x: W - 1 - 2, y: 0, flip: { flipX: true, flipY: false } });
  });

  it('crossing the x-seam twice returns to the original position with identity orientation', () => {
    const y0 = 3;
    const right = PROJECTIVE_PLANE.wrapX(W, y0, W, H); // steps off the right edge
    const back = PROJECTIVE_PLANE.wrapX(-1, right.y, W, H); // steps off the left from there
    expect(back.y).toBe(y0);
    expect(composeOrientation(right.flip, back.flip)).toEqual(IDENTITY_ORIENTATION);
  });

  it('crossing the y-seam twice returns to the original position with identity orientation', () => {
    const x0 = 2;
    const down = PROJECTIVE_PLANE.wrapY(x0, H, W, H); // steps off the bottom edge
    const back = PROJECTIVE_PLANE.wrapY(down.x, -1, W, H); // steps off the top from there
    expect(back.x).toBe(x0);
    expect(composeOrientation(down.flip, back.flip)).toEqual(IDENTITY_ORIENTATION);
  });

  it('tileOrientation depends on the parity of both tileX and tileY independently', () => {
    expect(PROJECTIVE_PLANE.tileOrientation(0, 0)).toEqual(IDENTITY_ORIENTATION);
    expect(PROJECTIVE_PLANE.tileOrientation(1, 0)).toEqual({ flipX: false, flipY: true });
    expect(PROJECTIVE_PLANE.tileOrientation(0, 1)).toEqual({ flipX: true, flipY: false });
    expect(PROJECTIVE_PLANE.tileOrientation(1, 1)).toEqual({ flipX: true, flipY: true });
    expect(PROJECTIVE_PLANE.tileOrientation(2, 2)).toEqual(IDENTITY_ORIENTATION);
  });
});

describe('tileOrientation matches step-by-step composition of the wrap rules', () => {
  /**
   * The critical invariant rendering relies on: hopping tile-by-tile via
   * repeated wraps (composing each hop's orientation delta in sequence)
   * must agree with the closed-form `tileOrientation(tileX, tileY)`,
   * regardless of path, since Z2 x Z2 is abelian.
   */
  function simulateTileOrientation(topology: Topology, tileX: number, tileY: number): Orientation {
    let o = IDENTITY_ORIENTATION;
    const stepX = tileX >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(tileX); i++) {
      const result = stepX > 0 ? topology.wrapX(W, 0, W, H) : topology.wrapX(-1, 0, W, H);
      o = composeOrientation(o, result.flip);
    }
    const stepY = tileY >= 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(tileY); i++) {
      const result = stepY > 0 ? topology.wrapY(0, H, W, H) : topology.wrapY(0, -1, W, H);
      o = composeOrientation(o, result.flip);
    }
    return o;
  }

  it.each([TORUS, KLEIN_BOTTLE, PROJECTIVE_PLANE])('$kind', (topology) => {
    for (const [tx, ty] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 0],
      [0, 2],
      [3, 2],
      [-1, 0],
      [0, -1],
      [-2, 3],
    ]) {
      expect(simulateTileOrientation(topology, tx, ty)).toEqual(topology.tileOrientation(tx, ty));
    }
  });
});

describe('topologyFor', () => {
  it('resolves each kind to its singleton', () => {
    expect(topologyFor('torus')).toBe(TORUS);
    expect(topologyFor('klein')).toBe(KLEIN_BOTTLE);
    expect(topologyFor('projective')).toBe(PROJECTIVE_PLANE);
  });
});

describe('wrappedNeighbor', () => {
  it('is a plain step when in bounds', () => {
    expect(wrappedNeighbor(TORUS, 2, 3, 1, 0, W, H)).toEqual({ x: 3, y: 3 });
    expect(wrappedNeighbor(TORUS, 2, 3, 0, -1, W, H)).toEqual({ x: 2, y: 2 });
  });

  it('wraps when a step would leave the board', () => {
    expect(wrappedNeighbor(TORUS, W - 1, 3, 1, 0, W, H)).toEqual({ x: 0, y: 3 });
    expect(wrappedNeighbor(KLEIN_BOTTLE, 2, H - 1, 0, 1, W, H)).toEqual({ x: W - 1 - 2, y: 0 });
  });
});
