import { computeEdgeComponents } from './game/edgeComponents';
import { faceToScreen, faceToScreenTiled, toScreen, toScreenTiled, type Layout } from './game/geometry';
import { parseEdgeKey, type EdgeKey, type Face, type Region } from './game/regions';
import { parseKey, type Puzzle } from './game/puzzle';
import { topologyFor, wrappedNeighbor, type Topology } from './game/topology';
import type { Viewport } from './view/viewport';

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

/**
 * `view` is only used for a wraparound board (see `drawWrapped`) — an
 * ordinary board's pan/zoom is a CSS transform on the whole canvas element
 * (`main.ts`'s `applyTransform`), so `draw` itself always draws in a single,
 * fixed, unpanned/unzoomed coordinate space for that case.
 */
export function draw(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, state: RenderState, layout: Layout, view: Viewport): void {
  const { puzzle } = state;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (puzzle.topology) {
    drawWrapped(ctx, canvasWidth, canvasHeight, state, layout, view, topologyFor(puzzle.topology));
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

interface TiledEdge {
  /** Which endpoint to draw first, and in which tile offset (relative to whichever tile is being rendered) the *other* endpoint belongs — see the doc comment on `drawWrapped`. */
  from: readonly [number, number];
  to: readonly [number, number];
  tileDX: number;
  tileDY: number;
}

/**
 * Classifies a graph edge between two adjacent cells as a rightward or
 * downward step from one endpoint to the other (using `wrappedNeighbor`,
 * which is orientation-agnostic — see `topology.ts`), and how many tiles
 * over the far endpoint should render (0 unless the step wraps). A torus's
 * wraps never cross a tile boundary in a way that needs more than ±1, and
 * neither does klein/projective, since every step here is a single
 * orthogonal unit move.
 */
function classifyEdge(a: readonly [number, number], b: readonly [number, number], topology: Topology, W: number, H: number): TiledEdge {
  const right = wrappedNeighbor(topology, a[0], a[1], 1, 0, W, H);
  if (right.x === b[0] && right.y === b[1]) return { from: a, to: b, tileDX: a[0] + 1 >= W ? 1 : 0, tileDY: 0 };
  const rightB = wrappedNeighbor(topology, b[0], b[1], 1, 0, W, H);
  if (rightB.x === a[0] && rightB.y === a[1]) return { from: b, to: a, tileDX: b[0] + 1 >= W ? 1 : 0, tileDY: 0 };
  const down = wrappedNeighbor(topology, a[0], a[1], 0, 1, W, H);
  if (down.x === b[0] && down.y === b[1]) return { from: a, to: b, tileDX: 0, tileDY: a[1] + 1 >= H ? 1 : 0 };
  // The only remaining possibility for a valid single-step edge: b steps down to a.
  return { from: b, to: a, tileDX: 0, tileDY: b[1] + 1 >= H ? 1 : 0 };
}

/**
 * A wraparound board renders as a seamlessly, genuinely infinite repeating
 * tiling: panning or zooming out reveals more real copies of the same
 * board, computed fresh each draw from the current `view` rather than a
 * fixed pre-rendered halo. Klein bottle/projective plane tiles alternate
 * between mirrored and unmirrored depending on which tile they are (see
 * `topology.tileOrientation`) — a torus's tiles are never mirrored.
 *
 * Layers are drawn globally (every tile's region highlight, then every
 * tile's candidate edges, then every tile's nodes, then every tile's marked
 * edges, then every tile's cursor) rather than one tile fully at a time.
 * Drawing tile-by-tile let one tile's candidate (unmarked) edges land on
 * top of a *different* tile's already-drawn marked edge at a seam, since
 * two adjacent tiles' content can occupy the exact same screen pixels
 * there — global layering keeps marked edges on top everywhere, matching
 * how they're always drawn after candidate edges within a single tile too.
 */
function drawWrapped(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  state: RenderState,
  layout: Layout,
  view: Viewport,
  topology: Topology,
): void {
  const { puzzle, edges, won, focusedRegion, keyboardCursor } = state;
  const { W, H } = puzzle;

  ctx.save();
  ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);

  const tileWidthPx = W * layout.cellSize;
  const tileHeightPx = H * layout.cellSize;
  const corners: Array<[number, number]> = [
    [0, 0],
    [canvasWidth, 0],
    [0, canvasHeight],
    [canvasWidth, canvasHeight],
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [sx, sy] of corners) {
    const x = (sx - view.tx) / view.scale;
    const y = (sy - view.ty) / view.scale;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const minTileX = Math.floor((minX - layout.pad) / tileWidthPx) - 1;
  const maxTileX = Math.floor((maxX - layout.pad) / tileWidthPx) + 1;
  const minTileY = Math.floor((minY - layout.pad) / tileHeightPx) - 1;
  const maxTileY = Math.floor((maxY - layout.pad) / tileHeightPx) + 1;

  const tiledEdges: TiledEdge[] = [];
  const seen = new Set<string>();
  for (const [k, neighbors] of puzzle.adj) {
    const a = parseKey(k);
    for (const nk of neighbors) {
      const dedupeKey = k < nk ? `${k}|${nk}` : `${nk}|${k}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      tiledEdges.push(classifyEdge(a, parseKey(nk), topology, W, H));
    }
  }

  const components = won ? null : computeEdgeComponents(edges);
  const tiledMarkedEdges: Array<TiledEdge & { color: string }> = [];
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const color = components ? segmentColor(components.get(ek)!) : COLORS.markedWon;
    tiledMarkedEdges.push({ ...classifyEdge(a, b, topology, W, H), color });
  }

  function forEachTile(fn: (tileX: number, tileY: number) => void): void {
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) fn(tileX, tileY);
    }
  }

  if (focusedRegion) {
    ctx.fillStyle = COLORS.regionFocus;
    forEachTile((tileX, tileY) => {
      const orientation = topology.tileOrientation(tileX, tileY);
      for (const face of focusedRegion.faces) {
        // A face isn't a vertex — `toScreenTiled` would silently mirror it
        // by the wrong (point, not interval) reflection in a flipped tile,
        // landing the fill a full cell off from the face it's meant to
        // mark (see `faceAt`'s doc comment). `faceToScreenTiled` gives the
        // face's *center*, so offset back by half a cell for `fillRect`'s
        // top-left corner.
        const [cx, cy] = faceToScreenTiled(face, layout, tileX, tileY, W, H, orientation);
        ctx.fillRect(cx - layout.cellSize / 2, cy - layout.cellSize / 2, layout.cellSize, layout.cellSize);
      }
    });
  }

  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
  ctx.lineCap = 'round';
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY } of tiledEdges) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(tileX + tileDX, tileY + tileDY);
      const [sx2, sy2] = toScreenTiled(to, layout, tileX + tileDX, tileY + tileDY, W, H, oTo);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  });

  const r = Math.max(1.5, layout.cellSize * 0.11);
  ctx.fillStyle = COLORS.node;
  forEachTile((tileX, tileY) => {
    const orientation = topology.tileOrientation(tileX, tileY);
    for (const k of puzzle.adj.keys()) {
      const [sx, sy] = toScreenTiled(parseKey(k), layout, tileX, tileY, W, H, orientation);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  ctx.lineWidth = Math.max(3, layout.cellSize * 0.32);
  ctx.lineCap = 'round';
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY, color } of tiledMarkedEdges) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(tileX + tileDX, tileY + tileDY);
      const [sx2, sy2] = toScreenTiled(to, layout, tileX + tileDX, tileY + tileDY, W, H, oTo);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  });

  if (keyboardCursor) {
    const cr = Math.max(6, layout.cellSize * 0.44);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = Math.max(2, layout.cellSize * 0.09);
    ctx.strokeStyle = COLORS.cursor;
    forEachTile((tileX, tileY) => {
      const orientation = topology.tileOrientation(tileX, tileY);
      const [sx, sy] = faceToScreenTiled(keyboardCursor, layout, tileX, tileY, W, H, orientation);
      ctx.beginPath();
      ctx.arc(sx, sy, cr, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  ctx.restore();
}
