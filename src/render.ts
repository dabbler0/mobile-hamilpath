import { computeEdgeComponents } from './game/edgeComponents';
import { faceToScreen, toScreen, type Layout } from './game/geometry';
import { parseEdgeKey, type EdgeKey, type Face, type Region } from './game/regions';
import { parseKey, type Puzzle } from './game/puzzle';

export interface RenderState {
  puzzle: Puzzle;
  edges: ReadonlySet<EdgeKey>;
  won: boolean;
  /** The region a press/keyboard cursor is currently over, if any, so it can be highlighted as the one about to toggle. */
  focusedRegion?: Region | null;
  /** The keyboard-control cursor's exact face, if keyboard navigation is in use — drawn on top of the (possibly larger) focused-region fill so movement within one region is still visible. */
  keyboardCursor?: Face | null;
}

const COLORS = {
  background: '#14151a',
  edge: '#33353e',
  node: '#45474f',
  markedWon: '#35c46a',
  regionFocus: 'rgba(127, 184, 255, 0.22)',
  cursor: '#e8e8ea',
};

/**
 * One color per connected component of marked edges, so it's easy to tell
 * how many separate segments/cycles are on the board and which edges belong
 * to which — a categorical palette (CVD- and contrast-validated against
 * `COLORS.background`), cycling if there are ever more segments than colors.
 * Segments are transient (they merge/split as the player edits), so unlike a
 * data-viz legend this doesn't need per-identity color stability across
 * redraws — a segment can change color when it merges with another.
 */
const SEGMENT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

function segmentColor(component: number): string {
  return SEGMENT_COLORS[component % SEGMENT_COLORS.length];
}

export function draw(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, state: RenderState, layout: Layout): void {
  const { puzzle, edges, won, focusedRegion, keyboardCursor } = state;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (focusedRegion) drawRegionHighlight(ctx, focusedRegion, layout);
  drawEdges(ctx, puzzle, layout);
  drawNodes(ctx, puzzle, layout);
  drawMarkedEdges(ctx, edges, won, layout);
  if (keyboardCursor) drawCursor(ctx, keyboardCursor, layout);
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

function drawRegionHighlight(ctx: CanvasRenderingContext2D, region: Region, layout: Layout): void {
  ctx.fillStyle = COLORS.regionFocus;
  for (const face of region.faces) {
    const [sx, sy] = toScreen(face, layout);
    ctx.fillRect(sx, sy, layout.cellSize, layout.cellSize);
  }
}

function drawMarkedEdges(ctx: CanvasRenderingContext2D, edges: ReadonlySet<EdgeKey>, won: boolean, layout: Layout): void {
  ctx.lineWidth = Math.max(3, layout.cellSize * 0.32);
  ctx.lineCap = 'round';

  // A win is exactly one component covering every cell, so there's nothing to
  // tell apart — keep the single "solved" color instead of an arbitrary one
  // from the segment palette.
  const components = won ? null : computeEdgeComponents(edges);

  for (const ek of edges) {
    ctx.strokeStyle = components ? segmentColor(components.get(ek)!) : COLORS.markedWon;
    const [a, b] = parseEdgeKey(ek);
    const [sx1, sy1] = toScreen(a, layout);
    const [sx2, sy2] = toScreen(b, layout);
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
  }
}

function drawCursor(ctx: CanvasRenderingContext2D, face: Face, layout: Layout): void {
  const [sx, sy] = faceToScreen(face, layout);
  const r = Math.max(6, layout.cellSize * 0.44);
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = Math.max(2, layout.cellSize * 0.09);
  ctx.strokeStyle = COLORS.cursor;
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}
