import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory, recordMove, type HistoryState } from '../game/history';
import { createInitialPath } from '../game/pathEdit';
import type { EdgeCollectionParams } from '../game/puzzle';
import type { PuzzleId } from '../game/puzzleGen';
import { clearAllStoresForTests, putRecord, STORES } from './db';
import { clearInProgress, deleteCompleted, getCompleted, getInProgress, listCompleted, listInProgress, puzzleIdOf, recordCompletion, saveInProgress } from './gameStore';

const RECT = 'rect' as const;

beforeEach(async () => {
  await clearAllStoresForTests();
});

describe('in-progress persistence', () => {
  it('round-trips a saved game', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 3 };
    expect(await getInProgress(id)).toBeUndefined();
    await saveInProgress(id, ['0,0|1,0']);
    const loaded = await getInProgress(id);
    expect(loaded?.edges).toEqual(['0,0|1,0']);
    expect(loaded?.seed).toBe(3);
  });

  it('overwrites the previous save for the same id', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 3 };
    await saveInProgress(id, ['0,0|1,0']);
    await saveInProgress(id, ['0,0|1,0', '1,0|2,0']);
    const loaded = await getInProgress(id);
    expect(loaded?.edges).toEqual(['0,0|1,0', '1,0|2,0']);
  });

  it('keeps two different seeds of the same size/shape as independent saves', async () => {
    const a: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 1 };
    const b: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 2 };
    await saveInProgress(a, ['0,0|1,0']);
    await saveInProgress(b, ['1,0|2,0']);
    expect((await getInProgress(a))?.edges).toEqual(['0,0|1,0']);
    expect((await getInProgress(b))?.edges).toEqual(['1,0|2,0']);
  });

  it('is cleared on completion', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    await recordCompletion(id, ['0,0|1,0']);
    expect(await getInProgress(id)).toBeUndefined();
  });

  it('clearInProgress removes a saved game directly', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    await clearInProgress(id);
    expect(await getInProgress(id)).toBeUndefined();
  });

  it('round-trips an undo/redo history alongside the edges', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    const history: HistoryState = recordMove(createHistory(), createInitialPath(), [{ op: 'toggleRegion', region: 0, edges: ['0,0|1,0'] }]);
    await saveInProgress(id, ['0,0|1,0'], history);
    const loaded = await getInProgress(id);
    expect(loaded?.history).toEqual(history);
  });

  it('leaves history undefined for a save that never provided one (older save format)', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    const loaded = await getInProgress(id);
    expect(loaded?.history).toBeUndefined();
  });

  it('treats a pre-region-toggle save (segments, no edges) as absent', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await putRecord(STORES.inProgress, {
      id: `${id.sizeKey}::${id.shapeMode}::${id.seed}`,
      sizeKey: id.sizeKey,
      shapeMode: id.shapeMode,
      seed: id.seed,
      segments: [[[0, 0]]],
    });
    expect(await getInProgress(id)).toBeUndefined();
  });

  it('treats a pre-seed-restructuring save (day/index, no seed) as absent', async () => {
    await putRecord(STORES.inProgress, {
      id: '2026-07-10::mini::rect',
      day: '2026-07-10',
      sizeKey: 'mini',
      shapeMode: RECT,
      index: 0,
      edges: ['0,0|1,0'],
    });
    expect(await listInProgress()).toEqual([]);
  });

  it('lists all in-progress games, most recently saved first', async () => {
    const a: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 1 };
    const b: PuzzleId = { sizeKey: 'small', shapeMode: RECT, seed: 2 };
    await saveInProgress(a, ['0,0|1,0']);
    await saveInProgress(b, ['1,0|2,0']);
    const all = await listInProgress();
    expect(all).toHaveLength(2);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].updatedAt).toBeGreaterThanOrEqual(all[i].updatedAt);
    }
  });
});

describe('completed games', () => {
  it('is retrievable by id after recording', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await recordCompletion(id, ['0,0|1,0']);
    const completed = await getCompleted(id);
    expect(completed?.edges).toEqual(['0,0|1,0']);
    expect(completed?.completedAt).toBeGreaterThan(0);
  });

  it('lists all completed games, most recent first', async () => {
    await recordCompletion({ sizeKey: 'mini', shapeMode: RECT, seed: 0 }, ['0,0|1,0']);
    await recordCompletion({ sizeKey: 'mini', shapeMode: RECT, seed: 1 }, ['0,0|1,0']);
    await recordCompletion({ sizeKey: 'small', shapeMode: RECT, seed: 0 }, ['0,0|1,0']);
    const all = await listCompleted();
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].completedAt).toBeGreaterThanOrEqual(all[i].completedAt);
    }
  });

  it('stores the move log for replay when provided', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    const history = recordMove(createHistory(), createInitialPath(), [{ op: 'toggleRegion', region: 0, edges: ['0,0|1,0'] }]);
    await recordCompletion(id, ['0,0|1,0'], history.moveLog);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toEqual(history.moveLog);
  });

  it('leaves moveLog undefined for a completion that never provided one (older completion format)', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await recordCompletion(id, ['0,0|1,0']);
    const completed = await getCompleted(id);
    expect(completed?.moveLog).toBeUndefined();
  });

  it('deleteCompleted removes a completed record directly', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await recordCompletion(id, ['0,0|1,0']);
    await deleteCompleted(id);
    expect(await getCompleted(id)).toBeUndefined();
    expect(await listCompleted()).toEqual([]);
  });

  it('filters out a pre-region-toggle completed record (segments, no edges) from listCompleted/getCompleted', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await putRecord(STORES.completed, {
      id: `${id.sizeKey}::${id.shapeMode}::${id.seed}`,
      sizeKey: id.sizeKey,
      shapeMode: id.shapeMode,
      seed: id.seed,
      segments: [[[0, 0]]],
      completedAt: Date.now(),
    });
    expect(await listCompleted()).toEqual([]);
    expect(await getCompleted(id)).toBeUndefined();
  });

  it('filters out a pre-seed-restructuring completed record (day/index, no seed) from listCompleted/getCompleted', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await putRecord(STORES.completed, {
      id: '2026-07-10::mini::rect::0',
      day: '2026-07-10',
      sizeKey: 'mini',
      shapeMode: RECT,
      index: 0,
      edges: ['0,0|1,0'],
      completedAt: Date.now(),
    });
    expect(await listCompleted()).toEqual([]);
    expect(await getCompleted(id)).toBeUndefined();
  });

  it('leaves collections undefined for a completion where the feature is off, matching pre-feature behavior', async () => {
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0 };
    await saveInProgress(id, ['0,0|1,0']);
    expect((await getInProgress(id))?.id).toBe('mini::rect::0');
    await recordCompletion(id, ['0,0|1,0']);
    expect((await getCompleted(id))?.id).toBe('mini::rect::0');
  });

  it('tracks a distinct edge-collections setting as a fully independent puzzle identity', async () => {
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    await saveInProgress({ sizeKey: 'mini', shapeMode: RECT, seed: 0, collections: on }, ['0,0|1,0']);
    expect(await getInProgress({ sizeKey: 'mini', shapeMode: RECT, seed: 0 })).toBeUndefined(); // the "off" bucket is unaffected
    expect((await getInProgress({ sizeKey: 'mini', shapeMode: RECT, seed: 0, collections: on }))?.edges).toEqual(['0,0|1,0']);
  });

  it('round-trips the collections params on in-progress and completed records', async () => {
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 0, collections: on };
    await saveInProgress(id, ['0,0|1,0']);
    expect((await getInProgress(id))?.collections).toEqual(on);
    await recordCompletion(id, ['0,0|1,0']);
    expect((await getCompleted(id))?.collections).toEqual(on);
  });
});

describe('puzzleIdOf', () => {
  it('reconstructs a full PuzzleId from any stored record shape', async () => {
    const on: EdgeCollectionParams = { maxCollections: 2, minSize: 2, maxSize: 4 };
    const id: PuzzleId = { sizeKey: 'mini', shapeMode: RECT, seed: 7, collections: on };
    await recordCompletion(id, ['0,0|1,0']);
    const [record] = await listCompleted();
    expect(puzzleIdOf(record)).toEqual(id);
  });
});
