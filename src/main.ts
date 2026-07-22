import { generateDailyPuzzle, SIZE_OPTIONS, sizeOption, todayKey, type PuzzleId } from './game/dailyPuzzle';
import { boardPixelSize, type Layout } from './game/geometry';
import type { Cell } from './game/hamiltonianCycle';
import { createInitialPath, totalVisitedCells, type PathState, type Segment } from './game/pathDrag';
import { totalCells, type Puzzle } from './game/puzzle';
import { attachPointerHandling, type GameInputHost } from './input';
import { attachKeyboardHandling, type KeyboardInputHost } from './keyboard';
import { getInProgress, getUnlockedIndex, listCompleted, recordCompletion, saveInProgress, type CompletedRecord } from './persistence/gameStore';
import { draw } from './render';
import './style.css';
import { computeFitView, computeZoomAt, type Viewport, type ViewportBounds } from './view/viewport';

const LAYOUT: Layout = { cellSize: 34, pad: 24 };
const VIEW_BOUNDS: ViewportBounds = { minScale: 0.12, maxScale: 3 };

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
const nextBtn = byId<HTMLButtonElement>('nextBtn');
const playControlsEl = byId<HTMLDivElement>('playControls');
const reviewBarEl = byId<HTMLDivElement>('reviewBar');
const reviewLabelEl = byId<HTMLSpanElement>('reviewLabel');
const historyOverlayEl = byId<HTMLDivElement>('historyOverlay');
const historyListEl = byId<HTMLDivElement>('historyList');

type Mode = 'playing' | 'reviewing';
let mode: Mode = 'playing';

let currentPuzzleId: PuzzleId;
let puzzle: Puzzle;
let pathState: PathState;
let reviewPuzzle: Puzzle | null = null;
let reviewSegments: Segment[] = [];
let view: Viewport = { scale: 1, tx: 0, ty: 0 };
/** Tracks the latest in-flight IndexedDB write so "Next Puzzle" can wait for a completion to land before re-reading the unlock gate. */
let pendingPersist: Promise<void> = Promise.resolve();
/** Index of whichever segment is currently being edited (pointer-dragged or keyboard-held), for highlighting. Reset on any mode/puzzle change. */
let activeSegmentIndex: number | null = null;
let keyboardCursor: Cell | null = null;
let keyboardCursorHeld = false;

function activePuzzle(): Puzzle {
  return mode === 'reviewing' && reviewPuzzle ? reviewPuzzle : puzzle;
}

function render(): void {
  const state =
    mode === 'reviewing' && reviewPuzzle
      ? { puzzle: reviewPuzzle, segments: reviewSegments, won: true }
      : {
          puzzle,
          segments: pathState.segments,
          won: pathState.won,
          activeSegmentIndex,
          keyboardCursor,
          keyboardCursorHeld,
        };
  draw(ctx, canvas.width, canvas.height, state, LAYOUT);
}

function setActiveSegment(index: number | null): void {
  activeSegmentIndex = index;
  render();
}

function setKeyboardCursor(cursor: Cell | null, held: boolean): void {
  keyboardCursor = cursor;
  keyboardCursorHeld = held;
  render();
}

function applyTransform(): void {
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

function updateProgress(): void {
  progressEl.textContent = `${totalVisitedCells(pathState)} / ${totalCells(puzzle)}`;
}

function updatePuzzleLabel(): void {
  const opt = sizeOption(currentPuzzleId.sizeKey);
  puzzleLabelEl.textContent = `${opt.label} #${currentPuzzleId.index + 1}`;
}

function updateNextButton(): void {
  nextBtn.disabled = !pathState.won;
}

function setPathState(next: PathState): void {
  const justWon = next.won && !pathState.won;
  pathState = next;
  updateProgress();
  updateNextButton();
  render();
  if (justWon) {
    winBannerEl.classList.add('show');
    pendingPersist = recordCompletion(currentPuzzleId, next.segments).catch((err: unknown) => console.error('failed to record completion', err));
  } else {
    pendingPersist = saveInProgress(currentPuzzleId, next.segments).catch((err: unknown) => console.error('failed to save progress', err));
  }
}

function setView(next: Viewport): void {
  view = next;
  applyTransform();
}

function fitView(): void {
  const { w, h } = boardPixelSize(activePuzzle(), LAYOUT);
  setView(computeFitView(w, h, wrapEl.clientWidth, wrapEl.clientHeight, VIEW_BOUNDS));
}

function layout(): void {
  const { w, h } = boardPixelSize(activePuzzle(), LAYOUT);
  canvas.width = w;
  canvas.height = h;
  fitView();
  render();
}

function resetPath(): void {
  pathState = createInitialPath(puzzle);
  winBannerEl.classList.remove('show');
  activeSegmentIndex = null;
  keyboardCursor = null;
  keyboardCursorHeld = false;
  updateProgress();
  updateNextButton();
  pendingPersist = saveInProgress(currentPuzzleId, pathState.segments).catch((err: unknown) => console.error('failed to save progress', err));
  render();
}

const LAST_SIZE_STORAGE_KEY = 'loopit:lastSize';

/** Loads whichever puzzle is current for this size today: a resumed in-progress game, or the next unlocked one. */
async function startPuzzleForSize(sizeKey: string): Promise<void> {
  localStorage.setItem(LAST_SIZE_STORAGE_KEY, sizeKey);
  const day = todayKey();
  const unlockedIndex = await getUnlockedIndex(day, sizeKey);
  const existing = await getInProgress(day, sizeKey);
  const resuming = existing && existing.index === unlockedIndex;
  const index = resuming ? existing.index : unlockedIndex;

  currentPuzzleId = { day, sizeKey, index };
  puzzle = generateDailyPuzzle(currentPuzzleId);
  pathState = resuming ? { segments: existing.segments, won: false } : createInitialPath(puzzle);

  winBannerEl.classList.remove('show');
  activeSegmentIndex = null;
  keyboardCursor = null;
  keyboardCursorHeld = false;
  updatePuzzleLabel();
  updateProgress();
  updateNextButton();
  layout();
}

function formatCompletedAt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderHistoryItem(item: CompletedRecord): HTMLButtonElement {
  const opt = sizeOption(item.sizeKey);
  const btn = document.createElement('button');
  btn.className = 'historyItem';

  const info = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'historyItemTitle';
  title.textContent = `${opt.label} #${item.index + 1}`;
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
  const id: PuzzleId = { day: item.day, sizeKey: item.sizeKey, index: item.index };
  reviewPuzzle = generateDailyPuzzle(id);
  reviewSegments = item.segments;
  mode = 'reviewing';
  activeSegmentIndex = null;
  keyboardCursor = null;
  keyboardCursorHeld = false;

  const opt = sizeOption(item.sizeKey);
  reviewLabelEl.textContent = `${opt.label} #${item.index + 1} · ${item.day}`;
  reviewBarEl.classList.remove('hidden');
  playControlsEl.classList.add('hidden');
  winBannerEl.classList.remove('show');
  layout();
}

function exitReview(): void {
  mode = 'playing';
  reviewPuzzle = null;
  activeSegmentIndex = null;
  keyboardCursor = null;
  keyboardCursorHeld = false;
  reviewBarEl.classList.add('hidden');
  playControlsEl.classList.remove('hidden');
  layout();
}

const host: GameInputHost = {
  getPuzzle: () => activePuzzle(),
  getPathState: () => (mode === 'reviewing' ? { segments: reviewSegments, won: true } : pathState),
  setPathState,
  getLayout: () => LAYOUT,
  getView: () => view,
  setView,
  setActiveSegment,
  bounds: VIEW_BOUNDS,
  wrapEl,
};

attachPointerHandling(canvas, host);

const keyboardHost: KeyboardInputHost = {
  getPuzzle: () => activePuzzle(),
  getPathState: () => (mode === 'reviewing' ? { segments: reviewSegments, won: true } : pathState),
  setPathState,
  getLayout: () => LAYOUT,
  setActiveSegment,
  setKeyboardCursor,
  isEnabled: () => mode === 'playing' && historyOverlayEl.classList.contains('hidden'),
};

attachKeyboardHandling(window, keyboardHost);

byId('resetBtn').addEventListener('click', resetPath);
sizeSelect.addEventListener('change', () => {
  void startPuzzleForSize(sizeSelect.value);
});
nextBtn.addEventListener('click', () => {
  if (!pathState.won) return;
  void (async () => {
    await pendingPersist;
    await startPuzzleForSize(currentPuzzleId.sizeKey);
  })();
});
byId('historyBtn').addEventListener('click', () => {
  void openHistory();
});
byId('closeHistoryBtn').addEventListener('click', closeHistory);
byId('exitReviewBtn').addEventListener('click', exitReview);

byId('zoomFitBtn').addEventListener('click', fitView);
byId('zoomInBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale * 1.4, VIEW_BOUNDS));
});
byId('zoomOutBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale / 1.4, VIEW_BOUNDS));
});
window.addEventListener('resize', () => {
  if (puzzle) fitView();
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
void startPuzzleForSize(sizeSelect.value);
