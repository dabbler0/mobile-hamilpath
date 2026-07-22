import { toScreen, type Layout } from './game/geometry';
import type { Cell } from './game/hamiltonianCycle';
import type { Segment } from './game/pathDrag';
import { parseKey, type Puzzle } from './game/puzzle';

export interface RenderState {
  puzzle: Puzzle;
  segments: readonly Segment[];
  won: boolean;
  /** Index into `segments` of whichever one is currently being dragged/held, if any, so it can be drawn in a distinct color. */
  activeSegmentIndex?: number | null;
  /** The keyboard-control cursor's cell, if keyboard navigation is in use. */
  keyboardCursor?: Cell | null;
  /** Whether the keyboard cursor is currently holding a path endpoint (constrained to graph edges) vs. browsing freely. */
  keyboardCursorHeld?: boolean;
}

const COLORS = {
  background: '#14151a',
  edge: '#33353e',
  node: '#45474f',
  pathActive: '#4f7cff',
  pathEditing: '#7fb8ff',
  pathWon: '#35c46a',
  endpoint: '#8fb0ff',
  endpointEditing: '#bcdcff',
  cursorFree: '#e8e8ea',
  cursorHeld: '#7fb8ff',
};

export function draw(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, state: RenderState, layout: Layout): void {
  const { puzzle, segments, won, activeSegmentIndex, keyboardCursor, keyboardCursorHeld } = state;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  drawEdges(ctx, puzzle, layout);
  drawNodes(ctx, puzzle, layout);
  segments.forEach((seg, i) => drawSegment(ctx, seg, won, i === activeSegmentIndex, layout));
  if (keyboardCursor) drawCursor(ctx, keyboardCursor, Boolean(keyboardCursorHeld), layout);
}

function drawEdges(ctx: CanvasRenderingContext2D, puzzle: Puzzle, layout: Layout): void {
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
  ctx.lineCap = 'round';
  const seen = new Set<string>();
  for (const [k, neighbors] of puzzle.adj) {
    const [x1, y1] = parseKey(k);
    for (const nk of neighbors) {
      const edgeKey = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      const [x2, y2] = parseKey(nk);
      const [sx1, sy1] = toScreen([x1, y1], layout);
      const [sx2, sy2] = toScreen([x2, y2], layout);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }
}

function drawNodes(ctx: CanvasRenderingContext2D, puzzle: Puzzle, layout: Layout): void {
  const r = Math.max(1.5, layout.cellSize * 0.11);
  ctx.fillStyle = COLORS.node;
  for (const k of puzzle.adj.keys()) {
    const [sx, sy] = toScreen(parseKey(k), layout);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSegment(ctx: CanvasRenderingContext2D, seg: Segment, won: boolean, isActive: boolean, layout: Layout): void {
  ctx.strokeStyle = won ? COLORS.pathWon : isActive ? COLORS.pathEditing : COLORS.pathActive;
  ctx.lineWidth = Math.max(3, layout.cellSize * 0.32);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let [sx, sy] = toScreen(seg[0], layout);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < seg.length; i++) {
    [sx, sy] = toScreen(seg[i], layout);
    ctx.lineTo(sx, sy);
  }
  if (won) {
    [sx, sy] = toScreen(seg[0], layout);
    ctx.lineTo(sx, sy);
  }
  ctx.stroke();

  const endpointRadius = Math.max(4, layout.cellSize * 0.26);
  const drawEndpoint = (index: number) => {
    const [ex, ey] = toScreen(seg[index], layout);
    ctx.beginPath();
    ctx.arc(ex, ey, endpointRadius, 0, Math.PI * 2);
    ctx.fillStyle = won ? COLORS.pathWon : isActive ? COLORS.endpointEditing : COLORS.endpoint;
    ctx.fill();
  };
  drawEndpoint(0);
  if (seg.length > 1) drawEndpoint(seg.length - 1);
}

function drawCursor(ctx: CanvasRenderingContext2D, cell: Cell, held: boolean, layout: Layout): void {
  const [sx, sy] = toScreen(cell, layout);
  const r = Math.max(6, layout.cellSize * 0.44);
  ctx.beginPath();
  ctx.setLineDash(held ? [] : [4, 4]);
  ctx.lineWidth = Math.max(2, layout.cellSize * 0.09);
  ctx.strokeStyle = held ? COLORS.cursorHeld : COLORS.cursorFree;
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}
