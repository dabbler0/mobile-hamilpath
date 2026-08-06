import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BlitzEvent } from '../game/blitz';
import { clearAllStoresForTests } from './db';
import { blitzParamsKey, deleteBlitzRun, deleteBlitzRunsForParams, listAllBlitzRuns, listBlitzDifficulties, listBlitzRunsForParams, saveBlitzRun, type BlitzRunRecord } from './blitzStore';

beforeEach(async () => {
  await clearAllStoresForTests();
});

const EVENTS: BlitzEvent[] = [
  { kind: 'puzzleStart', t: 0, sizeKey: 'tiny', shapeMode: 'rect', seed: 1 },
  { kind: 'move', t: 100, ops: [{ op: 'toggleRegion', region: 0, edges: ['0,0|1,0'] }] },
  { kind: 'puzzleSolved', t: 200, timeAwardedMs: 500 },
  { kind: 'runEnd', t: 5000, scoreMs: 5000 },
];

function makeRun(overrides: Partial<Omit<BlitzRunRecord, 'id'>> = {}): Omit<BlitzRunRecord, 'id'> {
  return {
    seed: 1,
    startingTimeSec: 60,
    timeBackPerEdgeSec: 0.3,
    scoreMs: 5000,
    puzzlesSolved: 1,
    startedAt: 1000,
    completedAt: 6000,
    events: EVENTS,
    ...overrides,
  };
}

describe('saveBlitzRun / listAllBlitzRuns', () => {
  it('round-trips a saved run, deriving a unique id from seed + startedAt', async () => {
    const saved = await saveBlitzRun(makeRun());
    expect(saved.id).toBe('1::1000');
    const all = await listAllBlitzRuns();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(saved);
  });

  it('keeps two runs with the same seed but different start times as independent records', async () => {
    await saveBlitzRun(makeRun({ startedAt: 1000 }));
    await saveBlitzRun(makeRun({ startedAt: 2000 }));
    expect(await listAllBlitzRuns()).toHaveLength(2);
  });

  it('filters out a record missing events/scoreMs (defensive, matching gameStore.ts policy)', async () => {
    await saveBlitzRun(makeRun());
    // simulate a malformed record landing in the store directly
    const { putRecord, STORES } = await import('./db');
    await putRecord(STORES.blitzRuns, { id: 'bogus::1', seed: 2, startedAt: 1 });
    const all = await listAllBlitzRuns();
    expect(all).toHaveLength(1);
  });
});

describe('deleteBlitzRun', () => {
  it('removes exactly the targeted run', async () => {
    const a = await saveBlitzRun(makeRun({ startedAt: 1000 }));
    const b = await saveBlitzRun(makeRun({ startedAt: 2000 }));
    await deleteBlitzRun(a.id);
    const remaining = await listAllBlitzRuns();
    expect(remaining.map((r) => r.id)).toEqual([b.id]);
  });
});

describe('blitzParamsKey', () => {
  it('matches for identical params and differs for different ones', () => {
    expect(blitzParamsKey({ startingTimeSec: 60, timeBackPerEdgeSec: 0.3 })).toBe(blitzParamsKey({ startingTimeSec: 60, timeBackPerEdgeSec: 0.3 }));
    expect(blitzParamsKey({ startingTimeSec: 60, timeBackPerEdgeSec: 0.3 })).not.toBe(blitzParamsKey({ startingTimeSec: 90, timeBackPerEdgeSec: 0.3 }));
    expect(blitzParamsKey({ startingTimeSec: 60, timeBackPerEdgeSec: 0.3 })).not.toBe(blitzParamsKey({ startingTimeSec: 60, timeBackPerEdgeSec: 0.5 }));
  });
});

describe('listBlitzDifficulties', () => {
  it('groups runs by (startingTimeSec, timeBackPerEdgeSec), tracking count/best score/last played', async () => {
    await saveBlitzRun(makeRun({ startedAt: 1000, completedAt: 6000, scoreMs: 5000 }));
    await saveBlitzRun(makeRun({ startedAt: 2000, completedAt: 9000, scoreMs: 8000 }));
    await saveBlitzRun(makeRun({ startingTimeSec: 120, startedAt: 3000, completedAt: 4000, scoreMs: 1000 }));

    const diffs = await listBlitzDifficulties();
    expect(diffs).toHaveLength(2);
    const sixty = diffs.find((d) => d.startingTimeSec === 60)!;
    expect(sixty.runCount).toBe(2);
    expect(sixty.bestScoreMs).toBe(8000);
    expect(sixty.lastPlayedAt).toBe(9000);
  });

  it('sorts most-recently-played difficulty first', async () => {
    await saveBlitzRun(makeRun({ startingTimeSec: 30, startedAt: 1000, completedAt: 2000 }));
    await saveBlitzRun(makeRun({ startingTimeSec: 60, startedAt: 3000, completedAt: 9000 }));
    const diffs = await listBlitzDifficulties();
    expect(diffs.map((d) => d.startingTimeSec)).toEqual([60, 30]);
  });
});

describe('listBlitzRunsForParams', () => {
  it('returns only runs matching the exact params, sorted by score descending', async () => {
    const params = { startingTimeSec: 60, timeBackPerEdgeSec: 0.3 };
    await saveBlitzRun(makeRun({ ...params, startedAt: 1000, scoreMs: 3000 }));
    await saveBlitzRun(makeRun({ ...params, startedAt: 2000, scoreMs: 9000 }));
    await saveBlitzRun(makeRun({ startingTimeSec: 90, timeBackPerEdgeSec: 0.3, startedAt: 3000, scoreMs: 100000 }));

    const runs = await listBlitzRunsForParams(params);
    expect(runs.map((r) => r.scoreMs)).toEqual([9000, 3000]);
  });
});

describe('deleteBlitzRunsForParams', () => {
  it('deletes every run at exactly that difficulty and leaves others untouched', async () => {
    const params = { startingTimeSec: 60, timeBackPerEdgeSec: 0.3 };
    await saveBlitzRun(makeRun({ ...params, startedAt: 1000 }));
    await saveBlitzRun(makeRun({ ...params, startedAt: 2000 }));
    const other = await saveBlitzRun(makeRun({ startingTimeSec: 90, startedAt: 3000 }));

    await deleteBlitzRunsForParams(params);
    const remaining = await listAllBlitzRuns();
    expect(remaining.map((r) => r.id)).toEqual([other.id]);
  });
});
