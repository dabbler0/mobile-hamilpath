import type { Layout } from './game/geometry';
import { orderLoopCells } from './game/loopOrder';
import { generatePuzzle, generateSolutionEdges, type PuzzleId } from './game/puzzleGen';
import { draw, type AnimationState } from './render';
import type { Viewport } from './view/viewport';

const LAYOUT: Layout = { cellSize: 34, pad: 24 };
/** How far zoomed out the background sits — small enough that several repeated tile copies are visible at once, which is what makes the "constantly diagonally panning" wraparound tiling actually readable as a pattern. */
const SCALE = 0.55;
/** Diagonal pan speed, in unscaled board pixels per second on each axis — deliberately slow and stately, a background detail rather than something demanding attention. */
const PAN_SPEED_X = 26;
const PAN_SPEED_Y = 18;

/**
 * A fixed, arbitrary identity for the main menu's showcase puzzle — always
 * the exact same huge toroidal puzzle, so the background looks the same
 * every time the menu is shown rather than regenerating (and re-solving) a
 * fresh one on every visit. "Huge" (1120 cells) is deliberately the
 * biggest board size, and toroidal so the seamless repeating-tile
 * background (`render.ts`'s `drawWrapped`) has something to tile.
 */
const MENU_PUZZLE_ID: PuzzleId = { sizeKey: 'huge', shapeMode: 'toroidal', seed: 0x6c6f6f70 };

/**
 * Drives the main menu's animated background: a huge toroidal puzzle,
 * already marked with its own winning loop, replaying the postgame
 * win-comet animation (see `CLAUDE.md`'s "Win-comet (postgame)") forever
 * while the view pans diagonally — reusing `render.ts`'s `draw()` and its
 * win-comet math completely unchanged, just fed a perpetually-advancing
 * `Viewport` instead of one driven by pointer/keyboard input. Since the
 * board is toroidal, `drawWrapped` already recomputes the visible tiling
 * fresh from whatever `view` it's given every frame, so panning forever is
 * exactly as free here as it is in ordinary wraparound gameplay.
 *
 * Returns a teardown function that cancels the animation frame loop and
 * detaches the resize listener — call it when the main menu is no longer
 * shown, so the background doesn't keep drawing (and holding a
 * `requestAnimationFrame` chain alive) behind a different screen.
 */
export function startMenuBackground(canvas: HTMLCanvasElement): () => void {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) return () => {};
  const ctx: CanvasRenderingContext2D = maybeCtx;

  const puzzle = generatePuzzle(MENU_PUZZLE_ID);
  const solutionEdges = generateSolutionEdges(MENU_PUZZLE_ID);
  const winLoopCells = orderLoopCells(solutionEdges);
  const startTime = performance.now();

  // The pan wraps modulo one tile's on-screen size (rather than growing
  // `tx`/`ty` without bound for as long as the menu happens to be shown) —
  // panning by exactly one tile is visually identical to not panning at all
  // for a seamlessly repeating tiling, and wrapping keeps the arithmetic
  // (and any eventual floating-point drift) bounded regardless of how long
  // the menu sits open.
  const tileWidthPx = puzzle.W * LAYOUT.cellSize * SCALE;
  const tileHeightPx = puzzle.H * LAYOUT.cellSize * SCALE;

  let frameId: number | null = null;

  function resize(): void {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }

  function frame(): void {
    const now = performance.now();
    const t = (now - startTime) / 1000;
    const tx = (((-t * PAN_SPEED_X * SCALE) % tileWidthPx) + tileWidthPx) % tileWidthPx;
    const ty = (((-t * PAN_SPEED_Y * SCALE) % tileHeightPx) + tileHeightPx) % tileHeightPx;
    const view: Viewport = { scale: SCALE, tx, ty };
    const anim: AnimationState = {
      now,
      winComet: winLoopCells ? { cells: winLoopCells, startIndex: 0, startTime } : undefined,
    };
    draw(ctx, canvas.width, canvas.height, { puzzle, edges: solutionEdges, won: true, anim }, LAYOUT, view);
    frameId = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener('resize', resize);
  frame();

  return () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    window.removeEventListener('resize', resize);
  };
}
