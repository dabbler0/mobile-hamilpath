import { lockEdge } from './edgeLock';
import { generateHamiltonianCycle, generateShapeAndCycle, type Cell } from './hamiltonianCycle';
import { createInitialPath } from './pathEdit';
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
import { computeRegions, edgeKey, type EdgeKey } from './regions';
import { mulberry32, type Rng } from './rng';
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
  if (found) return found;
  const custom = parseCustomSizeKey(sizeKey);
  if (custom) return { key: sizeKey, label: `${custom.m}×${custom.n}`, m: custom.m, n: custom.n };
  throw new Error(`unknown size key: ${sizeKey}`);
}

const CUSTOM_SIZE_KEY_RE = /^custom:(\d+)x(\d+)$/;

/**
 * A synthetic `sizeKey` for a board with explicit, non-catalog dimensions —
 * used by Blitz mode, whose boards now vary continuously with the run's
 * difficulty budget rather than being picked from `SIZE_OPTIONS` (see
 * CLAUDE.md's "Blitz mode"). Encodes `m`/`n` directly into the key itself
 * rather than adding a second, parallel dimensions field to `PuzzleId` —
 * every other piece of code that already treats `sizeKey` as the one source
 * of a puzzle's dimensions (`generatePuzzle`, `generateSolutionCells`,
 * storage/hashing, `boardEdgeCount`) keeps working completely unchanged, it
 * just resolves through `sizeOption`'s fallback parsing below instead of a
 * `SIZE_OPTIONS` lookup.
 */
export function customSizeKey(m: number, n: number): string {
  return `custom:${m}x${n}`;
}

function parseCustomSizeKey(sizeKey: string): { m: number; n: number } | null {
  const match = CUSTOM_SIZE_KEY_RE.exec(sizeKey);
  if (!match) return null;
  return { m: Number(match[1]), n: Number(match[2]) };
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
  /**
   * Fraction (0-1) of the intended solution's own edges to lock at
   * generation time — see `edgeLock.ts`'s `lockEdge` and
   * `LOCKED_EDGE_FRACTION`. Optional, defaulting to `0` (no locking)
   * wherever read, and — like `collections` — *not* a distinct identity
   * from explicitly passing `0` (see `lockedEdgeKeySuffix`), so a
   * `PuzzleId` generated with this feature left off keeps exactly the same
   * hash/seed and storage keys as before this feature existed.
   */
  lockedEdgeFraction?: number;
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

/**
 * Suffix appended to a puzzle's hash/storage keys for its locked-edge
 * fraction — `''` whenever the feature is off (`fraction` absent or `<= 0`),
 * for the same reason `collectionsKeySuffix` returns `''` when collections
 * are off: a puzzle id with the feature untouched hashes and stores
 * byte-identically to one with the feature never mentioned.
 */
export function lockedEdgeKeySuffix(fraction: number | undefined): string {
  if (!fraction || fraction <= 0) return '';
  return `::lk${fraction}`;
}

export function puzzleIdKey(id: PuzzleId): string {
  return `${id.sizeKey}::${id.shapeMode}::${id.seed}${collectionsKeySuffix(id.collections)}${lockedEdgeKeySuffix(id.lockedEdgeFraction)}`;
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

/**
 * Fraction of a puzzle's intended-solution edges the "lock some solution
 * edges" feature locks when turned on — Free Play's experimental toggle
 * (`main.ts`'s New Game screen) and Blitz's own difficulty-gated locking
 * (`blitz.ts`'s `LOCK_EDGES_DIFFICULTY_THRESHOLD`) both use this same
 * constant, rather than two independently-tuned numbers that could drift
 * apart. Deliberately small ("no more than 5%" per this feature's spec) —
 * this is meant to read as a light nudge, not a large chunk of the solution
 * handed over for free.
 */
export const LOCKED_EDGE_FRACTION = 0.05;

function buildPuzzleForId(id: PuzzleId): Puzzle {
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

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Applies `id.lockedEdgeFraction` (see `PuzzleId`'s doc comment) to a
 * freshly-built puzzle: locks a random subset of the intended solution's
 * own edges — always locking them *into* the marked state, never out of it
 * (this feature's spec is specifically about pre-marking a few solution
 * edges, not deleting distractor ones) — via `edgeLock.ts`'s `lockEdge`.
 * The edges to lock are picked with a *separate*, freshly-hashed rng
 * (`` `${puzzleIdKey(id)}::lock` ``) rather than continuing whatever stream
 * `buildPuzzleForId` happened to consume, so the selection doesn't depend
 * on exactly how many rng calls generation itself made (which varies with
 * density/edge-collection rolls) — the same reasoning `generateSolutionEdges`
 * already relies on for Give Up. `Math.floor` (not `Math.round`) keeps the
 * count strictly at-or-under the requested fraction, never over it — "no
 * more than 5%" per this feature's spec — and exactly that many end up in
 * `puzzle.lockedEdges`; this is a plain loop, not a worklist.
 *
 * Locking one edge can *strand* others — see `lockEdge`'s/`regions.ts`'s
 * `lockEdgeInRegionMap`'s doc comments: merging two regions that share more
 * than one real edge between them leaves every edge but the one just locked
 * permanently unreachable by any tap, without itself ever being locked —
 * but a stranded edge never needs a *separate* fix to its mark state here:
 * it was, by construction, already on the boundary of whichever region just
 * got toggled to fix the edge actually being locked, so that same toggle
 * already marks/unmarks it correctly too (see `edgeLock.ts`'s doc comment
 * for the full reasoning, and `puzzleGen.test.ts`'s "never strands a
 * required solution edge" test, which checks this holds for every edge in
 * the graph, not just the ones chosen as candidates).
 *
 * Every stranded edge collected along the way *is* still folded into the
 * final `lockedEdges` set, though — not because it's required (it isn't;
 * see above), but purely for rendering: without this, a stranded edge sits
 * on screen looking like an ordinary, still-live candidate edge even though
 * no tap can ever reach it again, which reads as a rendering glitch rather
 * than the deliberate region merge it actually is. Since its mark state is
 * already correct by the time it's stranded, adding it to `lockedEdges`
 * here is a pure flag flip — no extra `lockEdge` call, no risk of an extra
 * toggle. (An earlier version of this feature *did* re-run `lockEdge` on
 * every stranded edge, via a worklist, in the mistaken belief that was
 * necessary for solvability; it wasn't, and that recursive toggling was
 * removed — this is only reinstating the harmless "flag it too" half.)
 *
 * A locked-and-marked edge can never be marked by the player themselves
 * (it's excluded from every region's boundary from the moment it locks —
 * see `regions.ts`), so the resulting puzzle's `initialEdges` records
 * exactly those edges for `pathEdit.ts`'s `createInitialPath` to seed a
 * fresh game with. A complete no-op — consuming no extra rng calls,
 * returning `puzzle` completely unchanged — whenever the fraction is
 * `0`/absent, so a puzzle generated with this feature off is
 * byte-identical to one from before it existed.
 */
function applyLockedEdges(id: PuzzleId, puzzle: Puzzle): Puzzle {
  const fraction = id.lockedEdgeFraction ?? 0;
  if (fraction <= 0) return puzzle;

  const solutionEdges = generateSolutionEdges(id);
  const shuffledSolutionEdges = shuffled([...solutionEdges], mulberry32(hashStringToSeed(`${puzzleIdKey(id)}::lock`)));
  const count = Math.floor(shuffledSolutionEdges.length * fraction);

  let lockedPuzzle = puzzle;
  let regionMap = computeRegions(lockedPuzzle);
  let state = createInitialPath();
  const allStrandedEdges = new Set<EdgeKey>();
  for (const edge of shuffledSolutionEdges.slice(0, count)) {
    const result = lockEdge(lockedPuzzle, regionMap, state, edge, true);
    lockedPuzzle = result.puzzle;
    regionMap = result.regionMap;
    state = result.state;
    for (const stranded of result.strandedEdges) allStrandedEdges.add(stranded);
  }
  if (allStrandedEdges.size > 0) {
    const lockedEdges = new Set(lockedPuzzle.lockedEdges ?? []);
    for (const stranded of allStrandedEdges) lockedEdges.add(stranded);
    lockedPuzzle = { ...lockedPuzzle, lockedEdges };
  }
  return { ...lockedPuzzle, initialEdges: [...state.edges] };
}

export function generatePuzzle(id: PuzzleId): Puzzle {
  return applyLockedEdges(id, buildPuzzleForId(id));
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
