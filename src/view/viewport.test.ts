import { describe, expect, it } from 'vitest';
import { computeFitView, computePan, computeZoomAt, toCanvasLocal } from './viewport';

const BOUNDS = { minScale: 0.12, maxScale: 3 };

describe('computeFitView', () => {
  it('centers a board that is smaller than the viewport', () => {
    const view = computeFitView(100, 50, 400, 400, BOUNDS);
    expect(view.scale).toBeCloseTo(1.6); // clamped to the 1.6 "comfortable" max
    expect(view.tx).toBeCloseTo((400 - 100 * view.scale) / 2);
    expect(view.ty).toBeCloseTo((400 - 50 * view.scale) / 2);
  });

  it('shrinks a board that is larger than the viewport to fit', () => {
    const view = computeFitView(2000, 1000, 400, 400, BOUNDS);
    expect(view.scale).toBeCloseTo(Math.min(400 / 2000, 400 / 1000));
    expect(view.scale).toBeLessThan(1);
  });

  it('never scales below minScale', () => {
    const view = computeFitView(100000, 100000, 100, 100, BOUNDS);
    expect(view.scale).toBeGreaterThanOrEqual(BOUNDS.minScale);
  });
});

describe('computeZoomAt', () => {
  it('keeps the anchor point fixed on screen while scale changes', () => {
    const view = { scale: 1, tx: 10, ty: 20 };
    const anchorX = 150;
    const anchorY = 80;
    const zoomed = computeZoomAt(view, anchorX, anchorY, 2, BOUNDS);

    const [localBefore] = [toCanvasLocal(anchorX, anchorY, view)];
    const [localAfter] = [toCanvasLocal(anchorX, anchorY, zoomed)];
    expect(localAfter[0]).toBeCloseTo(localBefore[0]);
    expect(localAfter[1]).toBeCloseTo(localBefore[1]);
  });

  it('clamps to the provided min/max scale', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    expect(computeZoomAt(view, 0, 0, 10, BOUNDS).scale).toBe(BOUNDS.maxScale);
    expect(computeZoomAt(view, 0, 0, 0.001, BOUNDS).scale).toBe(BOUNDS.minScale);
  });
});

describe('computePan', () => {
  it('translates tx/ty without touching scale', () => {
    const view = { scale: 1.5, tx: 10, ty: 20 };
    const panned = computePan(view, 5, -3);
    expect(panned).toEqual({ scale: 1.5, tx: 15, ty: 17 });
  });
});

describe('toCanvasLocal', () => {
  it('undoes an identity viewport', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    expect(toCanvasLocal(42, 17, view)).toEqual([42, 17]);
  });

  it('accounts for pan and scale', () => {
    const view = { scale: 2, tx: 10, ty: 10 };
    // wrap-local (30, 30) -> canvas-local ((30-10)/2, (30-10)/2) = (10, 10)
    expect(toCanvasLocal(30, 30, view)).toEqual([10, 10]);
  });
});
