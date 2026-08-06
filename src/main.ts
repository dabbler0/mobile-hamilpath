import { createComponentColorState, resetComponentColorState, snapshotEdgeColors, updateComponentColors, type ComponentColorState } from './game/componentColors';
import { computeFarthestCell, computeReachableEdges, computeRecoloredEdges } from './game/edgeRipple';
import { boardPixelSize, faceToScreen, type Layout } from './game/geometry';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordMove, redo as redoHistory, undo as undoHistory, type HistoryState } from './game/history';
import { orderLoopCells } from './game/loopOrder';
import { createInitialPath, type EdgeKey, type PathOp, type PathState } from './game/pathEdit';
import { NO_EDGE_COLLECTIONS, totalCells, type Puzzle } from './game/puzzle';
import { generatePuzzle, generateSolutionEdges, randomSeed, SELECTABLE_SHAPE_MODE_OPTIONS, SIZE_OPTIONS, shapeModeOption, sizeOption, type PuzzleId, type ShapeMode } from './game/puzzleGen';
import { computeRegions, type Face, type RegionMap } from './game/regions';
import { attachPointerHandling, type GameInputHost } from './input';
import { attachKeyboardHandling, type KeyboardInputHost } from './keyboard';
import { startMenuBackground } from './menuBackground';
import { clearInProgress, deleteCompleted, getCompleted, listCompleted, listInProgress, puzzleIdOf, recordCompletion, saveInProgress, type CompletedRecord, type InProgressRecord } from './persistence/gameStore';
import { draw, GROW_MS, midgameRippleDelayMs, PULSE_MS, RIPPLE_STAGGER_MS, segmentColor, SHRINK_MS, type AnimationState } from './render';
import './style.css';
import { computeFitView, computeZoomAt, panToKeepVisible, type Viewport, type ViewportBounds } from './view/viewport';

const LAYOUT: Layout = { cellSize: 34, pad: 24 };
const VIEW_BOUNDS: ViewportBounds = { minScale: 0.12, maxScale: 3 };
/** How long each replay frame stays on screen at the default (1×) replay speed — see `replaySpeedSelect`/`replaySpeed`. */
const REPLAY_FRAME_MS = 50;
/** How long a transient status message (e.g. "undo history unavailable") stays visible. */
const TOAST_MS = 3200;
/**
 * How close (in on-screen pixels) the keyboard cursor is allowed to get to
 * the edge of `wrapEl` before the view auto-scrolls to pull it back — see
 * `setKeyboardCursor`. Expressed in screen pixels (not board cells), so it
 * stays a sensible-looking gap regardless of zoom level.
 */
const KEYBOARD_CURSOR_SCROLL_MARGIN = 56;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

// ---- Screens ----
// The app is a small stack of full-screen "pages" — see CLAUDE.md's "Menus
// and screen navigation" section. Exactly one is ever visible at a time;
// `showScreen` is the only place that toggles `.hidden` on their roots and
// runs each screen's enter/leave side effects (starting/stopping the main
// menu's animated background, refreshing the Resume/Replays lists, halting
// the live game's animation loop when it's no longer on screen).
type Screen = 'mainMenu' | 'freePlay' | 'newGame' | 'resume' | 'replays' | 'game';
let screen: Screen = 'mainMenu';

const mainMenuScreenEl = byId<HTMLDivElement>('mainMenuScreen');
const menuCanvas = byId<HTMLCanvasElement>('menuCanvas');
const freePlayEntryBtn = byId<HTMLButtonElement>('freePlayEntryBtn');
const blitzEntryBtn = byId<HTMLButtonElement>('blitzEntryBtn');

const freePlayMenuScreenEl = byId<HTMLDivElement>('freePlayMenuScreen');
const freePlayBackBtn = byId<HTMLButtonElement>('freePlayBackBtn');
const newGameEntryBtn = byId<HTMLButtonElement>('newGameEntryBtn');
const resumeEntryBtn = byId<HTMLButtonElement>('resumeEntryBtn');
const replaysEntryBtn = byId<HTMLButtonElement>('replaysEntryBtn');

const newGameMenuScreenEl = byId<HTMLDivElement>('newGameMenuScreen');
const newGameBackBtn = byId<HTMLButtonElement>('newGameBackBtn');
const newGameSizeSelect = byId<HTMLSelectElement>('newGameSizeSelect');
const newGameShapeSelect = byId<HTMLSelectElement>('newGameShapeSelect');
const newGameStartBtn = byId<HTMLButtonElement>('newGameStartBtn');

const resumeMenuScreenEl = byId<HTMLDivElement>('resumeMenuScreen');
const resumeBackBtn = byId<HTMLButtonElement>('resumeBackBtn');
const resumeListEl = byId<HTMLDivElement>('resumeListEl');

const replaysMenuScreenEl = byId<HTMLDivElement>('replaysMenuScreen');
const replaysBackBtn = byId<HTMLButtonElement>('replaysBackBtn');
const replaysListEl = byId<HTMLDivElement>('replaysListEl');

const gameScreenEl = byId<HTMLDivElement>('gameScreen');
const wrapEl = byId<HTMLDivElement>('boardWrap');
const canvas = byId<HTMLCanvasElement>('canvas');
const maybeCtx = canvas.getContext('2d');
if (!maybeCtx) throw new Error('2D canvas context unavailable');
const ctx: CanvasRenderingContext2D = maybeCtx;
const progressEl = byId<HTMLDivElement>('progress');
const puzzleLabelEl = byId<HTMLDivElement>('puzzleLabel');
const winBannerEl = byId<HTMLDivElement>('winBanner');
const playControlsEl = byId<HTMLDivElement>('playControls');
const exitBtn = byId<HTMLButtonElement>('exitBtn');
const undoBtn = byId<HTMLButtonElement>('undoBtn');
const redoBtn = byId<HTMLButtonElement>('redoBtn');
const giveUpBtn = byId<HTMLButtonElement>('giveUpBtn');
const activeControlsEl = byId<HTMLDivElement>('activeControls');
const completeControlsEl = byId<HTMLDivElement>('completeControls');
const rematchBtn = byId<HTMLButtonElement>('rematchBtn');
const viewReplayBtn = byId<HTMLButtonElement>('viewReplayBtn');
const reviewBarEl = byId<HTMLDivElement>('reviewBar');
const reviewLabelEl = byId<HTMLSpanElement>('reviewLabel');
const reviewIdleControlsEl = byId<HTMLDivElement>('reviewIdleControls');
const reviewPlaybackControlsEl = byId<HTMLDivElement>('reviewPlaybackControls');
const replayBtn = byId<HTMLButtonElement>('replayBtn');
const replayPlayPauseBtn = byId<HTMLButtonElement>('replayPlayPauseBtn');
const replaySpeedSelect = byId<HTMLSelectElement>('replaySpeedSelect');
const replayScrubberEl = byId<HTMLInputElement>('replayScrubber');
const replayCounterEl = byId<HTMLSpanElement>('replayCounter');
const replayCloseBtn = byId<HTMLButtonElement>('replayCloseBtn');
const toastEl = byId<HTMLDivElement>('toast');

type Mode = 'playing' | 'reviewing';
let mode: Mode = 'playing';

let currentPuzzleId: PuzzleId;
let puzzle: Puzzle;
let regionMap: RegionMap;
let pathState: PathState;
/**
 * True once the player has hit Give Up on the current live puzzle attempt
 * and its `pathState.edges` holds the revealed intended solution rather
 * than anything the player actually marked. Deliberately *not* folded into
 * `pathState.won`: giving up is not a win (no `recordCompletion`, nothing
 * persisted — see `revealSolution`), but input still needs blocking exactly
 * like a real win does, which is why `host.getPathState()` below reports
 * `won: true` whenever this is set.
 */
let gaveUp = false;
/** Undo/redo stacks + replay move log for the live (playing-mode) game. Reset on every fresh/resumed/rematched puzzle. */
let history: HistoryState = createHistory();
let reviewPuzzle: Puzzle | null = null;
let reviewRegionMap: RegionMap | null = null;
let reviewEdges: PathState['edges'] = new Set();
/** The reviewed game's own won-ness, distinct from the hardcoded `true` used for the static "view a finished puzzle" case — during replay playback, intermediate frames aren't won yet. */
let reviewWon = true;
/** The completed-game record currently open in the review overlay, so Replay can read its move log and Done/close-replay can restore the final solved view. */
let currentReviewItem: CompletedRecord | null = null;
/**
 * Where "Done" (`exitReview`) should return to: `'game'` when review was
 * opened via the just-completed live game's own Replay button (in which
 * case Done resumes showing that live, solved game), or `'menu'` when it
 * was opened from the Replays list (in which case Done goes back to that
 * list instead of surfacing whatever the live game happens to be).
 */
let reviewOrigin: 'game' | 'menu' = 'game';
let view: Viewport = { scale: 1, tx: 0, ty: 0 };
/** Tracks the latest in-flight IndexedDB write so a screen change can wait for a completion to land before reading persisted state back. */
let pendingPersist: Promise<void> = Promise.resolve();
/** Id of whichever region is currently focused (press-candidate under a pointer, or the keyboard cursor's region), for highlighting. Reset on any mode/puzzle change. */
let focusedRegionId: number | null = null;
let keyboardCursor: Face | null = null;

let replayFrames: PathState[] = [];
let replayIndex = 0;
let replayTimerId: number | null = null;
/** Playback speed multiplier — `REPLAY_FRAME_MS / replaySpeed` is the actual per-frame interval. Read from/written to `replaySpeedSelect`, and persisted the same way size/shape are. */
let replaySpeed = 1;
let toastTimerId: number | null = null;

/** Teardown for the main menu's animated background loop (`menuBackground.ts`), running only while `screen === 'mainMenu'` — see `showScreen`. */
let stopMenuBackground: (() => void) | null = null;

/**
 * ## Animations
 *
 * All "juice" is purely a rendering overlay on top of the already-committed
 * game state — nothing here ever gates a real move, undo, or win check.
 * `render()` is the single place that reads/prunes this state and feeds it
 * to `render.ts`'s `draw()`; every entry is keyed by `performance.now()`
 * timestamps rather than a frame counter, so pausing/resuming the tab (or a
 * slow frame) can't desync an animation from where it should be.
 *
 * - `growingEdges`/`shrinkingEdges`/`pulsingEdges` are populated by
 *   `scheduleToggleAnimation`, called only from `setPathState` — i.e. only a
 *   live tap/keyboard toggle animates. Undo, redo, Give Up, and
 *   entering/leaving review all jump straight to a new state instead
 *   (`clearEdgeAnimations`), which is simplest and keeps this file from
 *   having to reconcile an in-flight animation with a state it no longer
 *   describes.
 * - `winLoopCells`/`winLoopEdgesRef` track the completed puzzle's cell
 *   cycle, and `pendingCometStart`/`cometActive`/`cometStartIndex`/
 *   `cometStartTime` the win-comet built on top of it; see `render()`'s doc
 *   comment for how they're kept in sync with whatever's actually on screen.
 * - `animFrameId` is the single `requestAnimationFrame` handle driving
 *   continued redraws while anything above is active; `render()` reschedules
 *   itself as long as `edgeAnimsActive() || winLoopCells !== null`, and lets
 *   the loop lapse the moment neither is true. Because the win-comet runs
 *   *forever* once a puzzle is completed, leaving the game screen
 *   (`exitGame`) explicitly cancels this loop rather than waiting for it to
 *   lapse on its own — see `stopLiveAnimationLoop`.
 * - `liveComponentColors`/`reviewComponentColors` (`game/componentColors.ts`)
 *   are *not* cleared by `clearEdgeAnimations` — they track persistent
 *   per-component colors across ordinary edits (undo/redo included), which
 *   is the whole point (see that module's doc comment). `render()` updates
 *   whichever one is active every frame (cheap and idempotent when edges
 *   haven't changed, same as `computeEdgeComponents` always was); only a
 *   genuine switch to a *different* board (`beginPuzzle`, `enterReview`)
 *   explicitly resets one, so an unrelated old component's color can't
 *   spuriously "persist" onto a new puzzle just because cell coordinates
 *   happen to coincide.
 */
const growingEdges = new Map<EdgeKey, number>();
const shrinkingEdges = new Map<EdgeKey, { start: number; color: string }>();
const pulsingEdges = new Map<EdgeKey, { start: number; delay: number; fromColor: string }>();

const liveComponentColors: ComponentColorState = createComponentColorState();
const reviewComponentColors: ComponentColorState = createComponentColorState();

let winLoopCells: ReadonlyArray<readonly [number, number]> | null = null;
/** Reference (not deep-equality) to whichever edge set `winLoopCells` was computed from, so a *different* already-won puzzle (e.g. opening another completed puzzle in review) recomputes instead of keeping a stale cycle — see `render()`. */
let winLoopEdgesRef: ReadonlySet<EdgeKey> | null = null;

/**
 * Set by `scheduleToggleAnimation` the instant a toggle wins the puzzle:
 * where the winning ripple will finally finish (`computeFarthestCell`'s
 * result — the point its outward wave reaches last) and exactly when
 * (mirroring that edge's own pulse-completion time). `render()` holds the
 * win-comet off (`cometActive` stays `false`) until `now` reaches `at`, so
 * the comet only ever starts *after* the whole board has finished turning
 * green, right where that ripple ends — see `render()`'s doc comment.
 * `edgesRef` guards against a stale pending start ever being applied to a
 * *different* state that happens to become completed later (shouldn't
 * really be reachable, but cheap to guard).
 */
let pendingCometStart: { cell: readonly [number, number]; edgesRef: ReadonlySet<EdgeKey>; at: number } | null = null;
let cometActive = false;
let cometStartIndex = 0;
let cometStartTime = 0;

let animFrameId: number | null = null;

function edgeAnimsActive(): boolean {
  return growingEdges.size > 0 || shrinkingEdges.size > 0 || pulsingEdges.size > 0;
}

function pruneFinishedEdgeAnims(now: number): void {
  for (const [ek, start] of growingEdges) if (now - start >= GROW_MS) growingEdges.delete(ek);
  for (const [ek, a] of shrinkingEdges) if (now - a.start >= SHRINK_MS) shrinkingEdges.delete(ek);
  for (const [ek, a] of pulsingEdges) if (now - a.start - a.delay >= PULSE_MS) pulsingEdges.delete(ek);
}

/** Called by every "jump straight to a new state" mutation (undo/redo/Give Up/review navigation) so a leftover in-flight animation never gets reinterpreted against a state it no longer describes. */
function clearEdgeAnimations(): void {
  growingEdges.clear();
  shrinkingEdges.clear();
  pulsingEdges.clear();
  pendingCometStart = null;
}

/**
 * Cancels the live game's `requestAnimationFrame` chain outright, rather
 * than waiting for `render()`'s own "reschedule while anything's active"
 * check to lapse naturally — necessary because the win-comet (once a puzzle
 * is completed) runs forever, so that check alone would never stop firing
 * on a screen the player has since navigated away from (`exitGame`). Safe
 * to call even when nothing is running. The win-loop/comet cache heals
 * itself the next time `render()` actually runs against a fresh state (see
 * its own doc comment), so there's nothing else to reset here.
 */
function stopLiveAnimationLoop(): void {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

/**
 * Schedules the visual grow/shrink/recolor-ripple animation for one edge
 * transition — a live toggle (`setPathState`) or a single replay-frame step
 * (`showReplayFrame`) alike. `toggledEdges` is exactly which edges flipped
 * presence (a live toggle already knows this from its `PathOp`s; a replay
 * step derives it as the symmetric difference between consecutive frames'
 * edge sets, which works uniformly whether that frame came from a real move
 * or an undo/redo jump). An edge newly present starts a grow, one newly
 * absent freezes its current color and starts a shrink (see `render.ts`'s
 * `ShrinkingEdges`).
 *
 * For the recolor ripple: an ordinary toggle uses `computeRecoloredEdges`,
 * which only flags an edge whose component id actually changed (a merge or
 * split). The winning toggle instead uses `computeReachableEdges` — since a
 * win means every remaining edge is now one single component about to
 * switch to the solved color, filtering by "did the id change" would (by
 * incidental id-numbering luck) leave a chunk of the board jumping straight
 * to green with no animation — so every reachable edge ripples instead, so a
 * win visibly reads as the same animation, not a different one. The winning
 * ripple keeps `RIPPLE_STAGGER_MS`'s ordinary constant per-hop pace; an
 * ordinary (non-winning) ripple instead speeds up geometrically via
 * `midgameRippleDelayMs` — see its doc comment for why the two use different
 * timing. On a win, this also arranges for the win-comet to pick up exactly
 * where that ripple leaves off — see `pendingCometStart`'s doc comment.
 *
 * `colorState` is whichever `ComponentColorState` actually reflects
 * `prevEdges` right now (`liveComponentColors` for a live toggle,
 * `reviewComponentColors` for a replay step) — see `main.ts`'s "Animations"
 * doc comment for why that's always true without this function having to
 * recompute anything itself.
 */
function scheduleToggleAnimation(colorState: ComponentColorState, prevEdges: ReadonlySet<EdgeKey>, nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>, justWon: boolean): void {
  if (toggledEdges.size === 0) return;

  const now = performance.now();
  const prevColors = snapshotEdgeColors(colorState, prevEdges);

  for (const ek of toggledEdges) {
    growingEdges.delete(ek);
    shrinkingEdges.delete(ek);
    pulsingEdges.delete(ek);
    if (nextEdges.has(ek) && !prevEdges.has(ek)) {
      growingEdges.set(ek, now);
    } else if (prevEdges.has(ek) && !nextEdges.has(ek)) {
      shrinkingEdges.set(ek, { start: now, color: segmentColor(prevColors.get(ek)!) });
    }
  }

  const rippleEdges = justWon ? computeReachableEdges(prevEdges, nextEdges, toggledEdges) : computeRecoloredEdges(prevEdges, nextEdges, toggledEdges);
  for (const { edge, distance } of rippleEdges) {
    if (growingEdges.has(edge) || shrinkingEdges.has(edge)) continue;
    const delay = justWon ? distance * RIPPLE_STAGGER_MS : midgameRippleDelayMs(distance);
    pulsingEdges.set(edge, { start: now, delay, fromColor: segmentColor(prevColors.get(edge)!) });
  }

  if (justWon) {
    const farthest = computeFarthestCell(nextEdges, toggledEdges);
    pendingCometStart = farthest ? { cell: farthest.cell, edgesRef: nextEdges, at: now + farthest.distance * RIPPLE_STAGGER_MS + PULSE_MS } : null;
  }
}

/** The edges present in exactly one of `a`/`b` — what actually changed between two edge sets, regardless of whether that change came from a `PathOp` or an arbitrary jump (undo/redo, a replay frame). */
function symmetricDifference(a: ReadonlySet<EdgeKey>, b: ReadonlySet<EdgeKey>): Set<EdgeKey> {
  const result = new Set<EdgeKey>();
  for (const ek of a) if (!b.has(ek)) result.add(ek);
  for (const ek of b) if (!a.has(ek)) result.add(ek);
  return result;
}

function activePuzzle(): Puzzle {
  return mode === 'reviewing' && reviewPuzzle ? reviewPuzzle : puzzle;
}

function activeRegionMap(): RegionMap {
  return mode === 'reviewing' && reviewRegionMap ? reviewRegionMap : regionMap;
}

/**
 * Draws the current frame and, if any edge/win-loop animation is still in
 * flight, reschedules itself via `requestAnimationFrame` to keep going —
 * every other call site just calls `render()` once, exactly as before
 * animations existed; this function is the only place that decides whether
 * a *follow-up* frame is needed. `animFrameId` guards against ever having
 * more than one such chain running at once (harmless either way, since
 * every frame just redraws the same live state, but wasteful). Only ever
 * called while `screen === 'game'` — see each call site.
 *
 * Also owns the win-loop cycle cache and the win-comet built on it:
 * `completed` is `reviewWon` while reviewing (deliberately excluding
 * `gaveUp` — a given-up puzzle was *not* actually won, see its doc
 * comment) or `pathState.won` while playing. `winLoopCells` is only
 * recomputed when `completed` newly holds *or* the edge set it was
 * computed from has changed by reference — covering a fresh win, opening a
 * different already-completed puzzle in review, and replay reaching (or
 * leaving) its final frame, all without recomputing on every single one of
 * the animation's own re-renders.
 *
 * Whenever that transition happens, the comet either starts right away
 * (`cometStartIndex = 0`) — for anything that arrives at a completed state
 * with no ripple to wait for, e.g. opening an already-completed puzzle in
 * review — or, if `scheduleToggleAnimation` just recorded a
 * `pendingCometStart` for this exact edge set (a live or replayed winning
 * toggle), waits until `pendingCometStart.at` before starting there
 * instead, so the comet always picks up right where the winning ripple
 * left off rather than racing ahead of it.
 */
function render(): void {
  const now = performance.now();
  pruneFinishedEdgeAnims(now);

  const reviewing = mode === 'reviewing' && reviewPuzzle !== null;
  const state = mode === 'reviewing' && reviewPuzzle
    ? { puzzle: reviewPuzzle, edges: reviewEdges, won: reviewWon, focusedRegion: null, keyboardCursor: null }
    : {
        puzzle,
        edges: pathState.edges,
        // Drawn with the same single "solved" color as an actual win once given
        // up — `pathState.won` itself stays false (it wasn't a real win, see
        // `gaveUp`'s doc comment), this only affects how the revealed solution
        // looks on screen.
        won: pathState.won || gaveUp,
        focusedRegion: focusedRegionId !== null ? regionMap.regions[focusedRegionId] : null,
        keyboardCursor,
      };

  // A win has nothing to color (one component, the flat "solved" color) --
  // skip the update entirely rather than computing colors nothing will use.
  const componentColors = state.won ? null : updateComponentColors(reviewing ? reviewComponentColors : liveComponentColors, state.edges);

  const completed = reviewing ? reviewWon : pathState.won;
  if (completed) {
    if (winLoopEdgesRef !== state.edges) {
      winLoopCells = orderLoopCells(state.edges);
      winLoopEdgesRef = state.edges;
      if (pendingCometStart && pendingCometStart.edgesRef === state.edges) {
        cometActive = false; // wait for the winning ripple to finish -- see below
      } else {
        cometActive = true;
        cometStartIndex = 0;
        cometStartTime = now;
        pendingCometStart = null;
      }
    }
    if (!cometActive && pendingCometStart && pendingCometStart.edgesRef === state.edges && now >= pendingCometStart.at) {
      const idx = winLoopCells?.findIndex(([x, y]) => x === pendingCometStart!.cell[0] && y === pendingCometStart!.cell[1]) ?? -1;
      cometStartIndex = idx >= 0 ? idx : 0;
      cometStartTime = pendingCometStart.at;
      cometActive = true;
      pendingCometStart = null;
    }
  } else if (winLoopEdgesRef !== null) {
    winLoopCells = null;
    winLoopEdgesRef = null;
    cometActive = false;
    pendingCometStart = null;
  }

  const anim: AnimationState = {
    now,
    growing: growingEdges.size > 0 ? growingEdges : undefined,
    shrinking: shrinkingEdges.size > 0 ? shrinkingEdges : undefined,
    pulsing: pulsingEdges.size > 0 ? pulsingEdges : undefined,
    winComet: winLoopCells && cometActive ? { cells: winLoopCells, startIndex: cometStartIndex, startTime: cometStartTime } : undefined,
  };

  draw(ctx, canvas.width, canvas.height, { ...state, anim, componentColors }, LAYOUT, view);

  if (animFrameId === null && (edgeAnimsActive() || winLoopCells !== null)) {
    animFrameId = requestAnimationFrame(() => {
      animFrameId = null;
      render();
    });
  }
}

function setFocusedRegion(id: number | null): void {
  focusedRegionId = id;
  render();
}

/**
 * Updates the keyboard cursor and, if it moved, auto-scrolls the view to
 * keep it on screen — the same idea as a text editor scrolling to follow
 * its caret. `render()` first so the moved cursor is actually drawn onto the
 * canvas bitmap (needed even when no pan happens, and needed *before*
 * `setView` for a wraparound board, whose `applyTransform` redraws from the
 * current state at the new view); `setView` only runs when a pan is
 * actually needed (`panToKeepVisible` returns the same `view` reference
 * otherwise), so ordinary cursor movement within a screenful of board causes
 * no extra work.
 */
function setKeyboardCursor(cursor: Face | null): void {
  keyboardCursor = cursor;
  render();
  if (cursor) {
    const [px, py] = faceToScreen(cursor, LAYOUT);
    const next = panToKeepVisible(view, px, py, wrapEl.clientWidth, wrapEl.clientHeight, KEYBOARD_CURSOR_SCROLL_MARGIN);
    if (next !== view) setView(next);
  }
}

/** An ordinary board's pan/zoom is a cheap CSS transform on the whole canvas element. A wraparound board instead bakes pan/zoom into the canvas drawing itself (see `render.ts`'s `drawWrapped`), since the board tiles genuinely infinitely — there's no fixed-size bitmap a CSS transform could pan across — so it keeps the canvas untransformed and re-renders on every view change instead. */
function applyTransform(): void {
  if (activePuzzle().topology) {
    canvas.style.transform = '';
    render();
  } else {
    canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  }
}

function updateProgress(): void {
  progressEl.textContent = `${pathState.edges.size} / ${totalCells(puzzle)}`;
}

function updatePuzzleLabel(): void {
  const opt = sizeOption(currentPuzzleId.sizeKey);
  const shapeOpt = shapeModeOption(currentPuzzleId.shapeMode);
  const shapeSuffix = currentPuzzleId.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  const collectionCount = puzzle.edgeCollections?.length ?? 0;
  const collectionSuffix = collectionCount > 0 ? ` · ${collectionCount} link${collectionCount > 1 ? 's' : ''}` : '';
  puzzleLabelEl.textContent = `${opt.label}${shapeSuffix}${collectionSuffix}`;
}

/** Give Up only makes sense on a live, not-yet-decided game: not once the player has actually won, and not a second time once the solution is already showing. */
function giveUpAllowed(): boolean {
  return !pathState.won && !gaveUp;
}

/** Undo/Redo only ever act on the live, not-yet-won game — once a puzzle is won, editing (and so undoing) is already blocked everywhere else (input.ts/keyboard.ts refuse edits when `won`), so there's no "undo the winning move" case to reconcile with `recordCompletion` having already fired. Giving up blocks editing the same way a win does (see `gaveUp`'s doc comment), so it's excluded here too — there's nothing to undo back into a revealed solution. */
function undoRedoAllowed(): boolean {
  return !pathState.won && !gaveUp;
}

/**
 * A puzzle is "complete" — Undo/Redo/Give Up give way to Rematch/Replay in
 * the control bar — the instant it's either genuinely won or given up on;
 * see CLAUDE.md's "In-game controls" section for the exact button set in
 * each state. `viewReplayBtn` is further restricted to a real win: giving
 * up was never recorded (`revealSolution`'s doc comment), so there's no
 * move log to replay.
 */
function refreshControlBar(): void {
  const complete = pathState.won || gaveUp;
  activeControlsEl.classList.toggle('hidden', complete);
  completeControlsEl.classList.toggle('hidden', !complete);
  undoBtn.disabled = !undoRedoAllowed() || !canUndo(history);
  redoBtn.disabled = !undoRedoAllowed() || !canRedo(history);
  giveUpBtn.disabled = !giveUpAllowed();
  viewReplayBtn.classList.toggle('hidden', !pathState.won);
}

function persistLiveState(): void {
  const edges = [...pathState.edges];
  if (pathState.won) {
    pendingPersist = recordCompletion(currentPuzzleId, edges, history.moveLog).catch((err: unknown) => console.error('failed to record completion', err));
  } else {
    pendingPersist = saveInProgress(currentPuzzleId, edges, history).catch((err: unknown) => console.error('failed to save progress', err));
  }
}

/** Called by pointer/keyboard input with every path change plus exactly which ops produced it (see `PathOp`), so this is the single funnel point that records undo/redo + replay history — nothing else touches `history` for in-game edits. */
function setPathState(next: PathState, ops: PathOp[]): void {
  const prev = pathState;
  const justWon = next.won && !prev.won;
  const toggled = new Set<EdgeKey>();
  for (const op of ops) for (const ek of op.edges) toggled.add(ek);
  scheduleToggleAnimation(liveComponentColors, prev.edges, next.edges, toggled, justWon);
  pathState = next;
  history = recordMove(history, prev, ops);
  updateProgress();
  refreshControlBar();
  render();
  if (justWon) winBannerEl.classList.add('show');
  persistLiveState();
}

function performUndo(): void {
  if (!undoRedoAllowed()) return;
  const result = undoHistory(history, pathState);
  if (!result) return;
  clearEdgeAnimations();
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  refreshControlBar();
  render();
  persistLiveState();
}

function performRedo(): void {
  if (!undoRedoAllowed()) return;
  const result = redoHistory(history, pathState);
  if (!result) return;
  clearEdgeAnimations();
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  refreshControlBar();
  render();
  persistLiveState();
}

/**
 * Reveals the puzzle's intended solution (the hidden Hamiltonian cycle it
 * was generated from — `puzzleGen.ts`'s `generateSolutionEdges`) and blocks
 * further editing, without treating it as a win: no `recordCompletion`, and
 * — unlike every other path mutation in this file — nothing written to
 * `persistLiveState`, so a reload resumes whatever was actually in progress
 * before Give Up was pressed, exactly as if it had never happened.
 * `pathState.won` deliberately stays `false` (it wasn't a real win);
 * `gaveUp` is what blocks input instead (see its doc comment).
 *
 * A puzzle with edge collections may not have this exact cycle as a valid
 * win at all (`generateSolutionEdges`'s doc comment) — the button still
 * shows it anyway, since it's the intended answer regardless of whether the
 * player's particular collection constraints happen to also accept it.
 */
function revealSolution(): void {
  if (!giveUpAllowed()) return;
  const confirmed = window.confirm('Give up and reveal the intended solution? This puzzle will no longer count as solved.');
  if (!confirmed) return;

  clearEdgeAnimations();
  pathState = { edges: generateSolutionEdges(currentPuzzleId), won: false };
  gaveUp = true;
  focusedRegionId = null;
  keyboardCursor = null;
  updateProgress();
  refreshControlBar();
  winBannerEl.textContent = 'Here’s the solution';
  winBannerEl.classList.add('gaveUp', 'show');
  render();
}

/** Restores `#winBanner` to its default hidden, "Loop complete!" state — shared by every place that starts a fresh live attempt (a real win's banner is set explicitly by `setPathState`; a given-up one by `revealSolution`). */
function resetWinBanner(): void {
  winBannerEl.classList.remove('show', 'gaveUp');
  winBannerEl.textContent = 'Loop complete!';
}

function showToast(message: string): void {
  if (toastTimerId !== null) window.clearTimeout(toastTimerId);
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimerId = window.setTimeout(() => {
    toastEl.classList.remove('show');
    toastTimerId = null;
  }, TOAST_MS);
}

function setView(next: Viewport): void {
  view = next;
  applyTransform();
}

/**
 * "Fit to view" always means fitting one board-tile's span within the wrap
 * element — for a wraparound board this is exactly the same computation as
 * an ordinary board, since the primary tile sits at the canvas's own local
 * origin (see `render.ts`'s `drawWrapped`); there's no separate halo origin
 * to shift around anymore now that the tiling is computed fresh each draw
 * from the current view instead of pre-rendered.
 */
function fitView(): void {
  const { w, h } = boardPixelSize(activePuzzle(), LAYOUT);
  setView(computeFitView(w, h, wrapEl.clientWidth, wrapEl.clientHeight, VIEW_BOUNDS));
}

/**
 * A wraparound board's canvas is sized to the visible viewport itself
 * (content is drawn fresh each frame relative to the current pan/zoom, see
 * `render.ts`), rather than to a fixed board-derived size — so it has to be
 * kept in sync with the wrap element's size, including on window resize
 * (unlike an ordinary board, whose canvas size never changes after the
 * initial layout).
 */
function layout(): void {
  const puzzle = activePuzzle();
  if (puzzle.topology) {
    canvas.width = wrapEl.clientWidth;
    canvas.height = wrapEl.clientHeight;
  } else {
    const { w, h } = boardPixelSize(puzzle, LAYOUT);
    canvas.width = w;
    canvas.height = h;
  }
  fitView();
  render();
}

const LAST_SIZE_STORAGE_KEY = 'loopit:lastSize';
const LAST_SHAPE_STORAGE_KEY = 'loopit:lastShape';
const LAST_REPLAY_SPEED_KEY = 'loopit:replaySpeed';
/** Must match `replaySpeedSelect`'s `<option>` values in `index.html` exactly. */
const REPLAY_SPEED_OPTIONS = [0.25, 0.5, 1, 2];

/**
 * Puts a fresh (or resumed) puzzle on screen and switches to the `'game'`
 * screen — the one place `main.ts` actually starts playing something,
 * shared by New Game, Resume, and Rematch. `resume`, when given, is an
 * exact prior save (edges + its undo/redo history) to restore instead of
 * starting from an empty board; New Game and Rematch never pass it (a
 * random `seed` is a *fresh* puzzle even if it happens to be the same
 * size/shape as one already in progress — see `puzzleGen.ts`'s
 * `randomSeed`).
 */
function beginPuzzle(id: PuzzleId, resume?: { edges: EdgeKey[]; history?: HistoryState }): void {
  stopLiveAnimationLoop();
  clearEdgeAnimations();
  resetComponentColorState(liveComponentColors);
  localStorage.setItem(LAST_SIZE_STORAGE_KEY, id.sizeKey);
  localStorage.setItem(LAST_SHAPE_STORAGE_KEY, id.shapeMode);

  currentPuzzleId = id;
  puzzle = generatePuzzle(id);
  regionMap = computeRegions(puzzle);
  pathState = resume ? { edges: new Set(resume.edges), won: false } : createInitialPath();

  if (resume?.history) {
    history = resume.history;
  } else {
    // Graceful fallback for a save written before undo/redo existed (or a fresh puzzle,
    // which never had history to begin with): start with empty undo/redo/move-log rather
    // than crashing on the missing field. Only worth telling the player about in the
    // resumed-old-save case — a brand-new puzzle having no history yet is completely normal.
    history = createHistory();
    if (resume) showToast("This saved game predates undo history, so it isn't available for it.");
  }

  gaveUp = false;
  resetWinBanner();
  focusedRegionId = null;
  keyboardCursor = null;
  mode = 'playing';
  updatePuzzleLabel();
  updateProgress();
  refreshControlBar();
  showScreen('game');
  layout();
}

function startNewGame(sizeKey: string, shapeMode: ShapeMode): void {
  beginPuzzle({ sizeKey, shapeMode, seed: randomSeed(), collections: NO_EDGE_COLLECTIONS });
}

/** Immediately starts a fresh puzzle with the exact same size/shape/collections as the one just finished, but a brand-new random seed — only available once the current puzzle is complete (see `refreshControlBar`). */
function rematch(): void {
  if (!(pathState.won || gaveUp)) return;
  beginPuzzle({ sizeKey: currentPuzzleId.sizeKey, shapeMode: currentPuzzleId.shapeMode, seed: randomSeed(), collections: currentPuzzleId.collections });
}

/** Jumps directly from the just-completed live game into replaying it — waits for the winning move's `recordCompletion` write to actually land (see `pendingPersist`) so the move log it reads back is never stale. */
async function viewReplayFromGame(): Promise<void> {
  if (!pathState.won) return;
  await pendingPersist;
  const record = await getCompleted(currentPuzzleId);
  if (!record) return;
  enterReview(record, 'game');
  startReplay();
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function puzzleSummaryLabel(record: { sizeKey: string; shapeMode: ShapeMode }): string {
  const opt = sizeOption(record.sizeKey);
  const shapeOpt = shapeModeOption(record.shapeMode);
  const shapeSuffix = record.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  return `${opt.label}${shapeSuffix}`;
}

/** A generic Resume/Replays row: a clickable main area plus a separate delete button, so tapping the delete icon can never be mistaken for opening the item (`stopPropagation` isn't needed since they're already two distinct elements). */
function renderListItem(title: string, dateText: string, onOpen: () => void, onDelete: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'listItem';

  const main = document.createElement('button');
  main.className = 'listItemMain';
  const info = document.createElement('span');
  const titleEl = document.createElement('span');
  titleEl.className = 'listItemTitle';
  titleEl.textContent = title;
  const dateEl = document.createElement('span');
  dateEl.className = 'listItemDate';
  dateEl.textContent = dateText;
  info.append(titleEl, document.createElement('br'), dateEl);
  const chevron = document.createElement('span');
  chevron.textContent = '›';
  main.append(info, chevron);
  main.addEventListener('click', onOpen);

  const del = document.createElement('button');
  del.className = 'listItemDelete';
  del.textContent = '✕';
  del.title = 'Delete';
  del.setAttribute('aria-label', 'Delete');
  del.addEventListener('click', onDelete);

  row.append(main, del);
  return row;
}

async function refreshResumeList(): Promise<void> {
  const items = await listInProgress();
  resumeListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No saved games in progress.';
    resumeListEl.appendChild(empty);
    return;
  }
  for (const item of items) resumeListEl.appendChild(renderResumeItem(item));
}

function renderResumeItem(record: InProgressRecord): HTMLDivElement {
  return renderListItem(
    puzzleSummaryLabel(record),
    `${record.edges.length} edges marked · ${formatDate(record.updatedAt)}`,
    () => beginPuzzle(puzzleIdOf(record), { edges: record.edges, history: record.history }),
    () => {
      void (async () => {
        if (!window.confirm('Delete this saved game? This cannot be undone.')) return;
        await clearInProgress(puzzleIdOf(record));
        await refreshResumeList();
      })();
    },
  );
}

async function refreshReplaysList(): Promise<void> {
  const items = await listCompleted();
  replaysListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No completed puzzles yet.';
    replaysListEl.appendChild(empty);
    return;
  }
  for (const item of items) replaysListEl.appendChild(renderReplayItem(item));
}

function renderReplayItem(record: CompletedRecord): HTMLDivElement {
  return renderListItem(
    puzzleSummaryLabel(record),
    formatDate(record.completedAt),
    () => enterReview(record, 'menu'),
    () => {
      void (async () => {
        if (!window.confirm('Delete this replay? This cannot be undone.')) return;
        await deleteCompleted(puzzleIdOf(record));
        await refreshReplaysList();
      })();
    },
  );
}

/**
 * Opens a completed puzzle in the read-only review overlay. `origin`
 * decides what "Done" (`exitReview`) returns to afterward — see
 * `reviewOrigin`'s doc comment.
 */
function enterReview(item: CompletedRecord, origin: 'game' | 'menu'): void {
  stopLiveAnimationLoop();
  clearEdgeAnimations();
  resetComponentColorState(reviewComponentColors);
  const id = puzzleIdOf(item);
  reviewPuzzle = generatePuzzle(id);
  reviewRegionMap = computeRegions(reviewPuzzle);
  reviewEdges = new Set(item.edges);
  reviewWon = true;
  currentReviewItem = item;
  reviewOrigin = origin;
  mode = 'reviewing';
  focusedRegionId = null;
  keyboardCursor = null;

  reviewLabelEl.textContent = `${puzzleSummaryLabel(item)} · ${formatDate(item.completedAt)}`;
  const hasReplay = Boolean(item.moveLog && item.moveLog.length > 0);
  replayBtn.disabled = !hasReplay;
  replayBtn.title = hasReplay ? '' : "Replay isn't available — this puzzle was solved before replay support was added.";
  reviewBarEl.classList.remove('hidden');
  playControlsEl.classList.add('hidden');
  showScreen('game');
  resetWinBanner();
  layout();
}

/** Leaves review mode: back to the live completed game (`reviewOrigin === 'game'`) or back to the Replays list it was opened from (`'menu'`) — see `reviewOrigin`'s doc comment. */
function exitReview(): void {
  closeReplay();
  clearEdgeAnimations();
  const returnToMenu = reviewOrigin === 'menu';
  mode = 'playing';
  reviewPuzzle = null;
  reviewRegionMap = null;
  currentReviewItem = null;
  focusedRegionId = null;
  keyboardCursor = null;
  reviewBarEl.classList.add('hidden');
  playControlsEl.classList.remove('hidden');
  if (returnToMenu) {
    showScreen('replays');
  } else {
    layout();
  }
}

function stopReplayTimer(): void {
  if (replayTimerId !== null) {
    window.clearInterval(replayTimerId);
    replayTimerId = null;
  }
  replayPlayPauseBtn.textContent = 'Play';
}

/**
 * Replay only animates the same grow/shrink/ripple juice a live toggle gets
 * at the two slowest speeds — faster than that, a new animation would just
 * get interrupted by the next frame before finishing (`GROW_MS`/`PULSE_MS`
 * are both longer than a frame at 1×/2×), reading as flicker rather than
 * motion, so it's simplest to just skip scheduling any at those speeds.
 */
function replayAnimationsEnabled(): boolean {
  return replaySpeed <= 0.5;
}

/**
 * Shows one replay frame. `animate` is true only for a natural single-step
 * forward advance (`playReplay`'s own tick) — scrubbing or the initial
 * frame jump straight to the target state instead (`clearEdgeAnimations`),
 * since a dragged scrub can span an arbitrary number of frames and there's
 * no one sensible "toggle" to animate for that. When animating, the edges
 * that actually changed are the symmetric difference between this frame and
 * the previous one, which works the same whether that step was a real move
 * or an undo/redo jump (`symmetricDifference`) — `scheduleToggleAnimation`
 * doesn't need to know which.
 */
function showReplayFrame(index: number, animate = false): void {
  const prevFrame = replayFrames[replayIndex];
  replayIndex = Math.max(0, Math.min(replayFrames.length - 1, index));
  const frame = replayFrames[replayIndex];

  if (animate && replayAnimationsEnabled() && prevFrame) {
    scheduleToggleAnimation(reviewComponentColors, prevFrame.edges, frame.edges, symmetricDifference(prevFrame.edges, frame.edges), frame.won && !prevFrame.won);
  } else {
    clearEdgeAnimations();
  }

  reviewEdges = frame.edges;
  reviewWon = frame.won;
  replayScrubberEl.value = String(replayIndex);
  replayCounterEl.textContent = `${replayIndex + 1} / ${replayFrames.length}`;
  render();
}

function playReplay(): void {
  if (replayIndex >= replayFrames.length - 1) showReplayFrame(0);
  stopReplayTimer();
  replayPlayPauseBtn.textContent = 'Pause';
  replayTimerId = window.setInterval(() => {
    if (replayIndex >= replayFrames.length - 1) {
      stopReplayTimer();
      return;
    }
    showReplayFrame(replayIndex + 1, true);
  }, REPLAY_FRAME_MS / replaySpeed);
}

function startReplay(): void {
  if (!reviewPuzzle || !currentReviewItem?.moveLog?.length) return;
  replayFrames = decodeMoveLog(reviewPuzzle, createInitialPath(), currentReviewItem.moveLog);
  reviewIdleControlsEl.classList.add('hidden');
  reviewPlaybackControlsEl.classList.remove('hidden');
  replayScrubberEl.min = '0';
  replayScrubberEl.max = String(Math.max(0, replayFrames.length - 1));
  showReplayFrame(0);
  playReplay();
}

/** Leaves playback (if any) and restores the static, fully-solved view — called on Done and when leaving review entirely. */
function closeReplay(): void {
  stopReplayTimer();
  clearEdgeAnimations();
  reviewPlaybackControlsEl.classList.add('hidden');
  reviewIdleControlsEl.classList.remove('hidden');
  if (currentReviewItem) {
    reviewEdges = new Set(currentReviewItem.edges);
    reviewWon = true;
    render();
  }
}

/** The path state input handling should see: reviewing and giving-up both force `won: true` purely to block further edits (`input.ts`/`keyboard.ts` both gate on `.won`) without pretending either is an actual win — `pathState.won` itself, and `main.ts`'s own win-vs-gave-up bookkeeping, stay untouched. */
function inputPathState(): PathState {
  if (mode === 'reviewing') return { edges: reviewEdges, won: true };
  return gaveUp ? { edges: pathState.edges, won: true } : pathState;
}

const host: GameInputHost = {
  getPuzzle: () => activePuzzle(),
  getRegionMap: () => activeRegionMap(),
  getPathState: inputPathState,
  setPathState,
  getLayout: () => LAYOUT,
  getView: () => view,
  setView,
  setFocusedRegion,
  bounds: VIEW_BOUNDS,
  wrapEl,
};

attachPointerHandling(canvas, host);

const keyboardHost: KeyboardInputHost = {
  getPuzzle: () => activePuzzle(),
  getRegionMap: () => activeRegionMap(),
  getPathState: inputPathState,
  setPathState,
  setFocusedRegion,
  setKeyboardCursor,
  isEnabled: () => screen === 'game' && mode === 'playing',
};

attachKeyboardHandling(window, keyboardHost);

// ---- Screen navigation ----

/**
 * Hides every screen but `next` and runs each screen's enter/leave side
 * effects: the main menu's animated background starts only while it's
 * actually visible (and stops the instant it isn't, so its own
 * `requestAnimationFrame` chain doesn't run forever in the background); the
 * live game's animation loop is likewise force-stopped whenever leaving
 * `'game'` (see `stopLiveAnimationLoop`'s doc comment for why that can't
 * just be left to lapse on its own); Resume/Replays refresh their lists
 * from IndexedDB every time they're shown, so a delete or a just-finished
 * game is always reflected.
 */
function showScreen(next: Screen): void {
  if (screen === 'mainMenu' && next !== 'mainMenu') {
    stopMenuBackground?.();
    stopMenuBackground = null;
  }
  if (screen === 'game' && next !== 'game') {
    stopLiveAnimationLoop();
  }

  screen = next;
  mainMenuScreenEl.classList.toggle('hidden', next !== 'mainMenu');
  freePlayMenuScreenEl.classList.toggle('hidden', next !== 'freePlay');
  newGameMenuScreenEl.classList.toggle('hidden', next !== 'newGame');
  resumeMenuScreenEl.classList.toggle('hidden', next !== 'resume');
  replaysMenuScreenEl.classList.toggle('hidden', next !== 'replays');
  gameScreenEl.classList.toggle('hidden', next !== 'game');

  if (next === 'mainMenu') stopMenuBackground = startMenuBackground(menuCanvas);
  if (next === 'resume') void refreshResumeList();
  if (next === 'replays') void refreshReplaysList();
}

/** Leaves the live game back to the Free Play hub — the "Exit" button. Whatever's in progress is already autosaved on every edit (`persistLiveState`), so there's nothing extra to do here. */
function exitGame(): void {
  showScreen('freePlay');
}

freePlayEntryBtn.addEventListener('click', () => showScreen('freePlay'));
blitzEntryBtn.addEventListener('click', () => showToast('Blitz mode is coming soon!'));
freePlayBackBtn.addEventListener('click', () => showScreen('mainMenu'));
newGameEntryBtn.addEventListener('click', () => showScreen('newGame'));
resumeEntryBtn.addEventListener('click', () => showScreen('resume'));
replaysEntryBtn.addEventListener('click', () => showScreen('replays'));
newGameBackBtn.addEventListener('click', () => showScreen('freePlay'));
resumeBackBtn.addEventListener('click', () => showScreen('freePlay'));
replaysBackBtn.addEventListener('click', () => showScreen('freePlay'));
newGameStartBtn.addEventListener('click', () => {
  startNewGame(newGameSizeSelect.value, newGameShapeSelect.value as ShapeMode);
});

exitBtn.addEventListener('click', exitGame);
undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);
giveUpBtn.addEventListener('click', revealSolution);
rematchBtn.addEventListener('click', rematch);
viewReplayBtn.addEventListener('click', () => {
  void viewReplayFromGame();
});
replayBtn.addEventListener('click', startReplay);
replayCloseBtn.addEventListener('click', closeReplay);
byId('exitReviewBtn').addEventListener('click', exitReview);
replayPlayPauseBtn.addEventListener('click', () => {
  if (replayTimerId !== null) stopReplayTimer();
  else playReplay();
});
replayScrubberEl.addEventListener('input', () => {
  stopReplayTimer();
  showReplayFrame(Number(replayScrubberEl.value));
});
replaySpeedSelect.addEventListener('change', () => {
  replaySpeed = Number(replaySpeedSelect.value) || 1;
  localStorage.setItem(LAST_REPLAY_SPEED_KEY, String(replaySpeed));
  // Restart the running interval so a mid-playback speed change takes effect immediately, rather than waiting for the next tick.
  if (replayTimerId !== null) playReplay();
});

/** Tag names for controls where ctrl+z/y should keep its native text-editing meaning instead of undo/redo-ing the puzzle. Deliberately narrower than `keyboard.ts`'s equivalent list (which also excludes SELECT/BUTTON, since arrow keys and Enter/Space *do* conflict with those) — ctrl+z has no native behavior on a focused button or select, and excluding BUTTON here would mean clicking Undo/Redo (which keeps focus on the button afterward) silently breaks the ctrl+z shortcut until focus moves elsewhere. */
const TEXT_EDITING_TAGS = new Set(['INPUT', 'TEXTAREA']);

window.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey)) return;
  if (screen !== 'game' || mode !== 'playing') return;
  const targetTag = (evt.target as HTMLElement | null)?.tagName;
  if (targetTag && TEXT_EDITING_TAGS.has(targetTag)) return;

  const k = evt.key.toLowerCase();
  if (k === 'z') {
    evt.preventDefault();
    if (evt.shiftKey) performRedo();
    else performUndo();
  } else if (k === 'y') {
    evt.preventDefault();
    performRedo();
  }
});

byId('zoomFitBtn').addEventListener('click', fitView);
byId('zoomInBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale * 1.4, VIEW_BOUNDS));
});
byId('zoomOutBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale / 1.4, VIEW_BOUNDS));
});
window.addEventListener('resize', () => {
  if (screen === 'game' && puzzle) layout();
});

wrapEl.addEventListener(
  'wheel',
  (evt) => {
    evt.preventDefault();
    const rect = wrapEl.getBoundingClientRect();
    const wx = evt.clientX - rect.left;
    const wy = evt.clientY - rect.top;
    const factor = Math.pow(1.0015, -evt.deltaY);
    setView(computeZoomAt(view, wx, wy, view.scale * factor, VIEW_BOUNDS));
  },
  { passive: false },
);

const lastSize = localStorage.getItem(LAST_SIZE_STORAGE_KEY);
if (lastSize && SIZE_OPTIONS.some((opt) => opt.key === lastSize)) {
  newGameSizeSelect.value = lastSize;
}
const lastShape = localStorage.getItem(LAST_SHAPE_STORAGE_KEY);
if (lastShape && SELECTABLE_SHAPE_MODE_OPTIONS.some((opt) => opt.key === lastShape)) {
  newGameShapeSelect.value = lastShape;
}
const lastReplaySpeed = Number(localStorage.getItem(LAST_REPLAY_SPEED_KEY));
if (REPLAY_SPEED_OPTIONS.includes(lastReplaySpeed)) {
  replaySpeed = lastReplaySpeed;
  replaySpeedSelect.value = String(lastReplaySpeed);
}

showScreen('mainMenu');
