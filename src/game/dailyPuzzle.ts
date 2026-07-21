import { buildPuzzle, type Puzzle } from './puzzle';
import { mulberry32 } from './rng';

export interface SizeOption {
  /** Stable identifier used in storage keys and puzzle-id hashing — never rename once puzzles have been played. */
  key: string;
  label: string;
  m: number;
  n: number;
}

/** The board sizes offered, from smallest to largest. Order only affects UI; identity is by `key`. */
export const SIZE_OPTIONS: readonly SizeOption[] = [
  { key: 'tiny', label: 'Tiny', m: 3, n: 4 },
  { key: 'mini', label: 'Mini', m: 4, n: 6 },
  { key: 'small', label: 'Small', m: 6, n: 9 },
  { key: 'medium', label: 'Medium', m: 8, n: 12 },
  { key: 'large', label: 'Large', m: 10, n: 16 },
  { key: 'huge', label: 'Huge', m: 14, n: 20 },
];

export function sizeOption(sizeKey: string): SizeOption {
  const found = SIZE_OPTIONS.find((s) => s.key === sizeKey);
  if (!found) throw new Error(`unknown size key: ${sizeKey}`);
  return found;
}

/** Fixed so a puzzle is fully identified by (day, size, index) alone, with no separate user-facing setting. */
export const DAILY_PUZZLE_DENSITY = 0.28;

export interface PuzzleId {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  sizeKey: string;
  /** 0-based position in that day+size's infinite sequence. */
  index: number;
}

/** The local calendar day, as "YYYY-MM-DD" (not UTC — puzzles roll over at local midnight). */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function puzzleIdKey(id: PuzzleId): string {
  return `${id.day}::${id.sizeKey}::${id.index}`;
}

/** FNV-1a: a small, deterministic string hash, used to turn a puzzle id into a mulberry32 seed. */
function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function puzzleSeed(id: PuzzleId): number {
  return hashStringToSeed(puzzleIdKey(id));
}

export function generateDailyPuzzle(id: PuzzleId): Puzzle {
  const { m, n } = sizeOption(id.sizeKey);
  const rng = mulberry32(puzzleSeed(id));
  return buildPuzzle(m, n, DAILY_PUZZLE_DENSITY, rng);
}
