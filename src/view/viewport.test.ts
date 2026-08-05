import { describe, expect, it } from 'vitest';
import { computeFitView, computePan, computeZoomAt, panToKeepVisible, toCanvasLocal, toWrapLocal } from './viewport';

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

describe('toWrapLocal', () => {
  it('is the exact inverse of toCanvasLocal', () => {
    const view = { scale: 2, tx: 10, ty: -5 };
    expect(toWrapLocal(...toCanvasLocal(123, 45, view), view)).toEqual([123, 45]);
    expect(toCanvasLocal(...toWrapLocal(7, 8, view), view)).toEqual([7, 8]);
  });
});

describe('panToKeepVisible', () => {
  const view = { scale: 1, tx: 0, ty: 0 };

  it('leaves the view untouched when the point is already comfortably inside the margin', () => {
    const next = panToKeepVisible(view, 200, 200, 400, 400, 20);
    expect(next).toBe(view); // same reference: genuinely a no-op
  });

  it('pans just enough to bring a point past the left/top edge up to the margin', () => {
    const next = panToKeepVisible(view, -50, -50, 400, 400, 20);
    expect(next.tx).toBeCloseTo(70); // -50 + tx == 20  =>  tx == 70
    expect(next.ty).toBeCloseTo(70);
    expect(next.scale).toBe(1);
  });

  it('pans just enough to bring a point past the right/bottom edge back to the margin', () => {
    const next = panToKeepVisible(view, 450, 500, 400, 400, 20);
    expect(next.tx).toBeCloseTo(400 - 20 - 450); // sx == availW - margin
    expect(next.ty).toBeCloseTo(400 - 20 - 500);
  });

  it('only pans the axis that actually needs it', () => {
    const next = panToKeepVisible(view, 200, -50, 400, 400, 20);
    expect(next.tx).toBe(0);
    expect(next.ty).toBeCloseTo(70);
  });

  it('accounts for the current scale/pan when locating the point on screen', () => {
    const zoomed = { scale: 2, tx: 100, ty: 100 };
    // canvas-local (-60, 0) -> wrap-local (100 + 2*-60, 100) = (-20, 100), left of the margin
    const next = panToKeepVisible(zoomed, -60, 0, 400, 400, 20);
    expect(next.tx).toBeCloseTo(140); // wants sx == 20: 2*-60 + tx == 20 => tx == 140
    expect(next.ty).toBe(100);
  });

  it('clamps an oversized margin to half the viewport so both edges never fight', () => {
    const next = panToKeepVisible(view, 50, 50, 100, 100, 1000);
    expect(next.tx).toBeCloseTo(0); // margin clamped to 50 == availW/2, point already exactly there
    expect(next.ty).toBeCloseTo(0);
  });
});
