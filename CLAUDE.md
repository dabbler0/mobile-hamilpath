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
puzzle sequence (now also removed — superseded by the current seed-based
puzzle identity, see "Puzzle identity and generation" below), IndexedDB
persistence, non-rectangular/wraparound board shapes, edge collections, and
a menu-driven shell wrapped around what used to be a single always-visible
game screen (see "Menus and screen navigation" below).

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
edges are added (except that `puzzleGen.ts`'s `generateSolutionCells` can
always recompute it on demand from the same seed, for the Give Up button and
the main menu's animated background — see below). A completed puzzle's win
loop is just *some*
Hamiltonian cycle through `adj`, not necessarily the original generated one
(the player can solve it differently if distractor edges allow).

`rng.ts` is a small seeded PRNG (mulberry32) used everywhere generation
needs determinism.

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
  color". A merge/split can also renumber an entirely *unrelated* component
  in `edgeComponents.ts`'s raw, iteration-order ids (see its doc comment) —
  `computeRecoloredEdges` deliberately excludes anything not reachable from
  the toggle, so that case doesn't ripple at all; thanks to persistent
  component colors (above), it doesn't even *recolor* any more, since the
  persistent color assignment is keyed by which cells a component actually
  spans, not by that raw id — matching the fact that nothing about what's
  on screen actually changed.
  - **The winning move gets a bigger version of the same ripple, but at
    constant speed (endgame)**: the instant a toggle completes the puzzle,
    literally every already-marked edge is about to switch to the single
    "solved" green — so instead of `computeRecoloredEdges`'s "did the
    component id actually change" filter (which, on a win, would by
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
    `initial` is always `createInitialPath()` (no longer puzzle-dependent —
    an empty edge set is the same for every puzzle), never itself stored.
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
  actually finished. (There's no "Reset" button any more — see "Menus and
  screen navigation" below; abandoning an attempt now means Exit, and
  either Resume it again later or start a genuinely fresh one via New
  Game/Rematch.)
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
shapeMode, seed, collections? }` — `sizeKey` is one of the fixed
`SIZE_OPTIONS` (tiny/mini/small/medium/large/huge — the `key` field is a
storage identifier, never rename it once puzzles have been played),
`shapeMode` is one of `SHAPE_MODE_OPTIONS` (see "Board shapes and
topologies" above — `klein`/`projective` are disabled from selection but
still valid `PuzzleId` values for old data), `seed` is an arbitrary 32-bit
integer that, together with the rest of the id, fully determines the
puzzle, and `collections` is the optional `EdgeCollectionParams` (see "Edge
collections" above). `puzzleSeed()` hashes `puzzleIdKey(id)` (FNV-1a) into
the actual mulberry32 seed the generator runs on — deliberately *not*
`id.seed` directly, so two puzzles that happen to share a raw `seed` but
differ in size/shape/collections can't accidentally share so much as a PRNG
stream prefix. `PUZZLE_DENSITY` (0.28, formerly `DAILY_PUZZLE_DENSITY`) is
fixed — density is not a player-facing setting. `generatePuzzle(id)` builds
the `Puzzle`; `generateSolutionCells`/`generateSolutionEdges(id)` recompute
the hidden cycle on demand (Give Up, the main menu background — see their
own sections).

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
API (db name `loopit`, version 1, three stores — no external library).
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
`'mainMenu' | 'freePlay' | 'newGame' | 'resume' | 'replays' | 'game'` —
names them; `showScreen(next)` is the *only* place that toggles `.hidden`
on their root elements (`index.html` gives each one its own top-level
`<div class="screen">` inside `#app`) and runs each screen's enter/leave
side effects. Exactly one screen is ever visible at a time.

- **Main menu** (`#mainMenuScreen`): the animated postgame-loop background
  (see "Main menu background" below) behind two buttons — **Free Play** and
  **Blitz**. Blitz has no mode behind it yet (`blitzEntryBtn` just shows a
  toast, "Blitz mode is coming soon!" — a deliberate placeholder, not a
  disabled/dead button, so it still reads as "a real button that does
  something," just not implemented yet); a future change will give it its
  own screen the same way Free Play has one.
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

`showScreen` also owns: starting/stopping the main menu's animated
background (only running while it's actually visible — see below);
force-stopping the live game's `requestAnimationFrame` animation loop the
instant `'game'` stops being the visible screen (`stopLiveAnimationLoop` —
necessary because the win-comet runs *forever* once a puzzle is completed,
so `render()`'s own "reschedule while anything's active" check would never
naturally lapse on a screen the player has since navigated away from); and
refreshing the Resume/Replays lists from IndexedDB every time either is
shown, so a delete (or a game just finished elsewhere) is always reflected
without a stale cached list.

### In-game controls

`#playControls` (hidden outright while reviewing — see below) always shows
**Exit**; the rest of it swaps between two button groups depending on
whether the current live attempt is decided (`refreshControlBar`, called
from every place that can change `pathState.won`/`gaveUp`):

- **Not yet decided** (`#activeControls`): **Undo**, **Redo**, **Give Up** —
  same as before, just without the old Reset/History/Next-Puzzle buttons
  and the size/shape `<select>`s, all of which moved to the menus above (or
  were removed outright — see "Undo/redo and replay" above for why there's
  no Reset any more).
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
`enterReview` hides `#playControls` and shows `#reviewBar` in its place
(the reverse on `exitReview`) regardless of `origin`, since the control bar
Undo/Redo/Give Up/Rematch/Replay buttons are never meaningful while
reviewing — a review is always read-only (`inputPathState()` reports
`won: true` unconditionally while `mode === 'reviewing'`, which is what
makes the input layer refuse edits and only allow pan/zoom for free,
without any extra guarding in `input.ts`/`keyboard.ts`).

### Main menu background

`src/menuBackground.ts`'s `startMenuBackground(canvas)` drives
`#mainMenuScreen`'s `#menuCanvas`: a fixed, arbitrary `PuzzleId` — always
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
instant the main menu stops being the visible screen, so its own
`requestAnimationFrame` chain — like the live game's win-comet, this one
also runs forever by design — doesn't keep drawing to a hidden canvas after
the player has navigated away.

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

Vitest tests across 18 files, all in `*.test.ts` files next to their
modules. Pure game logic (`src/game/*`), viewport math, and persistence are
unit tested — including the pure pieces of the animation system
(`loopOrder.ts`'s cycle-walk, `edgeRipple.ts`'s reachable-recolor BFS,
`componentColors.ts`'s persistent color assignment), even though the
animations themselves are visual-only. `render.ts`, `input.ts`,
`keyboard.ts`, and `menuBackground.ts` are not — they're thin DOM/canvas
glue verified by hand instead. When changing pointer, keyboard, or
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
