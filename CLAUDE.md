# Loop It

A mobile-first Hamiltonian-cycle ("loop") puzzle game. The board is
partitioned into regions; tapping a region toggles all of its boundary
edges between marked/unmarked, and the goal is to end up with exactly one
marked edge at every cell — a single loop visiting every cell on the board.
TypeScript + Vite, deployed to GitHub Pages.

Original proof of concept was a single HTML file; it was rewritten into
this project structure with unit tests, then went through several major
redesigns: a multi-segment pointer-drag path editor (now removed —
superseded by the current region-toggle interaction), a deterministic daily
puzzle sequence, IndexedDB persistence, non-rectangular/wraparound board
shapes, and edge collections.

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

A board is a set of "blocks" (`src/game/shape.ts`'s `Shape`) — either the
full `m x n` rectangle, a random connected polyomino of the same area, or a
random fundamental domain of a torus. Each block is doubled into a 2x2 group
of cells, giving a `2m x 2n` cell grid (`W x H` in the code, though for a
non-rectangular shape not every cell in that bounding box necessarily
exists). The generation pipeline (`src/game/`):

1. **`spanningTree.ts`** — a randomized DFS spanning tree over the shape's
   blocks, from `shape.start`.
2. **`hamiltonianCycle.ts`** — a "wall follower" (prefer right turn, then
   straight, then left, then U-turn) walks the doubled cell grid,
   constrained to only cross between doubled-cells whose parent blocks are
   tree-adjacent (or the same block). This deterministically traces a
   Hamiltonian cycle — every cell visited exactly once, back to the start.
   `generateHamiltonianCycle` throws if the walk can't complete (an
   irregular shape can occasionally have a "notch" that closes a sub-loop
   early); `generateShapeAndCycle` wraps shape generation + cycle tracing
   together and retries with a fresh shape (still deterministic — it just
   consumes more of the same `rng` stream) when that happens, which is only
   a practical concern for `randomShape`/`randomToroidalShape`, never for a
   plain rectangle.
3. **`puzzle.ts`** — builds the graph the player actually sees: the cycle's
   edges, plus extra "distractor" edges between orthogonal neighbors (each
   added independently with probability `density`), so the hidden solution
   isn't the only loop visible. The result is a `Puzzle { adj: Map<CellKey,
   Set<CellKey>>, W, H, startCell, topology?, edgeCollections? }`.

`adj` is intentionally the only puzzle representation kept at runtime —
nothing else stores "the solution"; the cycle is discarded after distractor
edges are added (except that `dailyPuzzle.ts`'s `generateDailySolutionCells`
can always recompute it on demand from the same seed, for the Give Up
button — see below). A completed puzzle's win loop is just *some*
Hamiltonian cycle through `adj`, not necessarily the original generated one
(the player can solve it differently if distractor edges allow).

`rng.ts` is a small seeded PRNG (mulberry32) used everywhere generation
needs determinism.

### Board shapes and topologies

Orthogonal to board *size* is board *shape* (`dailyPuzzle.ts`'s
`ShapeMode`): `rect` (the plain `m x n` rectangle), `random` (a random
connected polyomino of the same area, `shape.ts`'s `randomShape`), or one of
three wraparound surfaces built by gluing a rectangle's edges together
(`topology.ts`):

- **`toroidal`**: right glues straight to left, top glues straight to
  bottom (a torus). Generated differently from the other two wraparounds —
  see `buildToroidalPuzzle`'s doc comment: it traces the Hamiltonian cycle
  directly on a randomly-skewed fundamental domain of the torus
  (`randomToroidalShape`) and reduces coordinates mod `(W, H)`, since a
  torus's gluings are pure translations and so compose correctly with the
  wall-follower's usual flat-plane logic.
- **`klein`**/**`projective`**: Klein bottle (one flipped gluing) and
  projective plane (both gluings flipped) — see `topology.ts`'s file doc
  comment for the exact gluing rules. **Currently disabled** — see below.

**Klein bottle and projective plane are disabled from the shape picker.**
Dealing with these nonorientable surfaces correctly turned out to be an
ongoing source of subtle bugs (wraparound-corner edge cases in
`regions.ts`/`geometry.ts`, wrong-neighbor bugs in rendering, etc. — see git
history), and getting them fully right has proven too hard for now. The
code (`topology.ts`'s `KLEIN_BOTTLE`/`PROJECTIVE_PLANE`, `puzzle.ts`'s
`buildKleinBottlePuzzle`/`buildProjectivePlanePuzzle`, and
`dailyPuzzle.ts`'s handling of those `ShapeMode` values) is deliberately
left in place rather than deleted — `dailyPuzzle.test.ts` still exercises
it, and `generateDailyPuzzle`/`generateDailySolutionCells` still handle
those shape modes so that a puzzle completed back when they *were*
selectable keeps regenerating correctly for the history/review view. Only
the *picker* is disabled: `dailyPuzzle.ts`'s `SHAPE_MODE_OPTIONS` marks
those two entries `disabled: true`, `SELECTABLE_SHAPE_MODE_OPTIONS` filters
them out for anything UI-facing (the `<select>` in `index.html` simply
doesn't have `<option>`s for them any more), and `shapeModeOption()` still
looks them up in the full `SHAPE_MODE_OPTIONS` list so old completed
records can still show a label. May be revisited later.

A wraparound board (`puzzle.topology` set) renders as a genuinely,
seamlessly infinite repeating tiling rather than a single fixed bitmap —
panning/zooming out reveals more real copies of the board, computed fresh
each draw from the current view (`render.ts`'s `drawWrapped`). Klein
bottle/projective plane tiles would alternate mirrored/unmirrored
(`topology.ts`'s `tileOrientation`/`Orientation`); a torus's tiles are
never mirrored. `geometry.ts`'s `*Tiled` functions and `wrapToTile` handle
placing a cell/face/edge within one specific repeated tile copy.

## The face grid, regions, and the tap-to-toggle interaction

The player never drags a path. Instead, `src/game/regions.ts` partitions
the board's **faces** (`Face`: a `[fx, fy]` grid square enclosed by four
graph vertices — the everyday sense of "cell", as opposed to a `Cell`
elsewhere in this codebase, which is a graph vertex the loop visits) into
**regions**: maximal groups of faces joined only through sides that are
*not* a real puzzle-graph edge (a permanent wall, which can never be part of
any solution, never separates two faces of the same region). This partition
is fixed by the puzzle alone, independent of which edges are currently
marked — with no distractor edges, it usually comes out as just a couple of
regions (the thickened spanning-tree corridor, and whatever's outside it),
each of whose boundary is exactly the hidden Hamiltonian cycle.

- **Tap** a face (mouse/touch, `src/input.ts`) or move the keyboard cursor
  onto it and press the action key (Enter/Space, `src/keyboard.ts`) →
  `pathEdit.ts`'s `toggleRegion` flips every one of that region's boundary
  edges: unmarked becomes marked, marked becomes unmarked. This is the
  *only* edit operation in the whole game.
- **Win** (`computeWin`) is auto-detected the instant the marked-edge set is
  exactly one Hamiltonian cycle: every cell has marked-degree exactly 2,
  every cell is included, and all of them are mutually reachable via marked
  edges (ruling out e.g. two disjoint sub-loops that would otherwise each
  pass the degree check) — *and*, if the puzzle has any edge collections
  (see below), each collection's marked-edge count matches its `required`
  count exactly.
- `pathEdit.ts`'s `PathState { edges: Set<EdgeKey>; won: boolean }` is the
  entire persisted game state — no segments, no path structure, just which
  edges are currently marked.
- `PathOp` has exactly one variant: `{ op: 'toggleRegion', region, edges }`.
  It's self-inverse — applying it twice flips the same edges right back —
  which is what keeps undo/redo and replay simple (see below):
  `applyPathOp` doubles as its own inverse, there's no separate "undo this
  op" logic to write.

`input.ts` (`attachPointerHandling`) wires DOM pointer events: pointerdown
near a face remembers a tap candidate (highlighted via
`host.setFocusedRegion`), committed as a toggle on pointerup only if the
pointer moved less than `TAP_MOVEMENT_THRESHOLD`; otherwise a single-finger
drag pans, two fingers pinch-zoom. It talks to the host app only through the
`GameInputHost` interface, so it has no direct dependency on `main.ts`.

`src/render.ts` draws the board: candidate edges, marked edges (colored by
connected component, `edgeComponents.ts`, unless `won` in which case there's
only one component and it gets the single "solved" color), the region
highlight under an in-progress press/keyboard cursor, edge collection halos
and badges, and (for a wraparound board) the seamless repeated tiling
described above. `src/view/viewport.ts` has the pure pan/zoom math
(fit-to-view, zoom-at-point, pan, and the keyboard-cursor auto-scroll below)
shared by touch, mouse wheel, the +/-/Fit buttons, and the keyboard.

### Keyboard controls

`src/keyboard.ts` (`attachKeyboardHandling`) is the keyboard-only path
editor, wired onto `window` (not the canvas — no `tabindex` juggling
needed) and gated off while a native form control has focus or the history
overlay is open. It holds a `cursor: Face | null` (there's no "held" state
any more — toggling is a single action, not a drag) and reports it back to
`main.ts` via `KeyboardInputHost.setKeyboardCursor`, along with the region
the cursor sits in (`setFocusedRegion`, for the same highlight a
pointer-press candidate gets) for `render.ts` to draw as a dashed ring.

- Arrow keys move the cursor one face at a time; shift+arrow jumps `JUMP`
  (5) faces at once. On an ordinary board this clamps to the `(W-1) x (H-1)`
  face grid; on a wraparound board it wraps via `topology.wrapX`/`wrapY`
  instead of stopping (`clampToFaceBoard`).
- The action key (Enter or Space) toggles the region the cursor is
  currently over (`toggleRegion`), exactly like tapping that region with a
  pointer.
- **Viewport auto-scroll**: moving the cursor near or past the edge of the
  visible viewport pans the view just enough to bring it back within
  `KEYBOARD_CURSOR_SCROLL_MARGIN` screen pixels of every edge
  (`main.ts`'s `setKeyboardCursor`, `view/viewport.ts`'s
  `panToKeepVisible`) — the same idea as a text editor scrolling to follow
  its caret. Ordinary movement that stays comfortably on screen causes no
  pan at all (`panToKeepVisible` returns the same `Viewport` reference in
  that case, which `setKeyboardCursor` checks to skip the extra `setView`
  call). This works uniformly for wraparound boards too: a keyboard cursor
  face's screen position is always computed in the *canonical, unmirrored*
  primary tile (`geometry.ts`'s plain `faceToScreen`, not the `*Tiled`
  variants), matching how `render.ts` draws that same tile.

## Animations

Three purely-visual overlays on top of the otherwise-instant game state —
none of them gate a real move, undo, or win check, and none of them are
persisted (a reload always resumes/redraws in the fully-settled state).
`main.ts` owns scheduling and timing; `render.ts` owns drawing a given
instant of it (its `AnimationState`, threaded through `RenderState.anim`)
for both the ordinary and wraparound (`drawWrapped`) render paths.

- **Grow/shrink**: a region toggle's newly-marked edges "grow" from zero to
  full length, and newly-unmarked edges "shrink" back to zero, over
  `render.ts`'s `GROW_MS`/`SHRINK_MS` (220ms each, eased with `smoothstep`).
  `main.ts`'s `scheduleToggleAnimation` (called only from `setPathState`,
  the single funnel every pointer/keyboard toggle already goes through)
  diffs the op's edges against the previous state to decide grow vs. shrink
  per edge. A shrinking edge is no longer in `pathState.edges` at all, so
  its color is frozen at the moment of removal (`segmentColor`, exported
  from `render.ts` for this) rather than recomputed live, and `render.ts`
  draws it as an extra edge alongside the live ones for as long as it's
  still animating.
- **Recolor ripple**: when a toggle causes a merge or split, some *other*
  already-marked edge's component (and so its color) can change as a side
  effect. `game/edgeRipple.ts`'s `computeRecoloredEdges` finds every such
  edge that's actually graph-reachable from the toggle location in the
  post-toggle marked-edge graph, together with its hop distance; `main.ts`
  staggers each one's pulse start by `distance * PULSE_STAGGER_MS` so the
  recolor visibly ripples outward rather than flipping everywhere at once.
  Each pulse (`render.ts`'s `PULSE_MS`, 260ms) bulges the edge's line width
  up and back down, swapping from its old color to its live one right at
  the peak — "growing and then shrinking as it changes color". A merge/
  split can also renumber an entirely *unrelated* component purely because
  `edgeComponents.ts`'s component ids are assigned by iteration order, not
  identity (see its doc comment) — `computeRecoloredEdges` deliberately
  excludes anything not reachable from the toggle, so that case recolors
  instantly on the next render with no ripple, matching the fact that there's
  nowhere real for a ripple to travel from.
- **Win-loop dot**: once a puzzle is actually complete (`pathState.won`
  live, or `reviewWon` while reviewing — deliberately *not* `gaveUp`, which
  is explicitly not a real win, see "Give Up" below), a small dot travels
  around the solved loop forever. `game/loopOrder.ts`'s `orderLoopCells`
  walks the marked-edge set (guaranteed to be one simple Hamiltonian cycle
  by `computeWin`) into an ordered cell sequence once per completed state;
  `render.ts` interpolates the dot's on-screen position each frame from
  elapsed time (`winDotPeriodMs`, scaled by loop length and clamped so a
  tiny board isn't dizzying and a huge one doesn't crawl).

All three share one `requestAnimationFrame` chain, driven entirely by
`main.ts`'s `render()`: every other call site still just calls `render()`
once, exactly as before animations existed, and `render()` itself is the
only place that decides whether a follow-up frame is needed
(`edgeAnimsActive() || winLoopCells !== null`), rescheduling itself via
`animFrameId` until neither is true. Every entry is keyed by
`performance.now()` timestamps rather than a frame counter, so a slow frame
or a backgrounded tab can't desync an animation from where it should be.

Only a live tap/keyboard toggle (`setPathState`) starts a grow/shrink/pulse
animation. Anything that jumps straight to a different state instead — undo,
redo, Give Up, Reset, starting a new puzzle, entering/leaving review — calls
`clearEdgeAnimations()` up front, so a leftover in-flight animation is never
reinterpreted against a state it no longer describes. The win-loop dot's
cycle cache doesn't need this: `render()` recomputes it (or clears it)
automatically whenever "is this state completed" changes, or the completed
edge set's *reference* changes (a fresh win, a different already-completed
puzzle opened in review, a replay frame) — see `render()`'s own doc comment.

## Edge collections

`puzzle.ts`'s `EdgeCollection { id, edges, required }`: an optional extra
constraint layered on top of "visit every cell" — a handful of `adj` edges
(a mix of hidden-solution and distractor edges) that the finished loop must
mark *exactly* `required` of, no more, no fewer. `EdgeCollectionParams {
maxCollections, minSize, maxSize }` (part of `PuzzleId`, so a puzzle stays
fully reproducible from its id alone) controls how many collections a
puzzle gets and how big each is; `NO_EDGE_COLLECTIONS` (`maxCollections: 0`)
is the feature switched off, and is what every puzzle from before this
feature existed is equivalent to.

`generateEdgeCollections` builds each collection *to match* its rolled
`required` count — drawing exactly `required` edges from the hidden
solution cycle and the rest from distractor edges, rather than mixing
freely and hoping the count lines up (`pickCollectionEdges`) — which is
what guarantees the generated solution (which marks all and only its own
cycle edges) always satisfies every collection regardless of luck. Every
edge is used in at most one collection. `pathEdit.ts`'s `computeWin` and
`puzzle.ts`'s `countCollectionEdges` enforce/check the exact-match rule;
`render.ts` draws each collection as a colored "halo" behind the ordinary
edge strokes plus a small badge (at every one of its edges) showing
`required`, turning error-red the moment the current marked count doesn't
match.

**The player-facing controls for tuning collection params are currently
removed.** In practice a puzzle's links turned out not to affect its
difficulty much — optimal play mostly ignores them, since the grid's own
"visit every cell" constraint is almost always enough to force the same
loop a link would additionally require. Every puzzle is now generated with
`NO_EDGE_COLLECTIONS` (`main.ts`'s `startPuzzle` hardcodes it, no UI reads
it back), so `index.html`'s three number inputs, and `main.ts`'s
`currentCollectionParams`/`reflectCollectionParams`/`onCollectionsInputChange`
and their `localStorage` keys, are gone. The generation code above is
deliberately untouched — `EdgeCollectionParams`/`generateEdgeCollections`/
`pickCollectionEdges`/`countCollectionEdges` all still work exactly as
described, `dailyPuzzle.ts`/`gameStore.ts` still handle a `PuzzleId` whose
`collections` isn't `NO_EDGE_COLLECTIONS` (so an old completed puzzle that
*was* played with links on still regenerates and reviews correctly), and
the balance question may get revisited later — it's just not something a
player can currently opt into from the UI.

## Give Up

The "Give Up" button (`main.ts`'s `revealSolution`) reveals the puzzle's
intended solution — `dailyPuzzle.ts`'s `generateDailySolutionCells`/
`generateDailySolutionEdges`, which mirror `generateDailyPuzzle`'s exact
sequence of shape/cycle generation calls from a freshly-seeded rng with the
same seed, so they reproduce the identical hidden cycle regardless of what
distractor-edge/edge-collection generation `generateDailyPuzzle` goes on to
do with the rng afterward (a seeded rng's output only depends on the calls
made so far). This is *a* valid win loop through `adj`, not necessarily the
only one, and if the puzzle has edge collections it isn't guaranteed to
satisfy every collection's `required` count (collections are generated with
an independently-rolled count, not derived from this specific cycle) — the
button still shows it anyway, since it's the intended answer regardless.

Giving up sets `gaveUp = true` and blocks further editing exactly like a
real win does (`inputPathState()` reports `won: true` to the input layer
whenever `gaveUp`), but is deliberately *not* a win: no `recordCompletion`,
no `unlockedIndex` advance, and — unlike every other path mutation — never
persisted, so a reload resumes whatever was actually in progress before
Give Up was pressed, as if it never happened.

## Undo/redo and replay (game history)

Undo/redo (Undo/Redo buttons, ctrl+z / ctrl+y / ctrl+shift+z) and the
replay "movie" for a finished puzzle share one recording mechanism, but
deliberately keep *two different logs* because they have different
requirements: undoing a move and then making a different move should let
you redo back into the abandoned branch for a while (classic linear undo
semantics), but the replay movie should show *everything that really
happened*, including a move that was later undone — "redo-ing over" a move
should not erase it from the movie.

- **`src/game/pathEdit.ts`'s `PathOp`** is the atomic unit both logs are
  built from — just one variant, `toggleRegion` (see above), self-inverse
  so `applyPathOp` doubles as its own undo. A single tap/keypress always
  produces exactly one `PathOp`.
- **Why ops, not full snapshots**: a naive move log storing the whole
  `PathState` after every change is O(edges marked) per entry, so a full
  solve of the largest board (huge = 1120 cells) would cost O(n²) total —
  hundreds of KB for one game. Logging ops instead is O(region size) per
  entry — see `src/game/pathCodec.ts`'s sorted-edge-list encoding for the
  other compactness lever, used for the (bounded-size) undo-stack snapshots
  below.
- **`src/game/history.ts`'s `HistoryState { undoStack, redoStack, moveLog }`**:
  - `undoStack`/`redoStack` are stacks of *full* encoded `PathState`
    snapshots (via `pathCodec.ts`), capped at `MAX_UNDO_DEPTH` (200) so a
    very long game's undo stack doesn't grow without bound — this is a
    normal, expected undo-depth limit, not a bug. `recordMove` pushes the
    pre-move state onto `undoStack` and clears `redoStack` (standard
    linear-undo semantics: you can't redo into a branch you've since moved
    away from). `undo`/`redo` just pop a snapshot and hand it back — no
    op-inversion needed, which is what keeps this side of the design
    simple.
  - `moveLog` is append-only and *never* truncated: a real move appends a
    compact `{ kind: 'ops', ops }` entry; an undo or redo appends a
    `{ kind: 'jump', state }` entry (the snapshot it's jumping to, which
    `undo`/`redo` already have on hand from the stack pop — no extra
    encoding work). Because undo/redo add entries instead of removing them,
    doing a move and then undoing it both show up, in the order they
    actually happened. `decodeMoveLog(puzzle, initial, moveLog)` expands
    this back into the full frame-by-frame sequence of states for replay —
    one frame per atomic op (plus one per jump), which is what makes the
    replay animate region-by-region rather than jumping in big chunks.
    `initial` is always `createInitialPath()` (no longer puzzle-dependent —
    an empty edge set is the same for every puzzle), never itself stored.
- **`main.ts` wiring**: `setPathState` (the single funnel every pointer/
  keyboard edit already goes through) is the one place that calls
  `recordMove`; `input.ts`/`keyboard.ts` just need to thread the `ops` their
  `toggleRegion` call already produces through to `setPathState`.
  `performUndo`/`performRedo` call `history.ts`'s `undo`/`redo` and apply
  the returned state exactly like any other path update. Undo/redo are only
  ever enabled while `mode === 'playing' && !pathState.won && !gaveUp`
  (`undoRedoAllowed()`). **Reset** (`resetPath`) starts a fresh `history`
  too — otherwise an eventual win's replay would confusingly interleave an
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
  frames usually aren't won yet.

## Daily puzzle sequence

`src/game/dailyPuzzle.ts`: a puzzle is identified by `PuzzleId { day,
sizeKey, shapeMode, index, collections? }` — `day` is the player's local
calendar date (`YYYY-MM-DD`, see `todayKey()`), `sizeKey` is one of the
fixed `SIZE_OPTIONS` (tiny/mini/small/medium/large/huge — the `key` field is
a storage identifier, never rename it once puzzles have been played),
`shapeMode` is one of `SHAPE_MODE_OPTIONS` (see "Board shapes and
topologies" above — `klein`/`projective` are disabled from selection but
still valid `PuzzleId` values for old data), `index` is 0-based position in
that day+size+shape(+collections)'s infinite sequence, and `collections` is
the optional `EdgeCollectionParams` (see "Edge collections" above).
`puzzleSeed()` hashes `puzzleIdKey(id)` (FNV-1a) into a mulberry32 seed, so
the same id always reproduces the exact same puzzle. `DAILY_PUZZLE_DENSITY`
(0.28) is fixed — density is not a player-facing setting.

Progression resets every calendar day: each day+size+shape+collections
combo starts back at index 0, and completing index N unlocks index N+1 *for
that combo*. This gating lives in persistence (below), not in
`dailyPuzzle.ts` itself, which is pure/stateless.

## Persistence (IndexedDB)

`src/persistence/db.ts` is a thin promise wrapper over the raw IndexedDB
API (db name `loopit`, version 1, three stores — no external library).
`src/persistence/gameStore.ts` has the actual domain logic:

- **`progress`** store, keyed by `day::sizeKey::shapeMode[::c...]` (see
  `dayAndSizeId`/`collectionsKeySuffix` — the suffix is empty whenever
  collections are off, so a puzzle id with the feature untouched hashes and
  stores byte-identically to one from before the feature existed) →
  `{ unlockedIndex }`. The next playable index for that combo (defaults to
  0 via `getUnlockedIndex` when no record exists).
- **`inProgress`** store, same key → current marked `edges` (plus the
  undo/redo `history`, see above) for whichever puzzle is active. `main.ts`
  autosaves here on every path change (`saveInProgress`) and reads it back
  on load/size-or-shape-switch (`getInProgress`) to resume exactly where
  you left off, undo stack included. Cleared on win.
- **`completed`** store, keyed by `puzzleIdKey(id)` (shared with
  `dailyPuzzle.ts` so the two never drift apart) → the final winning
  `edges` + timestamp + the game's `moveLog` (for replay, see above).
  `recordCompletion()` is the one function that does all three on a win:
  records the completed game, clears in-progress, and advances
  `unlockedIndex` (only if the completed index *was* the
  currently-unlocked one — a safety check, not normally reachable any
  other way since the UI only ever lets you play the unlocked index).

Puzzles are *not* stored in full — only `PuzzleId` + final `edges`. The
puzzle graph is always regenerated on demand via `generateDailyPuzzle(id)`
for review, relying on determinism. (Tradeoff: if the generation algorithm
ever changes, old stored completions would regenerate a different puzzle
than what was actually solved. Acceptable for this project's scope.)

Two backward-compatibility helpers in `gameStore.ts` are worth knowing
about: `hasEdges` rejects a record saved before the region-toggle rewrite
(which stored `segments`, not `edges` — structurally incompatible, so it's
simply treated as unusable rather than migrated) wherever a record is read;
`withShapeModeDefault` defaults a `completed` record with no `shapeMode` at
all (i.e. from before board shapes existed) to `'rect'`, since every such
puzzle genuinely was a plain rectangle.

Tests use `fake-indexeddb/auto` (import it at the top of the test file) and
`clearAllStoresForTests()` between tests — *not* `indexedDB.deleteDatabase`,
which hangs waiting for the previous connection to close since `db.ts`
caches a single open connection (`resetDbConnectionForTests()` exists but
is rarely what you want; clearing stores is simpler and doesn't require
re-opening).

## `main.ts` orchestration

Holds the mutable app state: `mode: 'playing' | 'reviewing'`,
`currentPuzzleId`, `puzzle`, `regionMap` (`computeRegions(puzzle)`,
recomputed whenever the puzzle changes), `pathState`, `gaveUp` (see "Give
Up" above), `history` (undo/redo + move log, see above), plus separate
`reviewPuzzle`/`reviewRegionMap`/`reviewEdges`/`reviewWon`/
`currentReviewItem` for the read-only history viewer (kept apart from the
live game so opening a review can't disturb an in-progress puzzle), and
`focusedRegionId`/`keyboardCursor` for the current press/keyboard
highlight. `activePuzzle()`/`activeRegionMap()` and the `GameInputHost`
given to `attachPointerHandling` all branch on `mode` — reviewing reports
`won: true` unconditionally (`inputPathState()`), which is what makes the
input layer refuse edits and only allow pan/zoom for free, without any
extra guarding in `input.ts`/`keyboard.ts`.

`startPuzzle(sizeKey, shapeMode, collections)` is the one place that
decides which puzzle to show: reads `unlockedIndex` and any `inProgress`
record for `(todayKey(), sizeKey, shapeMode, collections)`, resumes if they
match, otherwise starts fresh at `unlockedIndex`. Also persists `sizeKey`/
`shapeMode`/the three collection numbers to `localStorage` purely so a page
reload reopens the same configuration — separate from the IndexedDB game
state, and why `SELECTABLE_SHAPE_MODE_OPTIONS` (not the full
`SHAPE_MODE_OPTIONS`, which still includes the disabled klein/projective
entries) gates whether a stored `lastShape` is honored on reload.

A wraparound board (`puzzle.topology`) is panned/zoomed differently from an
ordinary one: an ordinary board's canvas is a fixed-size bitmap moved via a
cheap CSS `transform` (`applyTransform`); a wraparound board's canvas is
instead sized to the visible viewport itself and redrawn from scratch on
every view change, since the content genuinely tiles infinitely and there's
no fixed bitmap a CSS transform could pan across (`layout()`/
`applyTransform()` both branch on this).

`pendingPersist` tracks the latest in-flight IndexedDB write; the "Next
Puzzle" button `await`s it before reloading, so a fast click right after
winning can't race ahead of `recordCompletion()` and re-read a stale
`unlockedIndex`.

History UI: `#historyOverlay` lists `listCompleted()`; clicking an entry
calls `enterReview()` which regenerates that puzzle and switches `mode`.
`exitReview()` restores the live game — nothing about it was touched.

## Testing notes

250 vitest tests across 17 files, all in `*.test.ts` files next to their
modules. Pure game logic (`src/game/*`), viewport math, and persistence are
unit tested — including the pure pieces of the animation system
(`loopOrder.ts`'s cycle-walk, `edgeRipple.ts`'s reachable-recolor BFS), even
though the animations themselves are visual-only. `render.ts`, `input.ts`,
and `keyboard.ts` are not — they're thin DOM/canvas glue verified by hand
instead. When changing pointer or
keyboard interaction, the fastest way to sanity-check is a throwaway
Playwright script against `npm run dev` (pre-installed Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in this environment)
rather than trying to unit test DOM event sequencing — e.g. driving
`#sizeSelect`/keyboard arrow presses and reading back `#canvas`'s
`style.transform` is how the keyboard-cursor viewport auto-scroll
(`panToKeepVisible`) was manually verified.

To compute an exact solution path for a given `PuzzleId` for scripted
end-to-end testing, use `dailyPuzzle.ts`'s `generateDailySolutionCells(id)`
directly (it mirrors `generateDailyPuzzle`'s exact rng call sequence for
every shape mode, including toroidal's mod-reduction — see "Give Up"
above) rather than trying to reverse-engineer a solution from `adj` or
blindly raster-sweeping the face grid.

## Things to know before changing size/shape/puzzle identity

`SIZE_OPTIONS[].key`, `SHAPE_MODE_OPTIONS[].key`, and the id hash
(`puzzleIdKey`: `day::sizeKey::shapeMode::index` plus the optional
collections suffix) are load-bearing storage/identity strings — renaming a
size or shape key, or changing the hash input format, invalidates existing
players' `unlockedIndex`/`inProgress`/`completed` records (they'd just
silently reset to fresh, no crash, but progress and history would appear to
vanish). If that's ever needed, it's a one-time migration problem, not
something currently handled. This includes `klein`/`projective`: even
though they're disabled from the picker, their `ShapeMode` keys must stay
exactly as they are for as long as any player might have completed puzzles
of those shapes sitting in their `completed` store.
