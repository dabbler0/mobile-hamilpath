import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory, recordMove, type HistoryState } from '../game/history';
import { clearAllStoresForTests } from './db';
import {
  clearInProgress,
  getCompleted,
  getInProgress,
  getUnlockedIndex,
  listCompleted,
  recordCompletion,
  saveInProgress,
} from './gameStore';

beforeEach(async () => {
  await clearAllStoresForTests();
});

describe('progress gating', () => {
  it('starts at unlockedIndex 0 for a fresh day/size', async () => {
    expect(await getUnlockedIndex('2026-07-10', 'mini')).toBe(0);
  });

  it('advances by one after completing the currently-unlocked index', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 0 }, [[[0, 0]]]);
    expect(await getUnlockedIndex('2026-07-10', 'mini')).toBe(1);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 1 }, [[[0, 0]]]);
    expect(await getUnlockedIndex('2026-07-10', 'mini')).toBe(2);
  });

  it('does not advance when completing an index that is not the currently-unlocked one', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 2 }, [[[0, 0]]]);
    expect(await getUnlockedIndex('2026-07-10', 'mini')).toBe(0);
  });

  it('tracks each size independently', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 0 }, [[[0, 0]]]);
    expect(await getUnlockedIndex('2026-07-10', 'mini')).toBe(1);
    expect(await getUnlockedIndex('2026-07-10', 'small')).toBe(0);
  });

  it('tracks each day independently', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 0 }, [[[0, 0]]]);
    expect(await getUnlockedIndex('2026-07-11', 'mini')).toBe(0);
  });
});

describe('in-progress persistence', () => {
  it('round-trips a saved game', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 3 };
    expect(await getInProgress(id.day, id.sizeKey)).toBeUndefined();
    await saveInProgress(id, [
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    const loaded = await getInProgress(id.day, id.sizeKey);
    expect(loaded?.segments).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    expect(loaded?.index).toBe(3);
  });

  it('overwrites the previous save for the same day/size', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 3 };
    await saveInProgress(id, [[[0, 0]]]);
    await saveInProgress(id, [
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ]);
    const loaded = await getInProgress(id.day, id.sizeKey);
    expect(loaded?.segments).toEqual([
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ]);
  });

  it('is cleared on completion', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await saveInProgress(id, [[[0, 0]]]);
    await recordCompletion(id, [
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    expect(await getInProgress(id.day, id.sizeKey)).toBeUndefined();
  });

  it('clearInProgress removes a saved game directly', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await saveInProgress(id, [[[0, 0]]]);
    await clearInProgress(id.day, id.sizeKey);
    expect(await getInProgress(id.day, id.sizeKey)).toBeUndefined();
  });

  it('round-trips an undo/redo history alongside the segments', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    const history: HistoryState = recordMove(createHistory(), { segments: [[[0, 0]]], won: false }, [
      { op: 'extend', seg: 0, end: 'tail', cell: [1, 0] },
    ]);
    await saveInProgress(id, [[[0, 0], [1, 0]]], history);
    const loaded = await getInProgress(id.day, id.sizeKey);
    expect(loaded?.history).toEqual(history);
  });

  it('leaves history undefined for a save that never provided one (older save format)', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await saveInProgress(id, [[[0, 0]]]);
    const loaded = await getInProgress(id.day, id.sizeKey);
    expect(loaded?.history).toBeUndefined();
  });
});

describe('completed games', () => {
  it('is retrievable by id after recording', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await recordCompletion(id, [
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    const completed = await getCompleted(id);
    expect(completed?.segments).toEqual([
      [
        [0, 0],
        [1, 0],
      ],
    ]);
    expect(completed?.completedAt).toBeGreaterThan(0);
  });

  it('lists all completed games, most recent first', async () => {
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 0 }, [[[0, 0]]]);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'mini', index: 1 }, [[[0, 0]]]);
    await recordCompletion({ day: '2026-07-10', sizeKey: 'small', index: 0 }, [[[0, 0]]]);
    const all = await listCompleted();
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].completedAt).toBeGreaterThanOrEqual(all[i].completedAt);
    }
  });

  it('stores the move log for replay when provided', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    const history = recordMove(createHistory(), { segments: [[[0, 0]]], won: false }, [
      { op: 'extend', seg: 0, end: 'tail', cell: [1, 0] },
    ]);
    await recordCompletion(id, [[[0, 0], [1, 0]]], history.moveLog);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toEqual(history.moveLog);
  });

  it('leaves moveLog undefined for a completion that never provided one (older completion format)', async () => {
    const id = { day: '2026-07-10', sizeKey: 'mini', index: 0 };
    await recordCompletion(id, [[[0, 0]]]);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toBeUndefined();
  });
});
