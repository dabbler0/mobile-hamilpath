import type { Rng } from './rng';

/** A block coordinate key, "i,j" — i,j may be negative (used internally by the toroidal fundamental-domain construction, before it's reduced into a canonical rectangle). */
export type BlockKey = string;

export function blockKey(i: number, j: number): BlockKey {
  return `${i},${j}`;
}

export function parseBlockKey(k: BlockKey): [number, number] {
  const [i, j] = k.split(',').map(Number);
  return [i, j];
}

/**
 * A board shape: an arbitrary set of "blocks" (each doubled into a 2x2 cell
 * group later on, same as the original rectangular board), plus a designated
 * `start` block — guaranteed to be in `blocks` — used as the seed for the
 * spanning tree / Hamiltonian cycle walk. `rectShape`/`randomShape` normalize
 * their blocks to start at (0,0) (so bounding-box math elsewhere is simple);
 * `randomToroidalShape` deliberately does not, since its raw, unreduced block
 * coordinates are exactly what makes the later mod-reduction into a torus
 * rectangle correct (see `puzzle.ts`'s `buildToroidalPuzzle`).
 */
export interface Shape {
  blocks: Set<BlockKey>;
  start: readonly [number, number];
}

export function hasBlock(shape: Shape, i: number, j: number): boolean {
  return shape.blocks.has(blockKey(i, j));
}

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The full m x n rectangle of blocks — the original board shape. */
export function rectShape(m: number, n: number): Shape {
  const blocks = new Set<BlockKey>();
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) blocks.add(blockKey(i, j));
  }
  return { blocks, start: [0, 0] };
}

const DIAGONALS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * A random connected polyomino of exactly `m * n` blocks, via an Eden growth
 * model: start from a single seed block and repeatedly add a uniformly
 * random block adjacent to the current shape, until the target area is
 * reached. Always connected by construction. Normalized so the bounding box
 * starts at (0,0) (the seed itself may end up anywhere within that box).
 *
 * Two extra safeguards keep the shape usable by the doubling-trick
 * Hamiltonian cycle construction (`hamiltonianCycle.ts`), which requires a
 * genuine simply-connected polyomino with no "pinch points":
 *  - A candidate is rejected if adding it would make the shape touch itself
 *    only diagonally (i.e. complete a 2x2 block window with just the
 *    diagonal pair present and both orthogonal "bridge" cells absent) — that
 *    configuration splits the doubled-cell wall-follower's boundary into two
 *    pieces that meet at a single point, which can close the traced cycle
 *    early instead of covering the whole shape.
 *  - Whenever adding a block would fully enclose one of its not-yet-included
 *    neighbors (leaving a one-cell hole with no path out), that neighbor is
 *    filled in too (recursively, in the rare case that cascades) — a hole
 *    would make the shape topologically an annulus, which the same
 *    construction can't trace. This can very occasionally push the final
 *    block count slightly above `m * n`.
 */
export function randomShape(m: number, n: number, rng: Rng): Shape {
  const area = m * n;
  const blocks = new Set<BlockKey>();
  const inShape = (i: number, j: number) => blocks.has(blockKey(i, j));
  const frontier: Array<[number, number]> = [];

  function wouldPinch(i: number, j: number): boolean {
    for (const [di, dj] of DIAGONALS) {
      if (!inShape(i + di, j + dj)) continue;
      const bridgeA = inShape(i + di, j);
      const bridgeB = inShape(i, j + dj);
      if (!bridgeA && !bridgeB) return true;
    }
    return false;
  }

  function fillEnclosedNeighbors(i: number, j: number): void {
    for (const [di, dj] of ORTHOGONAL) {
      const ni = i + di;
      const nj = j + dj;
      if (inShape(ni, nj)) continue;
      const surrounded = ORTHOGONAL.every(([ddi, ddj]) => inShape(ni + ddi, nj + ddj));
      if (surrounded) {
        blocks.add(blockKey(ni, nj));
        fillEnclosedNeighbors(ni, nj);
      }
    }
  }

  const addBlock = (i: number, j: number) => {
    blocks.add(blockKey(i, j));
    fillEnclosedNeighbors(i, j);
    for (const [di, dj] of ORTHOGONAL) {
      const ni = i + di;
      const nj = j + dj;
      if (!inShape(ni, nj)) frontier.push([ni, nj]);
    }
  };

  addBlock(0, 0);
  while (blocks.size < area && frontier.length > 0) {
    const idx = Math.floor(rng() * frontier.length);
    const [i, j] = frontier[idx];
    frontier[idx] = frontier[frontier.length - 1];
    frontier.pop();
    if (inShape(i, j)) continue; // stale entry: already added via another neighbor
    if (wouldPinch(i, j)) continue; // would touch the shape only at a corner — skip, try another candidate
    addBlock(i, j);
  }
  if (blocks.size < area) throw new Error('randomShape: ran out of growable frontier before reaching the target area');

  let minI = Infinity;
  let minJ = Infinity;
  for (const k of blocks) {
    const [i, j] = parseBlockKey(k);
    if (i < minI) minI = i;
    if (j < minJ) minJ = j;
  }
  const normalized = new Set<BlockKey>();
  for (const k of blocks) {
    const [i, j] = parseBlockKey(k);
    normalized.add(blockKey(i - minI, j - minJ));
  }
  return { blocks: normalized, start: [-minI, -minJ] };
}

/**
 * A random fundamental domain for the torus Z^2 / (mZ x nZ): exactly one
 * representative block per (i mod m, j mod n) residue class, constructed as
 * a "column skew" — column i (for i in [0, m)) holds the n consecutive rows
 * [offset_i, offset_i + n), where offset_i does a small random walk from
 * column to column. Every column trivially covers every row-residue exactly
 * once (n consecutive integers), and columns are indexed 0..m-1 directly, so
 * this is always a valid transversal regardless of the offsets chosen.
 * Consecutive columns overlap by `n - |step|` rows, so keeping each step
 * smaller than n keeps the whole shape orthogonally connected. Unlike
 * `rectShape`/`randomShape`, coordinates are NOT normalized to start at
 * (0,0) — column 0 always starts at row 0, but other columns can drift
 * negative, and that's fine: this shape's raw coordinates are what the
 * mod-reduction step in `buildToroidalPuzzle` operates on directly.
 */
export function randomToroidalShape(m: number, n: number, rng: Rng): Shape {
  const blocks = new Set<BlockKey>();
  const maxStep = Math.min(2, n - 1);
  let offset = 0;
  for (let i = 0; i < m; i++) {
    if (i > 0 && maxStep > 0) {
      const step = Math.floor(rng() * (2 * maxStep + 1)) - maxStep;
      offset += step;
    }
    for (let k = 0; k < n; k++) blocks.add(blockKey(i, offset + k));
  }
  return { blocks, start: [0, 0] };
}

/** The bounding box of a shape's blocks, as block-grid dimensions (assumes the shape is normalized to start at (0,0), true for `rectShape`/`randomShape`). */
export function shapeBoundingBox(shape: Shape): { m: number; n: number } {
  let maxI = 0;
  let maxJ = 0;
  for (const k of shape.blocks) {
    const [i, j] = parseBlockKey(k);
    if (i > maxI) maxI = i;
    if (j > maxJ) maxJ = j;
  }
  return { m: maxI + 1, n: maxJ + 1 };
}
