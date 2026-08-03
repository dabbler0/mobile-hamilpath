import type { PuzzleId, ShapeMode } from '../game/dailyPuzzle';
import type { HistoryState, MoveLogEntry } from '../game/history';
import type { EdgeKey } from '../game/regions';
import { deleteRecord, getAllRecords, getRecord, putRecord, STORES } from './db';

function dayAndSizeId(day: string, sizeKey: string, shapeMode: ShapeMode): string {
  return `${day}::${sizeKey}::${shapeMode}`;
}

function puzzleRecordId(id: PuzzleId): string {
  return `${id.day}::${id.sizeKey}::${id.shapeMode}::${id.index}`;
}

export interface ProgressRecord {
  id: string;
  day: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  /** The next puzzle index of this day+size+shape the player is allowed to start. */
  unlockedIndex: number;
}

export async function getProgress(day: string, sizeKey: string, shapeMode: ShapeMode): Promise<ProgressRecord | undefined> {
  return getRecord<ProgressRecord>(STORES.progress, dayAndSizeId(day, sizeKey, shapeMode));
}

/** The next playable index for this day+size+shape — 0 if no puzzles of that size/shape have been completed yet today. */
export async function getUnlockedIndex(day: string, sizeKey: string, shapeMode: ShapeMode): Promise<number> {
  const record = await getProgress(day, sizeKey, shapeMode);
  return record?.unlockedIndex ?? 0;
}

async function advanceUnlockedIndex(day: string, sizeKey: string, shapeMode: ShapeMode, completedIndex: number): Promise<void> {
  const current = await getUnlockedIndex(day, sizeKey, shapeMode);
  if (completedIndex !== current) return; // only forward, in-order completion advances the gate
  const record: ProgressRecord = { id: dayAndSizeId(day, sizeKey, shapeMode), day, sizeKey, shapeMode, unlockedIndex: completedIndex + 1 };
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

export async function getInProgress(day: string, sizeKey: string, shapeMode: ShapeMode): Promise<InProgressRecord | undefined> {
  const record = await getRecord<InProgressRecord>(STORES.inProgress, dayAndSizeId(day, sizeKey, shapeMode));
  return record && hasEdges(record) ? record : undefined;
}

export async function saveInProgress(id: PuzzleId, edges: EdgeKey[], history?: HistoryState): Promise<void> {
  const record: InProgressRecord = {
    id: dayAndSizeId(id.day, id.sizeKey, id.shapeMode),
    day: id.day,
    sizeKey: id.sizeKey,
    shapeMode: id.shapeMode,
    index: id.index,
    edges,
    history,
  };
  await putRecord(STORES.inProgress, record);
}

export async function clearInProgress(day: string, sizeKey: string, shapeMode: ShapeMode): Promise<void> {
  await deleteRecord(STORES.inProgress, dayAndSizeId(day, sizeKey, shapeMode));
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
}

export async function listCompleted(): Promise<CompletedRecord[]> {
  const all = await getAllRecords<CompletedRecord>(STORES.completed);
  return all.filter(hasEdges).sort((a, b) => b.completedAt - a.completedAt);
}

export async function getCompleted(id: PuzzleId): Promise<CompletedRecord | undefined> {
  const record = await getRecord<CompletedRecord>(STORES.completed, puzzleRecordId(id));
  return record && hasEdges(record) ? record : undefined;
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
  };
  await putRecord(STORES.completed, record);
  await clearInProgress(id.day, id.sizeKey, id.shapeMode);
  await advanceUnlockedIndex(id.day, id.sizeKey, id.shapeMode, id.index);
}
