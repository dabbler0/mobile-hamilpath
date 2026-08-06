import { generateHamiltonianCycle, generateShapeAndCycle, type Cell } from './hamiltonianCycle';
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
import { edgeKey, type EdgeKey } from './regions';
import { mulberry32 } from './rng';
import { randomShape, randomToroidalShape, rectShape } from './shape';

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
 *
 * `klein`/`projective` are currently disabled from the shape picker (see
 * `ShapeModeOption.disabled`) — their nonorientable-surface generation has
 * known bugs that are too hard to fix for now (`topology.ts`'s file doc
 * comment) — but the type still includes them, and `generatePuzzle`
 * still handles them, purely so a puzzle completed while they *were*
 * selectable keeps regenerating correctly for review.
 */
export type ShapeMode = 'rect' | 'random' | 'toroidal' | 'klein' | 'projective';

export interface ShapeModeOption {
  key: ShapeMode;
  label: string;
  /**
   * True for a shape mode that's currently broken and hidden from the shape
   * picker (see `ShapeMode`'s doc comment). Kept in `SHAPE_MODE_OPTIONS`
   * (rather than deleted) so `shapeModeOption` can still resolve a label for
   * an already-completed puzzle of this shape — e.g. in the Replays list —
   * even though it can no longer be freshly selected.
   */
  disabled?: boolean;
}

export const SHAPE_MODE_OPTIONS: readonly ShapeModeOption[] = [
  { key: 'rect', label: 'Rectangle' },
  { key: 'random', label: 'Random shape' },
  { key: 'toroidal', label: 'Toroidal' },
  { key: 'klein', label: 'Klein bottle', disabled: true },
  { key: 'projective', label: 'Projective plane', disabled: true },
];

/** The shape modes currently offered by the picker — `SHAPE_MODE_OPTIONS` minus any `disabled` entries (see `ShapeModeOption.disabled`). */
export const SELECTABLE_SHAPE_MODE_OPTIONS: readonly ShapeModeOption[] = SHAPE_MODE_OPTIONS.filter((opt) => !opt.disabled);

export function shapeModeOption(shapeModeKey: string): ShapeModeOption {
  const found = SHAPE_MODE_OPTIONS.find((s) => s.key === shapeModeKey);
  if (!found) throw new Error(`unknown shape mode: ${shapeModeKey}`);
  return found;
}

/** Fixed so a puzzle is fully identified by (size, shape mode, seed) alone, with no separate user-facing setting. */
export const PUZZLE_DENSITY = 0.28;

export interface PuzzleId {
  sizeKey: string;
  shapeMode: ShapeMode;
  /**
   * An arbitrary 32-bit identifier that, together with `sizeKey` +
   * `shapeMode` (+ `collections`), fully determines the puzzle
   * (`puzzleSeed` hashes all of it into the actual mulberry32 seed used to
   * generate it) — see `randomSeed`. Two `PuzzleId`s that differ only in
   * `seed` are two independently-generated puzzles of the same kind, which
   * is what lets a player start a fresh puzzle of a kind they already have
   * in progress (`main.ts`'s New Game flow).
   */
  seed: number;
  /**
   * Random edge-collection generation parameters (see `puzzle.ts`'s
   * `EdgeCollectionParams`). Optional, defaulting to `NO_EDGE_COLLECTIONS`
   * (the feature off) wherever read — *not* a distinct identity from
   * explicitly passing `NO_EDGE_COLLECTIONS` (see `collectionsKeySuffix`),
   * so every `PuzzleId` generated with the feature left off keeps exactly
   * the same hash/seed and storage keys regardless of whether the field is
   * present at all.
   */
  collections?: EdgeCollectionParams;
}

/**
 * A fresh, random 32-bit seed for a brand-new `PuzzleId` (`main.ts`'s New
 * Game flow) — uses `crypto.getRandomValues` where available (every
 * supported browser) for real randomness, falling back to `Math.random` so
 * this still works in a non-browser test environment.
 */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}

/**
 * Suffix appended to a puzzle's hash/storage keys for its edge-collection
 * params — `''` (no suffix at all) whenever collections are off (`params`
 * absent, or `maxCollections <= 0`), so a puzzle id with the feature untouched
 * hashes and stores byte-identically to one with the feature never
 * mentioned. Only turning the feature on actually changes the key, which is
 * exactly what makes two different collection configs (or "off" vs "on")
 * distinct, independently-generated puzzles — the same trick `shapeMode`
 * already relies on for board shapes.
 */
export function collectionsKeySuffix(params: EdgeCollectionParams | undefined): string {
  if (!params || params.maxCollections <= 0) return '';
  return `::c${params.maxCollections}.${params.minSize}.${params.maxSize}`;
}

export function puzzleIdKey(id: PuzzleId): string {
  return `${id.sizeKey}::${id.shapeMode}::${id.seed}${collectionsKeySuffix(id.collections)}`;
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

/**
 * The mulberry32 seed a `PuzzleId` actually generates from — a hash of the
 * *whole* id (size + shape + seed + collections), not `id.seed` directly.
 * This keeps two puzzles that happen to share a raw `id.seed` but differ in
 * size/shape/collections from ever sharing so much as a PRNG *stream*
 * prefix (their generation reads different numbers of values regardless,
 * since board dimensions differ, but hashing avoids relying on that).
 */
export function puzzleSeed(id: PuzzleId): number {
  return hashStringToSeed(puzzleIdKey(id));
}

export function generatePuzzle(id: PuzzleId): Puzzle {
  const { m, n } = sizeOption(id.sizeKey);
  const rng = mulberry32(puzzleSeed(id));
  const collections = id.collections ?? NO_EDGE_COLLECTIONS;
  switch (id.shapeMode) {
    case 'rect':
      return buildPuzzle(rectShape(m, n), PUZZLE_DENSITY, rng, collections);
    case 'random':
      return buildRandomShapePuzzle(m, n, PUZZLE_DENSITY, rng, collections);
    case 'toroidal':
      return buildToroidalPuzzle(m, n, PUZZLE_DENSITY, rng, collections);
    case 'klein':
      return buildKleinBottlePuzzle(m, n, PUZZLE_DENSITY, rng, collections);
    case 'projective':
      return buildProjectivePlanePuzzle(m, n, PUZZLE_DENSITY, rng, collections);
  }
}

/**
 * Recomputes the hidden Hamiltonian cycle a puzzle id was generated from —
 * the "intended" solution — without ever storing it on the `Puzzle` itself
 * (see `puzzle.ts`'s `Puzzle.adj` doc comment: `adj` is intentionally the
 * only puzzle representation kept at runtime). This mirrors, call for call,
 * the exact sequence of shape/cycle generation each `generatePuzzle`
 * branch makes, starting from a freshly-seeded rng with the same seed —
 * since a seeded rng's output only depends on calls made *so far*, making
 * the identical prefix of calls reproduces the identical cycle regardless
 * of what `generatePuzzle` itself goes on to do with the rng afterward
 * (distractor edges, edge collections).
 *
 * Used both for the player-facing "reveal solution" give-up button and for
 * the main-menu animated background (`menuBackground.ts`) — this is *a*
 * valid win path through the puzzle's `adj` graph, not necessarily the only
 * one (distractor edges can open up other solutions the player may have
 * found instead), and if the puzzle has edge collections, marking exactly
 * these edges is not guaranteed to satisfy every collection's required
 * count (`generateEdgeCollections` picks each collection's required count
 * independently of how many of its edges happen to be on the hidden cycle).
 */
export function generateSolutionCells(id: PuzzleId): Cell[] {
  const { m, n } = sizeOption(id.sizeKey);
  const rng = mulberry32(puzzleSeed(id));
  switch (id.shapeMode) {
    case 'rect':
    case 'klein':
    case 'projective':
      return generateHamiltonianCycle(rectShape(m, n), rng).cells;
    case 'random':
      return generateShapeAndCycle((r) => randomShape(m, n, r), rng).cycle.cells;
    case 'toroidal': {
      const { cycle } = generateShapeAndCycle((r) => randomToroidalShape(m, n, r), rng);
      const W = 2 * m;
      const H = 2 * n;
      const wrapX = (x: number) => ((x % W) + W) % W;
      const wrapY = (y: number) => ((y % H) + H) % H;
      return cycle.cells.map(([x, y]): Cell => [wrapX(x), wrapY(y)]);
    }
  }
}

/** `generateSolutionCells`'s cycle, converted to the same `EdgeKey` set shape `PathState.edges` uses, closing the loop back from the last cell to the first. */
export function generateSolutionEdges(id: PuzzleId): Set<EdgeKey> {
  const cells = generateSolutionCells(id);
  const edges = new Set<EdgeKey>();
  for (let i = 0; i < cells.length; i++) {
    edges.add(edgeKey(cells[i], cells[(i + 1) % cells.length]));
  }
  return edges;
}
