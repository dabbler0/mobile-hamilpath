import type { Rng } from './rng';
import type { Cell } from './hamiltonianCycle';

/**
 * Scrambles an already-generated Hamiltonian cycle via random "backbite"
 * mutations, so the puzzle's hidden solution isn't structurally pegged to
 * the shape of the spanning tree it was built from.
 *
 * `hamiltonianCycle.ts`'s wall-follower only ever crosses between doubled
 * cells whose parent blocks are the same or tree-adjacent — a real
 * restriction on the *class* of cycles it can produce (every cycle it draws
 * is, in effect, the boundary of a thickened spanning tree). That
 * regularity turns out to make a puzzle far easier than it looks: once a
 * player notices the pattern, the "which loop is hidden here" problem stops
 * being anywhere near as hard as general Hamiltonian-cycle reconstruction.
 * Backbiting breaks that link — after tracing the initial tree-following
 * cycle, this module repeatedly cuts it into a Hamiltonian *path* and
 * randomly re-walks/re-closes it using the full grid's orthogonal adjacency
 * (not just tree-adjacent steps), producing a cycle that's still perfectly
 * valid but no longer has any structural relationship to the tree it
 * started from.
 *
 * The backbite move itself (`applyBackbite`): given a Hamiltonian path with
 * endpoints at both ends of the array, pick an endpoint `e` and a *different*
 * vertex `w` already on the path that's graph-adjacent to `e` (not the
 * vertex `e` is already connected to, which would be a no-op). Since `e-w`
 * is a real edge, splicing it in and dropping the path's existing edge into
 * `w` turns the path into a *different* Hamiltonian path — reverse the
 * segment between the old endpoint and `w`, and `w`'s old path-neighbor on
 * that side becomes the new endpoint. This is a standard technique for
 * randomizing self-avoiding walks/Hamiltonian paths on a fixed graph (it
 * never leaves the graph's real edges, and always stays Hamiltonian since
 * it's just a reordering of the same vertex set).
 *
 * Each round: cut the current cycle at a random edge (a Hamiltonian path
 * with the cut edge's two former endpoints as its own path endpoints), do a
 * batch of *random* backbite moves to scramble it, then do a batch of
 * *beeline* backbite moves that mostly pick the candidate landing closest to
 * the *other* endpoint's current path position, with a small chance of a
 * uniformly-random move thrown in (`reclosingBackbiteStep`'s
 * `EXPLORE_PROBABILITY`) — pure greedy hill-climbing can stall out
 * oscillating between a couple of unfavorable configurations, and this small
 * amount of noise is enough to knock it loose. Once the two endpoints are a
 * single graph-step apart, the path re-closes into a new cycle (implicitly:
 * the last cell connects back to the first) and that becomes the input to
 * the next round. Reclosing isn't mathematically guaranteed to succeed in
 * bounded steps, so each round is capped and simply abandoned (falling back
 * to the cycle from before that round) if it can't reclose in time — safe,
 * since every round starts from and can fall back to an already-valid cycle;
 * it just means that round contributed no scrambling.
 */

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** How many independent cut/scramble/reclose rounds a cycle goes through. Each round that fails to reclose in time is simply skipped (see file doc comment), so more rounds only ever help, never hurt. */
export const BACKBITE_ROUNDS = 6;

/**
 * Random backbite steps per round. Scaled to `sqrt(n)`, not `n`: each move
 * costs O(path length) (it reverses a segment, on average roughly a quarter
 * of the path), so a move count linear in `n` would cost O(n^2) per round —
 * enough to make generating a huge (1120-cell) board noticeably slow. Since
 * a single move already touches a large chunk of the path, far fewer than
 * `n` of them are needed to thoroughly scramble it — `sqrt(n)` steps still
 * means, in expectation, well over half the path gets reshuffled by at least
 * one move.
 */
function randomStepCount(n: number, rng: Rng): number {
  const lo = Math.ceil(Math.sqrt(n) * 2);
  const hi = Math.ceil(Math.sqrt(n) * 4);
  return Math.max(4, lo + Math.floor(rng() * (hi - lo + 1)));
}

/**
 * Upper bound on reclose attempts before a round gives up and falls back to
 * its pre-round cycle. In practice a successful reclose converges within a
 * few dozen attempts (each attempt is itself an O(path length) reversal, so
 * this can't be too generous without risking real slowness on a huge board)
 * — scaled to `sqrt(n)`, the same reasoning as `randomStepCount`.
 */
function maxRecloseAttempts(n: number): number {
  return Math.max(60, Math.ceil(Math.sqrt(n) * 20));
}

/** Reverses `path[lo..hi]` in place, keeping `posMap` (cell key -> path index) in sync. */
function reverseRange(path: Cell[], posMap: Map<string, number>, lo: number, hi: number): void {
  while (lo < hi) {
    const a = path[lo];
    const b = path[hi];
    path[lo] = b;
    path[hi] = a;
    posMap.set(cellKey(b[0], b[1]), lo);
    posMap.set(cellKey(a[0], a[1]), hi);
    lo++;
    hi--;
  }
}

/** Every path index a backbite at `end` could reconnect to: positions of `path[end]`'s graph-neighbors that are already on the path, excluding the vertex it's already connected to (that move would be a no-op). */
function backbiteCandidates(path: Cell[], posMap: Map<string, number>, end: 'front' | 'back', inShape: (x: number, y: number) => boolean): number[] {
  const n = path.length;
  const endIdx = end === 'front' ? 0 : n - 1;
  const adjIdx = end === 'front' ? 1 : n - 2;
  const [ex, ey] = path[endIdx];
  const candidates: number[] = [];
  for (const [dx, dy] of ORTHOGONAL) {
    const nx = ex + dx;
    const ny = ey + dy;
    if (!inShape(nx, ny)) continue;
    const j = posMap.get(cellKey(nx, ny));
    if (j === undefined || j === adjIdx) continue;
    candidates.push(j);
  }
  return candidates;
}

/** Performs the reversal that reconnects `end` to path index `j` (see file doc comment for the underlying move). */
function applyBackbite(path: Cell[], posMap: Map<string, number>, end: 'front' | 'back', j: number): void {
  const n = path.length;
  if (end === 'front') reverseRange(path, posMap, 0, j - 1);
  else reverseRange(path, posMap, j + 1, n - 1);
}

/** One uniformly-random backbite move at a random end, or a no-op (returns false) if that end has no valid candidate. */
function randomBackbiteStep(path: Cell[], posMap: Map<string, number>, inShape: (x: number, y: number) => boolean, rng: Rng): boolean {
  const end: 'front' | 'back' = rng() < 0.5 ? 'front' : 'back';
  const candidates = backbiteCandidates(path, posMap, end, inShape);
  if (candidates.length === 0) return false;
  const j = candidates[Math.floor(rng() * candidates.length)];
  applyBackbite(path, posMap, end, j);
  return true;
}

/**
 * A step toward closing the path back into a cycle at `end`: usually picks
 * whichever candidate lands closest to the *other* endpoint's current path
 * position (ties broken randomly) — the "beeline" move that tends to pull
 * the two endpoints back together fastest. A pure greedy hill-climb can get
 * stuck oscillating between a couple of unfavorable configurations without
 * ever making real progress, though, so a small fraction of steps
 * (`EXPLORE_PROBABILITY`) instead pick uniformly among *all* candidates —
 * enough noise to knock the search out of a local trap without meaningfully
 * slowing down the common case where greedy alone converges quickly.
 * Returns false if `end` has no candidate at all.
 */
const EXPLORE_PROBABILITY = 0.15;

function reclosingBackbiteStep(path: Cell[], posMap: Map<string, number>, end: 'front' | 'back', inShape: (x: number, y: number) => boolean, rng: Rng): boolean {
  const candidates = backbiteCandidates(path, posMap, end, inShape);
  if (candidates.length === 0) return false;

  let j: number;
  if (rng() < EXPLORE_PROBABILITY) {
    j = candidates[Math.floor(rng() * candidates.length)];
  } else {
    // Front wants the largest j (closest to the back endpoint at n-1); back wants the smallest j (closest to the front endpoint at 0).
    let best = end === 'front' ? -Infinity : Infinity;
    for (const c of candidates) {
      if (end === 'front' ? c > best : c < best) best = c;
    }
    const ties = candidates.filter((c) => c === best);
    j = ties[Math.floor(rng() * ties.length)];
  }
  applyBackbite(path, posMap, end, j);
  return true;
}

function areAdjacent(a: Cell, b: Cell): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/**
 * One cut/scramble/reclose round: returns the newly-closed cycle, or `null`
 * if reclosing didn't succeed within budget (caller keeps the pre-round
 * cycle in that case).
 */
function scrambleRound(cycle: readonly Cell[], inShape: (x: number, y: number) => boolean, rng: Rng): Cell[] | null {
  const n = cycle.length;

  // 1. Cut a random edge, turning the cycle into a Hamiltonian path whose
  // endpoints are exactly the two cells that edge used to connect.
  const cutAfter = Math.floor(rng() * n);
  const path: Cell[] = new Array(n);
  for (let k = 0; k < n; k++) path[k] = cycle[(cutAfter + 1 + k) % n];
  const posMap = new Map<string, number>();
  for (let i = 0; i < n; i++) posMap.set(cellKey(path[i][0], path[i][1]), i);

  // 2. Scramble: a batch of uniformly-random backbite moves. A move that
  // finds no candidate is simply skipped — still deterministic given `rng`,
  // just occasionally a no-op.
  const steps = randomStepCount(n, rng);
  for (let s = 0; s < steps; s++) {
    randomBackbiteStep(path, posMap, inShape, rng);
  }

  // 3. Beeline: backbite toward closing the path back into a cycle.
  const cap = maxRecloseAttempts(n);
  for (let a = 0; a < cap && !areAdjacent(path[0], path[n - 1]); a++) {
    const primary: 'front' | 'back' = rng() < 0.5 ? 'front' : 'back';
    const secondary = primary === 'front' ? 'back' : 'front';
    if (!reclosingBackbiteStep(path, posMap, primary, inShape, rng) && !reclosingBackbiteStep(path, posMap, secondary, inShape, rng)) {
      break; // neither endpoint has any move left — stuck, abandon this round
    }
  }

  return areAdjacent(path[0], path[n - 1]) ? path : null;
}

/**
 * Runs `BACKBITE_ROUNDS` rounds of cut/scramble/reclose (see file doc
 * comment) on an already-valid Hamiltonian cycle, returning a new cycle
 * over the same cell set. `inShape` is the same "does this doubled cell
 * exist" predicate `generateHamiltonianCycle` traces with — the graph
 * backbiting is allowed to move through is the shape's full orthogonal
 * adjacency, not just tree-adjacent steps, which is the whole point (see
 * file doc comment). Cheap no-ops (too few candidates, a round failing to
 * reclose) are always safe — the function never fails or throws, worst case
 * it returns the input cycle unchanged.
 */
export function scrambleHamiltonianCycle(cells: readonly Cell[], inShape: (x: number, y: number) => boolean, rng: Rng): Cell[] {
  let cycle: Cell[] = cells.slice();
  if (cycle.length < 4) return cycle; // nothing meaningful to scramble (smallest possible board, a single 2x2 block)

  for (let round = 0; round < BACKBITE_ROUNDS; round++) {
    const next = scrambleRound(cycle, inShape, rng);
    if (next) cycle = next;
  }
  return cycle;
}
