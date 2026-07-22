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

Whichever segment is actively being edited — dragged by a pointer, or held
by the keyboard cursor (below) — is reported up to `main.ts` via
`GameInputHost.setActiveSegment`/`KeyboardInputHost.setActiveSegment` and
drawn in a distinct color (`render.ts`'s `RenderState.activeSegmentIndex`),
so mid-edit it's visually clear which segment will move next.

### Keyboard controls

`src/keyboard.ts` (`attachKeyboardHandling`) is the keyboard-only path
editor, wired onto `window` (not the canvas — no `tabindex` juggling
needed) and gated off while a native form control has focus or the
history overlay is open. It never touches the DOM/canvas itself: it holds
a `cursor: Cell | null` and a `held: boolean`, and reports both back to
`main.ts` via `KeyboardInputHost.setKeyboardCursor` for `render.ts` to draw
as a ring (dashed white while free, solid blue while held).

- Arrow keys move the cursor freely around the full `W x H` lattice when
  nothing is held (clamped to the board, not constrained to graph edges).
- The action key (Enter or Space) on a segment endpoint "picks it up"
  (`held = true`); pressing it again drops it. On an *interior* cell it
  splits the segment there instead (same `splitSegmentAtCell` the tap
  gesture uses), without picking anything up.
- While held, arrow keys move that endpoint exactly one cell in the
  pressed direction, replaying the same extend/retract/merge/win rules as
  a pointer drag: `src/game/pathDrag.ts`'s `stepPathEndDirection` builds a
  target position for the immediate neighbor cell and hands it to
  `updatePathDrag`, so a single key press yields exactly one step (`updatePathDrag`
  hill-climbs toward whatever pixel target it's given; aiming precisely at
  one neighbor's cell — distance zero once reached — means it can't
  overshoot further in the same call).
- Shift+arrow jumps: 5 cells at once for the free cursor, or (while held)
  runs via `runPathEndDirection` — repeated single steps in the same fixed
  direction — until the endpoint reaches a fork (a node with graph degree
  > 2), a dead end (degree 1), merges into another segment, or wins,
  stopping right there rather than requiring a key press per cell.
  Winning is checked before the "did we move" check inside
  `runPathEndDirection`: `updatePathDrag` deliberately leaves
  `draggedCell` unmoved on a winning close (the endpoint conceptually
  stays put once the loop shuts), so checking movement first would
  misread a win as "blocked" and silently drop it.
- On a merge, the keyboard cursor stays at the join instead of jumping to
  the merged segment's far end. This differs from a pointer drag on
  purpose: a mouse drag keeps tracking the far end so a continued drag
  gesture can carry on past the join (see `updatePathDrag`'s docs above),
  but a keyboard press is a single, discrete action — the join cell is
  where the user's key press actually landed, so that's where the cursor
  should visually stay. `stepPathEndDirection`/`runPathEndDirection` both
  report this as `mergeJoinCell` (non-null only on a merge), alongside the
  unchanged `draggedCell` (the far end, kept for consistency with
  `updatePathDrag`); `keyboard.ts` reads `mergeJoinCell` for the cursor
  position instead of `draggedCell` whenever a merge happened.

## Undo/redo and replay (game history)

Undo/redo (Undo/Redo buttons, ctrl+z / ctrl+y / ctrl+shift+z) and the
replay "movie" for a finished puzzle share one recording mechanism, but
deliberately keep *two different logs* because they have different
requirements: undoing a move and then making a different move should let
you redo back into the abandoned branch for a while (classic linear undo
semantics), but the replay movie should show *everything that really
happened*, including a move that was later undone — "redo-ing over" a
move should not erase it from the movie.

- **`src/game/pathDrag.ts`'s `PathOp`** is the atomic, compact unit both
  logs are built from: `extend`/`retract`/`merge`/`split`/`win`, each O(1)
  regardless of how long the segments involved are (a `merge` is just two
  segment indices + which ends touched, not the merged cells). `applyPathOp`
  is the forward-only replay of one op. `updatePathDrag` (and therefore
  `stepPathEndDirection`/`runPathEndDirection`) now returns `ops: PathOp[]`
  alongside its usual result — every mutation the hill-climbing loop made,
  in order, so one pointer-move or key-press call that resolves into several
  extend/retract steps still reports each one individually. Split doesn't
  happen inside `updatePathDrag` (it's a direct tap/keyboard action in
  `input.ts`/`keyboard.ts`), so those two call sites construct the `split`
  op by hand right next to their `splitSegmentAtCell` call.
- **Why ops, not full snapshots**: a naive move log storing the whole
  `PathState` after every change is O(path length) per entry, so a full
  solve of the largest board (huge = 1120 cells) would cost O(n²) total —
  hundreds of KB for one game. Logging ops instead is O(1) per entry, O(n)
  total for a whole solve, which is what "fairly compact" actually requires
  here — see `src/game/pathCodec.ts`'s segment encoding (start cell +
  one direction char per step, e.g. `"3,4:RRDU"`) for the other compactness
  lever, used for the (bounded-size) undo-stack snapshots below.
- **`src/game/history.ts`'s `HistoryState { undoStack, redoStack, moveLog }`**:
  - `undoStack`/`redoStack` are stacks of *full* encoded `PathState`
    snapshots (via `pathCodec.ts`), capped at `MAX_UNDO_DEPTH` (200) so a
    very long game's undo stack doesn't grow without bound — this is a
    normal, expected undo-depth limit, not a bug. `recordMove` pushes the
    pre-move state onto `undoStack` and clears `redoStack` (standard
    linear-undo semantics: you can't redo into a branch you've since moved
    away from). `undo`/`redo` just pop a snapshot and hand it back —
    no op-inversion needed, which is what keeps this side of the design
    simple.
  - `moveLog` is append-only and *never* truncated: a real move appends a
    compact `{ kind: 'ops', ops }` entry; an undo or redo appends a
    `{ kind: 'jump', state }` entry (the snapshot it's jumping to, which
    `undo`/`redo` already have on hand from the stack pop — no extra
    encoding work). Because undo/redo add entries instead of removing them,
    doing a move and then undoing it both show up, in the order they
    actually happened. `decodeMoveLog(initial, moveLog)` expands this back
    into the full frame-by-frame sequence of states for replay — one frame
    per atomic op (plus one per jump), which is what makes the replay
    animate cell-by-cell rather than jumping in big chunks. `initial` is
    always `createInitialPath(puzzle)`, never itself stored, since it's
    the same for every game of a given puzzle.
- **`main.ts` wiring**: `setPathState` (the single funnel every pointer/
  keyboard edit already went through) is now the one place that calls
  `recordMove` — it's the only thing that needed to change in `input.ts`/
  `keyboard.ts` was threading the `ops` their existing calls already
  compute through to `setPathState`. `performUndo`/`performRedo` call
  `history.ts`'s `undo`/`redo` and apply the returned state exactly like
  any other path update. Undo/redo are only ever enabled while
  `mode === 'playing' && !pathState.won` (`undoRedoAllowed()`) — editing is
  already blocked everywhere else once a puzzle is won, so there's no
  "undo the winning move" case to reconcile with `recordCompletion` having
  already fired. **Reset** (`resetPath`) starts a fresh `history` too —
  otherwise an eventual win's replay would confusingly interleave an
  earlier abandoned attempt with the one that actually finished.
- **Backward compatibility**: `history` on `InProgressRecord` and
  `moveLog` on `CompletedRecord` (`gameStore.ts`) are both optional.
  Resuming an old in-progress save with no `history` field falls back to a
  fresh, empty `HistoryState` (undo/redo simply start unavailable) and
  shows a one-time toast (`showToast`, `#toast`) explaining why — but only
  when *resuming* an old save; a brand-new puzzle having no history yet is
  completely normal and shows nothing. An old completed record with no
  `moveLog` just disables the Replay button with an explanatory `title`,
  rather than crashing `decodeMoveLog` on missing data.
- **Replay UI**: `#reviewBar` swaps between `#reviewIdleControls`
  (Replay/Done) and `#reviewPlaybackControls` (Play/Pause, a scrubber,
  Done) rather than being two separate bars, to keep the CSS/layout
  simple. `reviewWon` (distinct from the hardcoded `won: true` `render()`
  used before this feature, for the static "view a finished puzzle" case)
  tracks the *current replay frame's* own `won` flag, since mid-playback
  frames usually aren't won yet — rendering them with `won` hardcoded true
  would incorrectly draw the closing loop edge before the path actually
  covers the board.

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
- **`inProgress`** store, keyed by `day::sizeKey` → current segments (plus
  the undo/redo `history`, see above) for whichever puzzle is active.
  `main.ts` autosaves here on every path change (`saveInProgress`) and
  reads it back on load/size-switch (`getInProgress`) to resume exactly
  where you left off, undo stack included. Cleared on win.
- **`completed`** store, keyed by `day::sizeKey::index` → the final
  winning segments + timestamp + the game's `moveLog` (for replay, see
  above). `recordCompletion()` is the one function that does all three on
  a win: records the completed game, clears in-progress, and advances
  `unlockedIndex` (only if the completed index *was* the
  currently-unlocked one — a safety check, not normally reachable any
  other way since the UI only ever lets you play the unlocked index).

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
`currentPuzzleId`, `puzzle`, `pathState`, `history` (undo/redo + move log,
see "Undo/redo and replay" above), plus separate `reviewPuzzle`/
`reviewSegments`/`reviewWon`/`currentReviewItem` for the read-only history
viewer (kept apart from the live game so opening a review can't disturb an
in-progress puzzle).
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

111 vitest tests, all in `*.test.ts` files next to their modules. Pure game
logic (`src/game/*`), viewport math, and persistence are unit tested.
`render.ts`, `input.ts`, and `keyboard.ts` are not — they're thin DOM/canvas
glue verified by hand instead (`keyboard.ts` pushes its actual step/run
logic down into `pathDrag.ts`'s pure, tested functions for exactly this
reason). When changing pointer or keyboard interaction, the fastest way to
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
