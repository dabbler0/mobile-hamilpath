import { describe, expect, it } from 'vitest';
import { createComponentColorState, previewComponentColors, resetComponentColorState, snapshotEdgeColors, updateComponentColors } from './componentColors';
import { edgeKey } from './regions';

describe('updateComponentColors', () => {
  it('assigns colors 0, 1, 2, ... in order to a fresh state', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]);
    const b = edgeKey([5, 5], [6, 5]);
    const c = edgeKey([9, 9], [10, 9]);
    const colors = updateComponentColors(state, new Set([a, b, c]));
    expect(new Set(colors.values())).toEqual(new Set([0, 1, 2]));
  });

  it('keeps an unchanged component the same color across calls', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]);
    const b = edgeKey([5, 5], [6, 5]);
    const first = updateComponentColors(state, new Set([a, b]));
    const second = updateComponentColors(state, new Set([a, b]));
    expect(second.get(a)).toBe(first.get(a));
    expect(second.get(b)).toBe(first.get(b));
  });

  it('leaves a surviving component\'s color untouched when a lower-colored one vanishes, and a new component reuses the freed color', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]);
    const b = edgeKey([5, 5], [6, 5]);
    const c = edgeKey([9, 9], [10, 9]);
    const before = updateComponentColors(state, new Set([a, b, c]));
    expect(before.get(a)).toBe(0);
    expect(before.get(b)).toBe(1);
    expect(before.get(c)).toBe(2);

    // b vanishes -- c should stay color 2, not shift down to fill the gap.
    const afterVanish = updateComponentColors(state, new Set([a, c]));
    expect(afterVanish.get(a)).toBe(0);
    expect(afterVanish.get(c)).toBe(2);

    // A brand new component should pick up the now-free color 1.
    const d = edgeKey([20, 20], [21, 20]);
    const afterNew = updateComponentColors(state, new Set([a, c, d]));
    expect(afterNew.get(a)).toBe(0);
    expect(afterNew.get(c)).toBe(2);
    expect(afterNew.get(d)).toBe(1);
  });

  it('resolves a merge in favor of the lower-index color, regardless of which side has more cells', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]); // small, will become color 0
    const b1 = edgeKey([5, 0], [6, 0]);
    const b2 = edgeKey([6, 0], [7, 0]);
    const b3 = edgeKey([7, 0], [8, 0]); // bigger, will become color 1
    const before = updateComponentColors(state, new Set([a, b1, b2, b3]));
    expect(before.get(a)).toBe(0);
    expect(before.get(b1)).toBe(1);

    // Connect the two components via a bridging edge -- b (more cells) merges into a's component.
    const bridge = edgeKey([1, 0], [5, 0]);
    const after = updateComponentColors(state, new Set([a, b1, b2, b3, bridge]));
    const merged = after.get(a);
    expect(merged).toBe(0); // blue (lower index) wins, despite b's side being bigger
    expect(after.get(b1)).toBe(merged);
    expect(after.get(b3)).toBe(merged);
  });

  it('lets the larger half of a split keep the old color; the smaller half gets a new one', () => {
    const state = createComponentColorState();
    const e1 = edgeKey([0, 0], [1, 0]);
    const e2 = edgeKey([1, 0], [2, 0]);
    const e3 = edgeKey([2, 0], [3, 0]);
    const e4 = edgeKey([3, 0], [4, 0]);
    const e5 = edgeKey([4, 0], [5, 0]);
    const before = updateComponentColors(state, new Set([e1, e2, e3, e4, e5]));
    expect(new Set(before.values())).toEqual(new Set([0]));

    // Removing e2 splits the path into a 1-edge piece (e1) and a 3-edge piece (e3, e4, e5).
    const after = updateComponentColors(state, new Set([e1, e3, e4, e5]));
    expect(after.get(e3)).toBe(0); // larger piece keeps the old color
    expect(after.get(e4)).toBe(0);
    expect(after.get(e5)).toBe(0);
    expect(after.get(e1)).toBe(1); // smaller piece gets a fresh one
  });

  it('resetComponentColorState clears remembered colors so the next call starts fresh', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]);
    updateComponentColors(state, new Set([a]));
    resetComponentColorState(state);
    // A totally different component whose cells happen to coincide should not inherit color 0 by
    // coincidence any differently than it would from an empty state -- this just checks the state
    // was actually cleared, not merely that recomputing is idempotent.
    expect(state.cellsByColor.size).toBe(0);
    const b = edgeKey([9, 9], [10, 9]);
    const colors = updateComponentColors(state, new Set([b]));
    expect(colors.get(b)).toBe(0);
  });
});

describe('previewComponentColors', () => {
  it('matches what updateComponentColors would assign, without committing it to state', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]); // small, will become color 0
    const b1 = edgeKey([5, 0], [6, 0]);
    const b2 = edgeKey([6, 0], [7, 0]);
    const b3 = edgeKey([7, 0], [8, 0]); // bigger, will become color 1
    updateComponentColors(state, new Set([a, b1, b2, b3]));

    const bridge = edgeKey([1, 0], [5, 0]);
    const merged = new Set([a, b1, b2, b3, bridge]);
    const preview = previewComponentColors(state, merged);

    // Same merge-resolution rule as updateComponentColors: blue (a's lower
    // color) wins, regardless of which side has more cells.
    expect(preview.get(a)).toBe(0);
    expect(preview.get(b1)).toBe(0);
    expect(preview.get(b3)).toBe(0);

    // Nothing was actually committed -- state still reflects the pre-merge
    // components, so a fresh updateComponentColors call from here produces
    // exactly the same result the preview predicted.
    expect(state.cellsByColor.size).toBe(2);
    const committed = updateComponentColors(state, merged);
    expect(committed.get(a)).toBe(preview.get(a));
    expect(committed.get(b1)).toBe(preview.get(b1));
    expect(committed.get(b3)).toBe(preview.get(b3));
  });
});

describe('snapshotEdgeColors', () => {
  it('reads back colors already established by updateComponentColors without recomputing them', () => {
    const state = createComponentColorState();
    const a = edgeKey([0, 0], [1, 0]);
    const b = edgeKey([5, 5], [6, 5]);
    const established = updateComponentColors(state, new Set([a, b]));
    const snapshot = snapshotEdgeColors(state, new Set([a, b]));
    expect(snapshot.get(a)).toBe(established.get(a));
    expect(snapshot.get(b)).toBe(established.get(b));
  });
});
