# Eincycle

A mobile-first Hamiltonian-cycle ("loop") puzzle game. Formerly called "Loop
It", then "Einkreis" — the current name is, like its predecessors, a
placeholder and may change again; don't read anything permanent into it.
Renaming it is now a one-constant edit: `src/gameName.ts`'s `GAME_NAME` is
the single source of truth for the display name, propagated at startup
(`main.ts`) to every on-screen occurrence — `index.html`'s `.gameName`
elements and `document.title` — see `gameName.ts`'s own doc comment for
what a rename deliberately does *not* touch (storage/identity keys like the
`loopit:`-prefixed `localStorage` keys and `persistence/db.ts`'s IndexedDB
database name, which stay put regardless of what the game is called this
week). The board is partitioned into regions; tapping a region toggles all
of its boundary edges between marked/unmarked, and the goal is to end up
with exactly one marked edge at every cell — a single loop visiting every
cell on the board. TypeScript + Vite, deployed to GitHub Pages.

Original proof of concept was a single HTML file; it was rewritten into
this project structure with unit tests, then went through several major
redesigns: a multi-segment pointer-drag path editor (now removed —
superseded by the current region-toggle interaction), a deterministic daily
puzzle sequence (now also removed — superseded by the current seed-based
puzzle identity, see "Puzzle identity and generation" below), IndexedDB
persistence, non-rectangular/wraparound board shapes, edge collections, a
menu-driven shell wrapped around what used to be a single always-visible
game screen (see "Menus and screen navigation" below), and Blitz mode — a
timed run through an endlessly-escalating sequence of puzzles, with its own
personal leaderboard and real-time replay (see "Blitz mode" below).

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
   plain rectangle. Once the wall-follower's walk completes,
   `generateHamiltonianCycle` immediately scrambles it via
   `backbite.ts`'s `scrambleHamiltonianCycle` before returning — see
   "Backbite scrambling" below.
3. **`puzzle.ts`** — builds the graph the player actually sees: the cycle's
   edges, plus extra "distractor" edges between orthogonal neighbors (each
   added independently with probability `density`), so the hidden solution
   isn't the only loop visible. The result is a `Puzzle { adj: Map<CellKey,
   Set<CellKey>>, W, H, startCell, topology?, edgeCollections? }`.

`adj` is intentionally the only puzzle representation kept at runtime —
nothing else stores "the solution"; the cycle is discarded after distractor
edges are added (except that `puzzleGen.ts`'s `generateSolutionCells` can
always recompute it on demand from the same seed, for the Give Up button and
the main menu's animated background — see below). A completed puzzle's win
loop is just *some*
Hamiltonian cycle through `adj`, not necessarily the original generated one
(the player can solve it differently if distractor edges allow).

`rng.ts` is a small seeded PRNG (mulberry32) used everywhere generation
needs determinism.

### Backbite scrambling

The wall-follower above only ever crosses between doubled cells whose
parent blocks are the same or tree-adjacent — every cycle it can produce is,
structurally, the boundary of a thickened spanning tree. That's a real
restriction on the *class* of Hamiltonian cycles the generator can ever
draw, and it makes a puzzle much easier than "find a Hamiltonian cycle"
sounds: once a player notices the tree-boundary pattern, reconstructing the
loop stops requiring anything like a general search. `src/game/backbite.ts`
exists purely to break that link, by scrambling the freshly-traced cycle
into a different Hamiltonian cycle over the same cells before
`generateHamiltonianCycle` returns it — every shape mode gets this for free
since they all funnel through `generateHamiltonianCycle` (or, for toroidal,
through the same function traced on the unreduced fundamental-domain
shape), and `puzzleGen.ts`'s `generateSolutionCells`/`generateSolutionEdges`
stay in sync automatically for the same reason (see "Give Up" below) — no
separate call site needed to know scrambling exists at all.

The technique is repeated rounds of **backbite** mutation, a standard way to
randomize a Hamiltonian path/cycle on a fixed graph without ever leaving its
real edges:

- **The backbite move** (`applyBackbite`): given a Hamiltonian *path* (an
  open cycle, with two endpoints), pick an endpoint `e` and some *other*
  vertex `w` already on the path that's graph-adjacent to `e` in the
  underlying grid (excluding the vertex `e`'s already connected to, which
  would be a no-op). Since `e-w` is a real edge, reversing the segment of
  the path between the old endpoint and `w` turns it into a different valid
  Hamiltonian path — `w`'s old path-neighbor on the near side becomes the
  new endpoint. This never uses anything but real orthogonal-adjacency
  edges and never revisits a cell, so the result is always a legal
  Hamiltonian path.
- **Each round** (`scrambleRound`): cut the current cycle at a random edge,
  turning it into a Hamiltonian path whose two endpoints are exactly the
  cut edge's former ends (so they start out trivially adjacent — that's
  the edge that was just removed). Do a batch of *uniformly-random*
  backbite moves (`randomBackbiteStep`, alternating a random end each
  time) to scramble the path, using the shape's *full* orthogonal
  adjacency as the graph to move through — not the tree-adjacency
  restriction the wall-follower is limited to, which is the whole point.
  Then do a batch of *beeline* moves (`reclosingBackbiteStep`) that mostly
  pick whichever candidate lands closest to the *other* endpoint's current
  path position, pulling the two endpoints back toward being adjacent again;
  a small chance per step (`EXPLORE_PROBABILITY`) of a uniformly-random move
  instead is what keeps this from stalling in a hill-climbing local trap
  (pure greedy could oscillate between a couple of unfavorable
  configurations without ever converging — confirmed empirically during
  development). Once the two endpoints are graph-adjacent again, the path
  implicitly re-closes into a new cycle (last cell connects back to the
  first), which becomes the input to the next round.
- **Reclosing isn't mathematically guaranteed** to succeed within a bounded
  number of beeline attempts, so each round is capped
  (`maxRecloseAttempts`) and simply *abandoned* — falling back to the cycle
  from before that round — if it can't reclose in time. This is always
  safe: every round starts from an already-valid cycle and can fall back to
  it losing nothing but that round's contribution to the scrambling.
  `scrambleHamiltonianCycle` never throws; worst case (never observed in
  practice — see below) it returns the input cycle completely unscrambled.
  `BACKBITE_ROUNDS` (6) rounds run regardless, each independently capable of
  failing or succeeding.
- **Cost, and why the move/attempt counts scale with `sqrt(n)` rather than
  `n`**: a single backbite move costs O(path length) (the reversal touches,
  on average, roughly a quarter of the whole path) — so a move count linear
  in the cycle's cell count `n` would cost O(n²) per round, which measured
  as ~600ms for a single huge (1120-cell) board before this was tuned down.
  Since one move already touches a large chunk of the path, far fewer than
  `n` of them are needed to thoroughly scramble it — both
  `randomStepCount` and `maxRecloseAttempts` scale with `sqrt(n)` instead,
  which brought a huge board back down to roughly 100ms while still
  reclosing successfully in every round across broad stress-testing (every
  size, every shape mode, dozens of seeds each — see `backbite.test.ts` and
  `puzzleGen.test.ts`).
- After scrambling, `generateHamiltonianCycle` rotates the resulting cycle
  so it once again starts at the shape's doubled start cell (`cells[0]` is
  still `[2 * shape.start[0], 2 * shape.start[1]]`, exactly as before this
  feature existed) — scrambling only changes which cycle is traced, not
  where in it the returned array happens to begin.

### Board shapes and topologies

Orthogonal to board *size* is board *shape* (`puzzleGen.ts`'s
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
`puzzleGen.ts`'s handling of those `ShapeMode` values) is deliberately
left in place rather than deleted — `puzzleGen.test.ts` still exercises
it, and `generatePuzzle`/`generateSolutionCells` still handle those shape
modes so that a puzzle completed back when they *were* selectable keeps
regenerating correctly for the Replays/review view. Only the *picker* is
disabled: `puzzleGen.ts`'s `SHAPE_MODE_OPTIONS` marks those two entries
`disabled: true`, `SELECTABLE_SHAPE_MODE_OPTIONS` filters them out for
anything UI-facing (the New Game `<select>` in `index.html` simply doesn't
have `<option>`s for them any more), and `shapeModeOption()` still looks
them up in the full `SHAPE_MODE_OPTIONS` list so old completed records can
still show a label. May be revisited later.

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

**Not every computed region is actually safe to toggle.** Toggling a region
only preserves the game's core invariant (every cell's marked-degree stays
*even* after any sequence of taps, starting from 0 at an empty board) if
that region's own `boundary` is itself a closed loop — every cell it
touches has an even number of `boundary` edges. On an unwrapped
(non-toroidal) board, a lone, unpaired distractor edge can land exactly on
the board's true outer edge (or a non-rectangular shape's own gap) with no
matching edge to close the loop around it there — `computeRegions` still
has to include that one real candidate edge in whichever region borders it
(nothing else can ever toggle it), but the resulting `boundary` ends up an
*open* chain instead of a closed one. Toggling a region like that would
create a cell with a dangling single marked edge — a state `computeWin` can
never call a win, and neither the same tap nor any other single tap can
undo, since nothing else touches that same open chain. `regions.ts`'s
`isBoundaryEnclosed`/`Region.enclosed` detects this per region (every
region on a wraparound board is always enclosed — there's no true outer
edge for the problem to arise from); `input.ts` and `keyboard.ts` refuse to
highlight or toggle a non-enclosed region at all — a tap or keyboard cursor
on one behaves exactly as if there were no region there. `pathEdit.ts`'s
`toggleRegion` itself stays completely unchanged and unconditional — the
check lives in every *caller* that picks which region to toggle, not inside
`toggleRegion` itself, which is what lets `game/edgeLock.ts`'s `lockEdge`
(both generation-time locking and the live "Hint me" feature — see
"Locking edges" below) apply the *same* check with different fallback
behavior: it can't just refuse outright the way the input layer does, since
the edge it's locking still has to end up in the right mark state, so it
prefers an enclosed candidate among an edge's bordering regions and only
falls back to setting the edge's mark state directly (no toggle at all)
once every candidate is non-enclosed — `lockEdge`'s own doc comment has the
details, including why this was a real bug found (and fixed) here, not a
hypothetical one: an earlier version of `lockEdge` picked purely by
boundary size with no enclosure check, and did measurably pick a
non-enclosed region in practice, which could bake a dangling
odd-marked-degree cell into a locked puzzle's starting state — see
`puzzleGen.test.ts`'s "never bakes a dangling odd-marked-degree cell into
initialEdges" test. Refusing to toggle a non-enclosed region never strands
anything real: every other edge on its boundary is an ordinary interior
wall that also borders some other, different (and reliably enclosed)
region, so it stays reachable through that one instead — verified for real
generated puzzles, across every shape mode, in `regions.test.ts` and
`puzzleGen.test.ts` (including a GF(2) linear-algebra check that the
intended solution stays fully reachable using only enclosed regions, not
just that each individual solution edge does).

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
Listeners are bound to `wrapEl` (`#boardWrap`, the whole board viewport),
*not* the canvas element inside it — an ordinary (non-wraparound) board's
canvas is only sized to the board's own fixed pixel dimensions, so a small
board (or any board zoomed out below 1:1) leaves empty wrap area the canvas
itself doesn't cover; binding to the canvas alone meant pan/pinch only
worked when the gesture started directly on top of the board's own pixels.
The coordinate math (`wrapLocal`) already read `host.wrapEl`'s own
`getBoundingClientRect()` rather than the canvas's, so nothing else needed
to change for this. Since `wrapEl` also contains real interactive controls
as plain siblings of the canvas (the zoom buttons, and — while
reviewing/watching a Blitz replay — the review/Blitz-replay bars' buttons,
speed `<select>`, and scrubber), listening on their common ancestor means
a tap on any of those now bubbles up here too; `isInteractiveTarget` (an
early return in `onPointerDown` for any `evt.target` inside a `button`,
`select`, `input`, `a`, or `label`) is what keeps those working as plain
control presses instead of being misread as a board gesture.

**Mouse hover highlight** (GitHub issue #58): unlike a tap, a mouse can
rest over a face *before* clicking, so with a mouse the region under the
cursor is highlighted continuously as it moves, not just for the brief
instant between mousedown and mouseup. `onPointerMove`'s early return for a
pointer that isn't in `activePointers` (i.e. nothing pressed) is exactly
where a bare hover move lands; there, `evt.pointerType === 'mouse'` gates a
call to `updateHoverRegion`, which shares `onPointerDown`'s own
face-under-point → enclosed-region lookup (factored out as
`regionAtPoint`, so a click always agrees with whatever its own
immediately-preceding hover move already highlighted) and reports it
through the same `host.setFocusedRegion` a tap-candidate already uses —
this is one shared highlight slot, not a separate hover concept, so a
mouse's own click still shows exactly the same highlight it was already
hovering. Never triggered for touch/pen (no meaningful "hover" gesture
exists for those), and suppressed while a pan or pinch from some *other*
pointer is already in progress, so an idle second mouse can't fight an
in-progress gesture's own highlight. `onPointerLeave` (a new listener,
gated the same way) clears the highlight when the cursor leaves `wrapEl`
without a mouseup — otherwise it would linger showing a region the cursor
is no longer over — and `onPointerEnd`, for a mouse's own genuine
`pointerup` (not a `pointercancel`), re-derives the hover highlight for
wherever the cursor still is rather than leaving it dark until the next
physical mousemove.

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
needed) and gated off while a native form control has focus, or the app
isn't actually on the `'game'` screen showing a live (not reviewed) puzzle
(`main.ts`'s `keyboardHost.isEnabled`, `screen === 'game' && mode ===
'playing'` — see "Menus and screen navigation" below). It holds a `cursor:
Face | null` (there's no "held" state
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

Any of these can temporarily widen an edge past its normal stroke width
(grow overshoots nothing, but a pulse or the comet's bulge do). Both
`drawMarkedEdges` and `drawWrapped` collect every edge's draw info first
and stroke them widest-last (`strokeMarkedEdges`, and `tiledMarkedEdges`'s
own sort) rather than drawing each edge immediately in `edges`' arbitrary
iteration order: two edges sharing a vertex both get a rounded end cap
there, and whichever is stroked *second* paints over the first's cap at
that point. Normally invisible (same-width neighbors' caps align exactly),
but a temporarily-widened edge stroked *before* its ordinary-width
neighbor let that neighbor's thinner cap visibly bite into the wide edge's
join — most noticeable as a "hole" right at a moving wave's leading edge.
Sorting so wider edges always draw last keeps a bulging edge's join on top
everywhere, regardless of draw order.

### Persistent component colors

`edgeComponents.ts`'s `computeEdgeComponents` numbers each connected
component by iteration order within a single call — cheap, but that
numbering is only meaningful for that one call, not stable across edits. A
naive `segmentColor(component id)` using those raw ids directly, as an
earlier version of this game did, could make a component's *displayed*
color change even when nothing touching it changed at all, purely because
some unrelated component elsewhere merged or vanished and shifted
everything after it in its numbering.

`game/componentColors.ts`'s `updateComponentColors` fixes this: given a
`ComponentColorState` (just `color index -> the cells that color's
component currently spans`, as of the last call) and the current edge set,
it re-derives this frame's components fresh via `computeEdgeComponents`
(unavoidable — edges can change from several unrelated call sites, so this
has to be recomputed every time regardless), then matches each one back to
whichever old color(s) its cells overlap, instead of just taking the raw
ids at face value:

- A component that shares cells with exactly one old color (grew, shrank,
  or is simply unchanged) keeps that color.
- A **merge** (a component now spans cells from more than one old color)
  keeps the *lowest* of those colors — "blue wins" — regardless of which
  side contributed more cells.
- A **split** (one old color's cells now spread across more than one new
  component) lets whichever new piece kept the most of those cells keep the
  color; the other piece is treated as brand new.
- A component touching no old color at all (brand new, or the losing side
  of a split) gets the lowest color index not already claimed by anything
  else *this frame* — so a color that just freed up (its component
  vanished, or lost a split/merge collision) is exactly what a new
  component picks up, and every *other* still-live color's assignment is
  completely undisturbed (a vanished component's neighbor's color doesn't
  shift down to fill the gap).

`main.ts` owns two `ComponentColorState`s — `liveComponentColors` for the
live game, `reviewComponentColors` for the review/replay overlay — kept
entirely separate so switching between them can't cross-contaminate, and
each explicitly reset (`resetComponentColorState`) only at a genuine
board-identity boundary (`beginPuzzle`, `enterReview`) rather than on every
edit, since an unrelated old puzzle's component could otherwise
coincidentally "donate" its color to a new puzzle's component just because
their cell coordinates happen to line up. `render()` recomputes whichever
one is active every single frame from the live edge set (cheap and
idempotent when edges haven't actually changed, exactly like
`computeEdgeComponents` always was) and threads the result through
`RenderState.componentColors` — skipped entirely once `won`, since a win is
one component with the flat "solved" color and there's nothing left to look
up. `scheduleToggleAnimation` reads the *previous* frame's colors back out
via `snapshotEdgeColors` (a plain cell-to-color lookup, no recomputation)
to freeze a shrinking edge's color and set a pulsing edge's `fromColor` —
valid because `render()` already updated the relevant `ComponentColorState`
for the pre-toggle edge set on the frame just before the toggle.

- **Grow/shrink**: a region toggle's newly-marked edges "grow" from zero to
  full *width* (drawn at full length the whole time), and newly-unmarked
  edges "shrink" from full width back to zero, over `render.ts`'s
  `GROW_MS`/`SHRINK_MS` (220ms each, eased with `smoothstep`). A stroke
  below `MIN_VISIBLE_WIDTH` is skipped outright rather than drawn at
  `ctx.lineWidth` near 0, since canvas normalizes/ignores an actual `0` and
  would otherwise flash a stray hairline at the very start/end. `main.ts`'s
  `scheduleToggleAnimation` (called only from `setPathState`, the single
  funnel every pointer/keyboard toggle already goes through) diffs the op's
  edges against the previous state to decide grow vs. shrink per edge. A
  shrinking edge is no longer in `pathState.edges` at all, so its color is
  frozen at the moment of removal (`segmentColor`, exported from `render.ts`
  for this) rather than recomputed live, and `render.ts` draws it as an
  extra edge alongside the live ones for as long as it's still animating.
- **Recolor ripple** (midgame): when a toggle causes a merge or split, some
  *other* already-marked edge's component (and so its persistent color, see
  above) can change as a side effect. `game/edgeRipple.ts`'s
  `computeRecoloredEdges` finds every such edge that's actually
  graph-reachable from the toggle location in the post-toggle marked-edge
  graph, together with its hop distance; `main.ts` staggers each one's pulse
  start by `render.ts`'s `midgameRippleDelayMs(distance)` so the recolor
  visibly ripples outward rather than flipping everywhere at once. Unlike
  the endgame/postgame ripples below, this delay is **not** linear in hop
  distance — it's `RIPPLE_STAGGER_MS * log2(distance + 1)`, so it speeds up
  geometrically as it travels: doubling the remaining distance only costs
  one more constant-size time increment, rather than one more
  `RIPPLE_STAGGER_MS` per hop, making the *total* time to sweep an entire
  connected component logarithmic in that component's size instead of
  linear. A midgame ripple's whole job is to draw the eye to what just
  changed, so a huge board's ripple shouldn't take proportionally longer to
  finish just because there's more board to cover — unlike the win/comet
  ripples, which are more of a small deliberate celebration where "the same
  pace as everything else, just possibly longer" is the intended feel
  instead (see below). Each pulse (`render.ts`'s `PULSE_MS`, 260ms) bulges
  the edge's line width up and back down, swapping from its old color to its
  live one right at the peak — "growing and then shrinking as it changes
  color". `computeRecoloredEdges` decides "did this edge actually recolor"
  by comparing `componentColors.ts`'s *persistent* colors before/after the
  toggle (`snapshotEdgeColors`/`previewComponentColors`), not
  `edgeComponents.ts`'s raw, iteration-order-assigned ids (see its doc
  comment) — an earlier version compared those raw ids instead, which was
  only a loose proxy for "did this edge's component identity change" and
  had a real bug as a result: since a raw id's numbering depends purely on
  the current `Set`'s iteration order (which drifts over the course of a
  game as edges are toggled off and back on) while a persistent color's
  identity doesn't, the two could disagree about *which side* of a
  merge/split actually changed color once a puzzle had been edited enough
  to desync them — occasionally rippling the component that already had the
  right color while the one that actually changed silently snapped with no
  animation. Comparing real persistent colors instead can't have that
  failure mode, since it's exactly the same color assignment `render()`
  goes on to display. A merge/split can also renumber an entirely
  *unrelated* component in `edgeComponents.ts`'s raw ids purely as an
  incidental side effect — `computeRecoloredEdges` deliberately excludes
  anything not reachable from the toggle, so that case doesn't ripple at
  all; thanks to persistent component colors (above), it doesn't even
  *recolor* any more regardless, since the persistent color assignment is
  keyed by which cells a component actually spans, not by that raw id —
  matching the fact that nothing about what's on screen actually changed.
  - **The winning move gets a bigger version of the same ripple, but at
    constant speed (endgame)**: the instant a toggle completes the puzzle,
    literally every already-marked edge is about to switch to the single
    "solved" green — so instead of `computeRecoloredEdges`'s "did the
    persistent color actually change" filter (which, on a win, would by
    incidental id-numbering luck leave whichever pre-existing segment kept
    id 0 jumping straight to green with no animation), `main.ts` uses
    `edgeRipple.ts`'s `computeReachableEdges`, which ripples *every*
    reachable edge unconditionally. It deliberately keeps the ordinary
    linear `distance * RIPPLE_STAGGER_MS` pace instead of the midgame
    ripple's geometric speedup above (an earlier version used a separate,
    even faster stagger so a huge board's sweep wouldn't take too long —
    but that made the win ripple visibly a *different* animation from the
    everyday one, which read as inconsistent rather than snappy). Since
    this is a one-time celebration rather than something that needs to stay
    snappy on every single edit, it's simplest, and truest to "the same
    animation, just over more edges", to just let a huge board's win ripple
    take longer, same as everything else here scales with board size.
- **Win-comet (postgame)**: once the winning move's ripple above finishes covering the
  whole board in green, a bright-green "comet" starts exactly where that
  ripple last reached (`edgeRipple.ts`'s `computeFarthestCell`) and travels
  forever around the loop in one direction at the same `RIPPLE_STAGGER_MS`
  pace, its tail fading from `COLORS.markedWon` down to a darker
  `COLORS.winCometDark` the longer it's been since the comet passed over
  that edge — reaching fully dark right as the comet is about to lap back
  around and relight it, since the fade's duration is deliberately exactly
  one full lap (`render.ts`'s `computeCometStyles`: `cells.length *
  RIPPLE_STAGGER_MS`), which is what makes the fade pace scale with board
  size the way a bigger loop takes a bigger lap. Its leading edge also
  bulges past normal width, peaking exactly *at* the head and easing back
  down to normal over a trailing `PULSE_MS`-ish window behind it
  (`PULSE_BULGE`, same magnitude as an ordinary recolor pulse's width
  bulge) — deliberately *not* the ordinary pulse's symmetric grow-then-
  shrink shape (zero at both ends of its own window), since the comet's
  frontier is always mid-motion with nothing "before" it to ramp up from;
  peaking immediately at the head means there's always a bulge in progress
  somewhere, continuously, with no ramp-up gap — see
  `computeCometStyles`'s doc comment for why an earlier, symmetric-bulge
  version of this caused a visible stutter right at the ripple-to-comet
  handoff. This replaced an earlier, simpler "dot traveling around the
  loop" animation — the comet reuses the same underlying cell-cycle data
  (`game/loopOrder.ts`'s `orderLoopCells`, cached in `main.ts`'s
  `winLoopCells`/`winLoopEdgesRef` exactly as the dot used it) but colors
  (and locally widens) the whole loop instead of drawing a separate marker.
  - **Waiting for the ripple to actually finish**: the comet must not start
    until the winning ripple above has *completely* finished (not merely
    "the board looks all green," since the ripple's own pulses already make
    it look that way well before the last one completes) — `main.ts`'s
    `scheduleToggleAnimation` computes exactly when and where that'll be
    the moment it schedules a winning ripple (`pendingCometStart`, mirroring
    the farthest edge's own pulse-completion time), and `render()` holds the
    comet off (`cometActive` stays `false`) until then. A completed state
    reached with no ripple to wait for at all — opening an already-completed
    puzzle from history, or replay reaching its end with animations off —
    just starts the comet immediately instead, from an arbitrary point
    (index 0 of the cycle), since there's no ripple endpoint to anchor to.
  - Deliberately *not* shown for a given-up puzzle (`gaveUp`): the flat
    "solved" green is used there instead, same as before this feature
    existed, since giving up isn't a real win — see "Give Up" below.
  - **The first lap starts in a brighter field, on purpose**: the ordinary
    steady-state math (an edge's color age = hops since the comet's *current
    lap* last passed it, wrapping at one full lap) would, applied naively
    the instant the comet starts, treat every edge the comet hasn't reached
    yet in this first lap as if it were reached almost a full lap ago — the
    entire board would jump from flat bright green (how the ripple just left
    it) to mostly-dark in one frame. `computeCometStyles` avoids this by
    capping an edge's color age at `elapsedHops` (how long the comet has
    actually been running) rather than the raw wraparound distance — so at
    the moment the comet starts every edge's age is `0` (matching the
    ripple's own bright finish exactly), and only the arc truly behind the
    comet's head darkens for real, until a full lap has passed and the cap
    stops applying anywhere. The width-bulge calculation deliberately does
    *not* get this same cap (it always uses the raw distance) — capping it
    too would make the whole not-yet-reached arc bulge in width together
    during the first lap, instead of staying one small pulse localized at
    the comet's actual head.
  - **Investigated for a memory leak, none found**: because the comet
    "travels forever", it's the one animation here that keeps calling
    `computeCometStyles` (and rebuilding `drawMarkedEdges`/`drawWrapped`'s
    per-frame draw list) at 60fps indefinitely rather than for a bounded
    burst — a plausible place for a slow leak to hide on a long-running tab.
    It was checked two ways: a Node benchmark reproducing
    `computeCometStyles` and the draws-array construction verbatim for a
    "huge" (1120-cell) board's win loop, run for the equivalent of ~16
    minutes of continuous 60fps animation with forced GC between samples;
    and the same logic driven by a real `requestAnimationFrame` loop in
    actual Chromium (via CDP `Performance.getMetrics`), sampled over 90
    real seconds. Both show heap usage oscillating in an ordinary sawtooth
    GC pattern (roughly flat/bounded, not trending upward) — i.e. steady
    per-frame garbage that V8 reclaims normally, not an unbounded leak. Every
    per-frame allocation in this path (the `Map` from `computeCometStyles`,
    the `MarkedEdgeDraw[]` array, the lerped color strings) is purely local
    to that one call and holds no reference anything else retains, so
    there's no structural reason to expect one either. If a real-device
    "runs for a long time and eventually crashes" report resurfaces, look
    first at sustained CPU/GPU cost from redrawing the *entire* board at
    60fps forever (especially a wraparound board zoomed out to reveal many
    tile copies) rather than assuming a reference leak — that's a real,
    measurable cost this investigation didn't rule out, just the "heap grows
    without bound" leak specifically.

All three share one `requestAnimationFrame` chain, driven entirely by
`main.ts`'s `render()`: every other call site still just calls `render()`
once, exactly as before animations existed, and `render()` itself is the
only place that decides whether a follow-up frame is needed
(`edgeAnimsActive() || winLoopCells !== null`), rescheduling itself via
`animFrameId` until neither is true. Every entry is keyed by
`performance.now()` timestamps rather than a frame counter, so a slow frame
or a backgrounded tab can't desync an animation from where it should be.
`render.ts` exports `RIPPLE_STAGGER_MS` (alongside `GROW_MS`/`SHRINK_MS`/
`PULSE_MS`) so the endgame ripple's pulse-delay math and the comet's travel
speed in `main.ts` share the exact same constant-pace constant as their own
drawing code, rather than three places having to be kept in sync by hand;
the midgame ripple instead uses `render.ts`'s separately-exported
`midgameRippleDelayMs` for its geometric speedup (see "Persistent component
colors" and "Recolor ripple" above).

Only a live tap/keyboard toggle (`setPathState`) starts a grow/shrink/pulse
animation. Anything that jumps straight to a different state instead — undo,
redo, Give Up, Reset, starting a new puzzle, entering/leaving review — calls
`clearEdgeAnimations()` up front, so a leftover in-flight animation (and any
`pendingCometStart`) is never reinterpreted against a state it no longer
describes. The win-loop cycle cache doesn't need this: `render()` recomputes
it (or clears it, along with the comet's own state) automatically whenever
"is this state completed" changes, or the completed edge set's *reference*
changes (a fresh win, a different already-completed puzzle opened in review,
a replay frame) — see `render()`'s own doc comment.

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
`NO_EDGE_COLLECTIONS` (`main.ts`'s `startNewGame` hardcodes it, no UI reads
it back), so `index.html`'s three number inputs, and `main.ts`'s
`currentCollectionParams`/`reflectCollectionParams`/`onCollectionsInputChange`
and their `localStorage` keys, are gone. The generation code above is
deliberately untouched — `EdgeCollectionParams`/`generateEdgeCollections`/
`pickCollectionEdges`/`countCollectionEdges` all still work exactly as
described, `puzzleGen.ts`/`gameStore.ts` still handle a `PuzzleId` whose
`collections` isn't `NO_EDGE_COLLECTIONS` (so an old completed puzzle that
*was* played with links on still regenerates and reviews correctly), and
the balance question may get revisited later — it's just not something a
player can currently opt into from the UI.

## Locking edges

`game/edgeLock.ts`'s `lockEdge` is a general-purpose capability, independent
of any one feature: to *lock* an edge means to toggle one of its two
neighboring regions (via the ordinary `toggleRegion`, if the edge isn't
already in the right state — locking an edge that's already correctly
marked/unmarked needs no toggle at all) so the edge ends up marked iff a
caller-supplied `markedInSolution` says it should be, and then to exclude
that edge from region computation forever after — both of its neighboring
faces merge into one region (`regions.ts`'s `computeRegions`/`isLocked`
treat a locked edge exactly like a permanent wall, i.e. a side with no
candidate edge at all), so nothing — a tap, a keypress, another region
toggle — can ever flip it again. `Puzzle.lockedEdges` (the locked-edge set)
and `Puzzle.initialEdges` (which of them must start marked, for
`pathEdit.ts`'s `createInitialPath(puzzle)` to seed a fresh `PathState`
with) are the two structural fields this adds to `Puzzle`. `regions.ts`'s
`regionsForEdge` finds which region(s) currently border a given edge (what
`lockEdge` needs to decide what to toggle); only an *enclosed* candidate
(`Region.enclosed` — see "The face grid, regions, and the tap-to-toggle
interaction" above) is ever eligible to toggle at all, and among those,
`lockEdge` toggles whichever has the smaller boundary, to keep the
collateral flipping (see below) as small as practical — if an edge borders
no enclosed region at all (every bordering region happens to be
non-enclosed, or none border it any more), its mark state is set directly
instead, with no toggle. See `lockEdge`'s own doc comment for why the
enclosure check matters here specifically: toggling a non-enclosed region
mid-lock would bake a dangling odd-marked-degree cell into the result with
no way for the player to ever correct it, since the edge is about to become
permanently locked regardless.

**Locking is not the same as deleting**, but the two coincide in one
specific case: at the very start of a fresh game (every edge unmarked),
locking an edge *to unmarked* needs no toggle at all — the edge simply
stays unmarked forever, indistinguishable in play from having never existed
(this is what makes "locking an edge that's unmarked in the intended
solution" a legitimate way to *effectively* delete a distractor edge,
mentioned here because it's the property that makes the reverse — locking
an edge *to marked* — obviously safe to reach for as a "pre-solve a few
cells" hint). Locking an edge *to marked* from an empty start always needs
a real region toggle, and — since region toggle is the only edit primitive
this game has, see "The face grid, regions, and the tap-to-toggle
interaction" above — that toggle necessarily flips every *other* edge on
the chosen region's boundary too, not just the one edge being locked. This
collateral flipping is a real, unavoidable consequence of the mechanism as
specified, not a bug: a real generated board's regions vary hugely in size
(a "huge" board can have some regions boundaried by dozens of edges), so
locking even a handful of edges can end up pre-marking a noticeably larger
slice of the board than the locked count alone suggests — the
smaller-of-two-regions tie-break above softens this somewhat but doesn't
eliminate it. This is exactly why the feature below is introduced as
*experimental*.

**A region's boundary must never include an edge whose two faces are
already inside that same region** ("interior" to it) — `computeRegions`
excludes any such edge outright rather than adding it once. An earlier
version of this function *did* add it once (reasoning that the region's
toggle should "still flip it," since it's a real, unlocked candidate edge),
which is wrong: a region's toggle has to be exactly equivalent to toggling
every one of its still-distinguishable sub-pieces in turn (this is what
`lockEdgeInRegionMap` below relies on for a locked-edge-driven merge, and
it's just as true of two pieces that only ever got fused by ordinary
non-edge walls) — an edge bordering the *same* region on both sides would
be toggled twice by that equivalent sequence, a net no-op, so it must never
appear in the boundary the *actual* single-tap toggle uses either. Getting
this wrong let a single tap unmark an edge that had nothing to do with the
face the player actually meant to toggle, purely because that edge
happened to sit inside a region that had grown large enough (via locking,
see below) to border itself — see git history and `regions.test.ts` for
the regression this fixes. This never mattered before locking existed:
following the wall-follower's own tree-boundary construction, a real
solution-cycle edge's two faces can never land in the same region through
non-edge fusion alone (density only ever *splits* regions further, never
merges unrelated faces via non-edge fusion) — so before this feature, the
"both faces already the same region" case only ever arose for optional
distractor edges, where silently making them unreachable was harmless.
Locking is what makes it common and consequential (below).

**Performance**: `computeRegions` recomputes an entire board from scratch —
fine once per puzzle, but `lockEdge` needs a fresh region map after *every*
single lock, and the generation feature below locks a whole batch at once.
`regions.ts`'s `lockEdgeInRegionMap` is what actually backs this: an
incremental update that touches only the one or two regions the
just-locked edge itself bordered, rather than re-walking the whole face
grid. Merging two distinct regions takes their boundaries' *symmetric
difference*, not their union: any edge that directly bordered *both* of
them (the one just locked, and any other "multi-edge shared border" edge
between them) now has both its faces inside the single merged region, so —
per the boundary rule above — it must drop out of the merged boundary
entirely, not just the one edge actually being locked. Every such edge
*other* than the one just locked is reported back as `strandedEdges` (see
below for why that report matters). Region ids are kept stable across a
merge (the lower id survives; the higher one becomes an empty, permanently
unreachable tombstone at its old index) so nothing else referencing a
region by id needs to know a merge happened. This dropped a "huge" board's
full locked-generation cost from the better part of a second to a small
fraction of one — `regions.test.ts`'s `lockEdgeInRegionMap` tests assert it
produces the exact same partition a from-scratch `computeRegions` recompute
would, on both hand-built and real generated puzzles.

**Stranding, and why `applyLockedEdges` doesn't need to chase it**: merging
two regions that share *more than one* real edge between them — routine
once a puzzle has any real density of distractor edges, and
`lockEdgeInRegionMap`'s doc comment covers exactly this — leaves every
edge but the one just locked permanently unreachable by any tap, without
itself ever having been locked. `lockEdge` reports each of these back as
`strandedEdges` on its result, purely as information (`LockEdgeResult`'s
own doc comment). A stranded edge is often a *different* solution-cycle
edge (the hidden cycle can cross the same region boundary more than once,
in different places) — an earlier version of `applyLockedEdges` worried
this could leave a required edge no combination of taps could ever reach,
and handled it with a worklist that explicitly re-locked every stranded
edge too.

That worklist turned out to be unnecessary *for correctness*. A stranded
edge, by construction, was *already on the boundary of whichever region the
current lock's own toggle just flipped* — that's exactly why it became
stranded — so that same toggle already flips the stranded edge too, at the
same moment. Checked broadly (a sweep across five sizes, three shapes, and
twenty seeds each — 300 puzzles, 6,876 stranded edges total): every single
one ended up in exactly the state it needed to be in, with zero
exceptions, whether it was a solution edge that needed marking or a
distractor edge that needed to stay unmarked. `puzzleGen.test.ts`'s "never
strands a required solution edge" test pins this down for every edge in the
graph, not just the chosen candidates, and its "actually *reachable*" test
(an exhaustive search over every combination of a small locked puzzle's
region toggles) confirms the intended solution stays a genuinely reachable
state, not just `computeWin`-valid in principle. So `applyLockedEdges`
never needs to re-run `lockEdge` on a stranded edge to fix its mark
state — that half of the old worklist really is gone for good.

Its *mark state* isn't the only thing a stranded edge needs, though:
`applyLockedEdges` also folds every edge a candidate strands into the final
puzzle's `lockedEdges` set — purely for rendering. Without this, a stranded
edge sits on screen looking exactly like an ordinary, still-live candidate
edge (full opacity, no visual distinction) even though no tap can ever
reach it again, which reads as a rendering glitch rather than the
deliberate region merge it actually is; folding it in dims it consistently
with the rest of its now-merged region and makes that merge visually
legible. This is a pure flag flip, not a second `lockEdge` call — no risk
of an extra toggle, since the mark-state guarantee above already means
there's nothing left to fix. (This is, in effect, reinstating only the
harmless half of the old worklist: the recursive re-*toggling* it did was
unnecessary and is gone; the recursive *flagging* it did is back.)

**The stranded count now counts against the same budget the candidates
themselves draw from**, rather than being additional overhead on top of it
— a deliberate follow-up tightening: an earlier version of this fold-in
locked every candidate unconditionally and only *then* swept in whatever
got stranded, so the final `lockedEdges` size could end up well over the
nominal fraction (a real measured case: 32 candidates ballooning to 80
total locked edges on one board). `applyLockedEdges` now treats
`budget = Math.floor(solutionEdges.size * fraction)` as a hard cap on the
*final* `lockedEdges` size, not just on how many candidates get chosen, and
tries each shuffled candidate *speculatively* — `lockEdge` is a pure
function, so nothing is actually committed to `lockedPuzzle`/`regionMap`/
`state` until this step decides to keep the result — only committing it
(folding both the candidate and its own newly-stranded edges into
`lockedEdges`) if doing so wouldn't push the total past `budget`. A
candidate whose own stranding is too expensive is simply skipped in favor
of trying the next one instead of being locked anyway: "if locking the next
edge would bring along so many other edges that we go over the budget, we
don't do it." The loop stops the moment the locked count reaches `budget`
(no room left for even a single-cost edge) or the shuffled candidate list
is exhausted — so `lockedEdges.size` never exceeds `budget`, though which
specific solution edges end up locked (and how close to `budget` the final
count actually lands) now depends on how cheap the shuffled order's
candidates happen to be, not just on a fixed prefix of them.
`puzzleGen.test.ts`'s "never locks more than the budget's worth" test pins
the cap itself down across shapes/seeds, and its "skip-and-try-the-next-
candidate" test reproduces the exact hash+shuffle `applyLockedEdges` uses
internally to confirm the final locked set is genuinely *different* from
what an unconditional "take the first `budget` candidates" version would
pick, not just coincidentally under budget.

The mark-state guarantee above is specific to `applyLockedEdges`'s own
usage pattern — locking a batch of solution edges to *marked*,
sequentially, starting from a completely empty board — not a general
property of `lockEdge` itself. `LockEdgeResult.strandedEdges`' doc comment
is explicit about this: a different future caller (e.g. a live hint applied
mid-game, to an already-partially-solved board with edges in arbitrary
states) would need to re-derive whether the same reasoning holds for it,
not assume it does — which is exactly why `edgeLock.ts`'s `lockEdge` itself
still leaves `strandedEdges` as pure information and does *not* auto-fold
them into `lockedEdges`: `main.ts`'s live "Hint me" feature (`hintMe`) goes
through this same `lockEdge`, on an arbitrary mid-game board, and a
stranded-but-wrongly-marked edge there needs to stay eligible for a *later*
hint call to directly correct (`lockEdge`'s own "already stranded" branch —
see its doc comment) rather than being prematurely flagged locked and so
excluded from `hintMe`'s own candidate filter forever with no way to fix
it. The render-only auto-fold is deliberately scoped to `applyLockedEdges`
alone, where the guarantee is actually proven to hold.

### First use: pre-marking a few solution edges

`puzzleGen.ts`'s `PuzzleId.lockedEdgeFraction` (default `0`, off) is a
generation-time application of the capability above: `generatePuzzle`'s
`applyLockedEdges` step tries candidates, in shuffled order, from the
puzzle's own hidden solution edges — via a fresh, separately-hashed rng
stream (`` `${puzzleIdKey(id)}::lock` ``, the same "don't depend on how
many calls generation itself happened to make" reasoning
`generateSolutionEdges` already relies on for Give Up) so the selection
doesn't depend on collections/density having consumed a different number of
rng calls — and locks each one to marked, up to a hard cap of
`Math.floor(solutionEdges.size * LOCKED_EDGE_FRACTION)` total locked edges
(0.05, "no more than 5%" per this feature's spec). As covered above
("Stranding"), locking a candidate can strand others; their mark state
never needs a separate fix, but every one collected along the way *does*
count against this same budget — a candidate whose own stranding would push
the total over budget is skipped in favor of a cheaper one later in the
shuffle, so `lockedEdges.size` never exceeds the nominal 5%, only
approaches it as closely as the available candidates allow.
`lockedEdgeKeySuffix` folds `lockedEdgeFraction` into
`puzzleIdKey`/`puzzleSeed` exactly like `collectionsKeySuffix` already does
for edge collections — absent or `0` hashes byte-identically to a puzzle id
from before this feature existed; only actually turning it on changes the
hash. The resulting `Puzzle.initialEdges` (which `beginPuzzle`,
`advanceBlitzPuzzle`, `startReplay`, and Blitz's own replay
`applyBlitzReplayEvent` all now pass to `createInitialPath(puzzle)` instead
of the old no-argument call) is what makes a locked puzzle start with those
edges — and whatever collateral edges their region toggles pulled in —
already marked.

**Free Play**: the New Game screen's "Lock some solution edges
(experimental)" checkbox (`index.html`'s `#newGameLockEdgesCheckbox`) is
off by default; when checked, `startNewGame` passes `LOCKED_EDGE_FRACTION`
as the new puzzle's `lockedEdgeFraction`. Rematch carries the setting
forward from `currentPuzzleId.lockedEdgeFraction`, same as it already does
for `collections`.

**Blitz**: `blitz.ts`'s `LOCK_EDGES_DIFFICULTY_THRESHOLD` is the difficulty
rating of a plain rectangular 5x5-block board — CLAUDE.md's "boards that
are about 10x10 after doubling" (2×5=10 cells per side), matching
`boardDifficultyRating`'s rect multiplier of 1x. `lockedEdgeFractionForBoard(sizeKey,
shapeMode)` is the shared pure decision — `LOCKED_EDGE_FRACTION` once a
board's own rating passes the threshold, `undefined` otherwise —
`createBlitzSequence` calls it for every puzzle it hands out (so locking
phases in automatically as a run's difficulty budget climbs past the
threshold, same as any other difficulty-gated behavior), and `main.ts`'s
Blitz replay (`applyBlitzReplayEvent`) calls the exact same function against
a `puzzleStart` event's own recorded `sizeKey`/`shapeMode` rather than
storing the decision in the event at all — consistent with every other
`puzzleStart` field being resolved data, not something replay re-derives via
`createBlitzSequence` (see "Blitz mode" below).

**Persistence**: `lockedEdgeFraction` has to round-trip through
`persistence/gameStore.ts`'s `InProgressRecord`/`CompletedRecord` exactly
like `collections` already does — `saveInProgress`/`recordCompletion` write
it, `puzzleIdOf` reads it back into the reconstructed `PuzzleId`. This
isn't just for re-showing the dimmed locked edges on resume/review: since
`lockedEdgeFraction` is folded into `puzzleIdKey`/`puzzleSeed` (above), a
reconstructed id *missing* it doesn't merely lose track of which edges
were locked — it re-hashes to a different seed and regenerates a
*different puzzle graph entirely*, making the saved `edges` meaningless
against it. `gameStore.test.ts`'s round-trip test checks exactly this: that
`generatePuzzle(puzzleIdOf(record))` reproduces the identical `adj` graph
(not just a graph with the field present) as the original locked puzzle.

## Confirm dialogs

`src/dialog.ts`'s `confirmDialog({ message, confirmLabel?, cancelLabel?,
danger? })` is a small styleable confirm prompt (GitHub issue #51) that
replaces every `window.confirm()` call in the codebase — the browser's own
confirm box can't be restyled at all, so it looked nothing like the rest of
this game's UI. It's a drop-in async replacement: every former `if
(!window.confirm(msg)) return;` call site just becomes `if
(!(await confirmDialog({ message: msg, ... }))) return;`, resolving `true`
(Confirm), `false` (Cancel, a direct tap on the backdrop, or Escape).
`danger: true` (used by every current call site — Give Up, and every
Resume/Replays/Blitz-leaderboard Delete/Forfeit) styles the confirm button
with the same destructive red accent `style.css`'s `.listItemDelete`
already uses elsewhere, instead of the ordinary primary blue.

`index.html`'s `#dialogOverlay` is a sibling of every `.screen` (not nested
in any one of them), so the dialog works identically no matter which screen
it's opened from — a menu list's delete button or a live in-game button
(Give Up, Blitz Forfeit) alike. It's always present in the DOM, shown/hidden
purely by toggling a `.show` class that CSS transitions opacity/
pointer-events on — the same "always in flow, transformed away when
hidden" approach `main.ts`'s `showToast`/`#toast` already uses, chosen for
the same reason: a plain CSS transition animates it for free, with no
`display: none` timing for `dialog.ts` to coordinate. It needs no special
handling to block board
input while open: `#dialogOverlay` is a `position: fixed` layer above every
`.screen` (this stylesheet's highest `z-index`), so a tap anywhere on
screen lands on it or its card rather than on the board underneath, and
`confirmDialog` always focuses one of its own buttons the instant it opens
— `keyboard.ts`'s own board-cursor handling already ignores any keydown
whose target is a `BUTTON` (`NATIVE_CONTROL_TAGS`), so arrow
keys/Enter/Space can never leak through to move the cursor or toggle a
region while a dialog is up, with no changes needed in `keyboard.ts` itself.

Only one dialog can be open at a time — opening a second one while the
first is still awaiting a response resolves the first as `false`
(cancelled) rather than leaving its promise dangling forever. Nothing in
this codebase actually triggers that today (every call site `await`s the
result before doing anything else that could open another dialog), but it
keeps `confirmDialog` a well-behaved general-purpose primitive rather than
one that silently assumes its own callers' discipline.

## Give Up

The "Give Up" button (`main.ts`'s `revealSolution`) reveals the puzzle's
intended solution — `puzzleGen.ts`'s `generateSolutionCells`/
`generateSolutionEdges`, which mirror `generatePuzzle`'s exact sequence of
shape/cycle generation calls from a freshly-seeded rng with the same seed,
so they reproduce the identical hidden cycle regardless of what
distractor-edge/edge-collection generation `generatePuzzle` goes on to do
with the rng afterward (a seeded rng's output only depends on the calls
made so far). This is *a* valid win loop through `adj`, not necessarily the
only one, and if the puzzle has edge collections it isn't guaranteed to
satisfy every collection's `required` count (collections are generated with
an independently-rolled count, not derived from this specific cycle) — the
button still shows it anyway, since it's the intended answer regardless.

Giving up sets `gaveUp = true` and blocks further editing exactly like a
real win does (`inputPathState()` reports `won: true` to the input layer
whenever `gaveUp`), but is deliberately *not* a win: no `recordCompletion`,
and — unlike every other path mutation — never persisted, so a reload
resumes whatever was actually in progress before Give Up was pressed, as if
it never happened. Giving up still counts as the puzzle being "complete" for
the in-game control bar (`refreshControlBar`, see "Menus and screen
navigation" below) — Rematch appears immediately, letting the player bail
into a fresh attempt — but Replay doesn't, since a given-up puzzle was never
recorded and so has no move log to replay (`viewReplayBtn` stays hidden
whenever `!pathState.won`, gave-up or not).

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
    `initial` is always `createInitialPath(puzzle)`, never itself stored —
    cheaply reconstructible, and the same for every game of a given puzzle
    (an empty edge set, unless the puzzle has generation-time locked-and-
    marked edges — see "Locking edges" above — in which case exactly those
    start marked).
- **`main.ts` wiring**: `setPathState` (the single funnel every pointer/
  keyboard edit already goes through) is the one place that calls
  `recordMove`; `input.ts`/`keyboard.ts` just need to thread the `ops` their
  `toggleRegion` call already produces through to `setPathState`.
  `performUndo`/`performRedo` call `history.ts`'s `undo`/`redo` and apply
  the returned state exactly like any other path update. Undo/redo are only
  ever enabled while `!pathState.won && !gaveUp` (`undoRedoAllowed()`) —
  there's no separate `mode`/`screen` check needed here any more, since the
  Undo/Redo buttons themselves only exist inside the live game's control
  bar, which is hidden outright while reviewing (see "Menus and screen
  navigation" below). Every fresh puzzle (New Game, Resume, Rematch) starts
  a brand-new `history` too (`beginPuzzle`) — a resumed save restores its
  own saved `history` instead, but a *fresh* start never inherits a
  previous attempt's, since an eventual win's replay would otherwise
  confusingly interleave an earlier abandoned attempt with the one that
  actually finished. (A "Reset" button — see "In-game controls" below —
  clears the current attempt's board without abandoning it the way Exit
  does; it's built on the same undo-stack/move-log mechanism as Undo/Redo,
  so it doesn't reintroduce the confusing-interleaving problem a naive
  "wipe and start over" would.)
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
  (Replay/Done) and `#reviewPlaybackControls` (Play/Pause, a speed select, a
  scrubber, Done) rather than being two separate bars, to keep the
  CSS/layout simple. `reviewWon` (distinct from the hardcoded `won: true`
  `render()` used before this feature, for the static "view a finished
  puzzle" case) tracks the *current replay frame's* own `won` flag, since
  mid-playback frames usually aren't won yet.
- **Replay speed**: `#replaySpeedSelect` (0.25×/0.5×/1×/2×, default 1×) is
  read by `playReplay()` as a divisor on `REPLAY_FRAME_MS` (50ms — i.e. the
  default 1× option is the original, only-ever speed before this control
  existed, deliberately left close to the top of the range rather than in
  the middle). Changing it while already playing restarts the interval
  immediately (`main.ts`'s `replaySpeedSelect`'s `change` listener) rather
  than waiting for the next natural tick, and the choice is persisted to
  `localStorage` (`LAST_REPLAY_SPEED_KEY`) the same way size/shape are.
- **Replay plays the same grow/shrink/ripple animations live editing gets**,
  but only at the two slowest speeds (`replayAnimationsEnabled()`,
  `replaySpeed <= 0.5`) — at 1×/2× a new animation would just get
  interrupted by the next frame before finishing (`GROW_MS`/`PULSE_MS` are
  both longer than a frame interval at those speeds), reading as flicker
  rather than motion, so those speeds simply snap each frame in instantly
  instead, same as before this existed. `showReplayFrame`'s `animate`
  parameter is only ever `true` for `playReplay`'s own natural single-step
  tick; scrubbing (and the initial jump to frame 0) always snaps regardless
  of speed, since a dragged scrub can span an arbitrary number of frames and
  there's no one sensible toggle to animate for that. The animated edges are
  computed as the symmetric difference between consecutive frames'
  (`main.ts`'s `symmetricDifference`) rather than replayed from the
  original `PathOp`, which works the same whether that step was a real move
  or an undo/redo jump — `scheduleToggleAnimation` itself doesn't need to
  know which, and now takes an explicit `toggledEdges` set rather than
  `PathOp[]` so both call sites (`setPathState` and `showReplayFrame`) can
  feed it.

## Puzzle identity and generation

`src/game/puzzleGen.ts`: a puzzle is identified by `PuzzleId { sizeKey,
shapeMode, seed, collections?, lockedEdgeFraction? }` — `sizeKey` is one of
the fixed `SIZE_OPTIONS` (tiny/mini/small/medium/large/huge — the `key`
field is a storage identifier, never rename it once puzzles have been
played), `shapeMode` is one of `SHAPE_MODE_OPTIONS` (see "Board shapes and
topologies" above — `klein`/`projective` are disabled from selection but
still valid `PuzzleId` values for old data), `seed` is an arbitrary 32-bit
integer that, together with the rest of the id, fully determines the
puzzle, `collections` is the optional `EdgeCollectionParams` (see "Edge
collections" above), and `lockedEdgeFraction` is the optional fraction of
solution edges to lock at generation time (see "Locking edges" above).
`puzzleSeed()` hashes `puzzleIdKey(id)` (FNV-1a) into the actual mulberry32
seed the generator runs on — deliberately *not* `id.seed` directly, so two
puzzles that happen to share a raw `seed` but differ in
size/shape/collections/locking can't accidentally share so much as a PRNG
stream prefix. `PUZZLE_DENSITY` (0.28, formerly `DAILY_PUZZLE_DENSITY`) is
fixed — density is not a player-facing setting. `generatePuzzle(id)` builds
the `Puzzle`; `generateSolutionCells`/`generateSolutionEdges(id)` recompute
the hidden cycle on demand (Give Up, the main menu background, and locking's
own edge selection — see their own sections).

`sizeKey` doesn't strictly have to be a `SIZE_OPTIONS` entry: `sizeOption()`
also accepts a synthetic key produced by `customSizeKey(m, n)`
(`` `custom:${m}x${n}` ``), resolving it to a one-off `SizeOption` built from
the encoded dimensions rather than a catalog lookup. This exists solely for
Blitz mode's continuously-varying board sizes (see "Blitz mode" below) —
Free Play/New Game never produce one — and needs no changes anywhere else
that already treats `sizeKey` as the one source of a puzzle's dimensions
(`generatePuzzle`, `generateSolutionCells`, storage/hashing,
`blitz.ts`'s `boardEdgeCount`), since they all resolve dimensions through
`sizeOption()` rather than indexing `SIZE_OPTIONS` directly.

**There is no more daily rotation or unlock gating.** An earlier version of
this game identified a puzzle by `{ day, sizeKey, shapeMode, index,
collections? }` — the player's local calendar date plus a 0-based position
in that day+size+shape's sequence — and persistence tracked an
`unlockedIndex` per combo that only advanced by completing puzzles in
order, resetting to 0 every calendar day. The New Game/Resume/Replays menu
system (see "Menus and screen navigation" below) replaced this outright:
`randomSeed()` mints a fresh, genuinely random 32-bit seed
(`crypto.getRandomValues`, falling back to `Math.random` outside a browser)
every time New Game or Rematch starts a puzzle, with nothing gating which
sizes/shapes are available or when — a player can have any number of
puzzles of the same kind in progress at once, each independently seeded,
which is exactly what lets Rematch (and New Game generally) start a fresh
puzzle "of the same kind" as one already in progress. `todayKey`/`day` are
gone entirely; nothing in the current code needs the concept of "today" at
all. See "Persistence (IndexedDB)" below for how this reshaped storage, and
"Things to know before changing size/shape/puzzle identity" for the
backward-compatibility consequences.

## Persistence (IndexedDB)

`src/persistence/db.ts` is a thin promise wrapper over the raw IndexedDB
API (db name `loopit`, version 2, four stores — no external library).
`src/persistence/gameStore.ts` has the actual domain logic:

- **`progress`** store is **vestigial** — it used to hold the daily-puzzle
  unlock gate (`ProgressRecord { unlockedIndex }`), which no longer exists
  now that every puzzle is independently seeded with nothing to gate (see
  "Puzzle identity and generation" above). Nothing reads or writes it any
  more; it's left defined in `db.ts`'s `STORES` (rather than dropped, which
  would need an IndexedDB version bump + an `onupgradeneeded` migration
  just to delete an empty, harmless object store) purely so a future
  cleanup has somewhere to start from.
- **`inProgress`** store, keyed by `puzzleIdKey(id)` (the *whole* id —
  size, shape, seed, and collections together, not just size+shape+day the
  way it used to be, since there's no more "the currently active puzzle of
  this day+size+shape" — now there can be any number of independently
  seeded puzzles of the same size/shape in progress at once) → the current
  marked `edges`, the undo/redo `history` (see above), and `updatedAt`
  (used to sort the Resume menu, most-recently-played first). `main.ts`
  autosaves here on every path change (`saveInProgress`) and reads a
  specific one back by id (`getInProgress`) or lists every one of them
  (`listInProgress`, feeding the Resume menu). Cleared on win
  (`clearInProgress`, also directly wired to the Resume menu's per-item
  Delete button).
- **`completed`** store, same `puzzleIdKey(id)` keying (shared with
  `puzzleGen.ts` so the two never drift apart) → the final winning `edges`
  + timestamp + the game's `moveLog` (for replay, see above).
  `recordCompletion()` records the completed game and clears in-progress —
  there's no unlock gate left to advance any more. `deleteCompleted` is the
  Replays menu's per-item Delete button.
- **`blitzRuns`** store, added in the version-1-to-2 bump (`db.ts`'s
  `onupgradeneeded` re-checks every store with `objectStoreNames.contains`
  rather than assuming a fresh-vs-upgrade split, so it creates whichever
  stores are missing regardless of which version a given browser is
  upgrading *from*), keyed by `${seed}::${startedAt}` — one record per
  finished (or forfeited) Blitz run. See "Blitz mode" below;
  `persistence/blitzStore.ts` is its own small domain module, parallel to
  `gameStore.ts` rather than folded into it, since a Blitz run isn't a
  `PuzzleId` + `edges` at all. Unlike `inProgress`, there is no
  "in-progress Blitz run" record — a run is only ever written here once it
  ends.

Puzzles are *not* stored in full — only `PuzzleId` + final `edges`. The
puzzle graph is always regenerated on demand via `generatePuzzle(id)` for
review, relying on determinism (`gameStore.ts`'s `puzzleIdOf` rebuilds a
full `PuzzleId` from any stored record, so callers never have to
hand-assemble one from a record's individual fields). (Tradeoff: if the
generation algorithm ever changes, old stored completions would regenerate
a different puzzle than what was actually solved. Acceptable for this
project's scope.)

Backward-compatibility helpers in `gameStore.ts`, applied to every record
read (`isUsable`, combining both): `hasEdges` rejects a record saved before
the region-toggle rewrite (which stored `segments`, not `edges` —
structurally incompatible, so it's simply treated as unusable rather than
migrated); `hasSeed` rejects a record saved before the seed-based `PuzzleId`
restructuring (keyed by `day`/`index` instead, with no `seed` field to
regenerate its puzzle graph from at all) the same way — an old in-progress
or completed daily-puzzle save simply stops showing up in the Resume/Replays
menus, rather than crashing them. Both are "accept the loss, don't migrate"
per this project's established policy for breaking storage-format changes.
(An earlier version of `gameStore.ts` also had a `withShapeModeDefault`
helper defaulting a `completed` record with no `shapeMode` at all — from
before board shapes existed — to `'rect'` rather than dropping it, since
every such puzzle genuinely was a plain rectangle. That helper is gone now:
a record that old also predates `seed`, so `hasSeed` already excludes it
same as any other pre-restructuring record: nothing left for a
shape-specific default to apply to.)

Tests use `fake-indexeddb/auto` (import it at the top of the test file) and
`clearAllStoresForTests()` between tests — *not* `indexedDB.deleteDatabase`,
which hangs waiting for the previous connection to close since `db.ts`
caches a single open connection (`resetDbConnectionForTests()` exists but
is rarely what you want; clearing stores is simpler and doesn't require
re-opening).

## Menus and screen navigation

The app is a small stack of full-screen "pages" rather than the single
always-visible game view it used to be. `src/main.ts`'s `Screen` type —
`'mainMenu' | 'freePlay' | 'newGame' | 'resume' | 'replays' | 'game' |
'blitzMenu' | 'blitzSetup' | 'blitzLeaderboard' | 'blitzLeaderboardRuns' |
'blitzGameOver'` — names them; `showScreen(next)` is the *only* place that
toggles `.hidden` on their root elements (`index.html` gives each one its
own top-level `<div class="screen">` inside `#app`) and runs each screen's
enter/leave side effects. Exactly one screen is ever visible at a time. A
live Blitz run and watching a Blitz run's replay both reuse the `'game'`
screen (and its single canvas) rather than getting screens of their own —
see "Blitz mode" below for why.

- **Main menu** (`#mainMenuScreen`): the animated postgame-loop background
  (see "Main menu background" below) behind the title and a vertically
  centered button stack — **Free Play**, **Blitz** (opens the Blitz hub,
  `#blitzMenuScreen` — see "Blitz mode" below), and **Settings**. No
  instructional tagline any more (removed in favor of a future in-app
  tutorial, GitHub issue #47); Blitz gets its own highlighted button color
  (`.menuBtnBlitz`, orange), distinct from Free Play's blue `.menuBtnPrimary`,
  instead of sharing Settings' plain `.menuBtnSecondary` look. (The button
  group being genuinely centered, rather than pushed toward the bottom, was
  itself a bugfix — see `style.css`'s `header h1` rule and its own doc
  comment.)
- **Free Play hub** (`#freePlayMenuScreen`): three buttons — **New Game**,
  **Resume**, **Replays** — each opening its own screen. "‹ Menu" goes back
  to the main menu.
- **New Game** (`#newGameMenuScreen`): picks `sizeKey`/`shapeMode` (the
  same `<select>` options `index.html` used to have directly on the game
  screen, just moved here) and starts a brand-new, randomly-seeded puzzle
  on Start (`startNewGame` → `beginPuzzle`, see below). "‹ Free Play" goes
  back to the hub without starting anything.
- **Resume** (`#resumeMenuScreen`): every saved `InProgressRecord`
  (`listInProgress()`, most-recently-played first), each row showing its
  size/shape, a rough progress readout (edge count — not a fraction, since
  computing "of how many total" would mean regenerating every listed
  puzzle's full graph just to render the list), and when it was last
  played. Tapping a row resumes it exactly (`beginPuzzle` with that
  record's `edges`/`history`); a separate Delete (✕) button removes it
  (`clearInProgress`, behind a confirm dialog) without opening it — the two
  are physically distinct buttons in `renderListItem` specifically so a
  Delete tap can never be misread as "open".
- **Replays** (`#replaysMenuScreen`, the renamed/restructured former
  `#historyOverlay`): every `CompletedRecord` (`listCompleted()`, most
  recent first), same row shape as Resume — tapping opens it in the review
  overlay (`enterReview(item, 'menu')`, see below), Delete removes it
  (`deleteCompleted`, confirm-gated) without opening it.
- **Game** (`#gameScreen`): the live/reviewed puzzle itself — everything
  described elsewhere in this file (the board, the control bar, the review
  overlay) lives here unchanged in substance, just reachable only through
  the menus above instead of being the app's permanent single view.

`showScreen` also owns: starting/stopping the shared animated background
(see "Main menu background" below for *which* screens show it and why);
force-stopping the live game's `requestAnimationFrame` animation loop the
instant `'game'` stops being the visible screen (`stopLiveAnimationLoop` —
necessary because the win-comet runs *forever* once a puzzle is completed,
so `render()`'s own "reschedule while anything's active" check would never
naturally lapse on a screen the player has since navigated away from); and
refreshing the Resume/Replays lists from IndexedDB every time either is
shown, so a delete (or a game just finished elsewhere) is always reflected
without a stale cached list.

### Back/exit/done buttons are always top-left

Every screen that isn't the main menu has some way back to where it came
from, and that control is always the leftmost thing in that screen's own
header row, styled `.secondary.backBtn` (small, `‹ Label` text) — never on
the right, and never living in a bottom control bar instead. This is a
deliberate, enforced convention, not a coincidence of each screen's markup:
Free Play's "‹ Menu", New Game's "‹ Free Play", Resume's "‹ Free Play", and
Replays' "‹ Free Play" all share the same `.menuHeader` markup (button
first, then a centered `<h2>` — Resume/Replays used to have their own
`.overlayHeader` with the button *last*, which is what put their back
button in the top-right corner; that class is gone now, replaced by reusing
`.menuHeader` like every other submenu). The in-game **Exit** button
(`#exitBtn`) follows the same rule despite living in a very different part
of the DOM: it's the first element in `header` (game screen), positioned
exactly like a back button, rather than sitting in `#playControls`' bottom
bar the way it used to. Because it moved out of `#playControls`, it no
longer inherits that container's hidden/shown state for free — `enterReview`
and `exitReview` (see below) explicitly toggle `#exitBtn`'s own `.hidden`
class in lockstep with `#playControls`, so it still disappears the instant
`#reviewBar`'s own "‹ Done" takes over. `#reviewBar` itself follows the same
pattern once more: each of its two states (`#reviewIdleControls` for a
static review, `#reviewPlaybackControls` for an active replay) puts its own
"‹ Done" button first, ahead of the review label / playback widgets, so
whichever one is visible always has Done at the top-left — see "Review, and
where 'Done' goes back to" below.

### In-game controls

**Exit** (`#exitBtn`) lives in the game screen's `header`, not in
`#playControls` — see "Back/exit/done buttons are always top-left" above for
why, and how its visibility still tracks `#playControls`'s even though it's
no longer a child of it. `#playControls` itself (hidden outright while
reviewing — see below) swaps between two button groups depending on whether
the current live attempt is decided (`refreshControlBar`, called from every
place that can change `pathState.won`/`gaveUp`):

- **Not yet decided** (`#activeControls`): **Undo**, **Redo**, **Hint me
  (beta)** (`hintMe`, see "Locking edges" above), **Reset**, **Give Up** —
  the old History/Next-Puzzle buttons and the size/shape `<select>`s are
  still gone for good (moved to the menus above), but **Reset** (GitHub
  issue #48) was reintroduced once undo/redo/replay existed to make it
  safe again: `main.ts`'s `performReset` shares Undo/Redo's own eligibility
  (`undoRedoAllowed`) and is itself undoable, since it's built on the exact
  same mechanism they are — `history.ts`'s `resetPath` pushes the pre-reset
  state onto the undo stack and appends a `jump` entry to the move log,
  so a reset shows up in replay exactly like it happened: whatever moves
  came before, every unlocked edge disappearing at once, then whatever
  moves came after. "Reset" clears the board back to `game/edgeLock.ts`'s
  `resetToLockedState(puzzle, solutionEdges)`, not literally
  `createInitialPath(puzzle)` — a live "Hint me" session can have locked
  additional edges since the game began (`puzzle.lockedEdges` grows, but
  the puzzle's own generation-time `initialEdges` never does — see
  `edgeLock.ts`'s `lockEdge`), and the issue's spec is explicit that a
  reset should respect *all* currently-locked edges, not just the ones the
  puzzle started with. The two are exactly equivalent whenever nothing's
  been locked since generation, which is the common case.
  `resetToLockedState` lives in `edgeLock.ts`, not `pathEdit.ts`, precisely
  *because* it's built on `lockEdge`: an earlier version set each locked
  edge's mark bit directly, with no toggle at all, which is wrong (GitHub
  issue #57) — locking an edge *to marked* from an empty board always needs
  a real region toggle (see "Locking edges" above), and skipping that
  toggle can leave a cell with a single dangling marked edge (odd
  marked-degree), a state the player can never fix by tapping, sometimes
  making the puzzle outright unwinnable. The fix, per the issue's own
  suggestion, is to erase every edge and re-run the actual locking
  procedure: starting from a virgin puzzle/regionMap (`lockedEdges`
  cleared, so nothing is pre-excluded from any boundary) and an empty path
  state, `resetToLockedState` replays `lockEdge` over every edge in
  `puzzle.lockedEdges`, in that `Set`'s own insertion order (generation-time
  locks first, then any later live hints, in the order they actually
  happened) — exactly mirroring how `puzzleGen.ts`'s `applyLockedEdges`
  built `initialEdges` in the first place, so the two are byte-identical
  whenever nothing's been locked since generation (`edgeLock.test.ts`
  checks this against real generated puzzles). Collateral flipping (see
  "Locking edges" above) is a real, unavoidable side effect of this replay,
  same as it is at generation time — a locked edge's own toggle can
  legitimately leave some other, unlocked edge marked too, which the player
  remains free to toggle away again.
- **Complete, won or given up** (`#completeControls`): **Rematch** —
  `main.ts`'s `rematch()`, which immediately starts a fresh puzzle with the
  exact same `sizeKey`/`shapeMode`/`collections` as the one just finished
  but a brand-new `randomSeed()` (`beginPuzzle`) — and **Replay**, hidden
  unless the puzzle was actually won (`viewReplayBtn`'s visibility is keyed
  to `pathState.won` specifically, not the broader "complete" — a given-up
  puzzle has no move log to replay, see "Give Up" above).
  `viewReplayFromGame()` `await`s `pendingPersist` (so it never reads back
  a stale pre-`recordCompletion` record), fetches the just-recorded
  `CompletedRecord` for `currentPuzzleId`, and opens it via
  `enterReview(record, 'game')` followed immediately by `startReplay()` —
  landing the player straight into their own solve's replay rather than
  routing them through the Replays list.

**Exit** (`exitGame`) always returns to the Free Play hub — whatever's in
progress is already autosaved on every edit (`persistLiveState`), so there's
nothing to confirm or lose.

### Review, and where "Done" goes back to

`enterReview(item, origin)` — opened either from the Replays list or from
the just-completed live game's own Replay button — takes an explicit
`origin: 'game' | 'menu'`, stored in `reviewOrigin`, because "Done"
(`exitReview`) needs to go back to two genuinely different places depending
on how review was entered: back to the live, now-solved game
(`origin: 'game'`, the common case right after finishing a puzzle) or back
to the Replays list it was opened from (`origin: 'menu'`, since there might
be no live game underneath at all — Replays is reachable straight from the
Free Play hub without ever having played anything this session).
`enterReview` hides `#playControls` (and `#exitBtn` alongside it — see
"Back/exit/done buttons are always top-left" above) and shows `#reviewBar`
in its place (the reverse on `exitReview`) regardless of `origin`, since the
control bar Undo/Redo/Give Up/Rematch/Replay buttons are never meaningful
while reviewing — a review is always read-only (`inputPathState()` reports
`won: true` unconditionally while `mode === 'reviewing'`, which is what
makes the input layer refuse edits and only allow pan/zoom for free,
without any extra guarding in `input.ts`/`keyboard.ts`).

`#reviewBar` itself holds two mutually-exclusive rows, `#reviewIdleControls`
(static review: "‹ Done" / the puzzle's summary label / **Replay**) and
`#reviewPlaybackControls` (active replay: "‹ Done" / Play-Pause / speed
select / scrubber / frame counter) — `startReplay`/`closeReplay` toggle
which one is visible, exactly as before. Each row's own "‹ Done" button
(`exitReviewBtn` in the idle row, `replayCloseBtn` in the playback row) does
something different — `exitReview()` leaves review entirely (back to the
live game or the Replays list, per `origin` above), while `closeReplay()`
only stops playback and drops back to the static idle row, still inside
review — the two are deliberately kept as separate buttons/handlers rather
than unified into one context-sensitive button, so that nesting (stop
playback → still-reviewing idle view → actually leave review) still works
exactly as it did before the repositioning. `#reviewLabel` (the puzzle
summary/date) only appears in the idle row now, not the playback row — it
used to be a permanent sibling of both — since dropping it from the
playback row is both one fewer thing needing to fit at replay speed-picker
width, and consistent with "Replay" itself being a static-review-only
concept.

Both rows, and `#reviewBar` generally, are `flex-wrap: wrap` with every
child a `min-width: 0` flex item (`#replayScrubber` in particular, which
used to have a hard `max-width: 200px` fighting for room against
Play/Pause + the speed `<select>` + the frame counter): on a narrow phone
viewport, whichever controls don't fit the first line wrap to a second
instead of forcing the bar wider than the screen — this is what fixes the
playback controls overflowing horizontally off small screens (see also
`#reviewLabel`'s `text-overflow: ellipsis` for the same reasoning applied to
a long puzzle-summary string in the idle row).

### Main menu background

`#menuCanvas` is a *shared* background, not exclusive to the main menu
despite the name: it's `index.html`'s first child of `#app`, a sibling of
every `.screen` rather than nested inside `#mainMenuScreen`, positioned
behind all of them (plain DOM order — no explicit `z-index` needed, since
every `.screen` is opaque unless it opts out). Every *fixed-size* menu
screen — main menu, Free Play hub, New Game (`BACKGROUND_SCREENS` in
`main.ts`) — carries a `.menuBgScreen` class that makes its own background
transparent so the canvas shows through, with `.menuHeader`/`.menuContent`
given a translucent dark backdrop of their own for text legibility over the
busy animated board underneath. Resume and Replays deliberately do *not*
get `.menuBgScreen` — they're variable-length lists rather than fixed
layouts, and the animated board would be a distracting backdrop for reading
a list — so they keep the plain opaque `.screen` background, same as the
game screen itself (not a "menu" at all). `showScreen` starts/stops the
background exactly once per crossing *into*/*out of* `BACKGROUND_SCREENS`
as a set (tracked by whether `stopMenuBackground` is currently non-null,
not by comparing screens directly — see its function doc comment for why:
`screen`'s own initial value is `'mainMenu'`, so a naive "did the screen
change into the set" check misses the very first `showScreen('mainMenu')`
call at startup), so navigating *within* the set (e.g. Free Play → New
Game) leaves the animation running uninterrupted rather than restarting it.

`src/menuBackground.ts`'s `startMenuBackground(canvas)` drives whatever
canvas it's handed (`#menuCanvas` in practice, but the module itself has no
knowledge of which screen owns it): a fixed, arbitrary `PuzzleId` — always
the *huge* size, *toroidal* shape (`MENU_PUZZLE_ID`, a hardcoded seed so the
same showcase puzzle appears every time rather than regenerating a fresh
1120-cell board on every menu visit) — generated once via `generatePuzzle`/
`generateSolutionEdges` exactly like any other puzzle, then handed to
`render.ts`'s `draw()` already marked `won: true` with its win-comet
(`AnimationState.winComet`) running from the moment the background starts.
This reuses the entire postgame win-comet animation (see "Win-comet
(postgame)" above) completely unchanged — the background is quite literally
"the postgame ripple of a solved huge toroidal puzzle", not a separate
reimplementation of anything that looks similar.

The **constant diagonal panning** on top of that is the one genuinely new
piece: each frame computes a `Viewport` whose `tx`/`ty` advance linearly
with elapsed time (`PAN_SPEED_X`/`PAN_SPEED_Y`, board pixels/second) and
feeds it to the same `draw()` call — since the puzzle is toroidal,
`render.ts`'s `drawWrapped` already recomputes the entire visible tiling
fresh from whatever `view` it's given on every call (see "Board shapes and
topologies" above), so panning "for free" here is exactly the same
mechanism a real wraparound game board's pan/zoom already relies on, not
new rendering logic. `tx`/`ty` are wrapped modulo one tile's on-screen pixel
size rather than left to grow without bound for as long as the main menu
happens to stay open — for a seamlessly repeating tiling, panning by
exactly one tile is visually identical to not panning at all, and wrapping
keeps the arithmetic (and any long-run floating-point drift) bounded
regardless of session length.

`startMenuBackground` returns a teardown function; `showScreen` calls it the
instant navigation leaves `BACKGROUND_SCREENS` entirely (not on every
individual screen change within it — see above), so its own
`requestAnimationFrame` chain — like the live game's win-comet, this one
also runs forever by design — doesn't keep drawing to a hidden canvas after
the player has navigated away.

## Blitz mode

A timed-run mode alongside Free Play: solve an endless sequence of
increasingly-difficult puzzles against a countdown clock, earning time back
per puzzle solved, until the clock runs out. `src/game/blitz.ts` holds the
pure difficulty/sequencing logic (unit tested, `blitz.test.ts`);
`src/persistence/blitzStore.ts` holds the leaderboard's persistence layer
(unit tested, `blitzStore.test.ts`); `src/main.ts`'s "Blitz mode" section
(split into "live play", "leaderboard", and "real-time run replay"
subsections, mirroring this doc's own structure) wires both into the UI —
thin DOM/canvas glue, verified by hand per this project's usual policy (see
"Testing notes" below) rather than unit tested.

### Difficulty rating and the puzzle sequence

Every `(sizeKey, shapeMode)` combination has a **difficulty rating**
(`blitz.ts`'s `boardDifficultyRating`): a board's raw edge count
(`boardEdgeCount(sizeKey)`, `4 * m * n` — identical across every shape mode
of the same size, since a random shape is "a random connected polyomino of
the *same area*" and a toroidal board is generated on the same `m x n`
block grid, so it's a property of `sizeKey` alone, not of the actual
generated puzzle graph) times a **first-pass, easy-to-retune**
`SHAPE_DIFFICULTY_MULTIPLIER` table: `rect` 1×, `random` 0.75× (a
non-rectangular shape's irregular outline tends to make the hidden loop
more forced/obvious), `toroidal` 1.5× (no boundary to anchor on, plus the
wraparound rendering itself takes longer to read). These two non-`rect`
multipliers are deliberately closer to 1× than an earlier pass at this
table had them (0.5×/2×) — both shapes were locked out for much longer than
felt warranted once board size stopped being picked from a handful of fixed
sizes and started varying continuously (see below), so they were nudged
toward the middle for balance. Deliberately factored into one small table,
separate from the selection logic that reads it, so it can be rebalanced
later without touching anything else. Klein bottle/projective plane get a
nominal entry too (matching toroidal's multiplier) purely so the table
stays total over every `ShapeMode`, even though Blitz never actually offers
them (see "Board shapes and topologies" above — same picker restriction as
New Game).

**Board size is chosen continuously, not looked up from `SIZE_OPTIONS`.**
An earlier version of this feature picked each puzzle's size from the same
fixed `tiny`/`mini`/.../`huge` table Free Play's New Game screen uses;
`blitz.ts`'s `chooseBlitzBoard(rng, budget)` replaced that outright with a
generator that can produce *any* block dimensions, so a run's board sizes
form a smooth spread rather than jumping between six fixed points. For a
given budget it: picks a shape mode uniformly among whatever's affordable
at all (`eligibleBlitzShapes`, gating on that shape's cheapest-possible
board — `MIN_BLITZ_BLOCK_DIM` (2) per dimension — rather than on any one
fixed size); rolls a random target difficulty for that shape somewhere
between its own cheapest board and the full budget (CLAUDE.md's "choose a
random difficulty up to the present budget") — with no ceiling on the
resulting area any more (an earlier version capped this at
`MAX_BLITZ_BOARD_AREA`, 280 blocks matching the old `huge` size, to stop a
very long run's ever-growing budget from compounding toward absurdity; that
concern applied when budget growth was proportional to each puzzle's own
size — a bigger puzzle grew the budget more, which made the next puzzle
likely bigger still, racing exponentially upward. Budget growth is a flat
`BLITZ_BUDGET_INCREMENT` per puzzle now, independent of that puzzle's own
size (see below), so it no longer compounds, and the ceiling was removed as
unnecessary); and splits the resulting area into concrete `m`/`n` block
dimensions using a random aspect ratio between `MIN_ASPECT_RATIO` (a
perfect square, 1×) and `MAX_ASPECT_RATIO` (1.6× — the least-square ratio
any of the old fixed `SIZE_OPTIONS` ever used, `large`'s 10x16, computed
from that table rather than hardcoded so it stays consistent if those
entries ever change) — "make the aspect ratio random, but keep it at least
as square as the current aspect ratios." Which of the two split dimensions
ends up the wider one is independently randomized too, so boards aren't
always elongated in the same screen direction. All the rounding in this
split is deliberately asymmetric — the narrower dimension is *rounded* to
the nearest integer while the wider one is *floored* down from the area,
then explicitly re-clamped to the aspect-ratio cap — because flooring the
narrower dimension down (the naive approach) silently widens the *realized*
ratio past the target (dividing the same area by a smaller-than-intended
short side always yields a larger long side), which is what an earlier
draft of this function got wrong (`blitz.test.ts` catches this directly:
"never produces an aspect ratio more elongated than..."). Each chosen
board's dimensions are encoded into a synthetic `sizeKey` via
`puzzleGen.ts`'s `customSizeKey(m, n)` rather than needing a second,
parallel dimensions field on `PuzzleId` — see "Puzzle identity and
generation" above.

A run's puzzle sequence is driven by a difficulty **budget** that starts at
`BLITZ_INITIAL_BUDGET` and grows, after every puzzle handed out, by a flat
`BLITZ_BUDGET_INCREMENT` — both are multiples of one nominal difficulty
"unit" (`BLITZ_BUDGET_UNIT`, the larger of a `tiny`-sized, i.e. 3x4,
rectangle's and random-shape's own ratings — computed from the table, not
hardcoded, so retuning the multipliers keeps both self-consistent).
`BLITZ_INITIAL_BUDGET` is *two* units (doubled from the original one-unit
starting point, so a run opens noticeably harder right from its first
puzzle rather than starting at the cheapest board Blitz can generate);
`BLITZ_BUDGET_INCREMENT` is one unit, added after *every* puzzle handed out
regardless of that puzzle's own size. This is a deliberate change from an
earlier version of this feature, whose spec read "the difficulty rating
increases after each solve by the number of edges in the solution to the
solved board" — i.e. budget growth proportional to each puzzle's own `4 * m
* n` edge count. That compounded: a bigger puzzle grew the budget more,
which made the *next* puzzle likely bigger still, so a run's difficulty
climbed away from a comfortable pace far faster than felt fair, especially
combined with the now-doubled starting budget. A flat per-puzzle increment
keeps difficulty climbing at a steady, predictable pace regardless of how
large any single puzzle in the sequence happened to be. The increment is
still knowable the instant a board is chosen, before it's solved at all
(it doesn't even depend on which board was chosen any more, being a flat
constant) — which is what keeps the whole sequence precomputable (see
below), same as before this change.
`blitz.ts`'s `createBlitzSequence(runSeed)` returns a stepping generator
(`.next()`) that, each call, calls `chooseBlitzBoard` against the run's own
`mulberry32` rng stream, mints that puzzle's own seed from the same stream,
and grows the budget. Because every shape mode's cheapest possible board
already fits comfortably under `BLITZ_INITIAL_BUDGET`, a fresh run can, in
principle, roll any shape — including toroidal — from its very first
puzzle; what actually varies with the budget is the *size* range each shape
can be generated at, which starts small and widens, uncapped, as the budget
grows from puzzles handed out.

Critically, **puzzle generation is entirely independent of the run's
difficulty parameters** (see below): `createBlitzSequence` takes only
`runSeed`, nothing about starting time or time-back rate. Two runs sharing
a `runSeed` play through the *identical* sequence of puzzles in the
identical order, regardless of their `BlitzParams` — only the clock differs.
This is also what makes the whole sequence precomputable from the seed
alone without needing the player to actually solve anything (the budget
growth is a flat constant per puzzle, depending on neither which board was
picked nor on play quality), which is exactly what a real-time replay leans
on (see below): a stored
run's `puzzleStart` events record their own resolved `sizeKey`/`shapeMode`/
`seed` explicitly rather than replaying `createBlitzSequence` itself, so
replay never has to re-derive the sequence and stays correct even if the
difficulty/selection rules are retuned later.

### Starting a run: `BlitzParams`, and the three pace presets

`blitz.ts`'s `BlitzParams` bundles the two numbers that actually drive a
run's clock:

- **`startingTimeSec`** — how much time the run's clock starts with.
- **`timeBackPerEdgeSec`** — seconds credited back per edge of a puzzle's own
  solution cycle (`4 * m * n`, that puzzle's own edge count — no longer the
  same quantity the budget grows by now that budget growth is a flat
  constant, see "the puzzle sequence" above) — a proportionality constant,
  not a flat per-puzzle bonus, so a harder (bigger) puzzle is worth
  proportionally more time back. Credited the instant that puzzle *starts*,
  not when it's solved (see "Live play" below) — a deliberate change from an
  earlier version of this feature, which credited it on solve instead. Time
  credited this way has no cap — CLAUDE.md's spec: "time bank can get
  arbitrarily large."

Rather than letting the player type these in directly, the Blitz setup
screen (`#blitzSetupScreen`, reachable via the Blitz hub's **Play** button)
offers exactly three named **pace** presets — `blitz.ts`'s `BlitzPace`
(`'slow' | 'normal' | 'fast'`) and `BLITZ_PACE_PARAMS`, the one place these
numbers are defined:

| Pace | `startingTimeSec` | `timeBackPerEdgeSec` |
| --- | --- | --- |
| Slow | 90 | 0.2 |
| Normal (default) | 60 | 0.15 |
| Fast | 45 | 0.1 |

`#blitzPaceSelect` is a plain `<select>` of the three (`BLITZ_PACE_OPTIONS`
supplies the labels); `blitzStartBtn`'s click handler reads it, falling
back to `DEFAULT_BLITZ_PACE` for a value that doesn't resolve to a preset
(shouldn't happen from the `<select>` itself, but keeps the lookup total),
and starts the run with `BLITZ_PACE_PARAMS[pace]` directly — no clamping
needed any more, since every value a player can actually select is already
one of the three exact preset pairs. Starting a run (`main.ts`'s
`startBlitzRun`) mints a fresh `randomSeed()` for the run (independent of
`BlitzParams`, per above), builds its `createBlitzSequence`, and shows the
very first puzzle. `startBlitzRun` calls `showScreen('game')` *before*
`advanceBlitzPuzzle()` (which puts that first puzzle on screen via
`layout()`) rather than after — `#gameScreen` is still `.hidden`
(`display: none`) up to that call, and `layout()`'s `fitView()` reads
`wrapEl.clientWidth`/`clientHeight` to compute the fit-to-view scale/pan,
which read `0` while hidden and produced a degenerate, badly-mis-fitted
view. Every other mode-entry function (`beginPuzzle`, `enterReview`,
`openBlitzReplay`) already called `showScreen('game')` first for the same
reason; `startBlitzRun` was the one outlier.

A `BlitzRunRecord` still stores the raw `startingTimeSec`/
`timeBackPerEdgeSec` numbers, not the pace name — the leaderboard's
`formatBlitzParamsLabel` (`main.ts`) recovers the pace for *display* via
`blitz.ts`'s `paceForParams` (an exact match against `BLITZ_PACE_PARAMS`),
falling back to the raw `${startingTimeSec}s start · +${timeBackPerEdgeSec}s/edge`
wording for a run recorded before the presets existed (or, in principle,
if the presets are ever retuned) — a run's own params are always the
source of truth; the label is just a friendlier name for whichever preset
they happen to match today.

### Live play

A live run and a Free Play game share the exact same `'game'` screen and
canvas — `main.ts`'s `Mode` type gained `'blitz'` (live) and `'blitzReplay'`
(watching a recorded run back) alongside the existing `'playing'`/
`'reviewing'`, and `activePuzzle()`/`activeRegionMap()`/`inputPathState()`/
`render()` each grew a branch for both, exactly the way they already
branched for `'reviewing'`. This reuses every bit of existing board
rendering/pan/zoom/tap-to-toggle machinery unchanged — Blitz needed a new
*edit funnel* and *screen chrome*, not a new board. `index.html`'s
`#gameScreen` header/overlay elements are shared and swapped by visibility
class per mode: Free Play's `#exitBtn`/`#headerInfo`/`#playControls`, the
per-puzzle `#reviewBar`, and Blitz's own `#blitzExitBtn` ("‹ Forfeit",
top-left per this project's back-button convention — see "Back/exit/done
buttons are always top-left" above)/`#blitzHeaderInfo` (a live countdown
`#blitzTimer` plus a `#blitzStats` status line) — every mode-entry function
(`beginPuzzle`, `enterReview`, `startBlitzRun`, `openBlitzReplay`)
defensively resets all of them, so leftover visibility from whichever mode
was active before can never bleed into the next.

There is **no Undo/Redo/Give Up in Blitz** — a live run's only edit funnel
is `setBlitzPathState` (dispatched from the shared `setPathState` by
`mode`), which just records the move and checks for a solve; a puzzle is
either fresh or solved, nothing in between to undo back into. The one
exception is **Reset** (`#blitzResetBtn`, GitHub issue #48): a dedicated
button, shown in its own small `#blitzControls` bar (Blitz's own bottom
bar, analogous to Free Play's `#playControls` but with just this one
button — there's no Undo/Redo/Give Up to put next to it), that clears the
current puzzle's board back to its starting state via `resetBlitzBoard`.
Unlike Free Play's `performReset`, Blitz has no live "Hint me" feature to
ever lock an edge beyond generation time, so the plain
`createInitialPath(blitzPuzzle)` is exactly equivalent to
`resetToLockedState` here and cheaper (no solution recompute needed) —
see "In-game controls" above for why the two functions differ at all.
`resetBlitzBoard` only acts while the current puzzle is still live and
unsolved (`blitzPathState.won` is `false`); it appends a `{ kind: 'reset',
t }` event to `blitzEvents` (see "Recording and replaying a run" below) so
the run's replay shows the clear exactly where it happened, sandwiched
between whatever moves came before and after. Solving one
(`next.won && !prevWon`, exactly the same check Free Play's
`setFreePlayPathState` uses) triggers `handleBlitzPuzzleSolved`, which no
longer moves the clock at all — it just tallies the solve (`blitzPuzzlesSolved
+= 1`), records a `puzzleSolved` event, shows a plain "Solved!" toast, and,
after a short flash (`BLITZ_ADVANCE_DELAY_MS`, long enough to read the toast
and see the last edge's ordinary grow animation land, short enough to still
feel like Blitz), calls `advanceBlitzPuzzle`. The delay is a plain
`setTimeout`, guarded by `mode === 'blitz'` when it fires, in case the run
already ended (timer expired, or the player forfeited) in the meantime.

The time award moved to `advanceBlitzPuzzle` itself — a deliberate change
from an earlier version of this feature, which awarded it in
`handleBlitzPuzzleSolved` instead (i.e. on *solving* a puzzle, proportional
to *that* puzzle's own size). Now, every time `advanceBlitzPuzzle` pulls the
next `PuzzleId` from the run's `createBlitzSequence` and puts it on screen —
whether that's the very first puzzle of the run or the one after a solve —
it immediately computes that *new* puzzle's own award
(`timeBackPerEdgeSec * 1000 * totalCells(puzzle)`) and pushes it onto
`blitzDeadline` (a `performance.now()` timestamp, not a countdown number
that needs decrementing — "how much time is left" is always just
`blitzDeadline - performance.now()`, recomputed fresh, so nothing needs
reconciling when an award lands mid-frame) before the player has made a
single move on it, and shows a toast for the bonus. In other words: the
refund a puzzle is worth is now banked the moment that puzzle appears, not
handed out as a reward for finishing it — CLAUDE.md's spec is "time refunded
proportional to the number of edges in the solution to the solved board, at
the start of the puzzle in question."

The clock itself (`blitzTick`) is a `requestAnimationFrame` loop, separate
from the live board's own animation-driven `render()` chain (though a solve
still triggers the ordinary grow/shrink/ripple juice via
`scheduleToggleAnimation`, reusing `liveComponentColors` — a fresh puzzle
transition resets that color state, same as any other genuine board-identity
boundary per "Persistent component colors" above): each tick recomputes
`remaining = blitzDeadline - performance.now()`, updates the header, and — the
moment `remaining <= 0` — calls `endBlitzRun`. **Blitz doesn't specially
suppress the win-loop/comet machinery from "Animations" above** — `render()`
treats a solved puzzle as "completed" exactly like a real Free Play win
while `blitzPathState.won` is briefly true — but in practice it rarely gets
far: `BLITZ_ADVANCE_DELAY_MS` is usually shorter than the winning ripple
needs to finish sweeping the board (the comet doesn't even start until
then, see "Win-comet (postgame)" above), so most solves read as a quick
flash of the flat solved color rather than a full celebration. No special
teardown is needed when the next puzzle appears either way:
`advanceBlitzPuzzle`'s fresh, unwon `blitzPathState` makes `completed` false
again on the very next `render()`, which is exactly the condition that
already makes the win-loop/comet cache reset itself (the same
"self-heals from a reference/value change alone" property `render()`'s own
doc comment describes for every other mode).

**Forfeiting** (`#blitzExitBtn`, confirm-gated) and **timing out** both funnel
through the same `endBlitzRun`: it stops the clock, computes
`scoreMs = blitzElapsedMs()` (real time elapsed since the run's own start —
CLAUDE.md's spec: "the user's final score is the total amount of time they
lasted," which is exactly this, *not* a countdown-remaining or
time-bank-remaining number — a run that earned lots of refunds simply lasted
longer in real time, which this measures directly rather than by summing
awards), records the run (`saveBlitzRun`, see "Recording and replaying a
run" below), and shows the Blitz game-over screen (`#blitzGameOverScreen`,
one of `BACKGROUND_SCREENS` — see "Main menu background" above — showing
the shared animated background same as the other fixed-layout Blitz
screens) with **Play Again** (same `BlitzParams`, a brand-new
`randomSeed()` — mirrors Free Play's Rematch) and **Watch Replay** (opens
the just-finished run in the real-time replay viewer, disabled if the save
itself failed) as its button stack, plus its own top-left `.menuHeader`
back button ("‹ Blitz") — moved there from a third button at the bottom of
the stack so it follows this project's usual "back is always top-left"
convention (see "Back/exit/done buttons are always top-left" above, and
GitHub issue #47).

### Recording and replaying a run

`blitz.ts`'s `BlitzEvent` is the chronological, append-only recording of one
run — timestamped by `t` (milliseconds since the run's own first
`puzzleStart`, *not* a frame/step counter and *not* wall-clock `Date.now()`)
so replay can reproduce real *pacing*, not just an ordered sequence of
states:

- `{ kind: 'puzzleStart', t, sizeKey, shapeMode, seed, timeAwardedMs }` —
  carries its own resolved `PuzzleId` fields explicitly (see "the puzzle
  sequence" above for why replay never needs to re-run `createBlitzSequence`
  at all), plus `timeAwardedMs`: this puzzle's own time-back bonus, credited
  the instant it starts rather than when it's solved (see "Live play"
  above) — so applying this event both regenerates the puzzle *and* credits
  the award in one step. Applying this event (`applyBlitzReplayEvent`) calls
  `layout()` after swapping in the new puzzle, exactly like live play's
  `advanceBlitzPuzzle()` does — a run's puzzles are rarely all the same
  size, and without this the canvas stayed sized (and the view fitted) to
  whichever board the *first* `puzzleStart` set it to, cropping every
  later, larger board even when zoomed out. Both call sites that reach
  `applyBlitzReplayEvent` only ever run once `mode === 'blitzReplay'` and
  `#gameScreen` is already the visible screen (`openBlitzReplay` calls
  `showScreen('game')` *before* its initial `seekBlitzReplay(0)`, for the
  same `wrapEl`-must-be-visible reason `startBlitzRun` above needs it), so
  `layout()`'s `fitView()` always has a real `wrapEl` size to compute
  against.
- `{ kind: 'move', t, ops }` — reuses `PathOp` verbatim, same compact shape
  `history.ts`'s `moveLog` already uses. There's no `jump`/undo entry the
  way `history.ts`'s own `MoveLogEntry` has (no Undo/Redo in Blitz — every
  transition other than a reset is a real forward move).
- `{ kind: 'reset', t }` — the live "Reset" button (`#blitzResetBtn`, see
  "Live play" above, GitHub issue #48). Carries no payload beyond `t`:
  applying it (`applyBlitzReplayEvent`) just re-derives
  `createInitialPath(blitzReplayPuzzle)` from whichever `puzzleStart` is
  currently in effect, exactly like live play's own `resetBlitzBoard`
  does, so there's nothing else to record. `advanceBlitzReplayTo`'s
  animated forward-step path treats it like a `move` — computing the
  symmetric difference between the before/after edge sets and running it
  through the same `scheduleToggleAnimation` grow/shrink juice — and shows
  a "Board reset" toast, so scrubbing forward through one during playback
  reads the same as watching it happen live.
- `{ kind: 'puzzleSolved', t }` — no longer carries a time award (moved to
  `puzzleStart`, see above); only marks that the puzzle in progress at `t`
  was solved, for the puzzles-solved tally.
- `{ kind: 'runEnd', t, scoreMs }` — always the log's last entry;
  `blitzReplayDurationMs()` just reads its `t`.

`persistence/blitzStore.ts`'s `BlitzRunRecord` bundles this `events` log
with the run's `BlitzParams`, `scoreMs`, `puzzlesSolved`, and
`startedAt`/`completedAt` timestamps, keyed by `${seed}::${startedAt}`
(pairing rather than `seed` alone rules out even the astronomically-unlikely
case of two runs minting the same 32-bit seed — the same caveat
`puzzleGen.ts`'s `randomSeed` already carries). Runs are *not* stored in
full puzzle-graph form, same policy as `gameStore.ts`'s completed
puzzles — regenerated on demand from each `puzzleStart` event's own id.

**Replay** (`main.ts`'s "real-time run replay" section, `mode ===
'blitzReplay'`) is a second, genuinely different playback engine from the
per-puzzle `showReplayFrame`/`playReplay` above — that one steps through a
fixed array of pre-decoded frames; this one walks the live `events` array
forward from wherever `blitzReplayEventCursor` currently is, applying each
event in turn (`applyBlitzReplayEvent`) as its `t` comes due, because a
Blitz run's timeline spans *multiple puzzles*, each needing its own fresh
`generatePuzzle(id)`/`computeRegions` — not just replaying one puzzle's
edge-by-edge history. `advanceBlitzReplayTo(target, animate)` is playback's
one real primitive: `blitzReplayTick` (a `requestAnimationFrame` loop
advancing `blitzReplayT` by real elapsed time × `blitzReplaySpeed`, mirroring
the ordinary replay's speed-select pattern but with a wider 0.5×-4× range
since a whole run is longer than one puzzle) calls it with `animate: true`
for its natural forward steps (each `move` event gets the same
grow/shrink/ripple juice a live toggle does, via `scheduleToggleAnimation`
against `reviewComponentColors` — kept separate from live play's
`liveComponentColors`, same reasoning as ordinary review); scrubbing
(`#blitzReplayScrubber`) instead calls `seekBlitzReplay(targetT)`, which
always replays from event 0 (the same simplifying "always replay from the
start, never step backward" tradeoff `decodeMoveLog` already makes for the
per-puzzle case) and snaps with no animation, since an arbitrary scrub can
span many puzzles at once and there's no one sensible thing to animate for
that. `#blitzReplayBar` reuses `#blitzHeaderInfo`'s timer/stats display,
reconstructing "remaining time" as `startingTimeSec * 1000 +
(awarded-so-far) - t` — exactly the arithmetic `blitzDeadline` encodes live,
just derived from the event log instead of a running timestamp.

### Leaderboard

Every run is scoped to its exact `BlitzParams` — `blitzStore.ts`'s
`blitzParamsKey` (`${startingTimeSec}::${timeBackPerEdgeSec}`) is the
grouping key both `listBlitzDifficulties` (every distinct difficulty the
player has ever completed a run at, most-recently-played first — feeds
`#blitzLeaderboardScreen`'s picker) and `listBlitzRunsForParams` (every run
at one exact difficulty, sorted by score descending — feeds
`#blitzLeaderboardRunsScreen`) use, matching this feature's spec: "a
personal leaderboard for each difficulty setting... select difficulty
settings and then see all their recordings for that difficulty setting,
sorted by score." Both list screens reuse `main.ts`'s existing generic
`renderListItem` (title/date/onOpen/onDelete) — the same Resume/Replays
pattern, physically separate Delete (✕) buttons so a delete tap can never be
misread as "open". A difficulty row's own Delete (`deleteBlitzRunsForParams`)
removes every run at that difficulty in one go, a convenience beyond the
individual per-run delete one level down. Opening either a difficulty-picker
row or a run row navigates forward (`openBlitzLeaderboardRuns` /
`openBlitzReplay`); "‹ Leaderboard"/"‹ Blitz" back buttons follow this
project's usual top-left convention. The grouping itself is still by the
raw `BlitzParams` pair (unchanged since a run's own recorded numbers are
always the source of truth — see above), but every heading built from a
group's params — the difficulty-picker row and the runs-list screen's own
title (`#blitzLeaderboardRunsTitle`) — goes through `formatBlitzParamsLabel`,
so a difficulty group shows its pace name ("Slow"/"Normal"/"Fast") instead
of raw numbers whenever its params match one of the three current presets.

### Scope cuts

- **No resumable in-progress Blitz run.** Free Play autosaves on every edit
  so a reload always resumes exactly where it left off; Blitz deliberately
  does not — refreshing, closing the tab, or navigating away mid-run simply
  forfeits it with *nothing* recorded (not even a partial score), since
  there's no real-time clock to fairly "pause and resume" across an
  arbitrary reload gap the way a turn-based Free Play game can. Only a run
  that actually ends (times out or is explicitly forfeited via
  `#blitzExitBtn`) gets written to `blitzRuns` at all.
- **No player-facing "last used" default for the setup screen** — unlike
  New Game's remembered `sizeKey`/`shapeMode` (`localStorage`), the Blitz
  setup screen's pace `<select>` always starts on `DEFAULT_BLITZ_PACE`
  ("Normal"). Straightforward to add later (same `localStorage` pattern) if
  it turns out to matter; left out here to keep the first pass focused.

## `main.ts` orchestration

Holds the mutable app state: `screen` (above), `mode: 'playing' |
'reviewing'`, `currentPuzzleId`, `puzzle`, `regionMap`
(`computeRegions(puzzle)`, recomputed whenever the puzzle changes),
`pathState`, `gaveUp` (see "Give Up" above), `history` (undo/redo + move
log, see above), plus separate
`reviewPuzzle`/`reviewRegionMap`/`reviewEdges`/`reviewWon`/
`currentReviewItem`/`reviewOrigin` for the read-only review overlay (kept
apart from the live game so opening a review can't disturb an in-progress
puzzle), and `focusedRegionId`/`keyboardCursor` for the current
press/keyboard highlight. `activePuzzle()`/`activeRegionMap()` and the
`GameInputHost` given to `attachPointerHandling` all branch on `mode` —
reviewing reports `won: true` unconditionally (`inputPathState()`), which is
what makes the input layer refuse edits and only allow pan/zoom for free,
without any extra guarding in `input.ts`/`keyboard.ts`.

`beginPuzzle(id, resume?)` is the one place that actually starts showing a
puzzle — shared by New Game (`startNewGame`, no `resume`), Resume (passing
the saved record's `edges`/`history`), and Rematch (a fresh `randomSeed()`,
no `resume`, same as New Game). It switches to the `'game'` screen itself
(`showScreen('game')`), so none of its three callers need to. Also persists
`sizeKey`/`shapeMode` to `localStorage` purely so New Game's `<select>`s
default to the last-used configuration on a future visit — separate from
the IndexedDB game state, and why `SELECTABLE_SHAPE_MODE_OPTIONS` (not the
full `SHAPE_MODE_OPTIONS`, which still includes the disabled
klein/projective entries) gates whether a stored `lastShape` is honored.

A wraparound board (`puzzle.topology`) is panned/zoomed differently from an
ordinary one: an ordinary board's canvas is a fixed-size bitmap moved via a
cheap CSS `transform` (`applyTransform`); a wraparound board's canvas is
instead sized to the visible viewport itself and redrawn from scratch on
every view change, since the content genuinely tiles infinitely and there's
no fixed bitmap a CSS transform could pan across (`layout()`/
`applyTransform()` both branch on this).

`pendingPersist` tracks the latest in-flight IndexedDB write; both the
"Replay" control-bar button (`viewReplayFromGame`) and the (removed) old
"Next Puzzle" button's replacement flows `await` it before reading
persisted state back, so a fast click right after winning can't race ahead
of `recordCompletion()`.

## Testing notes

Vitest tests across 21 files, all in `*.test.ts` files next to their
modules. Pure game logic (`src/game/*`), viewport math, and persistence are
unit tested — including the pure pieces of the animation system
(`loopOrder.ts`'s cycle-walk, `edgeRipple.ts`'s reachable-recolor BFS,
`componentColors.ts`'s persistent color assignment) and of Blitz mode
(`blitz.ts`'s difficulty rating/eligible-options/puzzle-sequence,
`blitzStore.ts`'s leaderboard grouping/sorting/deletion — see "Blitz mode"
above), even though the animations themselves are visual-only. `render.ts`,
`input.ts`, `keyboard.ts`, `menuBackground.ts`, and `main.ts`'s own Blitz UI
wiring are not — they're thin DOM/canvas glue verified by hand instead
(Blitz's live-play/leaderboard/replay screen flow was verified end to end
via a throwaway Playwright script the same way the rest of the menu system
was — see below). When changing pointer, keyboard, or
menu/screen-navigation interaction, the fastest way to sanity-check is a
throwaway Playwright script against `npm run dev` (pre-installed Chromium
at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in this
environment) rather than trying to unit test DOM event sequencing — e.g.
driving `#newGameSizeSelect`/keyboard arrow presses and reading back
`#canvas`'s `style.transform` is how the keyboard-cursor viewport
auto-scroll (`panToKeepVisible`) was manually verified, and the same
approach (clicking through New Game → Exit → Resume → the resumed row,
watching which `.screen` ends up without `.hidden`) is how the menu system
itself was verified end to end, including seeding IndexedDB directly via
`page.evaluate` to test the Resume/Replays lists' Delete buttons and the
Replays-vs-in-game "Done" destinations without first having to solve a
puzzle in the browser.

To compute an exact solution path for a given `PuzzleId` for scripted
end-to-end testing, use `puzzleGen.ts`'s `generateSolutionCells(id)`
directly (it mirrors `generatePuzzle`'s exact rng call sequence for every
shape mode, including toroidal's mod-reduction — see "Give Up" above)
rather than trying to reverse-engineer a solution from `adj` or blindly
raster-sweeping the face grid.

## Things to know before changing size/shape/puzzle identity

`SIZE_OPTIONS[].key`, `SHAPE_MODE_OPTIONS[].key`, and the id hash
(`puzzleIdKey`: `sizeKey::shapeMode::seed` plus the optional collections
suffix) are load-bearing storage/identity strings — renaming a size or
shape key, or changing the hash input format, invalidates existing players'
`inProgress`/`completed` records (they'd just silently stop showing up in
Resume/Replays, no crash — see `hasSeed`/`isUsable` in "Persistence
(IndexedDB)" above). If that's ever needed, it's a one-time migration
problem, not something currently handled. This includes `klein`/
`projective`: even though they're disabled from the picker, their
`ShapeMode` keys must stay exactly as they are for as long as any player
might have completed puzzles of those shapes sitting in their `completed`
store. The main menu's animated background (`menuBackground.ts`'s
`MENU_PUZZLE_ID`) also pins a specific `seed` for its showcase puzzle —
changing it just picks a different (still huge/toroidal) board to display,
harmless, but pointless busywork with no player-visible benefit.
