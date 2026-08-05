import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory, recordMove, type HistoryState } from '../game/history';
import { createInitialPath } from '../game/pathEdit';
import type { EdgeCollectionParams } from '../game/puzzle';
import { clearAllStoresForTests, putRecord, STORES } from './db';
import {
  clearInProgress,
  getCompleted,
  getInProgress,
  getUnlockedIndex,
  listCompleted,
  recordCompletion,
  saveInProgress,
} from './gameStore';

const RECT = 'rect' as const;

beforeEach(async () => {
  await clearAllStoresForTests();
});

describe('progress gating', () => {
  it('starts at unlockedIndex 0 for a fresh day/size/shape', async () => {
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(0);
  });

  it('advances by one after completing the currently-unlocked index', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(1);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 1 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(2);
  });

  it('does not advance when completing an index that is not the currently-unlocked one', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 2 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(0);
  });

  it('tracks each size independently', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(1);
    expect(await getUnlockedIndex('2026-07-10', 'small', RECT)).toBe(0);
  });

  it('tracks each shape mode independently', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-10', 'mini', RECT)).toBe(1);
    expect(await getUnlockedIndex('2026-07-10', 'mini', 'toroidal')).toBe(0);
  });

  it('tracks each day independently', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    expect(await getUnlockedIndex('2026-07-11', 'mini', RECT)).toBe(0);
  });
});

describe('in-progress persistence', () => {
  it('round-trips a saved game', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 3 };
    expect(await getInProgress(id.day, id.sizeKey, id.shapeMode)).toBeUndefined();
    await saveInProgress(id, ['0,0|1,0']);
    const loaded = await getInProgress(id.day, id.sizeKey, id.shapeMode);
    expect(loaded?.edges).toEqual(['0,0|1,0']);
    expect(loaded?.index).toBe(3);
  });

  it('overwrites the previous save for the same day/size/shape', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 3 };
    await saveInProgress(id, ['0,0|1,0']);
    await saveInProgress(id, ['0,0|1,0', '1,0|2,0']);
    const loaded = await getInProgress(id.day, id.sizeKey, id.shapeMode);
    expect(loaded?.edges).toEqual(['0,0|1,0', '1,0|2,0']);
  });

  it('is cleared on completion', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    await recordCompletion(id, ['0,0|1,0']);
    expect(await getInProgress(id.day, id.sizeKey, id.shapeMode)).toBeUndefined();
  });

  it('clearInProgress removes a saved game directly', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    await clearInProgress(id.day, id.sizeKey, id.shapeMode);
    expect(await getInProgress(id.day, id.sizeKey, id.shapeMode)).toBeUndefined();
  });

  it('round-trips an undo/redo history alongside the edges', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    const history: HistoryState = recordMove(createHistory(), createInitialPath(), [
      { op: 'toggleRegion', region: 0, edges: ['0,0|1,0'] },
    ]);
    await saveInProgress(id, ['0,0|1,0'], history);
    const loaded = await getInProgress(id.day, id.sizeKey, id.shapeMode);
    expect(loaded?.history).toEqual(history);
  });

  it('leaves history undefined for a save that never provided one (older save format)', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    const loaded = await getInProgress(id.day, id.sizeKey, id.shapeMode);
    expect(loaded?.history).toBeUndefined();
  });

  it('treats a pre-region-toggle save (segments, no edges) as absent', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await putRecord(STORES.inProgress, {
      id: `${id.day}::${id.sizeKey}::${id.shapeMode}`,
      day: id.day,
      sizeKey: id.sizeKey,
      shapeMode: id.shapeMode,
      index: id.index,
      segments: [[[0, 0]]],
    });
    expect(await getInProgress(id.day, id.sizeKey, id.shapeMode)).toBeUndefined();
  });
});

describe('completed games', () => {
  it('is retrievable by id after recording', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await recordCompletion(id, ['0,0|1,0']);
    const completed = await getCompleted(id);
    expect(completed?.edges).toEqual(['0,0|1,0']);
    expect(completed?.completedAt).toBeGreaterThan(0);
  });

  it('lists all completed games, most recent first', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 1 }, ['0,0|1,0']);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'small', shapeMode: RECT, index: 0 }, ['0,0|1,0']);
    const all = await listCompleted();
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].completedAt).toBeGreaterThanOrEqual(all[i].completedAt);
    }
  });

  it('stores the move log for replay when provided', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    const history = recordMove(createHistory(), createInitialPath(), [{ op: 'toggleRegion', region: 0, edges: ['0,0|1,0'] }]);
    await recordCompletion(id, ['0,0|1,0'], history.moveLog);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toEqual(history.moveLog);
  });

  it('leaves moveLog undefined for a completion that never provided one (older completion format)', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await recordCompletion(id, ['0,0|1,0']);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toBeUndefined();
  });

  it('filters out a pre-region-toggle completed record (segments, no edges) from listCompleted/getCompleted', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await putRecord(STORES.completed, {
      id: `${id.day}::${id.sizeKey}::${id.shapeMode}::${id.index}`,
      day: id.day,
      sizeKey: id.sizeKey,
      shapeMode: id.shapeMode,
      index: id.index,
      segments: [[[0, 0]]],
      completedAt: Date.now(),
    });
    expect(await listCompleted()).toEqual([]);
    expect(await getCompleted(id)).toBeUndefined();
  });

  it('leaves progress/in-progress/completed keys untouched when collections are off, matching pre-feature behavior', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    expect(await getInProgress(id.day, id.sizeKey, id.shapeMode)).toBeDefined();
    expect((await getInProgress(id.day, id.sizeKey, id.shapeMode))?.id).toBe('2026-07-10::mini::rect');
    await recordCompletion(id, ['0,0|1,0']);
    expect((await getCompleted(id))?.id).toBe('2026-07-10::mini::rect::0');
  });

  it('tracks a distinct edge-collections setting as its own independent progression', async () => {
    const day = '2026-07-10';
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    await recordCompletion({ day, sizeKey: 'mini', shapeMode: RECT, index: 0, collections: on }, ['0,0|1,0']);
    expect(await getUnlockedIndex(day, 'mini', RECT, on)).toBe(1);
    expect(await getUnlockedIndex(day, 'mini', RECT)).toBe(0); // the "off" bucket is unaffected
  });

  it('distinguishes two different active edge-collections settings from each other', async () => {
    const day = '2026-07-10';
    const a: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    const b: EdgeCollectionParams = { maxCollections: 3, minSize: 2, maxSize: 4 };
    await saveInProgress({ day, sizeKey: 'mini', shapeMode: RECT, index: 0, collections: a }, ['0,0|1,0']);
    expect(await getInProgress(day, 'mini', RECT, b)).toBeUndefined();
    expect((await getInProgress(day, 'mini', RECT, a))?.edges).toEqual(['0,0|1,0']);
  });

  it('round-trips the collections params on in-progress and completed records', async () => {
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    const id = { day: '2026-07-10', sizeKey: 'mini', shapeMode: RECT, index: 0, collections: on };
    await saveInProgress(id, ['0,0|1,0']);
    expect((await getInProgress(id.day, id.sizeKey, id.shapeMode, on))?.collections).toEqual(on);
    await recordCompletion(id, ['0,0|1,0']);
    expect((await getCompleted(id))?.collections).toEqual(on);
  });

  it('defaults a pre-board-shape completed record (no shapeMode) to rect in listCompleted, instead of crashing the history view', async () => {
    // Every puzzle before board shapes existed was a plain rectangle, so this
    // is a readable legacy format (unlike segments/edges above) — it should
    // surface normally, not be filtered out. (Its id also predates the
    // shapeMode-qualified key format, so — like other breaking key-format
    // changes in this codebase — it's simply not reachable via `getCompleted`
    // by id anymore; that's fine, since only `listCompleted` feeds the
    // history view.)
    const legacyId = { id: '2026-07-10::mini::0', day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await putRecord(STORES.completed, { ...legacyId, edges: ['0,0|1,0'], completedAt: Date.now() });

    const listed = await listCompleted();
    expect(listed).toHaveLength(1);
    expect(listed[0].shapeMode).toBe(RECT);
  });
});
