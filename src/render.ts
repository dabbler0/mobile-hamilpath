import { computeEdgeComponents } from './game/edgeComponents';
import { faceToScreen, faceToScreenTiled, toScreen, toScreenTiled, wrapToTile, type Layout } from './game/geometry';
import { parseEdgeKey, type EdgeKey, type Face, type Region } from './game/regions';
import { countCollectionEdges, parseKey, type EdgeCollection, type Puzzle } from './game/puzzle';
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
  /** In-flight edge/win-loop animations, owned and scheduled by `main.ts` (see its "Animations" section) — omitted entirely for a plain, static draw (e.g. the review scrubber jumping straight to a frame). */
  anim?: AnimationState;
}

/** A single edge growing in from zero width (drawn at full length throughout), keyed by when it started (`main.ts`'s `growingEdges`). */
export type GrowingEdges = ReadonlyMap<EdgeKey, number>;
/** A single edge shrinking back to zero width after being unmarked, with the color it had at the moment it was removed (it's no longer part of any *live* component to re-derive a color from) — `main.ts`'s `shrinkingEdges`. */
export type ShrinkingEdges = ReadonlyMap<EdgeKey, { start: number; color: string }>;
/** An edge whose component recolored as a side effect of a toggle elsewhere (a merge/split), rippling out from the toggle location — `delay` staggers its pulse by graph distance, `fromColor` is the color to show until the wave "arrives" (`main.ts`'s `pulsingEdges`, `edgeRipple.ts`'s `computeRecoloredEdges`). */
export type PulsingEdges = ReadonlyMap<EdgeKey, { start: number; delay: number; fromColor: string }>;

export interface AnimationState {
  /** `performance.now()` at the moment this frame is being drawn. */
  now: number;
  growing?: GrowingEdges;
  shrinking?: ShrinkingEdges;
  pulsing?: PulsingEdges;
  /** The cell cycle a completed puzzle's win-loop dot travels along, and when it started — `null`/absent whenever the board isn't currently in a completed state. */
  winLoop?: { cells: ReadonlyArray<readonly [number, number]>; startTime: number } | null;
}

/** How long a newly-marked edge takes to grow from zero to full *width* (drawn full-length the whole time), and a newly-unmarked one to shrink back to zero width — `pathEdit.ts`'s `toggleRegion` is the only thing that starts one (see `main.ts`'s `scheduleToggleAnimation`). */
export const GROW_MS = 220;
export const SHRINK_MS = 220;
/** How long one edge's recolor "pulse" (width bulge + color swap at its peak) lasts, once its ripple delay has elapsed. */
export const PULSE_MS = 260;
const PULSE_BULGE = 0.85;
/** Below this a stroke is treated as invisible and skipped — canvas ignores/normalizes `ctx.lineWidth = 0` rather than actually drawing nothing, so a grow/shrink's endpoints would otherwise flash a stray hairline. */
const MIN_VISIBLE_WIDTH = 0.5;

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * The win-loop dot travels at a constant pace (edges per ms) rather than a
 * fixed lap time, so a bigger loop just takes proportionally longer to
 * complete rather than the dot itself visibly speeding up or slowing down —
 * a fixed-duration lap previously had to be clamped to keep a huge board's
 * lap watchable, which made the dot noticeably *faster* there than on a
 * small board (more cells covered per second) instead of the same speed.
 * The floor only guards a degenerate near-empty cycle from being instant.
 */
const WIN_DOT_MS_PER_EDGE = 90;
function winDotPeriodMs(cellCount: number): number {
  return Math.max(600, cellCount * WIN_DOT_MS_PER_EDGE);
}

const COLORS = {
  background: '#14151a',
  edge: '#33353e',
  node: '#45474f',
  markedWon: '#35c46a',
  regionFocus: 'rgba(127, 184, 255, 0.22)',
  cursor: '#e8e8ea',
  /** The dot that travels around a completed puzzle's loop, see `drawWinLoopDot`. */
  winDot: '#ffffff',
  /** Badge color for an edge collection whose currently-marked count doesn't match its `required` count — see `drawEdgeCollectionBadges`. */
  collectionError: '#e6483c',
  /** Badge text/outline color, kept constant across both the normal (collection-color) and error-red badge fills for contrast. */
  collectionBadgeText: '#ffffff',
};

/**
 * One color per edge collection (see `puzzle.ts`'s `EdgeCollection`), used
 * for both the colored "halo" drawn behind a collection's edges and its
 * count badge's fill when satisfied. Deliberately a different palette from
 * `SEGMENT_COLORS` (warmer/more saturated) since a collection edge and a
 * marked path segment routinely render at the very same screen position at
 * once — see `drawEdgeCollectionHalos`.
 */
const COLLECTION_COLORS = ['#ffb020', '#ff5da2', '#39e0c8', '#b98bff', '#ffe14d', '#6fd15f', '#5ab0ff', '#ff8a3d'];

function collectionColor(id: number): string {
  return COLLECTION_COLORS[id % COLLECTION_COLORS.length];
}

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

/** Exported so `main.ts` can freeze the same color a component was showing at the moment an animation starts (a shrinking edge's last color, a pulse's `fromColor`) — see its "Animations" section. */
export function segmentColor(component: number): string {
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
  const { puzzle, edges, won, focusedRegion, keyboardCursor, anim } = state;
  if (focusedRegion) drawRegionHighlight(ctx, focusedRegion, layout);
  drawEdgeCollectionHalos(ctx, puzzle, layout);
  drawEdges(ctx, puzzle, layout);
  drawNodes(ctx, puzzle, layout);
  drawMarkedEdges(ctx, edges, won, layout, anim);
  drawEdgeCollectionBadges(ctx, puzzle, edges, layout);
  if (anim?.winLoop) drawWinLoopDot(ctx, anim.winLoop, anim.now, layout);
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

/**
 * Draws every currently-marked edge, plus any edge still mid-`shrink` after
 * being unmarked (not in `edges` any more, but not done animating out yet —
 * see `main.ts`'s `shrinkingEdges`). A `growing` edge is drawn at full
 * length throughout, its *width* ramping from 0 up to normal over
 * `GROW_MS`; a `shrinking` one is the mirror image, its width ramping back
 * down to 0. A `pulsing` edge (present the whole time, just recoloring as a
 * merge/split ripples past it) bulges *past* normal width and back, swapping
 * from its old color to its live one at the peak — see `AnimationState`'s
 * doc comment for where these come from.
 */
function drawMarkedEdges(ctx: CanvasRenderingContext2D, edges: ReadonlySet<EdgeKey>, won: boolean, layout: Layout, anim?: AnimationState): void {
  const baseWidth = Math.max(3, layout.cellSize * 0.32);
  ctx.lineCap = 'round';

  // A win is exactly one component covering every cell, so there's nothing to
  // tell apart — keep the single "solved" color instead of an arbitrary one
  // from the segment palette.
  const components = won ? null : computeEdgeComponents(edges);
  const now = anim?.now ?? 0;

  for (const ek of edges) {
    const liveColor = components ? segmentColor(components.get(ek)!) : COLORS.markedWon;
    const [a, b] = parseEdgeKey(ek);
    const [sx1, sy1] = toScreen(a, layout);
    const [sx2, sy2] = toScreen(b, layout);

    const growStart = anim?.growing?.get(ek);
    const pulse = growStart === undefined ? anim?.pulsing?.get(ek) : undefined;

    let strokeStyle = liveColor;
    let lineWidth = baseWidth;
    if (growStart !== undefined) {
      lineWidth = baseWidth * smoothstep((now - growStart) / GROW_MS);
    } else if (pulse) {
      const t = (now - pulse.start - pulse.delay) / PULSE_MS;
      if (t < 0) {
        strokeStyle = pulse.fromColor; // ripple hasn't reached this edge yet
      } else if (t <= 1) {
        lineWidth = baseWidth * (1 + PULSE_BULGE * Math.sin(Math.PI * t));
        strokeStyle = t < 0.5 ? pulse.fromColor : liveColor;
      }
    }

    if (lineWidth < MIN_VISIBLE_WIDTH) continue;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
  }

  if (anim?.shrinking) {
    for (const [ek, shrink] of anim.shrinking) {
      if (edges.has(ek)) continue; // shouldn't happen — a re-marked edge is dropped from `shrinking` by `main.ts`
      const lineWidth = baseWidth * (1 - smoothstep((now - shrink.start) / SHRINK_MS));
      if (lineWidth < MIN_VISIBLE_WIDTH) continue;
      const [a, b] = parseEdgeKey(ek);
      const [sx1, sy1] = toScreen(a, layout);
      const [sx2, sy2] = toScreen(b, layout);
      ctx.strokeStyle = shrink.color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }
}

/** Draws the traveling dot that marks a completed puzzle's loop, walking `winLoop.cells` in order and looping forever (see `winDotPeriodMs`). */
function drawWinLoopDot(ctx: CanvasRenderingContext2D, winLoop: NonNullable<AnimationState['winLoop']>, now: number, layout: Layout): void {
  const { cells, startTime } = winLoop;
  if (cells.length < 2) return;
  const periodMs = winDotPeriodMs(cells.length);
  const frac = (((now - startTime) % periodMs) + periodMs) % periodMs / periodMs;
  const pos = frac * cells.length;
  const i = Math.floor(pos) % cells.length;
  const localT = pos - Math.floor(pos);
  const [sx1, sy1] = toScreen(cells[i], layout);
  const [sx2, sy2] = toScreen(cells[(i + 1) % cells.length], layout);
  const r = Math.max(4, layout.cellSize * 0.24);
  ctx.beginPath();
  ctx.fillStyle = COLORS.winDot;
  ctx.arc(sx1 + (sx2 - sx1) * localT, sy1 + (sy2 - sy1) * localT, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.stroke();
}

/**
 * Draws each edge collection's edges as a thick colored line *behind* the
 * ordinary candidate/marked-edge strokes (drawn right after this, in
 * `drawSingleTile`), so a collection edge always shows a colored "halo"
 * peeking out on both sides regardless of whether it's currently marked —
 * marking/unmarking a collection edge only changes the thin line on top,
 * never its collection identity underneath.
 */
function drawEdgeCollectionHalos(ctx: CanvasRenderingContext2D, puzzle: Puzzle, layout: Layout): void {
  const collections = puzzle.edgeCollections;
  if (!collections || collections.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(5, layout.cellSize * 0.5);
  for (const collection of collections) {
    ctx.strokeStyle = collectionColor(collection.id);
    for (const ek of collection.edges) {
      const [a, b] = parseEdgeKey(ek);
      const [sx1, sy1] = toScreen(a, layout);
      const [sx2, sy2] = toScreen(b, layout);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }
}

/** Fill + text color for one collection's count badge, given how many of its edges are currently marked. */
function collectionBadgeFill(collection: EdgeCollection, edges: ReadonlySet<EdgeKey>): string {
  return countCollectionEdges(collection, edges) === collection.required ? collectionColor(collection.id) : COLORS.collectionError;
}

function drawBadge(ctx: CanvasRenderingContext2D, mx: number, my: number, r: number, text: string, fill: string): void {
  ctx.beginPath();
  ctx.arc(mx, my, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.stroke();
  ctx.fillStyle = COLORS.collectionBadgeText;
  ctx.fillText(text, mx, my);
}

/**
 * Draws each collection's `required` count as a small badge at the midpoint
 * of every one of its edges (repeated per-edge rather than once per
 * collection, since a collection's edges are usually scattered around the
 * board — see `puzzle.ts`'s `pickCollectionEdges` — so there's no single
 * obviously-right place to put one shared label). Turns
 * `COLORS.collectionError` instead of the collection's own color the moment
 * the currently-marked count stops matching `required`, in either
 * direction — the simplest, most visually obvious way to flag "too many" or
 * "too few" without a separate icon.
 */
function drawEdgeCollectionBadges(ctx: CanvasRenderingContext2D, puzzle: Puzzle, edges: ReadonlySet<EdgeKey>, layout: Layout): void {
  const collections = puzzle.edgeCollections;
  if (!collections || collections.length === 0) return;
  const r = Math.max(7, layout.cellSize * 0.26);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.max(9, r * 1.15)}px sans-serif`;
  for (const collection of collections) {
    const fill = collectionBadgeFill(collection, edges);
    const text = String(collection.required);
    for (const ek of collection.edges) {
      const [a, b] = parseEdgeKey(ek);
      const [sx1, sy1] = toScreen(a, layout);
      const [sx2, sy2] = toScreen(b, layout);
      drawBadge(ctx, (sx1 + sx2) / 2, (sy1 + sy2) / 2, r, text, fill);
    }
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
  const { puzzle, edges, won, focusedRegion, keyboardCursor, anim } = state;
  const { W, H } = puzzle;
  const now = anim?.now ?? 0;

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

  // Mirrors `drawMarkedEdges`'s grow/shrink/pulse handling (see its doc
  // comment) — `lineWidth` is resolved once here per logical edge, then
  // reapplied identically to every tile copy below, since the animation's
  // progress doesn't depend on which repeated tile it's drawn in.
  const components = won ? null : computeEdgeComponents(edges);
  const baseMarkedWidth = Math.max(3, layout.cellSize * 0.32);
  const tiledMarkedEdges: Array<TiledEdge & { color: string; lineWidth: number }> = [];
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const liveColor = components ? segmentColor(components.get(ek)!) : COLORS.markedWon;
    const classified = classifyEdge(a, b, topology, W, H);

    const growStart = anim?.growing?.get(ek);
    const pulse = growStart === undefined ? anim?.pulsing?.get(ek) : undefined;
    let color = liveColor;
    let lineWidth = baseMarkedWidth;
    if (growStart !== undefined) {
      lineWidth = baseMarkedWidth * smoothstep((now - growStart) / GROW_MS);
    } else if (pulse) {
      const t = (now - pulse.start - pulse.delay) / PULSE_MS;
      if (t < 0) {
        color = pulse.fromColor;
      } else if (t <= 1) {
        lineWidth = baseMarkedWidth * (1 + PULSE_BULGE * Math.sin(Math.PI * t));
        color = t < 0.5 ? pulse.fromColor : liveColor;
      }
    }
    if (lineWidth >= MIN_VISIBLE_WIDTH) tiledMarkedEdges.push({ ...classified, color, lineWidth });
  }
  if (anim?.shrinking) {
    for (const [ek, shrink] of anim.shrinking) {
      if (edges.has(ek)) continue;
      const lineWidth = baseMarkedWidth * (1 - smoothstep((now - shrink.start) / SHRINK_MS));
      if (lineWidth < MIN_VISIBLE_WIDTH) continue;
      const [a, b] = parseEdgeKey(ek);
      const classified = classifyEdge(a, b, topology, W, H);
      tiledMarkedEdges.push({ ...classified, color: shrink.color, lineWidth });
    }
  }

  // Same "one entry per collection edge" shape as `tiledMarkedEdges`, computed
  // once up front so `forEachTile` below only has to re-project (not
  // re-derive) each collection edge's color/badge per tile copy — see
  // `drawEdgeCollectionHalos`/`drawEdgeCollectionBadges`'s single-tile
  // versions for what this is mirroring.
  const tiledCollectionHalos: Array<TiledEdge & { color: string }> = [];
  const tiledCollectionBadges: Array<TiledEdge & { text: string; fill: string }> = [];
  for (const collection of puzzle.edgeCollections ?? []) {
    const color = collectionColor(collection.id);
    const fill = collectionBadgeFill(collection, edges);
    const text = String(collection.required);
    for (const ek of collection.edges) {
      const [a, b] = parseEdgeKey(ek);
      const classified = classifyEdge(a, b, topology, W, H);
      tiledCollectionHalos.push({ ...classified, color });
      tiledCollectionBadges.push({ ...classified, text, fill });
    }
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

  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(5, layout.cellSize * 0.5);
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY, color } of tiledCollectionHalos) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, tileDX, tileDY);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
      const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  });

  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
  ctx.lineCap = 'round';
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY } of tiledEdges) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, tileDX, tileDY);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
      const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
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

  ctx.lineCap = 'round';
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY, color, lineWidth } of tiledMarkedEdges) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, tileDX, tileDY);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
      const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  });

  if (tiledCollectionBadges.length > 0) {
    const r = Math.max(7, layout.cellSize * 0.26);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(9, r * 1.15)}px sans-serif`;
    forEachTile((tileX, tileY) => {
      const oFrom = topology.tileOrientation(tileX, tileY);
      for (const { from, to, tileDX, tileDY, text, fill } of tiledCollectionBadges) {
        const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
        const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, tileDX, tileDY);
        const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
        const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
        drawBadge(ctx, (sx1 + sx2) / 2, (sy1 + sy2) / 2, r, text, fill);
      }
    });
  }

  if (anim?.winLoop && anim.winLoop.cells.length >= 2) {
    const { cells, startTime } = anim.winLoop;
    const periodMs = winDotPeriodMs(cells.length);
    const frac = (((now - startTime) % periodMs) + periodMs) % periodMs / periodMs;
    const pos = frac * cells.length;
    const i = Math.floor(pos) % cells.length;
    const localT = pos - Math.floor(pos);
    // `classifyEdge` returns `from`/`to` by reference to whichever of `a`/`b` it
    // picked as the canonical near endpoint — reference-compare against `a` to
    // know whether `localT` (a's-side-first) needs flipping to match.
    const a = cells[i];
    const b = cells[(i + 1) % cells.length];
    const classified = classifyEdge(a, b, topology, W, H);
    const dotT = classified.from === a ? localT : 1 - localT;
    const r = Math.max(4, layout.cellSize * 0.24);
    ctx.fillStyle = COLORS.winDot;
    forEachTile((tileX, tileY) => {
      const oFrom = topology.tileOrientation(tileX, tileY);
      const [sx1, sy1] = toScreenTiled(classified.from, layout, tileX, tileY, W, H, oFrom);
      const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, classified.tileDX, classified.tileDY);
      const oTo = classified.tileDX === 0 && classified.tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
      const [sx2, sy2] = toScreenTiled(classified.to, layout, toTileX, toTileY, W, H, oTo);
      ctx.beginPath();
      ctx.arc(sx1 + (sx2 - sx1) * dotT, sy1 + (sy2 - sy1) * dotT, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

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
