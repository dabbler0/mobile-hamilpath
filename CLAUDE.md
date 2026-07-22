# Loop It

A mobile-first Hamiltonian-cycle ("loop") puzzle game. The player drags a
path from a single starting cell until it visits every cell on the board
exactly once and closes back into a loop. TypeScript + Vite, deployed to
GitHub Pages.

Original proof of concept was a single HTML file; it was rewritten into
this project structure with unit tests, then extended with multi-segment
editing, a deterministic daily puzzle sequence, and IndexedDB persistence.

## Running things

```sh
npm install
npm run dev        # dev server (served under /mobile-hamilpath/ base path — vite.config.ts)
npm test           # vitest run (unit tests only, no browser)
npm run build      # tsc --noEmit-equivalent check + production build to dist/
npm run preview    # serve the production build locally
```

Deploys automatically via `.github/workflows/deploy.yml` on push to `main`
or `claude/hamiltonian-game-refactor-qnvac4` (update the branch list once a
permanent `main` exists). Requires the repo's Pages source to be set to
"GitHub Actions" and the `github-pages` environment's deployment-branch
policy to allow the pushing branch (both one-time manual settings in GitHub
repo Settings, not automatable via API).

Live at: https://dabbler0.github.io/mobile-hamilpath/

## The puzzle, conceptually

A board is an `m x n` grid of "blocks". Each block is doubled into a 2x2
group of cells, giving a `2m x 2n` cell grid (`W x H` in the code). The
generation pipeline (`src/game/`):

1. **`spanningTree.ts`** — a randomized DFS spanning tree over the `m x n`
   block grid.
2. **`hamiltonianCycle.ts`** — a "wall follower" (prefer right turn, then
   straight, then left, then U-turn) walks the doubled `W x H` grid,
   constrained to only cross between doubled-cells whose parent blocks are
   tree-adjacent (or the same block). This deterministically traces a
   Hamiltonian cycle — every cell visited exactly once, back to the start.
3. **`puzzle.ts`** — builds the graph the player actually sees: the cycle's
   edges, plus extra "distractor" edges between orthogonal neighbors (each
   added independently with probability `density`), so the hidden solution
   isn't the only path visible. The result is `Puzzle { adj: Map<CellKey,
   Set<CellKey>>, W, H, startCell }`.

`adj` is intentionally the only puzzle representation kept at runtime —
nothing else stores "the solution"; the cycle is discarded after distractor
edges are added. A completed puzzle's win path is just *some* Hamiltonian
cycle through `adj`, not necessarily the original generated one (the player
can solve it differently if distractor edges allow).

`rng.ts` is a small seeded PRNG (mulberry32) used everywhere generation
needs determinism.

## Path editing model (multi-segment)

This is the part most likely to need re-explaining. `src/game/pathDrag.ts`:

- A **segment** (`type Segment = Cell[]`) is a simple path: graph-adjacent,
  non-repeating cells. Its two ends — index `0` and `length-1` (equal when
  length is 1) — are draggable.
- `PathState { segments: Segment[]; won: boolean }` is the persisted game
  state. Cells are unique across all segments combined (never revisited).
- **Extend**: drag an endpoint onto a fresh, unvisited, graph-adjacent cell
  → it's appended/prepended to that segment.
- **Retract**: drag an endpoint back onto the cell it just came from → pops
  off.
- **Split**: tap (not drag) an *interior* cell of a segment → cuts the edge
  right after it, producing two segments. `findInteriorNodeAt` finds the
  tap target; `splitSegmentAtCell` does the cut.
- **Merge**: drag one segment's endpoint onto a *different* segment's
  endpoint → the two segments concatenate into one (orientation handled so
  the touching ends become adjacent in the merged array). Dragging onto an
  *interior* cell of another segment is blocked (would create a branch,
  which isn't a simple path).
- **Win**: dragging a segment's endpoint onto its *own other* endpoint only
  succeeds (sets `won = true`) once that segment already covers every cell
  on the board — otherwise it's a no-op.

`updatePathDrag` runs this as a hill-climbing loop per pointer-move event:
repeatedly step toward whichever neighbor (predecessor, or a puzzle-graph
neighbor) is closer to the pointer than staying put, so one big pointer
jump can resolve into several extend/retract steps at once. **Important
subtlety**: a merge always `break`s the loop immediately and reports the
newly-joined segment's far end as `draggedCell` for the *next* call, rather
than continuing to hill-climb in the same call. This was a real bug fix —
continuing in the same call (or in `input.ts`, continuing to track that far
end across the *next* pointermove event when the pointer had actually
stopped right at the join) would let the algorithm "retract" step by step
back through the segment you just merged with, silently deleting it. See
the `pathDrag.test.ts` test `'a merge stops at the join instead of
unraveling back through the joined segment'` and the comment in
`input.ts`'s pointermove handler for the full story before touching this.

`src/input.ts` (`attachPointerHandling`) wires DOM pointer events to this:
pointerdown near an endpoint starts a drag; pointerdown near an interior
cell remembers a tap candidate (committed as a split on pointerup only if
the pointer moved less than `TAP_MOVEMENT_THRESHOLD`); otherwise it's a
pan; two pointers is pinch-zoom. It talks to the host app only through the
`GameInputHost` interface (puzzle/path getters+setters, view, layout), so
it has no direct dependency on `main.ts`.

`src/render.ts` draws the board and every segment; `src/view/viewport.ts`
has the pure pan/zoom math (fit-to-view, zoom-at-point, pan) shared by
touch, mouse wheel, and the +/-/Fit buttons.

## Daily puzzle sequence

`src/game/dailyPuzzle.ts`: a puzzle is identified by `PuzzleId { day,
sizeKey, index }` — `day` is the player's local calendar date
(`YYYY-MM-DD`, see `todayKey()`), `sizeKey` is one of the fixed
`SIZE_OPTIONS` (tiny/mini/small/medium/large/huge — the `key` field is a
storage identifier, never rename it once puzzles have been played),
`index` is 0-based position in that day+size's infinite sequence.
`puzzleSeed()` hashes `"day::sizeKey::index"` (FNV-1a) into a mulberry32
seed, so the same triple always reproduces the exact same puzzle.
`DAILY_PUZZLE_DENSITY` (0.28) is fixed — density is no longer a
player-facing setting, since a puzzle's whole identity is just the triple
above (that's also why the old "Extra paths" selector is gone).

Progression resets every calendar day: each day+size starts back at index
0, and completing index N unlocks index N+1 *for that day*. This gating
lives in persistence (below), not in `dailyPuzzle.ts` itself, which is
pure/stateless.

## Persistence (IndexedDB)

`src/persistence/db.ts` is a thin promise wrapper over the raw IndexedDB
API (db name `loopit`, version 1, three stores — no external library).
`src/persistence/gameStore.ts` has the actual domain logic:

- **`progress`** store, keyed by `day::sizeKey` → `{ unlockedIndex }`. The
  next playable index for that day+size (defaults to 0 via
  `getUnlockedIndex` when no record exists).
- **`inProgress`** store, keyed by `day::sizeKey` → current segments for
  whichever puzzle is active. `main.ts` autosaves here on every path change
  (`saveInProgress`) and reads it back on load/size-switch
  (`getInProgress`) to resume exactly where you left off. Cleared on win.
- **`completed`** store, keyed by `day::sizeKey::index` → the final
  winning segments + timestamp. `recordCompletion()` is the one function
  that does all three on a win: records the completed game, clears
  in-progress, and advances `unlockedIndex` (only if the completed index
  *was* the currently-unlocked one — a safety check, not normally
  reachable any other way since the UI only ever lets you play the
  unlocked index).

Puzzles are *not* stored in full — only `PuzzleId` + final segments. The
puzzle graph is always regenerated on demand via `generateDailyPuzzle(id)`
for review, relying on determinism. (Tradeoff: if the generation algorithm
ever changes, old stored completions would regenerate a different puzzle
than what was actually solved. Acceptable for this project's scope.)

Tests use `fake-indexeddb/auto` (import it at the top of the test file) and
`clearAllStoresForTests()` between tests — *not* `indexedDB.deleteDatabase`,
which hangs waiting for the previous connection to close since `db.ts`
caches a single open connection (`resetDbConnectionForTests()` exists but
is rarely what you want; clearing stores is simpler and doesn't require
re-opening).

## `main.ts` orchestration

Holds the mutable app state: `mode: 'playing' | 'reviewing'`,
`currentPuzzleId`, `puzzle`, `pathState`, plus separate `reviewPuzzle`/
`reviewSegments` for the read-only history viewer (kept apart from the live
game so opening a review can't disturb an in-progress puzzle).
`activePuzzle()` / the `GameInputHost` given to `attachPointerHandling`
both branch on `mode` — reviewing reports `won: true` unconditionally,
which is what makes the input layer refuse edits and only allow pan/zoom
for free, without any extra guarding in `input.ts`.

`startPuzzleForSize(sizeKey)` is the one place that decides which puzzle
to show: reads `unlockedIndex` and any `inProgress` record for
`(todayKey(), sizeKey)`, resumes if they match, otherwise starts fresh at
`unlockedIndex`. Also persists `sizeKey` to `localStorage`
(`loopit:lastSize`) purely so a page reload reopens the same size — this
is separate from the IndexedDB game state and was a gap caught during
manual testing (the `<select>` otherwise resets to its HTML-declared
default on reload).

`pendingPersist` tracks the latest in-flight IndexedDB write; the "Next
Puzzle" button `await`s it before reloading, so a fast click right after
winning can't race ahead of `recordCompletion()` and re-read a stale
`unlockedIndex`.

History UI: `#historyOverlay` lists `listCompleted()`; clicking an entry
calls `enterReview()` which regenerates that puzzle and switches `mode`.
`exitReview()` restores the live game — nothing about it was touched.

## Testing notes

70 vitest tests, all in `*.test.ts` files next to their modules. Pure game
logic (`src/game/*`), viewport math, and persistence are unit tested.
`render.ts` and `input.ts` are not — they're thin DOM/canvas glue verified
by hand instead. When changing pointer interaction, the fastest way to
sanity-check is a throwaway Playwright script against `npm run dev`
(pre-installed Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
in this environment) rather than trying to unit test DOM event sequencing.
To compute an exact solution path for a given `PuzzleId` for scripted
end-to-end testing (rather than blindly raster-sweeping, which usually
gets stuck since the puzzle graph isn't a full grid), regenerate the cycle
directly: `generateHamiltonianCycle(m, n, mulberry32(puzzleSeed(id)))` —
that cycle's cell order is always a valid win path.

## Things to know before changing size/puzzle identity

`SIZE_OPTIONS[].key` and the seed hash (`day::sizeKey::index`) are load-bearing
storage/identity strings — renaming a size key or changing the hash input
format invalidates existing players' `unlockedIndex`/`inProgress`/
`completed` records (they'd just silently reset to fresh, no crash, but
progress and history would appear to vanish). If that's ever needed, it's
a one-time migration problem, not something currently handled.
