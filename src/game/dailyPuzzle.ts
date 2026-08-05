import {
  buildKleinBottlePuzzle,
  buildProjectivePlanePuzzle,
  buildPuzzle,
  buildRandomShapePuzzle,
  buildToroidalPuzzle,
  NO_EDGE_COLLECTIONS,
  type EdgeCollectionParams,
  type Puzzle,
} from './puzzle';
import { mulberry32 } from './rng';
import { rectShape } from './shape';

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

/**
 * The board's shape, orthogonal to its size: a plain m x n rectangle (the
 * original board), a random connected polyomino of the same area (see
 * `randomShape`), or one of three wraparound surfaces — toroidal (see
 * `buildToroidalPuzzle`), Klein bottle, or projective plane (see
 * `buildKleinBottlePuzzle`/`buildProjectivePlanePuzzle`). Stable
 * identifiers, like `SizeOption.key` — never rename once puzzles have been
 * played.
 */
export type ShapeMode = 'rect' | 'random' | 'toroidal' | 'klein' | 'projective';

export interface ShapeModeOption {
  key: ShapeMode;
  label: string;
}

export const SHAPE_MODE_OPTIONS: readonly ShapeModeOption[] = [
  { key: 'rect', label: 'Rectangle' },
  { key: 'random', label: 'Random shape' },
  { key: 'toroidal', label: 'Toroidal' },
  { key: 'klein', label: 'Klein bottle' },
  { key: 'projective', label: 'Projective plane' },
];

export function shapeModeOption(shapeModeKey: string): ShapeModeOption {
  const found = SHAPE_MODE_OPTIONS.find((s) => s.key === shapeModeKey);
  if (!found) throw new Error(`unknown shape mode: ${shapeModeKey}`);
  return found;
}

/** Fixed so a puzzle is fully identified by (day, size, shape mode, index) alone, with no separate user-facing setting. */
export const DAILY_PUZZLE_DENSITY = 0.28;

export interface PuzzleId {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  sizeKey: string;
  shapeMode: ShapeMode;
  /** 0-based position in that day+size+shape's infinite sequence. */
  index: number;
  /**
   * Random edge-collection generation parameters (see `puzzle.ts`'s
   * `EdgeCollectionParams`). Optional, defaulting to `NO_EDGE_COLLECTIONS`
   * (the feature off) wherever read — *not* a distinct identity from
   * explicitly passing `NO_EDGE_COLLECTIONS` (see `collectionsKeySuffix`),
   * so every `PuzzleId` from before this feature existed, and every puzzle
   * generated with the feature left off, keeps exactly the same hash/seed
   * and storage keys it always had.
   */
  collections?: EdgeCollectionParams;
}

/** The local calendar day, as "YYYY-MM-DD" (not UTC — puzzles roll over at local midnight). */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Suffix appended to a puzzle's hash/storage keys for its edge-collection
 * params — `''` (no suffix at all) whenever collections are off (`params`
 * absent, or `maxCollections <= 0`), so a puzzle id with the feature untouched
 * hashes and stores byte-identically to one from before this feature
 * existed. Only turning the feature on actually changes the key, which is
 * exactly what makes two different collection configs (or "off" vs "on")
 * distinct, independently-progressing puzzle sequences — the same trick
 * `shapeMode` already relies on for board shapes.
 */
export function collectionsKeySuffix(params: EdgeCollectionParams | undefined): string {
  if (!params || params.maxCollections <= 0) return '';
  return `::c${params.maxCollections}.${params.minSize}.${params.maxSize}`;
}

export function puzzleIdKey(id: PuzzleId): string {
  return `${id.day}::${id.sizeKey}::${id.shapeMode}::${id.index}${collectionsKeySuffix(id.collections)}`;
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
  const collections = id.collections ?? NO_EDGE_COLLECTIONS;
  switch (id.shapeMode) {
    case 'rect':
      return buildPuzzle(rectShape(m, n), DAILY_PUZZLE_DENSITY, rng, collections);
    case 'random':
      return buildRandomShapePuzzle(m, n, DAILY_PUZZLE_DENSITY, rng, collections);
    case 'toroidal':
      return buildToroidalPuzzle(m, n, DAILY_PUZZLE_DENSITY, rng, collections);
    case 'klein':
      return buildKleinBottlePuzzle(m, n, DAILY_PUZZLE_DENSITY, rng, collections);
    case 'projective':
      return buildProjectivePlanePuzzle(m, n, DAILY_PUZZLE_DENSITY, rng, collections);
  }
}
