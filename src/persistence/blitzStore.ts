import type { BlitzEvent, BlitzParams } from '../game/blitz';
import { deleteRecord, getAllRecords, putRecord, STORES } from './db';

/**
 * One finished (or forfeited) Blitz run — see `game/blitz.ts`'s `BlitzEvent`
 * for what `events` holds and CLAUDE.md's "Blitz mode" section for the
 * overall design. `id` is `${seed}::${startedAt}` rather than just `seed`:
 * two runs could in principle mint the same 32-bit seed (astronomically
 * unlikely but not impossible, same caveat `randomSeed` already carries),
 * and pairing it with the run's own start timestamp makes a collision
 * completely impossible without adding a separate id-generation scheme.
 */
export interface BlitzRunRecord {
  id: string;
  seed: number;
  startingTimeSec: number;
  timeBackPerEdgeSec: number;
  /** Total time survived, in milliseconds — this run's score (CLAUDE.md: "final score is the total amount of time they lasted"). */
  scoreMs: number;
  puzzlesSolved: number;
  /** `Date.now()` when the run began — shown in the leaderboard list. */
  startedAt: number;
  /** `Date.now()` when the run ended (ran out of time, or was forfeited). */
  completedAt: number;
  events: BlitzEvent[];
}

function blitzRunId(seed: number, startedAt: number): string {
  return `${seed}::${startedAt}`;
}

/** A record saved before this feature existed structurally can't occur (Blitz mode didn't write to IndexedDB at all until now), but `events`/`scoreMs` are checked anyway so a future breaking change to this shape can follow the same "treat as unusable rather than migrate" policy `gameStore.ts` already established. */
function isUsable(record: { events?: unknown; scoreMs?: unknown }): boolean {
  return Array.isArray(record.events) && typeof record.scoreMs === 'number';
}

export async function saveBlitzRun(record: Omit<BlitzRunRecord, 'id'>): Promise<BlitzRunRecord> {
  const full: BlitzRunRecord = { ...record, id: blitzRunId(record.seed, record.startedAt) };
  await putRecord(STORES.blitzRuns, full);
  return full;
}

export async function listAllBlitzRuns(): Promise<BlitzRunRecord[]> {
  const all = await getAllRecords<BlitzRunRecord>(STORES.blitzRuns);
  return all.filter(isUsable);
}

export async function deleteBlitzRun(id: string): Promise<void> {
  await deleteRecord(STORES.blitzRuns, id);
}

/** A stable string key for grouping/comparing `BlitzParams` — two params equal iff their keys match. */
export function blitzParamsKey(params: BlitzParams): string {
  return `${params.startingTimeSec}::${params.timeBackPerEdgeSec}`;
}

export interface BlitzDifficultySummary extends BlitzParams {
  runCount: number;
  bestScoreMs: number;
  /** Most recent `completedAt` among this difficulty's runs — sorts `listBlitzDifficulties`, most-recently-played first, matching the Resume/Replays convention. */
  lastPlayedAt: number;
}

/** Every distinct `(startingTimeSec, timeBackPerEdgeSec)` combination the player has ever completed a run at, most-recently-played first — feeds the Leaderboard's difficulty picker. */
export async function listBlitzDifficulties(): Promise<BlitzDifficultySummary[]> {
  const all = await listAllBlitzRuns();
  const groups = new Map<string, BlitzDifficultySummary>();
  for (const run of all) {
    const params: BlitzParams = { startingTimeSec: run.startingTimeSec, timeBackPerEdgeSec: run.timeBackPerEdgeSec };
    const k = blitzParamsKey(params);
    const existing = groups.get(k);
    if (!existing) {
      groups.set(k, { ...params, runCount: 1, bestScoreMs: run.scoreMs, lastPlayedAt: run.completedAt });
    } else {
      existing.runCount += 1;
      existing.bestScoreMs = Math.max(existing.bestScoreMs, run.scoreMs);
      existing.lastPlayedAt = Math.max(existing.lastPlayedAt, run.completedAt);
    }
  }
  return [...groups.values()].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

/** Every run recorded at exactly this difficulty, sorted by score descending (highest score first) — the Leaderboard's per-difficulty list. */
export async function listBlitzRunsForParams(params: BlitzParams): Promise<BlitzRunRecord[]> {
  const all = await listAllBlitzRuns();
  const k = blitzParamsKey(params);
  return all.filter((run) => blitzParamsKey({ startingTimeSec: run.startingTimeSec, timeBackPerEdgeSec: run.timeBackPerEdgeSec }) === k).sort((a, b) => b.scoreMs - a.scoreMs);
}

/** Deletes every run at exactly this difficulty in one go — backs the Leaderboard's per-difficulty-group delete affordance. */
export async function deleteBlitzRunsForParams(params: BlitzParams): Promise<void> {
  const runs = await listBlitzRunsForParams(params);
  await Promise.all(runs.map((run) => deleteBlitzRun(run.id)));
}
