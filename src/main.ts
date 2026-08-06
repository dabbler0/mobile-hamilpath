import { generateDailyPuzzle, generateDailySolutionEdges, SELECTABLE_SHAPE_MODE_OPTIONS, SIZE_OPTIONS, shapeModeOption, sizeOption, todayKey, type PuzzleId, type ShapeMode } from './game/dailyPuzzle';
import { computeEdgeComponents } from './game/edgeComponents';
import { computeReachableEdges, computeRecoloredEdges } from './game/edgeRipple';
import { boardPixelSize, faceToScreen, type Layout } from './game/geometry';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordMove, redo as redoHistory, undo as undoHistory, type HistoryState } from './game/history';
import { orderLoopCells } from './game/loopOrder';
import { createInitialPath, type EdgeKey, type PathOp, type PathState } from './game/pathEdit';
import { NO_EDGE_COLLECTIONS, totalCells, type Puzzle } from './game/puzzle';
import { computeRegions, type Face, type RegionMap } from './game/regions';
import { attachPointerHandling, type GameInputHost } from './input';
import { attachKeyboardHandling, type KeyboardInputHost } from './keyboard';
import { getInProgress, getUnlockedIndex, listCompleted, recordCompletion, saveInProgress, type CompletedRecord } from './persistence/gameStore';
import { draw, GROW_MS, PULSE_MS, segmentColor, SHRINK_MS, type AnimationState } from './render';
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

const wrapEl = byId<HTMLDivElement>('boardWrap');
const canvas = byId<HTMLCanvasElement>('canvas');
const maybeCtx = canvas.getContext('2d');
if (!maybeCtx) throw new Error('2D canvas context unavailable');
const ctx: CanvasRenderingContext2D = maybeCtx;
const progressEl = byId<HTMLDivElement>('progress');
const puzzleLabelEl = byId<HTMLDivElement>('puzzleLabel');
const winBannerEl = byId<HTMLDivElement>('winBanner');
const sizeSelect = byId<HTMLSelectElement>('sizeSelect');
const shapeSelect = byId<HTMLSelectElement>('shapeSelect');
const nextBtn = byId<HTMLButtonElement>('nextBtn');
const undoBtn = byId<HTMLButtonElement>('undoBtn');
const redoBtn = byId<HTMLButtonElement>('redoBtn');
const giveUpBtn = byId<HTMLButtonElement>('giveUpBtn');
const playControlsEl = byId<HTMLDivElement>('playControls');
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
const historyOverlayEl = byId<HTMLDivElement>('historyOverlay');
const historyListEl = byId<HTMLDivElement>('historyList');
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
 * `pathState.won`: giving up is not a win (no `recordCompletion`, no
 * `unlockedIndex` advance, nothing persisted — see `revealSolution`), but
 * input still needs blocking exactly like a real win does, which is why
 * `host.getPathState()` below reports `won: true` whenever this is set.
 */
let gaveUp = false;
/** Undo/redo stacks + replay move log for the live (playing-mode) game. Reset on every fresh/resumed puzzle and on Reset. */
let history: HistoryState = createHistory();
let reviewPuzzle: Puzzle | null = null;
let reviewRegionMap: RegionMap | null = null;
let reviewEdges: PathState['edges'] = new Set();
/** The reviewed game's own won-ness, distinct from the hardcoded `true` used for the static "view a finished puzzle" case — during replay playback, intermediate frames aren't won yet. */
let reviewWon = true;
/** The completed-game record currently open in the review overlay, so Replay can read its move log and Done/close-replay can restore the final solved view. */
let currentReviewItem: CompletedRecord | null = null;
let view: Viewport = { scale: 1, tx: 0, ty: 0 };
/** Tracks the latest in-flight IndexedDB write so "Next Puzzle" can wait for a completion to land before re-reading the unlock gate. */
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
 *   live tap/keyboard toggle animates. Undo, redo, reset, Give Up, and
 *   entering/leaving review all jump straight to a new state instead
 *   (`clearEdgeAnimations`), which is simplest and keeps this file from
 *   having to reconcile an in-flight animation with a state it no longer
 *   describes.
 * - `winLoopCells`/`winLoopEdgesRef`/`winLoopStartTime` track the traveling
 *   win-loop dot; see `render()`'s doc comment for how they're kept in sync
 *   with whatever's actually on screen.
 * - `animFrameId` is the single `requestAnimationFrame` handle driving
 *   continued redraws while anything above is active; `render()` reschedules
 *   itself as long as `edgeAnimsActive() || winLoopCells !== null`, and lets
 *   the loop lapse the moment neither is true.
 */
const growingEdges = new Map<EdgeKey, number>();
const shrinkingEdges = new Map<EdgeKey, { start: number; color: string }>();
const pulsingEdges = new Map<EdgeKey, { start: number; delay: number; fromColor: string }>();
/** Stagger between adjacent hops of an ordinary (merge/split) recolor ripple — see `edgeRipple.ts`'s `computeRecoloredEdges`. */
const PULSE_STAGGER_MS = 45;
/**
 * Stagger between adjacent hops of the winning move's "everything turns
 * green" ripple (see `edgeRipple.ts`'s `computeReachableEdges`) — smaller
 * than `PULSE_STAGGER_MS` because this one can span the *entire* loop (up to
 * roughly half its length in hops, from the toggle location to the far
 * side), not just a small local patch, so it needs a faster per-hop pace to
 * still read as one satisfying sweep rather than a multi-second crawl on a
 * huge board.
 */
const WIN_RIPPLE_STAGGER_MS = 12;

let winLoopCells: ReadonlyArray<readonly [number, number]> | null = null;
/** Reference (not deep-equality) to whichever edge set `winLoopCells` was computed from, so a *different* already-won puzzle (e.g. opening another completed puzzle in review) recomputes instead of keeping a stale cycle — see `render()`. */
let winLoopEdgesRef: ReadonlySet<EdgeKey> | null = null;
let winLoopStartTime = 0;

let animFrameId: number | null = null;

function edgeAnimsActive(): boolean {
  return growingEdges.size > 0 || shrinkingEdges.size > 0 || pulsingEdges.size > 0;
}

function pruneFinishedEdgeAnims(now: number): void {
  for (const [ek, start] of growingEdges) if (now - start >= GROW_MS) growingEdges.delete(ek);
  for (const [ek, a] of shrinkingEdges) if (now - a.start >= SHRINK_MS) shrinkingEdges.delete(ek);
  for (const [ek, a] of pulsingEdges) if (now - a.start - a.delay >= PULSE_MS) pulsingEdges.delete(ek);
}

/** Called by every "jump straight to a new state" mutation (undo/redo/reset/Give Up/review navigation) so a leftover in-flight animation never gets reinterpreted against a state it no longer describes. */
function clearEdgeAnimations(): void {
  growingEdges.clear();
  shrinkingEdges.clear();
  pulsingEdges.clear();
}

/**
 * Schedules the visual grow/shrink/recolor-ripple animation for one path
 * edit. Called from `setPathState` with the edge sets on either side of the
 * toggle, exactly which edges it touched (`ops`, see `PathOp`), and whether
 * this toggle is the one that just won the puzzle — an edge newly present
 * starts a grow, one newly absent freezes its current color and starts a
 * shrink (see `render.ts`'s `ShrinkingEdges`).
 *
 * For the recolor ripple: an ordinary toggle uses `computeRecoloredEdges`,
 * which only flags an edge whose component id actually changed (a merge or
 * split). The winning toggle instead uses `computeReachableEdges` — since a
 * win means every remaining edge is now one single component about to
 * switch to the solved color, filtering by "did the id change" would (by
 * incidental id-numbering luck) leave a chunk of the board jumping straight
 * to green with no animation — so every reachable edge ripples, using the
 * tighter `WIN_RIPPLE_STAGGER_MS` pace so a huge board's sweep still reads
 * as one ripple rather than a multi-second crawl. Either way, each pulse is
 * delayed by its graph distance from the toggle so the recolor visibly
 * ripples outward rather than flipping everywhere at once.
 */
function scheduleToggleAnimation(prevEdges: ReadonlySet<EdgeKey>, nextEdges: ReadonlySet<EdgeKey>, ops: PathOp[], justWon: boolean): void {
  const toggled = new Set<EdgeKey>();
  for (const op of ops) for (const ek of op.edges) toggled.add(ek);
  if (toggled.size === 0) return;

  const now = performance.now();
  const prevComponents = computeEdgeComponents(prevEdges);

  for (const ek of toggled) {
    growingEdges.delete(ek);
    shrinkingEdges.delete(ek);
    pulsingEdges.delete(ek);
    if (nextEdges.has(ek) && !prevEdges.has(ek)) {
      growingEdges.set(ek, now);
    } else if (prevEdges.has(ek) && !nextEdges.has(ek)) {
      shrinkingEdges.set(ek, { start: now, color: segmentColor(prevComponents.get(ek)!) });
    }
  }

  const rippleEdges = justWon ? computeReachableEdges(prevEdges, nextEdges, toggled) : computeRecoloredEdges(prevEdges, nextEdges, toggled);
  const staggerMs = justWon ? WIN_RIPPLE_STAGGER_MS : PULSE_STAGGER_MS;
  for (const { edge, distance } of rippleEdges) {
    if (growingEdges.has(edge) || shrinkingEdges.has(edge)) continue;
    pulsingEdges.set(edge, { start: now, delay: distance * staggerMs, fromColor: segmentColor(prevComponents.get(edge)!) });
  }
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
 * every other call site just calls `render()` once, same as before
 * animations existed; this function is the only place that decides whether
 * a *follow-up* frame is needed. `animFrameId` guards against ever having
 * more than one such chain running at once (harmless either way, since
 * every frame just redraws the same live state, but wasteful).
 *
 * Also owns the win-loop dot's cycle cache: `completed` is `reviewWon`
 * while reviewing (deliberately excluding `gaveUp` — a given-up puzzle was
 * *not* actually won, see its doc comment) or `pathState.won` while
 * playing. The cycle is only recomputed when `completed` newly holds *or*
 * the edge set it was computed from has changed by reference — covering a
 * fresh win, opening a different already-completed puzzle in review, and
 * replay reaching (or leaving) its final frame, all without recomputing on
 * every single one of the animation's own re-renders.
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

  const completed = reviewing ? reviewWon : pathState.won;
  if (completed) {
    if (winLoopEdgesRef !== state.edges) {
      winLoopCells = orderLoopCells(state.edges);
      winLoopEdgesRef = state.edges;
      winLoopStartTime = now;
    }
  } else if (winLoopEdgesRef !== null) {
    winLoopCells = null;
    winLoopEdgesRef = null;
  }

  const anim: AnimationState = {
    now,
    growing: growingEdges.size > 0 ? growingEdges : undefined,
    shrinking: shrinkingEdges.size > 0 ? shrinkingEdges : undefined,
    pulsing: pulsingEdges.size > 0 ? pulsingEdges : undefined,
    winLoop: winLoopCells ? { cells: winLoopCells, startTime: winLoopStartTime } : undefined,
  };

  draw(ctx, canvas.width, canvas.height, { ...state, anim }, LAYOUT, view);

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
  puzzleLabelEl.textContent = `${opt.label}${shapeSuffix} #${currentPuzzleId.index + 1}${collectionSuffix}`;
}

function updateNextButton(): void {
  nextBtn.disabled = !pathState.won;
}

/** Give Up only makes sense on a live, not-yet-decided game: not while reviewing, not once the player has actually won, and not a second time once the solution is already showing. */
function updateGiveUpButton(): void {
  giveUpBtn.disabled = mode !== 'playing' || pathState.won || gaveUp;
}

/** Undo/Redo only ever act on the live, not-yet-won game — once a puzzle is won, editing (and so undoing) is already blocked everywhere else (input.ts/keyboard.ts refuse edits when `won`), so there's no "undo the winning move" case to reconcile with `recordCompletion` having already fired. Giving up blocks editing the same way a win does (see `gaveUp`'s doc comment), so it's excluded here too — there's nothing to undo back into a revealed solution. */
function undoRedoAllowed(): boolean {
  return mode === 'playing' && !pathState.won && !gaveUp;
}

function updateUndoRedoButtons(): void {
  undoBtn.disabled = !undoRedoAllowed() || !canUndo(history);
  redoBtn.disabled = !undoRedoAllowed() || !canRedo(history);
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
  scheduleToggleAnimation(prev.edges, next.edges, ops, justWon);
  pathState = next;
  history = recordMove(history, prev, ops);
  updateProgress();
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
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
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
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
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
  render();
  persistLiveState();
}

/**
 * Reveals the puzzle's intended solution (the hidden Hamiltonian cycle it
 * was generated from — `dailyPuzzle.ts`'s `generateDailySolutionEdges`) and
 * blocks further editing, without treating it as a win: no `recordCompletion`,
 * no `unlockedIndex` advance, and — unlike every other path mutation in this
 * file — nothing written to `persistLiveState`, so a reload resumes whatever
 * was actually in progress before Give Up was pressed, exactly as if it had
 * never happened. `pathState.won` deliberately stays `false` (it wasn't a
 * real win); `gaveUp` is what blocks input instead (see its doc comment).
 *
 * A puzzle with edge collections may not have this exact cycle as a valid
 * win at all (`generateDailySolutionEdges`'s doc comment) — the button still
 * shows it, since it's the intended answer regardless of whether the
 * player's particular collection constraints happen to also accept it.
 */
function revealSolution(): void {
  if (mode !== 'playing' || pathState.won || gaveUp) return;
  const confirmed = window.confirm('Give up and reveal the intended solution? This puzzle will no longer count as solved.');
  if (!confirmed) return;

  clearEdgeAnimations();
  pathState = { edges: generateDailySolutionEdges(currentPuzzleId), won: false };
  gaveUp = true;
  focusedRegionId = null;
  keyboardCursor = null;
  updateProgress();
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
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

function resetPath(): void {
  clearEdgeAnimations();
  pathState = createInitialPath();
  // Reset starts a fresh attempt, so its move history starts fresh too — otherwise a
  // later win's replay would confusingly interleave an earlier abandoned attempt.
  history = createHistory();
  gaveUp = false;
  resetWinBanner();
  focusedRegionId = null;
  keyboardCursor = null;
  updateProgress();
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
  pendingPersist = saveInProgress(currentPuzzleId, [...pathState.edges], history).catch((err: unknown) => console.error('failed to save progress', err));
  render();
}

const LAST_SIZE_STORAGE_KEY = 'loopit:lastSize';
const LAST_SHAPE_STORAGE_KEY = 'loopit:lastShape';
const LAST_REPLAY_SPEED_KEY = 'loopit:replaySpeed';
/** Must match `replaySpeedSelect`'s `<option>` values in `index.html` exactly. */
const REPLAY_SPEED_OPTIONS = [0.25, 0.5, 1, 2];

/**
 * Loads whichever puzzle is current for this size+shape today: a resumed
 * in-progress game, or the next unlocked one. Edge collections are
 * generated with `NO_EDGE_COLLECTIONS` (the UI for tuning them was removed —
 * see CLAUDE.md's "Edge collections" section; the generation code itself is
 * still there for `dailyPuzzle`/history to reproduce old completed puzzles
 * that were played with collections enabled).
 */
async function startPuzzle(sizeKey: string, shapeMode: ShapeMode): Promise<void> {
  clearEdgeAnimations();
  localStorage.setItem(LAST_SIZE_STORAGE_KEY, sizeKey);
  localStorage.setItem(LAST_SHAPE_STORAGE_KEY, shapeMode);
  const collections = NO_EDGE_COLLECTIONS;
  const day = todayKey();
  const unlockedIndex = await getUnlockedIndex(day, sizeKey, shapeMode, collections);
  const existing = await getInProgress(day, sizeKey, shapeMode, collections);
  const resuming = existing && existing.index === unlockedIndex;
  const index = resuming ? existing.index : unlockedIndex;

  currentPuzzleId = { day, sizeKey, shapeMode, index, collections };
  puzzle = generateDailyPuzzle(currentPuzzleId);
  regionMap = computeRegions(puzzle);
  pathState = resuming ? { edges: new Set(existing.edges), won: false } : createInitialPath();

  if (resuming && existing.history) {
    history = existing.history;
  } else {
    // Graceful fallback for a save written before undo/redo existed (or a fresh puzzle,
    // which never had history to begin with): start with empty undo/redo/move-log rather
    // than crashing on the missing field. Only worth telling the player about in the
    // resumed-old-save case — a brand-new puzzle having no history yet is completely normal.
    history = createHistory();
    if (resuming) showToast("This saved game predates undo history, so it isn't available for it.");
  }

  gaveUp = false;
  resetWinBanner();
  focusedRegionId = null;
  keyboardCursor = null;
  updatePuzzleLabel();
  updateProgress();
  updateNextButton();
  updateGiveUpButton();
  updateUndoRedoButtons();
  layout();
}

function formatCompletedAt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderHistoryItem(item: CompletedRecord): HTMLButtonElement {
  const opt = sizeOption(item.sizeKey);
  const shapeOpt = shapeModeOption(item.shapeMode);
  const shapeSuffix = item.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  const btn = document.createElement('button');
  btn.className = 'historyItem';

  const info = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'historyItemTitle';
  title.textContent = `${opt.label}${shapeSuffix} #${item.index + 1}`;
  const dateEl = document.createElement('span');
  dateEl.className = 'historyItemDate';
  dateEl.textContent = `${item.day} · ${formatCompletedAt(item.completedAt)}`;
  info.append(title, document.createElement('br'), dateEl);

  const chevron = document.createElement('span');
  chevron.textContent = '›';

  btn.append(info, chevron);
  btn.addEventListener('click', () => {
    void enterReview(item);
  });
  return btn;
}

async function openHistory(): Promise<void> {
  const items = await listCompleted();
  historyListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'historyEmpty';
    empty.textContent = 'No completed puzzles yet.';
    historyListEl.appendChild(empty);
  } else {
    for (const item of items) historyListEl.appendChild(renderHistoryItem(item));
  }
  historyOverlayEl.classList.remove('hidden');
}

function closeHistory(): void {
  historyOverlayEl.classList.add('hidden');
}

async function enterReview(item: CompletedRecord): Promise<void> {
  closeHistory();
  clearEdgeAnimations();
  const id: PuzzleId = { day: item.day, sizeKey: item.sizeKey, shapeMode: item.shapeMode, index: item.index, collections: item.collections };
  reviewPuzzle = generateDailyPuzzle(id);
  reviewRegionMap = computeRegions(reviewPuzzle);
  reviewEdges = new Set(item.edges);
  reviewWon = true;
  currentReviewItem = item;
  mode = 'reviewing';
  focusedRegionId = null;
  keyboardCursor = null;

  const opt = sizeOption(item.sizeKey);
  const shapeOpt = shapeModeOption(item.shapeMode);
  const shapeSuffix = item.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  reviewLabelEl.textContent = `${opt.label}${shapeSuffix} #${item.index + 1} · ${item.day}`;
  const hasReplay = Boolean(item.moveLog && item.moveLog.length > 0);
  replayBtn.disabled = !hasReplay;
  replayBtn.title = hasReplay ? '' : "Replay isn't available — this puzzle was solved before replay support was added.";
  reviewBarEl.classList.remove('hidden');
  playControlsEl.classList.add('hidden');
  resetWinBanner();
  layout();
}

function exitReview(): void {
  closeReplay();
  clearEdgeAnimations();
  mode = 'playing';
  reviewPuzzle = null;
  reviewRegionMap = null;
  currentReviewItem = null;
  focusedRegionId = null;
  keyboardCursor = null;
  reviewBarEl.classList.add('hidden');
  playControlsEl.classList.remove('hidden');
  layout();
}

function stopReplayTimer(): void {
  if (replayTimerId !== null) {
    window.clearInterval(replayTimerId);
    replayTimerId = null;
  }
  replayPlayPauseBtn.textContent = 'Play';
}

function showReplayFrame(index: number): void {
  replayIndex = Math.max(0, Math.min(replayFrames.length - 1, index));
  const frame = replayFrames[replayIndex];
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
    showReplayFrame(replayIndex + 1);
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
  isEnabled: () => mode === 'playing' && historyOverlayEl.classList.contains('hidden'),
};

attachKeyboardHandling(window, keyboardHost);

byId('resetBtn').addEventListener('click', resetPath);
undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);
giveUpBtn.addEventListener('click', revealSolution);
sizeSelect.addEventListener('change', () => {
  void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode);
});
shapeSelect.addEventListener('change', () => {
  void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode);
});
nextBtn.addEventListener('click', () => {
  if (!pathState.won) return;
  void (async () => {
    await pendingPersist;
    await startPuzzle(currentPuzzleId.sizeKey, currentPuzzleId.shapeMode);
  })();
});
byId('historyBtn').addEventListener('click', () => {
  void openHistory();
});
byId('closeHistoryBtn').addEventListener('click', closeHistory);
byId('exitReviewBtn').addEventListener('click', exitReview);
replayBtn.addEventListener('click', startReplay);
replayCloseBtn.addEventListener('click', closeReplay);
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

/** Tag names for controls where ctrl+z/y should keep its native text-editing meaning instead of undo/redo-ing the puzzle. Deliberately narrower than `keyboard.ts`'s equivalent list (which also excludes SELECT/BUTTON, since arrow keys and Enter/Space *do* conflict with those) — ctrl+z has no native behavior on a focused button or select, and excluding BUTTON here would mean clicking Undo/Redo/Reset (which keeps focus on the button afterward) silently breaks the ctrl+z shortcut until focus moves elsewhere. */
const TEXT_EDITING_TAGS = new Set(['INPUT', 'TEXTAREA']);

window.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey)) return;
  if (mode !== 'playing' || !historyOverlayEl.classList.contains('hidden')) return;
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
  if (puzzle) layout();
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
  sizeSelect.value = lastSize;
}
const lastShape = localStorage.getItem(LAST_SHAPE_STORAGE_KEY);
if (lastShape && SELECTABLE_SHAPE_MODE_OPTIONS.some((opt) => opt.key === lastShape)) {
  shapeSelect.value = lastShape;
}
const lastReplaySpeed = Number(localStorage.getItem(LAST_REPLAY_SPEED_KEY));
if (REPLAY_SPEED_OPTIONS.includes(lastReplaySpeed)) {
  replaySpeed = lastReplaySpeed;
  replaySpeedSelect.value = String(lastReplaySpeed);
}
void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode);
