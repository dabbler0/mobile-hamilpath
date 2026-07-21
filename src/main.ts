import { boardPixelSize, type Layout } from './game/geometry';
import { createInitialPath, type PathState } from './game/pathDrag';
import { buildPuzzle, totalCells, type Puzzle } from './game/puzzle';
import { mulberry32, randomSeed } from './game/rng';
import { attachPointerHandling, type GameInputHost } from './input';
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
const winBannerEl = byId<HTMLDivElement>('winBanner');
const sizeSelect = byId<HTMLSelectElement>('sizeSelect');
const densitySelect = byId<HTMLSelectElement>('densitySelect');

let puzzle: Puzzle;
let pathState: PathState;
let view: Viewport = { scale: 1, tx: 0, ty: 0 };

function render(): void {
  draw(ctx, canvas.width, canvas.height, { puzzle, path: pathState.path, won: pathState.won }, LAYOUT);
}

function applyTransform(): void {
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

function updateProgress(): void {
  progressEl.textContent = `${pathState.path.length} / ${totalCells(puzzle)}`;
}

function setPathState(next: PathState): void {
  const justWon = next.won && !pathState.won;
  pathState = next;
  updateProgress();
  if (justWon) winBannerEl.classList.add('show');
  render();
}

function setView(next: Viewport): void {
  view = next;
  applyTransform();
}

function fitView(): void {
  const { w, h } = boardPixelSize(puzzle, LAYOUT);
  setView(computeFitView(w, h, wrapEl.clientWidth, wrapEl.clientHeight, VIEW_BOUNDS));
}

function layout(): void {
  const { w, h } = boardPixelSize(puzzle, LAYOUT);
  canvas.width = w;
  canvas.height = h;
  fitView();
  render();
}

function resetPath(): void {
  pathState = createInitialPath(puzzle);
  winBannerEl.classList.remove('show');
  updateProgress();
  render();
}

function newPuzzle(): void {
  const [m, n] = sizeSelect.value.split(',').map(Number);
  const density = parseFloat(densitySelect.value);
  const rng = mulberry32(randomSeed());
  puzzle = buildPuzzle(m, n, density, rng);
  resetPath();
  layout();
}

const host: GameInputHost = {
  getPuzzle: () => puzzle,
  getPathState: () => pathState,
  setPathState,
  getLayout: () => LAYOUT,
  getView: () => view,
  setView,
  bounds: VIEW_BOUNDS,
  wrapEl,
};

attachPointerHandling(canvas, host);

byId('newBtn').addEventListener('click', newPuzzle);
byId('resetBtn').addEventListener('click', resetPath);
sizeSelect.addEventListener('change', newPuzzle);
densitySelect.addEventListener('change', newPuzzle);
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

newPuzzle();
