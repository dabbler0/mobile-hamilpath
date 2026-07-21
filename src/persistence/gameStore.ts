import type { PuzzleId } from '../game/dailyPuzzle';
import type { Segment } from '../game/pathDrag';
import { deleteRecord, getAllRecords, getRecord, putRecord, STORES } from './db';

function dayAndSizeId(day: string, sizeKey: string): string {
  return `${day}::${sizeKey}`;
}

function puzzleRecordId(id: PuzzleId): string {
  return `${id.day}::${id.sizeKey}::${id.index}`;
}

export interface ProgressRecord {
  id: string;
  day: string;
  sizeKey: string;
  /** The next puzzle index of this day+size the player is allowed to start. */
  unlockedIndex: number;
}

export async function getProgress(day: string, sizeKey: string): Promise<ProgressRecord | undefined> {
  return getRecord<ProgressRecord>(STORES.progress, dayAndSizeId(day, sizeKey));
}

/** The next playable index for this day+size — 0 if no puzzles of that size have been completed yet today. */
export async function getUnlockedIndex(day: string, sizeKey: string): Promise<number> {
  const record = await getProgress(day, sizeKey);
  return record?.unlockedIndex ?? 0;
}

async function advanceUnlockedIndex(day: string, sizeKey: string, completedIndex: number): Promise<void> {
  const current = await getUnlockedIndex(day, sizeKey);
  if (completedIndex !== current) return; // only forward, in-order completion advances the gate
  const record: ProgressRecord = { id: dayAndSizeId(day, sizeKey), day, sizeKey, unlockedIndex: completedIndex + 1 };
  await putRecord(STORES.progress, record);
}

export interface InProgressRecord {
  id: string;
  day: string;
  sizeKey: string;
  index: number;
  segments: Segment[];
}

export async function getInProgress(day: string, sizeKey: string): Promise<InProgressRecord | undefined> {
  return getRecord<InProgressRecord>(STORES.inProgress, dayAndSizeId(day, sizeKey));
}

export async function saveInProgress(id: PuzzleId, segments: Segment[]): Promise<void> {
  const record: InProgressRecord = { id: dayAndSizeId(id.day, id.sizeKey), day: id.day, sizeKey: id.sizeKey, index: id.index, segments };
  await putRecord(STORES.inProgress, record);
}

export async function clearInProgress(day: string, sizeKey: string): Promise<void> {
  await deleteRecord(STORES.inProgress, dayAndSizeId(day, sizeKey));
}

export interface CompletedRecord {
  id: string;
  day: string;
  sizeKey: string;
  index: number;
  segments: Segment[];
  completedAt: number;
}

export async function listCompleted(): Promise<CompletedRecord[]> {
  const all = await getAllRecords<CompletedRecord>(STORES.completed);
  return all.sort((a, b) => b.completedAt - a.completedAt);
}

export async function getCompleted(id: PuzzleId): Promise<CompletedRecord | undefined> {
  return getRecord<CompletedRecord>(STORES.completed, puzzleRecordId(id));
}

/** Records a win: stores the completed puzzle for later review, clears its in-progress record, and — if it was the next in line — advances the unlock gate so the following index becomes playable. */
export async function recordCompletion(id: PuzzleId, segments: Segment[]): Promise<void> {
  const record: CompletedRecord = {
    id: puzzleRecordId(id),
    day: id.day,
    sizeKey: id.sizeKey,
    index: id.index,
    segments,
    completedAt: Date.now(),
  };
  await putRecord(STORES.completed, record);
  await clearInProgress(id.day, id.sizeKey);
  await advanceUnlockedIndex(id.day, id.sizeKey, id.index);
}
