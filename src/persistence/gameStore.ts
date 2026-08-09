import { puzzleIdKey, type PuzzleId, type ShapeMode } from '../game/puzzleGen';
import type { HistoryState, MoveLogEntry } from '../game/history';
import type { EdgeCollectionParams } from '../game/puzzle';
import type { EdgeKey } from '../game/regions';
import { deleteRecord, getAllRecords, getRecord, putRecord, STORES } from './db';

/** Storage key for one specific puzzle (in-progress or completed alike) — reuses `puzzleGen.ts`'s `puzzleIdKey` so the two never drift apart. */
function puzzleRecordId(id: PuzzleId): string {
  return puzzleIdKey(id);
}

export interface InProgressRecord {
  id: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  seed: number;
  edges: EdgeKey[];
  /** Undo/redo stacks + move log for this in-progress game. Absent on saves from before this feature existed — callers must fall back to a fresh (empty) history rather than assume this is present. */
  history?: HistoryState;
  /** The edge-collection params this puzzle was generated with. Absent when the feature is off (equivalent to `NO_EDGE_COLLECTIONS`) — needed to regenerate the exact same puzzle graph on resume. */
  collections?: EdgeCollectionParams;
  /** The locked-edge fraction this puzzle was generated with (see `puzzleGen.ts`'s `PuzzleId.lockedEdgeFraction`). Absent when the feature is off — needed to regenerate the *exact* same puzzle graph on resume: `lockedEdgeFraction` is folded into the puzzle's hash/seed exactly like `collections` is, so a resumed id missing it would regenerate a completely different board, not just one missing its locked edges. */
  lockedEdgeFraction?: number;
  /**
   * Edges locked mid-game via the "Hint me" button (`main.ts`'s `hintMe`,
   * `edgeLock.ts`'s `lockEdge`), in the order they were used. Unlike
   * `lockedEdgeFraction` above, this is a live, session-only action with
   * nothing in `PuzzleId` recording it — so it can't be recovered by
   * regenerating the puzzle from its id alone; resuming has to replay these
   * through `edgeLock.ts`'s `applyHintedEdges` against the freshly-generated
   * puzzle to rebuild its `lockedEdges`/region merges (which also drives the
   * dimmed rendering those edges get — see `render.ts`). Absent/empty for a
   * game that never used a hint, which is every game from before this
   * feature existed.
   */
  hintedEdges?: EdgeKey[];
  /** When this save was last written — sorts the Resume menu's list, most-recently-played first. */
  updatedAt: number;
}

/**
 * A record saved before the region-toggle rewrite has `segments` instead of
 * `edges` — structurally incompatible with the new edge-set path model, so
 * (per this project's existing policy for breaking storage-format changes)
 * it's simply treated as unusable rather than migrated.
 */
function hasEdges(record: { edges?: unknown }): boolean {
  return Array.isArray(record.edges);
}

/**
 * A record from before the seed-based `PuzzleId` restructuring is keyed by
 * (day, size, shape, index) and has no `seed` field at all — structurally
 * incompatible with the current identity scheme (there's no `seed` to
 * regenerate its puzzle graph from), so — like `hasEdges` above — it's
 * simply treated as unusable/invisible rather than migrated.
 */
function hasSeed(record: { seed?: unknown }): boolean {
  return typeof record.seed === 'number';
}

function isUsable(record: { edges?: unknown; seed?: unknown }): boolean {
  return hasEdges(record) && hasSeed(record);
}

export async function getInProgress(id: PuzzleId): Promise<InProgressRecord | undefined> {
  const record = await getRecord<InProgressRecord>(STORES.inProgress, puzzleRecordId(id));
  return record && isUsable(record) ? record : undefined;
}

/** Every saved in-progress game, most-recently-played first — feeds the Resume menu. */
export async function listInProgress(): Promise<InProgressRecord[]> {
  const all = await getAllRecords<InProgressRecord>(STORES.inProgress);
  return all.filter(isUsable).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveInProgress(id: PuzzleId, edges: EdgeKey[], history?: HistoryState, hintedEdges?: EdgeKey[]): Promise<void> {
  const record: InProgressRecord = {
    id: puzzleRecordId(id),
    sizeKey: id.sizeKey,
    shapeMode: id.shapeMode,
    seed: id.seed,
    edges,
    history,
    collections: id.collections,
    lockedEdgeFraction: id.lockedEdgeFraction,
    hintedEdges,
    updatedAt: Date.now(),
  };
  await putRecord(STORES.inProgress, record);
}

export async function clearInProgress(id: PuzzleId): Promise<void> {
  await deleteRecord(STORES.inProgress, puzzleRecordId(id));
}

export interface CompletedRecord {
  id: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  seed: number;
  edges: EdgeKey[];
  completedAt: number;
  /** The move log for this game's whole solve, for the replay animation. Absent on completions recorded before this feature existed — callers must treat replay as unavailable rather than assume this is present. */
  moveLog?: MoveLogEntry[];
  /** The edge-collection params this puzzle was generated with. Absent when the feature is off (equivalent to `NO_EDGE_COLLECTIONS`) — needed to regenerate the exact same puzzle graph for review. */
  collections?: EdgeCollectionParams;
  /** The locked-edge fraction this puzzle was generated with — see `InProgressRecord`'s matching field for why this has to round-trip exactly, not just for rendering the locked edges but to regenerate the identical puzzle graph at all. */
  lockedEdgeFraction?: number;
  /** Edges locked mid-game via "Hint me" — see `InProgressRecord`'s matching field. Needed so review/replay reconstructs the same `lockedEdges`/region merges (and so the same dimmed rendering) the live game ended up with. Absent/empty for a completion that never used a hint. */
  hintedEdges?: EdgeKey[];
}

export async function listCompleted(): Promise<CompletedRecord[]> {
  const all = await getAllRecords<CompletedRecord>(STORES.completed);
  return all.filter(isUsable).sort((a, b) => b.completedAt - a.completedAt);
}

export async function getCompleted(id: PuzzleId): Promise<CompletedRecord | undefined> {
  const record = await getRecord<CompletedRecord>(STORES.completed, puzzleRecordId(id));
  return record && isUsable(record) ? record : undefined;
}

export async function deleteCompleted(id: PuzzleId): Promise<void> {
  await deleteRecord(STORES.completed, puzzleRecordId(id));
}

/** Records a win: stores the completed puzzle (plus its move log, for replay) for later review, and clears its in-progress record. There is no unlock gate any more (see `puzzleGen.ts`'s doc comment) — every puzzle is independently generated from its own seed, so there's nothing to advance. */
export async function recordCompletion(id: PuzzleId, edges: EdgeKey[], moveLog?: MoveLogEntry[], hintedEdges?: EdgeKey[]): Promise<void> {
  const record: CompletedRecord = {
    id: puzzleRecordId(id),
    sizeKey: id.sizeKey,
    shapeMode: id.shapeMode,
    seed: id.seed,
    edges,
    completedAt: Date.now(),
    moveLog,
    collections: id.collections,
    lockedEdgeFraction: id.lockedEdgeFraction,
    hintedEdges,
  };
  await putRecord(STORES.completed, record);
  await clearInProgress(id);
}

/** Re-derives a full `PuzzleId` from a stored record — every record already carries every field a `PuzzleId` needs. */
export function puzzleIdOf(record: { sizeKey: string; shapeMode: ShapeMode; seed: number; collections?: EdgeCollectionParams; lockedEdgeFraction?: number }): PuzzleId {
  return { sizeKey: record.sizeKey, shapeMode: record.shapeMode, seed: record.seed, collections: record.collections, lockedEdgeFraction: record.lockedEdgeFraction };
}
