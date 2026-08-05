import { collectionsKeySuffix, puzzleIdKey, type PuzzleId, type ShapeMode } from '../game/dailyPuzzle';
import type { HistoryState, MoveLogEntry } from '../game/history';
import type { EdgeCollectionParams } from '../game/puzzle';
import type { EdgeKey } from '../game/regions';
import { deleteRecord, getAllRecords, getRecord, putRecord, STORES } from './db';

/**
 * Storage key for "the currently-active puzzle of this day+size+shape(+
 * collection params)" — used for both the unlock gate (`progress`) and the
 * resumable save (`inProgress`), neither of which is qualified by `index`
 * (there's only ever one active puzzle per this key at a time). Includes
 * `collectionsKeySuffix` so a distinct edge-collections setting gets its own
 * independent progression, exactly like `shapeMode` already does — and, for
 * the common case of collections left off, is byte-identical to the
 * pre-collections key format.
 */
function dayAndSizeId(day: string, sizeKey: string, shapeMode: ShapeMode, collections?: EdgeCollectionParams): string {
  return `${day}::${sizeKey}::${shapeMode}${collectionsKeySuffix(collections)}`;
}

/** Storage key for one specific completed puzzle — reuses `dailyPuzzle.ts`'s `puzzleIdKey` so the two never drift apart. */
function puzzleRecordId(id: PuzzleId): string {
  return puzzleIdKey(id);
}

export interface ProgressRecord {
  id: string;
  day: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  /** The next puzzle index of this day+size+shape the player is allowed to start. */
  unlockedIndex: number;
}

export async function getProgress(day: string, sizeKey: string, shapeMode: ShapeMode, collections?: EdgeCollectionParams): Promise<ProgressRecord | undefined> {
  return getRecord<ProgressRecord>(STORES.progress, dayAndSizeId(day, sizeKey, shapeMode, collections));
}

/** The next playable index for this day+size+shape(+collections) — 0 if no puzzles of that combo have been completed yet today. */
export async function getUnlockedIndex(day: string, sizeKey: string, shapeMode: ShapeMode, collections?: EdgeCollectionParams): Promise<number> {
  const record = await getProgress(day, sizeKey, shapeMode, collections);
  return record?.unlockedIndex ?? 0;
}

async function advanceUnlockedIndex(day: string, sizeKey: string, shapeMode: ShapeMode, completedIndex: number, collections?: EdgeCollectionParams): Promise<void> {
  const current = await getUnlockedIndex(day, sizeKey, shapeMode, collections);
  if (completedIndex !== current) return; // only forward, in-order completion advances the gate
  const record: ProgressRecord = { id: dayAndSizeId(day, sizeKey, shapeMode, collections), day, sizeKey, shapeMode, unlockedIndex: completedIndex + 1 };
  await putRecord(STORES.progress, record);
}

export interface InProgressRecord {
  id: string;
  day: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  index: number;
  edges: EdgeKey[];
  /** Undo/redo stacks + move log for this in-progress game. Absent on saves from before this feature existed — callers must fall back to a fresh (empty) history rather than assume this is present. */
  history?: HistoryState;
  /** The edge-collection params this puzzle was generated with. Absent on saves from before this feature existed (equivalent to `NO_EDGE_COLLECTIONS`) — needed to regenerate the exact same puzzle graph on resume. */
  collections?: EdgeCollectionParams;
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
 * A record saved before board shapes existed has no `shapeMode` at all —
 * unlike `segments`/`edges`, this one predates a *readable* format change
 * (every puzzle before this feature genuinely was a plain rectangle), so
 * rather than discarding it, default it to `'rect'`. `in-progress`/
 * `progress` records are keyed by (day, size, shape) and so never surface
 * here at all under the old key (a lookup for the new key just won't find
 * them, handled elsewhere as an ordinary cache miss) — this only matters for
 * `completed` records, which `listCompleted` scans regardless of key.
 */
function withShapeModeDefault<T extends { shapeMode?: ShapeMode }>(record: T): T & { shapeMode: ShapeMode } {
  return record.shapeMode ? (record as T & { shapeMode: ShapeMode }) : { ...record, shapeMode: 'rect' };
}

export async function getInProgress(day: string, sizeKey: string, shapeMode: ShapeMode, collections?: EdgeCollectionParams): Promise<InProgressRecord | undefined> {
  const record = await getRecord<InProgressRecord>(STORES.inProgress, dayAndSizeId(day, sizeKey, shapeMode, collections));
  return record && hasEdges(record) ? record : undefined;
}

export async function saveInProgress(id: PuzzleId, edges: EdgeKey[], history?: HistoryState): Promise<void> {
  const record: InProgressRecord = {
    id: dayAndSizeId(id.day, id.sizeKey, id.shapeMode, id.collections),
    day: id.day,
    sizeKey: id.sizeKey,
    shapeMode: id.shapeMode,
    index: id.index,
    edges,
    history,
    collections: id.collections,
  };
  await putRecord(STORES.inProgress, record);
}

export async function clearInProgress(day: string, sizeKey: string, shapeMode: ShapeMode, collections?: EdgeCollectionParams): Promise<void> {
  await deleteRecord(STORES.inProgress, dayAndSizeId(day, sizeKey, shapeMode, collections));
}

export interface CompletedRecord {
  id: string;
  day: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  index: number;
  edges: EdgeKey[];
  completedAt: number;
  /** The move log for this game's whole solve, for the replay animation. Absent on completions recorded before this feature existed — callers must treat replay as unavailable rather than assume this is present. */
  moveLog?: MoveLogEntry[];
  /** The edge-collection params this puzzle was generated with. Absent on completions recorded before this feature existed (equivalent to `NO_EDGE_COLLECTIONS`) — needed to regenerate the exact same puzzle graph for review. */
  collections?: EdgeCollectionParams;
}

export async function listCompleted(): Promise<CompletedRecord[]> {
  const all = await getAllRecords<CompletedRecord>(STORES.completed);
  return all
    .filter(hasEdges)
    .map(withShapeModeDefault)
    .sort((a, b) => b.completedAt - a.completedAt);
}

export async function getCompleted(id: PuzzleId): Promise<CompletedRecord | undefined> {
  const record = await getRecord<CompletedRecord>(STORES.completed, puzzleRecordId(id));
  return record && hasEdges(record) ? withShapeModeDefault(record) : undefined;
}

/** Records a win: stores the completed puzzle (plus its move log, for replay) for later review, clears its in-progress record, and — if it was the next in line — advances the unlock gate so the following index becomes playable. */
export async function recordCompletion(id: PuzzleId, edges: EdgeKey[], moveLog?: MoveLogEntry[]): Promise<void> {
  const record: CompletedRecord = {
    id: puzzleRecordId(id),
    day: id.day,
    sizeKey: id.sizeKey,
    shapeMode: id.shapeMode,
    index: id.index,
    edges,
    completedAt: Date.now(),
    moveLog,
    collections: id.collections,
  };
  await putRecord(STORES.completed, record);
  await clearInProgress(id.day, id.sizeKey, id.shapeMode, id.collections);
  await advanceUnlockedIndex(id.day, id.sizeKey, id.shapeMode, id.index, id.collections);
}
