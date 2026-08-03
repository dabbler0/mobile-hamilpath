import { computeEdgeComponents } from './game/edgeComponents';
import { faceToScreen, faceToScreenTiled, toScreen, toScreenTiled, TOROIDAL_PRIMARY_TILE_INDEX, TOROIDAL_TILE_COPIES, type Layout } from './game/geometry';
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

/** Opacity of a toroidal board's surrounding halo copies — legible enough to show the wraparound and the board's true size, but visually recessive and clearly not the interactive tile (see `isWithinToroidalPrimaryTile`). */
const TOROIDAL_HALO_OPACITY = 0.28;

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
  const { puzzle } = state;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (puzzle.toroidal) {
    drawToroidal(ctx, state, layout);
  } else {
    drawSingleTile(ctx, state, layout);
  }
}

function drawSingleTile(ctx: CanvasRenderingContext2D, state: RenderState, layout: Layout): void {
  const { puzzle, edges, won, focusedRegion, keyboardCursor } = state;
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

/**
 * A toroidal board is rendered as one interactive primary tile surrounded by
 * `TOROIDAL_TILE_COPIES` x `TOROIDAL_TILE_COPIES` - 1 dimmed, non-interactive
 * halo copies (see `geometry.ts`, `isWithinToroidalPrimaryTile`) — just
 * enough context to make the wraparound and the board's true size legible,
 * without implying the board is an actually-infinite scrolling surface. The
 * tricky part is edges: an edge between two cells that are graph-adjacent
 * via the wraparound (e.g. column W-1 to column 0) would draw as one long
 * line straight across the tile if drawn from each cell's own position in
 * the *same* tile copy — `wrapDelta` finds the small (usually ±1) on-screen
 * offset that makes it look like ordinary local adjacency in every repeated
 * copy instead.
 */
function wrapDelta(v1: number, v2: number, period: number): number {
  let d = ((v2 - v1) % period) + period;
  d %= period;
  if (d > period / 2) d -= period;
  return d;
}

function drawToroidal(ctx: CanvasRenderingContext2D, state: RenderState, layout: Layout): void {
  const { puzzle, edges, won, focusedRegion, keyboardCursor } = state;
  const { W, H } = puzzle;

  const edgeDeltas: Array<{ x1: number; y1: number; dx: number; dy: number }> = [];
  const seen = new Set<string>();
  for (const [k, neighbors] of puzzle.adj) {
    const [x1, y1] = parseKey(k);
    for (const nk of neighbors) {
      const dedupeKey = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const [x2, y2] = parseKey(nk);
      edgeDeltas.push({ x1, y1, dx: wrapDelta(x1, x2, W), dy: wrapDelta(y1, y2, H) });
    }
  }

  const markedEdgeDeltas: Array<{ a: readonly [number, number]; dx: number; dy: number; color: string }> = [];
  const components = won ? null : computeEdgeComponents(edges);
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    markedEdgeDeltas.push({
      a,
      dx: wrapDelta(a[0], b[0], W),
      dy: wrapDelta(a[1], b[1], H),
      color: components ? segmentColor(components.get(ek)!) : COLORS.markedWon,
    });
  }

  for (let tileY = 0; tileY < TOROIDAL_TILE_COPIES; tileY++) {
    for (let tileX = 0; tileX < TOROIDAL_TILE_COPIES; tileX++) {
      const isPrimary = tileX === TOROIDAL_PRIMARY_TILE_INDEX && tileY === TOROIDAL_PRIMARY_TILE_INDEX;
      ctx.globalAlpha = isPrimary ? 1 : TOROIDAL_HALO_OPACITY;

      // The focused-region highlight and keyboard cursor mark something the
      // player can act on — only ever the primary tile now that halo taps
      // don't toggle anything (see `input.ts`), so skip drawing them
      // (dimmed) in the halo, which would otherwise imply they're separately
      // interactive there too.
      if (isPrimary && focusedRegion) {
        ctx.fillStyle = COLORS.regionFocus;
        for (const face of focusedRegion.faces) {
          const [sx, sy] = toScreenTiled(face, layout, tileX, tileY, W, H);
          ctx.fillRect(sx, sy, layout.cellSize, layout.cellSize);
        }
      }

      ctx.strokeStyle = COLORS.edge;
      ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
      ctx.lineCap = 'round';
      for (const { x1, y1, dx, dy } of edgeDeltas) {
        const [sx1, sy1] = toScreenTiled([x1, y1], layout, tileX, tileY, W, H);
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx1 + dx * layout.cellSize, sy1 + dy * layout.cellSize);
        ctx.stroke();
      }

      const r = Math.max(1.5, layout.cellSize * 0.11);
      ctx.fillStyle = COLORS.node;
      for (const k of puzzle.adj.keys()) {
        const [sx, sy] = toScreenTiled(parseKey(k), layout, tileX, tileY, W, H);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.lineWidth = Math.max(3, layout.cellSize * 0.32);
      ctx.lineCap = 'round';
      for (const { a, dx, dy, color } of markedEdgeDeltas) {
        const [sx1, sy1] = toScreenTiled(a, layout, tileX, tileY, W, H);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx1 + dx * layout.cellSize, sy1 + dy * layout.cellSize);
        ctx.stroke();
      }

      if (isPrimary && keyboardCursor) {
        const [sx, sy] = faceToScreenTiled(keyboardCursor, layout, tileX, tileY, W, H);
        const cr = Math.max(6, layout.cellSize * 0.44);
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = Math.max(2, layout.cellSize * 0.09);
        ctx.strokeStyle = COLORS.cursor;
        ctx.arc(sx, sy, cr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  ctx.globalAlpha = 1;
}
