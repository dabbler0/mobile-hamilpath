import { generateDailyPuzzle, SHAPE_MODE_OPTIONS, SIZE_OPTIONS, shapeModeOption, sizeOption, todayKey, type PuzzleId, type ShapeMode } from './game/dailyPuzzle';
import { boardPixelSize, type Layout } from './game/geometry';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordMove, redo as redoHistory, undo as undoHistory, type HistoryState } from './game/history';
import { createInitialPath, type PathOp, type PathState } from './game/pathEdit';
import { EDGE_COLLECTION_LIMITS, NO_EDGE_COLLECTIONS, totalCells, type EdgeCollectionParams, type Puzzle } from './game/puzzle';
import { computeRegions, type Face, type RegionMap } from './game/regions';
import { attachPointerHandling, type GameInputHost } from './input';
import { attachKeyboardHandling, type KeyboardInputHost } from './keyboard';
import { getInProgress, getUnlockedIndex, listCompleted, recordCompletion, saveInProgress, type CompletedRecord } from './persistence/gameStore';
import { draw } from './render';
import './style.css';
import { computeFitView, computeZoomAt, type Viewport, type ViewportBounds } from './view/viewport';

const LAYOUT: Layout = { cellSize: 34, pad: 24 };
const VIEW_BOUNDS: ViewportBounds = { minScale: 0.12, maxScale: 3 };
/** How long each replay frame stays on screen. */
const REPLAY_FRAME_MS = 50;
/** How long a transient status message (e.g. "undo history unavailable") stays visible. */
const TOAST_MS = 3200;

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
const maxCollectionsInput = byId<HTMLInputElement>('maxCollectionsInput');
const minCollectionSizeInput = byId<HTMLInputElement>('minCollectionSizeInput');
const maxCollectionSizeInput = byId<HTMLInputElement>('maxCollectionSizeInput');
const nextBtn = byId<HTMLButtonElement>('nextBtn');
const undoBtn = byId<HTMLButtonElement>('undoBtn');
const redoBtn = byId<HTMLButtonElement>('redoBtn');
const playControlsEl = byId<HTMLDivElement>('playControls');
const reviewBarEl = byId<HTMLDivElement>('reviewBar');
const reviewLabelEl = byId<HTMLSpanElement>('reviewLabel');
const reviewIdleControlsEl = byId<HTMLDivElement>('reviewIdleControls');
const reviewPlaybackControlsEl = byId<HTMLDivElement>('reviewPlaybackControls');
const replayBtn = byId<HTMLButtonElement>('replayBtn');
const replayPlayPauseBtn = byId<HTMLButtonElement>('replayPlayPauseBtn');
const replayScrubberEl = byId<HTMLInputElement>('replayScrubber');
const replayCounterEl = byId<HTMLSpanElement>('replayCounter');
const replayCloseBtn = byId<HTMLButtonElement>('replayCloseBtn');
const historyOverlayEl = byId<HTMLDivElement>('historyOverlay');
const historyListEl = byId<HTMLDivElement>('historyList');
const toastEl = byId<HTMLDivElement>('toast');

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Reads and clamps the three edge-collection number inputs into a valid
 * `EdgeCollectionParams`, swapping min/max size if the player entered them
 * backwards rather than rejecting the input. `maxCollections: 0` (the
 * default) turns the feature off entirely — see `NO_EDGE_COLLECTIONS`.
 */
function currentCollectionParams(): EdgeCollectionParams {
  const maxCollections = clampInt(maxCollectionsInput.value, EDGE_COLLECTION_LIMITS.maxCollections.min, EDGE_COLLECTION_LIMITS.maxCollections.max, NO_EDGE_COLLECTIONS.maxCollections);
  let minSize = clampInt(minCollectionSizeInput.value, EDGE_COLLECTION_LIMITS.size.min, EDGE_COLLECTION_LIMITS.size.max, NO_EDGE_COLLECTIONS.minSize);
  let maxSize = clampInt(maxCollectionSizeInput.value, EDGE_COLLECTION_LIMITS.size.min, EDGE_COLLECTION_LIMITS.size.max, NO_EDGE_COLLECTIONS.maxSize);
  if (minSize > maxSize) [minSize, maxSize] = [maxSize, minSize];
  return { maxCollections, minSize, maxSize };
}

/** Writes a (possibly clamped/swapped) `EdgeCollectionParams` back into the three inputs, so an out-of-range or backwards entry visibly snaps to what was actually used. */
function reflectCollectionParams(params: EdgeCollectionParams): void {
  maxCollectionsInput.value = String(params.maxCollections);
  minCollectionSizeInput.value = String(params.minSize);
  maxCollectionSizeInput.value = String(params.maxSize);
}

type Mode = 'playing' | 'reviewing';
let mode: Mode = 'playing';

let currentPuzzleId: PuzzleId;
let puzzle: Puzzle;
let regionMap: RegionMap;
let pathState: PathState;
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
let toastTimerId: number | null = null;

function activePuzzle(): Puzzle {
  return mode === 'reviewing' && reviewPuzzle ? reviewPuzzle : puzzle;
}

function activeRegionMap(): RegionMap {
  return mode === 'reviewing' && reviewRegionMap ? reviewRegionMap : regionMap;
}

function render(): void {
  const state =
    mode === 'reviewing' && reviewPuzzle
      ? { puzzle: reviewPuzzle, edges: reviewEdges, won: reviewWon, focusedRegion: null, keyboardCursor: null }
      : {
          puzzle,
          edges: pathState.edges,
          won: pathState.won,
          focusedRegion: focusedRegionId !== null ? regionMap.regions[focusedRegionId] : null,
          keyboardCursor,
        };
  draw(ctx, canvas.width, canvas.height, state, LAYOUT, view);
}

function setFocusedRegion(id: number | null): void {
  focusedRegionId = id;
  render();
}

function setKeyboardCursor(cursor: Face | null): void {
  keyboardCursor = cursor;
  render();
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

/** Undo/Redo only ever act on the live, not-yet-won game — once a puzzle is won, editing (and so undoing) is already blocked everywhere else (input.ts/keyboard.ts refuse edits when `won`), so there's no "undo the winning move" case to reconcile with `recordCompletion` having already fired. */
function undoRedoAllowed(): boolean {
  return mode === 'playing' && !pathState.won;
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
  pathState = next;
  history = recordMove(history, prev, ops);
  updateProgress();
  updateNextButton();
  updateUndoRedoButtons();
  render();
  if (justWon) winBannerEl.classList.add('show');
  persistLiveState();
}

function performUndo(): void {
  if (!undoRedoAllowed()) return;
  const result = undoHistory(history, pathState);
  if (!result) return;
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  updateNextButton();
  updateUndoRedoButtons();
  render();
  persistLiveState();
}

function performRedo(): void {
  if (!undoRedoAllowed()) return;
  const result = redoHistory(history, pathState);
  if (!result) return;
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  updateNextButton();
  updateUndoRedoButtons();
  render();
  persistLiveState();
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
  pathState = createInitialPath();
  // Reset starts a fresh attempt, so its move history starts fresh too — otherwise a
  // later win's replay would confusingly interleave an earlier abandoned attempt.
  history = createHistory();
  winBannerEl.classList.remove('show');
  focusedRegionId = null;
  keyboardCursor = null;
  updateProgress();
  updateNextButton();
  updateUndoRedoButtons();
  pendingPersist = saveInProgress(currentPuzzleId, [...pathState.edges], history).catch((err: unknown) => console.error('failed to save progress', err));
  render();
}

const LAST_SIZE_STORAGE_KEY = 'loopit:lastSize';
const LAST_SHAPE_STORAGE_KEY = 'loopit:lastShape';
const LAST_MAX_COLLECTIONS_KEY = 'loopit:collections:max';
const LAST_MIN_COLLECTION_SIZE_KEY = 'loopit:collections:minSize';
const LAST_MAX_COLLECTION_SIZE_KEY = 'loopit:collections:maxSize';

/** Loads whichever puzzle is current for this size+shape+collections today: a resumed in-progress game, or the next unlocked one. */
async function startPuzzle(sizeKey: string, shapeMode: ShapeMode, collections: EdgeCollectionParams): Promise<void> {
  localStorage.setItem(LAST_SIZE_STORAGE_KEY, sizeKey);
  localStorage.setItem(LAST_SHAPE_STORAGE_KEY, shapeMode);
  localStorage.setItem(LAST_MAX_COLLECTIONS_KEY, String(collections.maxCollections));
  localStorage.setItem(LAST_MIN_COLLECTION_SIZE_KEY, String(collections.minSize));
  localStorage.setItem(LAST_MAX_COLLECTION_SIZE_KEY, String(collections.maxSize));
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

  winBannerEl.classList.remove('show');
  focusedRegionId = null;
  keyboardCursor = null;
  updatePuzzleLabel();
  updateProgress();
  updateNextButton();
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
  winBannerEl.classList.remove('show');
  layout();
}

function exitReview(): void {
  closeReplay();
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
  }, REPLAY_FRAME_MS);
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

const host: GameInputHost = {
  getPuzzle: () => activePuzzle(),
  getRegionMap: () => activeRegionMap(),
  getPathState: () => (mode === 'reviewing' ? { edges: reviewEdges, won: true } : pathState),
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
  getPathState: () => (mode === 'reviewing' ? { edges: reviewEdges, won: true } : pathState),
  setPathState,
  setFocusedRegion,
  setKeyboardCursor,
  isEnabled: () => mode === 'playing' && historyOverlayEl.classList.contains('hidden'),
};

attachKeyboardHandling(window, keyboardHost);

byId('resetBtn').addEventListener('click', resetPath);
undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);
sizeSelect.addEventListener('change', () => {
  void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode, currentCollectionParams());
});
shapeSelect.addEventListener('change', () => {
  void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode, currentCollectionParams());
});
function onCollectionsInputChange(): void {
  const params = currentCollectionParams();
  reflectCollectionParams(params); // snap any out-of-range/backwards entry back to what's actually used
  void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode, params);
}
maxCollectionsInput.addEventListener('change', onCollectionsInputChange);
minCollectionSizeInput.addEventListener('change', onCollectionsInputChange);
maxCollectionSizeInput.addEventListener('change', onCollectionsInputChange);
nextBtn.addEventListener('click', () => {
  if (!pathState.won) return;
  void (async () => {
    await pendingPersist;
    await startPuzzle(currentPuzzleId.sizeKey, currentPuzzleId.shapeMode, currentPuzzleId.collections ?? NO_EDGE_COLLECTIONS);
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
if (lastShape && SHAPE_MODE_OPTIONS.some((opt) => opt.key === lastShape)) {
  shapeSelect.value = lastShape;
}
const lastMaxCollections = localStorage.getItem(LAST_MAX_COLLECTIONS_KEY);
if (lastMaxCollections !== null) maxCollectionsInput.value = lastMaxCollections;
const lastMinCollectionSize = localStorage.getItem(LAST_MIN_COLLECTION_SIZE_KEY);
if (lastMinCollectionSize !== null) minCollectionSizeInput.value = lastMinCollectionSize;
const lastMaxCollectionSize = localStorage.getItem(LAST_MAX_COLLECTION_SIZE_KEY);
if (lastMaxCollectionSize !== null) maxCollectionSizeInput.value = lastMaxCollectionSize;
reflectCollectionParams(currentCollectionParams());
void startPuzzle(sizeSelect.value, shapeSelect.value as ShapeMode, currentCollectionParams());
