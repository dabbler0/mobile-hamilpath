import { faceToScreen, faceToScreenTiled, toScreen, toScreenTiled, wrapToTile, type Layout } from './game/geometry';
import { edgeKey, parseEdgeKey, type EdgeKey, type Face, type Region } from './game/regions';
import { countCollectionEdges, key, parseKey, type CellKey, type EdgeCollection, type Puzzle } from './game/puzzle';
import { topologyFor, wrappedNeighbor, type Orientation, type Topology } from './game/topology';
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
  /**
   * Every marked edge's *persistent* color index (see `game/componentColors.ts`)
   * — omitted/ignored whenever `won` (a win is one component with the single
   * flat "solved" color, so there's nothing to look up). `main.ts` owns the
   * `ComponentColorState` this is derived from and recomputes it once per
   * render; `render.ts` itself stays a pure function of whatever's handed
   * to it, same as everything else here.
   */
  componentColors?: ReadonlyMap<EdgeKey, number> | null;
  /**
   * Optional halo overlay of the puzzle's intended solution edges, drawn
   * *underneath* the ordinary board (`drawSingleTile`/`drawWrapped` draw it
   * first, then repaint the real candidate/node/marked-edge picture on top —
   * see `drawGhostHalo`'s doc comment for the technique and why) — shown
   * once a Blitz run's board is "final" (the run ended, or its own replay
   * reached the end) so the player can compare their own attempt against
   * the answer without leaving the board they were just looking at
   * (`main.ts`'s "Blitz mode" section). A solution edge the player also
   * marked reads as a thin, uniform halo flush against their own stroke; a
   * solution edge they *didn't* mark reads as the same halo with plain
   * background (and the thin candidate line) showing through the middle —
   * an obvious empty outline, distinct from — but legible right alongside —
   * every other color already on screen. Every edge in this set gets the
   * same halo regardless of whether it's also in `edges`. Omitted/`null`/
   * empty for the ordinary case (nothing to overlay).
   */
  ghostEdges?: ReadonlySet<EdgeKey> | null;
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
  /**
   * The perpetual "comet" that replaces a completed puzzle's flat solved
   * color once the winning move's recolor ripple finishes (see `main.ts`'s
   * "Animations" section): `cells` is the loop's cell cycle (same data the
   * old traveling dot used), `startIndex` is which cell the comet began at
   * (wherever the ripple last reached), and `startTime` is when it was
   * there. `null`/absent whenever the board isn't in a completed state, or
   * is but the ripple hasn't finished yet (main.ts holds off on setting
   * this until then).
   */
  winComet?: { cells: ReadonlyArray<readonly [number, number]>; startIndex: number; startTime: number } | null;
}

/** How long a newly-marked edge takes to grow from zero to full *width* (drawn full-length the whole time), and a newly-unmarked one to shrink back to zero width — `pathEdit.ts`'s `toggleRegion` is the only thing that starts one (see `main.ts`'s `scheduleToggleAnimation`). */
export const GROW_MS = 220;
export const SHRINK_MS = 220;
/** How long one edge's recolor "pulse" (width bulge + color swap at its peak) lasts, once its ripple delay has elapsed. */
export const PULSE_MS = 260;
/**
 * Per-hop pace, in ms, for the **endgame** (winning move's "everything
 * turns green") ripple and the **postgame** win-comet's constant travel
 * speed once that ripple hands off to it — see `midgameRippleDelayMs` for
 * the ordinary in-game (merge/split) ripple, which does *not* use this
 * directly any more (see its own doc comment for why). Exported so
 * `main.ts` can share the exact same value when scheduling the endgame
 * ripple's pulse delays and computing when it (and so the comet) finishes.
 */
export const RIPPLE_STAGGER_MS = 45;
/**
 * Per-hop delay, in ms, for an ordinary **midgame** recolor ripple (a
 * merge/split during play, `main.ts`'s `computeRecoloredEdges` case) —
 * unlike the endgame/postgame ripples above, this speeds up geometrically
 * as it travels rather than moving at a constant pace, so the *total* time
 * to sweep an entire connected component is logarithmic in that
 * component's size instead of linear: doubling the remaining distance only
 * costs one more constant-size time increment (`RIPPLE_STAGGER_MS` per
 * doubling, via `log2`), rather than one more `RIPPLE_STAGGER_MS` per hop.
 * A midgame ripple's whole job is to draw the eye to what just changed —
 * on a huge board that shouldn't take proportionally longer just because
 * there's more board to cover, unlike the endgame/postgame ripples, whose
 * "same pace as everything else, just possibly longer" is the intended
 * feel for what's more of a deliberate little celebration (see their own
 * doc comments). `distance === 0` (the toggled edges themselves) never
 * reaches this — those animate as a grow/shrink instead, not a pulse.
 */
export function midgameRippleDelayMs(distance: number): number {
  return RIPPLE_STAGGER_MS * Math.log2(distance + 1);
}
const PULSE_BULGE = 0.85;
/** Below this a stroke is treated as invisible and skipped — canvas ignores/normalizes `ctx.lineWidth = 0` rather than actually drawing nothing, so a grow/shrink's endpoints would otherwise flash a stray hairline. */
const MIN_VISIBLE_WIDTH = 0.5;
/**
 * A marked edge that's locked (`Puzzle.lockedEdges` — see `game/edgeLock.ts`)
 * draws at this fraction of normal opacity instead of the usual fully-opaque
 * 1, so a pre-marked "given" edge reads visually distinct from one the
 * player actually toggled themselves — same color/component, same width and
 * animation behavior otherwise, just dimmer. Suppressed once `won` (a win's
 * flat, uniform "solved" color has nothing left to distinguish — see
 * `drawMarkedEdges`/`drawWrapped`'s own `components = won ? null : ...`
 * reasoning), so the celebratory win state stays visually clean.
 */
const LOCKED_EDGE_OPACITY = 0.55;

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linearly interpolates between two `#rrggbb` colors — used for the win-comet's bright-to-dark fade. */
function lerpColor(from: string, to: string, t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const [r1, g1, b1] = hexToRgb(from);
  const [r2, g2, b2] = hexToRgb(to);
  return `rgb(${Math.round(r1 + (r2 - r1) * c)}, ${Math.round(g1 + (g2 - g1) * c)}, ${Math.round(b1 + (b2 - b1) * c)})`;
}

const COLORS = {
  background: '#14151a',
  edge: '#33353e',
  node: '#45474f',
  markedWon: '#35c46a',
  regionFocus: 'rgba(127, 184, 255, 0.22)',
  cursor: '#e8e8ea',
  /** The far, faded end of the win-comet's tail (see `computeCometStyles`) — `markedWon` itself is reused as the comet's bright head color, so a completed puzzle's coloring stays anchored to the same "solved" green it's always been, just animated now. */
  winCometDark: '#173a24',
  /** Badge color for an edge collection whose currently-marked count doesn't match its `required` count — see `drawEdgeCollectionBadges`. */
  collectionError: '#e6483c',
  /** Badge text/outline color, kept constant across both the normal (collection-color) and error-red badge fills for contrast. */
  collectionBadgeText: '#ffffff',
  /**
   * The Blitz result "intended solution" halo — see
   * `RenderState.ghostEdges`/`drawGhostHalo`. A bright emerald, distinct
   * from (if in the same general family as) `markedWon`'s more forest
   * green — sharing the hue doesn't read as confusing "this is actually
   * won" the way it would for a translucent fill over the edge itself (an
   * earlier design tried here, see `drawGhostHalo`'s doc comment), since a
   * thin halo rim is a visually distinct *language* from a thick
   * marked-edge stroke, legible right alongside it rather than blended
   * into it.
   */
  ghostSolution: '#34d399',
};

export interface CometStyle {
  color: string;
  /** Multiplies the ordinary marked-edge width — 1 well behind the comet's head, bulging up past 1 right at/just behind it (see `computeCometStyles`). */
  widthMultiplier: number;
}

/**
 * Colors (and, right at the comet's head, temporarily widens) every edge of
 * a completed loop for the win-comet: a bright head (`COLORS.markedWon`)
 * travels forward around `cells` at a constant pace (`RIPPLE_STAGGER_MS`
 * per hop, same as an ordinary recolor ripple), with each edge fading from
 * bright to `COLORS.winCometDark` the longer it's been since the comet last
 * passed over it — reaching fully dark right as the comet is about to lap
 * back around to it, since the fade's duration is exactly one full lap
 * (`cells.length * RIPPLE_STAGGER_MS`), which is what makes the fade pace
 * scale with board size the way `main.ts`'s doc comment on this feature
 * describes.
 *
 * The width bulge peaks *at* the comet's exact head (`sincePassedHops ===
 * 0`) and eases back down to normal width over the trailing
 * `PULSE_MS`-ish window behind it — deliberately not the symmetric
 * grow-then-shrink shape an ordinary recolor pulse uses (which is zero at
 * *both* ends of its own window, since it's a one-shot event with nothing
 * before or after it to stay connected to). The comet's frontier has
 * nothing analogous to "before" — it's *always* mid-motion — so if it used
 * that same symmetric shape, its bulge would have to ramp up from zero
 * every time it (re)starts, which is exactly what caused a visible stutter
 * right at the ripple-to-comet handoff (the ripple's own bulge fading to
 * nothing as it runs out of new edges to animate, at the same moment the
 * comet's would still be ramping up from zero). Peaking immediately at the
 * head instead means the frontier is *always* at full bulge somewhere,
 * continuously, with nothing to hand off to — see `main.ts`'s doc comment
 * on `pendingCometStart` for how the timing lines up with the ripple.
 *
 * `colorAgeHops` (used only for color, never for the width bulge — see
 * below) is capped at `elapsedHops`: every edge the comet hasn't actually
 * passed *yet* in its very first lap has never truly been "passed" at all,
 * so the ordinary wraparound math (which would otherwise treat "not yet
 * reached" as "reached almost a full lap ago", i.e. nearly the darkest
 * color) is wrong for it — capping at how long the comet has been running
 * at all instead means every edge starts out exactly as bright as the
 * winning ripple just left it (`elapsedHops` is `0` the instant the comet
 * starts, so every edge's age is `0` too), and only the arc actually behind
 * the comet's head darkens for real until a full lap has passed and the cap
 * stops applying anywhere — this is what turns the ripple-to-comet handoff
 * into a seamless continuation instead of the rest of the board abruptly
 * jumping from flat bright green to a mostly-dark field the instant the
 * comet takes over.
 */
function computeCometStyles(cells: ReadonlyArray<readonly [number, number]>, startIndex: number, startTime: number, now: number): Map<EdgeKey, CometStyle> {
  const n = cells.length;
  const styles = new Map<EdgeKey, CometStyle>();
  if (n < 2) return styles;
  const elapsedHops = (now - startTime) / RIPPLE_STAGGER_MS;
  const cometPos = (((startIndex + elapsedHops) % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const ek = edgeKey(cells[i], cells[(i + 1) % n]);
    // How many hops ago the comet was at this edge's position, wrapping — 0
    // right under the comet's head, approaching `n` (a full lap) just before
    // it laps back around to relight this edge.
    const sincePassedHops = (((cometPos - i) % n) + n) % n;
    const colorAgeHops = Math.min(sincePassedHops, elapsedHops);
    const color = lerpColor(COLORS.markedWon, COLORS.winCometDark, colorAgeHops / n);
    // Deliberately keyed to the *uncapped* distance — capping this too would
    // make the entire not-yet-reached arc bulge in width together during the
    // first lap (since they'd all briefly share the same small `elapsedHops`
    // age), instead of the bulge staying a single small pulse localized right
    // at the comet's actual head.
    const tPulse = (sincePassedHops * RIPPLE_STAGGER_MS) / PULSE_MS;
    const widthMultiplier = 1 + PULSE_BULGE * (1 - smoothstep(tPulse));
    styles.set(ek, { color, widthMultiplier });
  }
  return styles;
}

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

/** Converts an `h` (degrees, any real number — wrapped mod 360)/`s`/`l` (both `0..1`) color to a `#rrggbb` string, so `segmentColor` below can hand back the same hex-string shape every other color in this file uses. */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1: number, g1: number, b1: number;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/** Decomposes a `#rrggbb` color into `[hue (degrees), saturation, lightness]` (the latter two `0..1`) — the inverse of `hslToHex` above. */
function rgbToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return [0, 0, l];
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  const s = delta / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}
const [WON_HUE] = rgbToHsl(COLORS.markedWon);
/** Half-width, in degrees, of the hue band kept clear on either side of `WON_HUE` — wide enough that no procedurally-generated component color reads as "basically the victory green" while a puzzle is still in progress. */
const WON_HUE_EXCLUSION = 30;
/** Fractional part of the golden ratio — an irrational step, so `frac(i * GOLDEN_RATIO_CONJUGATE)` never lands on the same value twice for distinct integer `i` (up to floating-point precision) and spreads new values evenly between whatever's already been used, rather than needing to know in advance how many colors will ever be requested. Same "golden angle" trick used to scatter points/hues with maximal, ever-increasing coverage. */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
/**
 * The very first entry of `SEGMENT_COLORS`, the fixed 8-color palette this
 * game used before component colors were generated procedurally — kept
 * here (rather than deleted along with the rest of that palette) purely as
 * the anchor for `component === 0`'s color below, since it's a specific
 * hand-picked blue this game's design already settled on once and there's
 * no reason to pick a *different* blue now that generation is procedural.
 */
const HANDPICKED_FIRST_COLOR = '#3987e5';
/**
 * Saturation/lightness are held constant across every generated color
 * (rather than also varied procedurally) so they all stay similarly
 * legible against `COLORS.background` — and are pinned to
 * `HANDPICKED_FIRST_COLOR`'s own saturation/lightness specifically, so that
 * combined with `BASE_FRAC` below reproducing its hue exactly,
 * `segmentColor(0)` comes back out *byte-identical* to the original
 * hand-picked color, not just a same-hue approximation of it.
 */
const [BASE_HUE, SEGMENT_SATURATION, SEGMENT_LIGHTNESS] = rgbToHsl(HANDPICKED_FIRST_COLOR);
/** How much of the hue circle the walk actually gets to use, and where that usable arc begins — the band around `WON_HUE` is off limits (see `segmentColor`'s doc comment), so a `frac` in `[0, 1)` maps onto the remaining `360 - 2 * WON_HUE_EXCLUSION` degrees starting right past the band's far edge. */
const WALKABLE_ARC = 360 - 2 * WON_HUE_EXCLUSION;
const ARC_START = WON_HUE + WON_HUE_EXCLUSION;

/** Maps a walk position `frac` (`[0, 1)`, wrapping) to the hue it lands on within the walkable arc — the forward half of the pair below. */
function arcFracToHue(frac: number): number {
  return (ARC_START + frac * WALKABLE_ARC) % 360;
}

/** Inverse of `arcFracToHue`: which walk position lands exactly on `hue`, assuming `hue` already sits on the walkable arc (i.e. outside the excluded band around `WON_HUE` — true of `BASE_HUE`, an ordinary blue nowhere near the victory green). Used only to anchor the walk's starting point below. */
function hueToArcFrac(hue: number): number {
  const t = (((hue - ARC_START) % 360) + 360) % 360;
  return t / WALKABLE_ARC;
}

/** A plain, unmixed red — what the walk's *direction* (below) is chosen to land the walk's near-red color (walk position 1 — see `colorWalkIndex` just below for why that's not necessarily `component === 1`) closest to. */
const RED_HUE = 0;

/**
 * Swaps which two walk *positions* components 1 and 9 land on, so that
 * `segmentColor(1)` (the second connected-component color, in this game's
 * 1-based player-facing counting) comes out the same as the *old*
 * `segmentColor(9)` (the tenth) used to be, per this feature's request —
 * rather than the near-red hue the golden-angle walk naturally puts at
 * position 1 (see `WALK_DIRECTION`'s doc comment). A plain swap of two
 * finite walk positions, applied before the walk formula runs, is enough:
 * the walk itself never changes, so every position it can ever produce
 * (including 1 and 9 themselves, just relabeled) is still hit by exactly
 * one component index, and two distinct indices still never land on the
 * same walk position — the uniqueness `segmentColor`'s doc comment
 * describes is a property of the walk, not of which index we ask it to
 * evaluate at. Every index other than 1 and 9 is unaffected. Component 0
 * is untouched, so it still always lands on `BASE_HUE` as before.
 */
function colorWalkIndex(component: number): number {
  if (component === 1) return 9;
  if (component === 9) return 1;
  return component;
}

function circularHueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** The walk's starting position: `component === 0` always lands exactly on `BASE_HUE` (`HANDPICKED_FIRST_COLOR`'s own hue). */
const BASE_FRAC = hueToArcFrac(BASE_HUE);
/**
 * The walk's direction: `+1` steps forward through the golden-angle
 * sequence, `-1` steps backward (still irrational, so uniqueness is
 * unaffected either way — see `GOLDEN_RATIO_CONJUGATE`'s doc comment).
 * With the start pinned to `BASE_FRAC` above, this sign is the only knob
 * left to influence where `component === 1` lands, so it's picked —
 * computed once here rather than hardcoded, so it keeps re-deriving the
 * better choice if `HANDPICKED_FIRST_COLOR`/`WON_HUE`/`WON_HUE_EXCLUSION`
 * ever change — as whichever direction's `component === 1` comes closer to
 * `RED_HUE`.
 */
const WALK_DIRECTION: 1 | -1 = (() => {
  const forwardHue = arcFracToHue((BASE_FRAC + GOLDEN_RATIO_CONJUGATE) % 1);
  const backwardHue = arcFracToHue((((BASE_FRAC - GOLDEN_RATIO_CONJUGATE) % 1) + 1) % 1);
  return circularHueDistance(forwardHue, RED_HUE) <= circularHueDistance(backwardHue, RED_HUE) ? 1 : -1;
})();

/**
 * One color per connected component of marked edges, so it's easy to tell
 * how many separate segments/cycles are on the board and which edges belong
 * to which. The *index* passed in here is a persistent color assignment from
 * `game/componentColors.ts`, not the raw, iteration-order id
 * `edgeComponents.ts`'s `computeEdgeComponents` returns — a component keeps
 * showing the same color across edits (merges resolve to the lower-index
 * "blue wins" color, a vanished component's color stays free rather than
 * shifting everything after it down) instead of an arbitrary color swap
 * whenever some unrelated component's numbering happens to shift. See
 * `componentColors.ts`'s doc comment for the full assignment rules.
 *
 * Colors are generated procedurally rather than picked from a fixed
 * palette (an earlier version of this game cycled through eight hand-picked
 * `SEGMENT_COLORS`, which meant a board with a ninth live component reused
 * color #0 and became visually indistinguishable from it) — every distinct
 * `component` index gets a hue found by walking the golden-angle sequence
 * above, so two components are never colored alike no matter how many are
 * ever on screen at once, without needing an upper bound baked in anywhere.
 * The hue walk's range excludes a band around `WON_HUE` (the "solved" green
 * — see `COLORS.markedWon`) so an in-progress segment is never mistakable,
 * even briefly, for the fully-solved color: the walk covers only
 * `WALKABLE_ARC` degrees *outside* that band, mapped back onto the real hue
 * circle starting right past the band's far edge (`ARC_START`). Component 0
 * always lands exactly on `BASE_HUE` — `HANDPICKED_FIRST_COLOR`'s own hue,
 * reproduced byte-for-byte since `SEGMENT_SATURATION`/`SEGMENT_LIGHTNESS`
 * are pinned to that same color's saturation/lightness too — so the one
 * color from the old hand-picked palette this game's design had already
 * settled on survives into the procedural walk exactly as it looked
 * before, rather than the walk picking some arbitrary blue of its own.
 * `WALK_DIRECTION` is then chosen so walk position 1 lands as close to a
 * plain red as a single fixed step size can manage from that anchor,
 * without disturbing where position 0 landed. Every later position still
 * just keeps walking the same golden-angle step from there, so
 * uniqueness/coverage past those first two is completely unaffected.
 *
 * The `component` index passed in is remapped through `colorWalkIndex`
 * before evaluating the walk — see its own doc comment — so that the
 * near-red hue the walk naturally puts at position 1 shows up as this
 * game's *tenth* component color instead of its second, without disturbing
 * uniqueness or where any other component's color lands.
 */
export function segmentColor(component: number): string {
  const walkIndex = colorWalkIndex(component);
  const frac = (((BASE_FRAC + WALK_DIRECTION * walkIndex * GOLDEN_RATIO_CONJUGATE) % 1) + 1) % 1;
  return hslToHex(arcFracToHue(frac), SEGMENT_SATURATION, SEGMENT_LIGHTNESS);
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
    drawSingleTile(ctx, canvasWidth, canvasHeight, state, layout);
  }
}

function drawSingleTile(ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number, state: RenderState, layout: Layout): void {
  const { puzzle, edges, won, focusedRegion, keyboardCursor, anim, componentColors, ghostEdges } = state;
  if (focusedRegion) drawRegionHighlight(ctx, focusedRegion, layout);
  drawEdgeCollectionHalos(ctx, puzzle, layout);
  drawEdges(ctx, puzzle, layout);
  drawNodes(ctx, puzzle, layout);
  drawMarkedEdges(ctx, edges, won, layout, anim, componentColors, puzzle.lockedEdges);
  drawEdgeCollectionBadges(ctx, puzzle, edges, layout);
  if (!won) drawDegreeWarnings(ctx, puzzle, edges, layout);
  // Drawn last, genuinely on top of everything above (including a marked
  // edge's own color and the degree-warning reveal) — see `drawGhostHalo`'s
  // doc comment for why this needs an offscreen canvas rather than just
  // moving earlier in this list the way `drawEdgeCollectionHalos` does.
  if (ghostEdges && ghostEdges.size > 0) drawGhostHalo(ctx, ghostEdges, layout, canvasWidth, canvasHeight);
  if (keyboardCursor) drawCursor(ctx, keyboardCursor, layout);
}

/**
 * Halo overlay of the puzzle's intended solution — see
 * `RenderState.ghostEdges`'s doc comment. Drawn dead last in
 * `drawSingleTile`, genuinely on top of everything else (a marked edge's
 * own color, a degree-warning reveal, all of it), rather than underneath
 * with the ordinary passes redrawing over it — this needs a real *hole*
 * carved through an otherwise-opaque ring shape, not just "something drawn
 * earlier gets painted over later", so it has to happen on an isolated
 * offscreen canvas: draw the thick outer ring in the halo color, then erase
 * a `markedEdgeBaseWidth`-wide (the same width a real marked edge is drawn
 * at) strip back out of it with `globalCompositeOperation:
 * 'destination-out'`, which only works correctly here because it's erasing
 * pixels *this function itself just drew* on a canvas that started fully
 * transparent — running the same erase directly against `ctx` would punch a
 * hole straight through the real board underneath it instead. `drawImage`
 * then stamps the finished ring (opaque halo color, with a genuinely
 * transparent gap down the middle) onto `ctx` in one shot: the gap's
 * zero-alpha pixels leave whatever's already on `ctx` untouched, which is what makes
 * the marked edge's own color (or the degree-warning reveal, or the plain
 * candidate line) show through the middle exactly as before, with the halo
 * now sitting visibly on top everywhere else. Mirrors
 * `drawDegreeWarningReveal`'s own "isolated offscreen canvas +
 * composite-mode trick, then one `drawImage` back onto the real `ctx`"
 * shape, just with `destination-out` carving a hole instead of
 * `destination-in` masking a radial fade.
 *
 * Two edges sharing a vertex still join seamlessly at every corner, exactly
 * as before: both the outer ring and the inner erase are drawn per-edge
 * with round caps centered at the same shared vertex point, so overlapping
 * caps blend (ring) or erase (hole) identically regardless of which edge
 * "arrives" at that point first — no offset math, no line-join handling.
 *
 * (Earlier versions of this either drew a single translucent stroke
 * directly over the edge — muddy against the player's own marked-edge
 * coloring — or two independently-offset thin lines per edge — which
 * self-intersected or gapped at a turn, since each edge's own offset
 * direction has nothing to do with its neighbor's — or this same
 * thick-ring-then-erase shape but drawn *underneath* everything else,
 * relying on the ordinary candidate/node/marked-edge passes to redraw on
 * top of it; that got flush corners for free but could only ever sit
 * *behind* the rest of the board, not on top of it.)
 */
function drawGhostHalo(ctx: CanvasRenderingContext2D, edges: ReadonlySet<EdgeKey>, layout: Layout, canvasWidth: number, canvasHeight: number): void {
  const outerWidth = markedEdgeBaseWidth(layout) + 2 * ghostHaloLineWidth(layout);
  const innerWidth = markedEdgeBaseWidth(layout);

  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.ceil(canvasWidth));
  off.height = Math.max(1, Math.ceil(canvasHeight));
  const octx = off.getContext('2d');
  if (!octx) return;

  octx.lineCap = 'round';
  octx.strokeStyle = COLORS.ghostSolution;
  octx.lineWidth = outerWidth;
  strokeGhostEdges(octx, edges, layout);

  octx.globalCompositeOperation = 'destination-out';
  octx.lineWidth = innerWidth;
  strokeGhostEdges(octx, edges, layout);

  ctx.drawImage(off, 0, 0);
}

/** Strokes every ghost edge at `ctx`'s currently-set `strokeStyle`/`lineWidth` — the one piece of `drawGhostHalo`'s two passes (and `drawWrapped`'s own tiled equivalent) that's actually per-edge geometry, factored out so both passes (and both single-tile/wrapped call sites) share it instead of repeating the same loop body. */
function strokeGhostEdges(ctx: CanvasRenderingContext2D, edges: ReadonlySet<EdgeKey>, layout: Layout): void {
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const [sx1, sy1] = toScreen(a, layout);
    const [sx2, sy2] = toScreen(b, layout);
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
  }
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

/**
 * Every cell's current marked-degree (how many currently-marked edges touch
 * it), keyed by `CellKey` — a cell with no marked edges at all simply has no
 * entry, same "absence means zero" convention `isBoundaryEnclosed`'s own
 * degree map uses. A finished win always has every cell at exactly 2
 * (`computeWin`'s own check), but a region toggle mid-game is free to create
 * a cell with *more* than 2 (two unrelated toggles both routing a marked
 * edge through the same corner, say) — `drawDegreeWarnings`/its tiled-board
 * counterpart below flag any such cell on screen, rather than leaving the
 * player to notice the problem unaided.
 */
function computeMarkedDegrees(edges: ReadonlySet<EdgeKey>): Map<CellKey, number> {
  const degree = new Map<CellKey, number>();
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const ka = key(a[0], a[1]);
    const kb = key(b[0], b[1]);
    degree.set(ka, (degree.get(ka) ?? 0) + 1);
    degree.set(kb, (degree.get(kb) ?? 0) + 1);
  }
  return degree;
}

/**
 * Width a marked edge is drawn at before any grow/shrink/pulse/comet
 * scaling — factored out of `drawMarkedEdges`/`drawWrapped` so
 * `degreeWarningRadius` below can size the degree-warning halo relative to
 * the *real* path width instead of a second, independently-guessed magic
 * number.
 */
function markedEdgeBaseWidth(layout: Layout): number {
  return Math.max(3, layout.cellSize * 0.32);
}

/** Thickness of each side of `drawGhostHalo`'s rim — thin relative to a marked edge, matching `drawEdges`' own candidate-edge line width. */
function ghostHaloLineWidth(layout: Layout): number {
  return Math.max(1.5, layout.cellSize * 0.09);
}

/**
 * Radius of the halo's fully-opaque "core" — the flat plateau at the center
 * of `drawDegreeWarningHalo`'s gradient, before the fade to transparent even
 * begins. Sizing this to just barely exceed the stroke width itself isn't
 * enough: at an actual self-intersection, two *perpendicular* marked-edge
 * strokes (each `markedEdgeBaseWidth` wide) overlap in a `w x w` square, and
 * that square's corners — the crossing's true worst-case extent — sit `w *
 * Math.SQRT2` apart on the diagonal, not just `w` apart straight across.
 * Sized here to `markedEdgeBaseWidth` itself (i.e. a core *diameter* of `2 *
 * w`), comfortably past that `sqrt(2) * w` minimum, so the core alone is
 * guaranteed to fully cover the crossing corner-to-corner, not merely
 * stroke-width-to-stroke-width: every converging edge reads as unambiguously
 * *cut*, not just dimmed, with the fade only starting past that.
 */
function degreeWarningCoreRadius(layout: Layout): number {
  return markedEdgeBaseWidth(layout);
}

/**
 * Outer radius of the degree-warning "fade" halo (see
 * `drawDegreeWarningHalo`) — reaches about halfway along each edge
 * converging on the vertex (`cellSize / 2`: half the distance to that
 * edge's *other* endpoint) before fully fading to transparent. The 2x2
 * block of faces surrounding an over-marked vertex is free space for this
 * halo to use — nothing else is ever drawn there except the converging
 * edges themselves — so the fade can safely reach much farther than the old
 * ring's tight radius (or `degreeWarningCoreRadius` alone) without risking
 * painting over an unrelated edge or vertex on the far side.
 */
function degreeWarningRadius(layout: Layout): number {
  return Math.max(degreeWarningCoreRadius(layout) * 1.2, layout.cellSize * 0.5);
}

/**
 * Renders, into a small offscreen canvas, exactly the candidate-edge/vertex-
 * dot picture that would sit at `(sx, sy)` if the marked edges converging on
 * it weren't drawn at all, then composites that picture onto `ctx` faded
 * from fully opaque at `degreeWarningCoreRadius` out to fully transparent at
 * `degreeWarningRadius` — this feature's old plain red ring, then a flat
 * background-color halo, is now a genuine *reveal*: the converging marked
 * edges read as fading out of existence right where they cross, uncovering
 * the ordinary candidate edges/node dot underneath, rather than being
 * covered by an opaque patch of background color.
 *
 * This needs a real offscreen canvas (not just a clipped region of `ctx`
 * itself) because the fade has to mask an entire *picture* — a background
 * fill plus however many edge strokes and a node dot land within it — not a
 * single flat color: `ctx.globalAlpha` only ever applies one scalar, with no
 * way to vary a normal drawing operation's opacity smoothly across its own
 * pixels. `destination-in` against a radial-gradient mask is the standard
 * way to get that softness, but it has to run against a canvas that started
 * out holding *only* this reveal's own content, or it would just as happily
 * erase whatever else was already on `ctx` outside the small circle this is
 * meant to stay inside.
 *
 * `drawUnderlay` draws that content, already translated so its own `(sx,
 * sy)` lines up with the offscreen canvas's center — the single-tile and
 * wraparound-tile callers each supply their own version of it
 * (`drawDegreeWarningUnderlay`/`drawDegreeWarningUnderlayTiled`), since a
 * wraparound board's repeated tiles need `toScreenTiled` projections instead
 * of plain `toScreen`. `pixelScale` lets a wraparound caller — whose `ctx`
 * is already redrawn crisp at the board's current zoom every frame, see
 * `drawWrapped`'s own doc comment — rasterize the offscreen canvas at a
 * matching resolution, instead of this one small patch of the board going
 * soft at any zoom past 1:1 while everything drawn straight onto `ctx`
 * around it stays sharp. The ordinary single-tile board doesn't need this
 * (its canvas is a fixed-resolution bitmap panned/zoomed via a CSS
 * transform on the whole element, so this reveal blurring along with
 * everything else at extreme zoom is nothing new), so it always passes `1`.
 *
 * **Cached** (`degreeWarningCache`) rather than rebuilt from scratch on
 * every call: unlike every other overlay in this file, an over-marked cell
 * isn't a bounded-duration animation — a self-crossing board state can sit
 * there for as long as the player keeps panning/zooming/editing elsewhere —
 * and this content never actually depends on which *frame* is being drawn
 * (a marked edge is never part of it; only the static candidate edges/node
 * underneath are). Rebuilding it every frame regardless meant a fresh
 * `document.createElement('canvas')` plus a full radial-gradient composite
 * per warning cell, per frame — multiplied by every repeated tile copy a
 * zoomed-out wraparound board shows at once — which was the measured source
 * of this feature's animation jank, not the (tiny) actual pixel work.
 * `cacheKey` is whatever the caller has already established distinguishes
 * one reveal's pixel content from another (cell identity alone for the
 * single-tile case; cell + tile `Orientation` + `pixelScale` bucket for the
 * tiled case, since those are the only other inputs this content actually
 * varies with — see both call sites). Invalidated wholesale
 * (`invalidateDegreeWarningCacheIfStale`) the moment the puzzle or layout
 * this cache was built against no longer matches.
 */
let degreeWarningCache = new Map<string, HTMLCanvasElement>();
let degreeWarningCachePuzzle: Puzzle | null = null;
let degreeWarningCacheCellSize = 0;
let degreeWarningCachePad = 0;

function invalidateDegreeWarningCacheIfStale(puzzle: Puzzle, layout: Layout): void {
  if (puzzle === degreeWarningCachePuzzle && layout.cellSize === degreeWarningCacheCellSize && layout.pad === degreeWarningCachePad) return;
  degreeWarningCache.clear();
  degreeWarningCachePuzzle = puzzle;
  degreeWarningCacheCellSize = layout.cellSize;
  degreeWarningCachePad = layout.pad;
}

function drawDegreeWarningReveal(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  layout: Layout,
  pixelScale: number,
  puzzle: Puzzle,
  cacheKey: string,
  drawUnderlay: (octx: CanvasRenderingContext2D) => void,
): void {
  invalidateDegreeWarningCacheIfStale(puzzle, layout);

  const r = degreeWarningRadius(layout);
  const size = Math.max(1, Math.ceil(r * 2));

  let off = degreeWarningCache.get(cacheKey);
  if (!off) {
    const coreR = degreeWarningCoreRadius(layout);
    off = document.createElement('canvas');
    off.width = Math.max(1, Math.ceil(size * pixelScale));
    off.height = off.width;
    const octx = off.getContext('2d');
    if (!octx) return;

    octx.scale(pixelScale, pixelScale);
    octx.fillStyle = COLORS.background;
    octx.beginPath();
    octx.arc(r, r, r, 0, Math.PI * 2);
    octx.fill();

    octx.translate(r - sx, r - sy);
    drawUnderlay(octx);
    // Undo the translate above (keeping `pixelScale`) before the mask fill
    // below, which needs to cover the offscreen canvas's own `size x size`
    // extent, not wherever the translate left the origin.
    octx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);

    // Only this gradient's *alpha* is ever used — `destination-in` reads
    // nothing else from its source — so the color itself is never painted.
    const mask = octx.createRadialGradient(r, r, 0, r, r, r);
    mask.addColorStop(0, 'rgba(0, 0, 0, 1)');
    mask.addColorStop(coreR / r, 'rgba(0, 0, 0, 1)');
    mask.addColorStop(1, 'rgba(0, 0, 0, 0)');
    octx.globalCompositeOperation = 'destination-in';
    octx.fillStyle = mask;
    octx.fillRect(0, 0, size, size);

    degreeWarningCache.set(cacheKey, off);
  }

  ctx.drawImage(off, sx - r, sy - r, size, size);
}

/**
 * `drawDegreeWarningReveal`'s content for a single-tile (non-wraparound)
 * board: `cell`'s own vertex dot, plus every candidate edge incident to
 * it — the only edges that can possibly reach inside `degreeWarningRadius`
 * at all (an edge that *doesn't* touch `cell` has both endpoints a full
 * `cellSize` or more away, well outside the half-a-cell reveal radius), so
 * this never needs to touch the rest of the board's edges/nodes the way
 * reusing `drawEdges`/`drawNodes` wholesale would — a real saving on a huge
 * board, where this can run every animation frame for as long as the
 * over-marked state persists.
 */
function drawDegreeWarningUnderlay(ctx: CanvasRenderingContext2D, cell: readonly [number, number], puzzle: Puzzle, layout: Layout): void {
  const ck = key(cell[0], cell[1]);
  const [sx, sy] = toScreen(cell, layout);
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
  ctx.lineCap = 'round';
  for (const nk of puzzle.adj.get(ck) ?? []) {
    const [nsx, nsy] = toScreen(parseKey(nk), layout);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(nsx, nsy);
    ctx.stroke();
  }
  const r = Math.max(1.5, layout.cellSize * 0.11);
  ctx.fillStyle = COLORS.node;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * `drawDegreeWarningReveal`'s content for one repeated tile copy of a
 * wraparound board — the tiled equivalent of `drawDegreeWarningUnderlay`:
 * `cell`'s own vertex dot plus its incident candidate edges, each projected
 * through `toScreenTiled`/`wrapToTile` exactly like `drawWrapped`'s own
 * edges pass does. `incidentEdges` is precomputed once per overfull cell by
 * the caller (`classifyEdge`'s result doesn't depend on which tile copy is
 * being drawn, only `toScreenTiled`'s projection of it does), not re-derived
 * per tile here.
 */
function drawDegreeWarningUnderlayTiled(
  ctx: CanvasRenderingContext2D,
  incidentEdges: readonly TiledEdge[],
  cell: readonly [number, number],
  layout: Layout,
  topology: Topology,
  tileX: number,
  tileY: number,
  W: number,
  H: number,
  orientation: Orientation,
): void {
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = Math.max(1.5, layout.cellSize * 0.09);
  ctx.lineCap = 'round';
  for (const { from, to, tileDX, tileDY } of incidentEdges) {
    const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, orientation);
    const [toTileX, toTileY] = wrapToTile(orientation, tileX, tileY, tileDX, tileDY);
    const oTo = tileDX === 0 && tileDY === 0 ? orientation : topology.tileOrientation(toTileX, toTileY);
    const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
  }
  const [sx, sy] = toScreenTiled(cell, layout, tileX, tileY, W, H, orientation);
  const r = Math.max(1.5, layout.cellSize * 0.11);
  ctx.fillStyle = COLORS.node;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draws the degree-warning reveal (`drawDegreeWarningReveal`) at every cell
 * whose marked-degree currently exceeds 2 (see `computeMarkedDegrees`) — a
 * state a win can never be in, so skipped outright whenever `won`. Drawn
 * after every other overlay (marked edges, collection badges) so the
 * warning is never obscured by an edge converging on the same point.
 */
function drawDegreeWarnings(ctx: CanvasRenderingContext2D, puzzle: Puzzle, edges: ReadonlySet<EdgeKey>, layout: Layout): void {
  for (const [ck, degree] of computeMarkedDegrees(edges)) {
    if (degree <= 2) continue;
    const cell = parseKey(ck);
    const [sx, sy] = toScreen(cell, layout);
    // `pixelScale` is always 1 and there's only ever one "tile", so the
    // cell key alone already uniquely identifies this reveal's content —
    // see `drawDegreeWarningReveal`'s caching doc comment.
    drawDegreeWarningReveal(ctx, sx, sy, layout, 1, puzzle, ck, (octx) => drawDegreeWarningUnderlay(octx, cell, puzzle, layout));
  }
}

function drawRegionHighlight(ctx: CanvasRenderingContext2D, region: Region, layout: Layout): void {
  ctx.fillStyle = COLORS.regionFocus;
  for (const face of region.faces) {
    const [sx, sy] = toScreen(face, layout);
    ctx.fillRect(sx, sy, layout.cellSize, layout.cellSize);
  }
}

interface MarkedEdgeDraw {
  sx1: number;
  sy1: number;
  sx2: number;
  sy2: number;
  color: string;
  lineWidth: number;
  /** `LOCKED_EDGE_OPACITY` for a locked edge, 1 for an ordinary one — see its doc comment. */
  alpha: number;
}

/** Draws a batch of marked-edge segments, widest last — see `drawMarkedEdges`'s doc comment for why draw order matters here. Resets `ctx.globalAlpha` back to 1 before returning, so a dimmed locked edge never bleeds into whatever's drawn right after (collection badges, the keyboard cursor). */
function strokeMarkedEdges(ctx: CanvasRenderingContext2D, draws: MarkedEdgeDraw[]): void {
  draws.sort((a, b) => a.lineWidth - b.lineWidth);
  for (const { sx1, sy1, sx2, sy2, color, lineWidth, alpha } of draws) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(sx1, sy1);
    ctx.lineTo(sx2, sy2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
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
 * doc comment for where these come from. Once the win-comet is running
 * (`anim.winComet`), its per-edge styles (`computeCometStyles`) take over
 * from the flat "solved" color/width for every edge that isn't otherwise
 * mid grow or pulse — this can only actually apply once every edge is done
 * pulsing, since that's the same moment `main.ts` starts the comet.
 *
 * Every edge is collected first and stroked in ascending-width order
 * (`strokeMarkedEdges`) rather than drawn immediately in `edges`' arbitrary
 * iteration order: two edges sharing a vertex both get rounded end caps
 * there, and whichever is drawn *second* paints over the first's cap at
 * that point — normally invisible since same-width neighbors' caps align,
 * but a temporarily-widened edge (grow/pulse/comet) drawn *before* an
 * ordinary-width neighbor lets that neighbor's thinner cap visibly bite
 * into the wide edge's join, reading as a notch right at a moving wave's
 * leading edge. Sorting so wider edges always draw last keeps a bulging
 * edge's join on top everywhere, regardless of `edges`' iteration order.
 *
 * `lockedEdges` (`Puzzle.lockedEdges`) draws any of its members at
 * `LOCKED_EDGE_OPACITY` instead of fully opaque — see that constant's doc
 * comment.
 */
function drawMarkedEdges(
  ctx: CanvasRenderingContext2D,
  edges: ReadonlySet<EdgeKey>,
  won: boolean,
  layout: Layout,
  anim?: AnimationState,
  componentColors?: ReadonlyMap<EdgeKey, number> | null,
  lockedEdges?: ReadonlySet<EdgeKey>,
): void {
  const baseWidth = markedEdgeBaseWidth(layout);
  ctx.lineCap = 'round';

  // A win is exactly one component covering every cell, so there's nothing to
  // tell apart — keep the single "solved" color instead of an arbitrary one
  // from the segment palette.
  const components = won ? null : componentColors;
  const now = anim?.now ?? 0;
  const cometStyles = anim?.winComet ? computeCometStyles(anim.winComet.cells, anim.winComet.startIndex, anim.winComet.startTime, now) : null;

  const draws: MarkedEdgeDraw[] = [];

  for (const ek of edges) {
    const cometStyle = cometStyles?.get(ek);
    const liveColor = cometStyle?.color ?? (components ? segmentColor(components.get(ek)!) : COLORS.markedWon);
    const [a, b] = parseEdgeKey(ek);
    const [sx1, sy1] = toScreen(a, layout);
    const [sx2, sy2] = toScreen(b, layout);

    const growStart = anim?.growing?.get(ek);
    const pulse = growStart === undefined ? anim?.pulsing?.get(ek) : undefined;

    let strokeStyle = liveColor;
    let lineWidth = baseWidth * (cometStyle?.widthMultiplier ?? 1);
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
    const alpha = !won && lockedEdges?.has(ek) ? LOCKED_EDGE_OPACITY : 1;
    draws.push({ sx1, sy1, sx2, sy2, color: strokeStyle, lineWidth, alpha });
  }

  if (anim?.shrinking) {
    for (const [ek, shrink] of anim.shrinking) {
      if (edges.has(ek)) continue; // shouldn't happen — a re-marked edge is dropped from `shrinking` by `main.ts`
      const lineWidth = baseWidth * (1 - smoothstep((now - shrink.start) / SHRINK_MS));
      if (lineWidth < MIN_VISIBLE_WIDTH) continue;
      const [a, b] = parseEdgeKey(ek);
      const [sx1, sy1] = toScreen(a, layout);
      const [sx2, sy2] = toScreen(b, layout);
      // A locked edge can never transition back to unmarked (it's excluded
      // from every region's boundary the moment it locks — see
      // `game/edgeLock.ts`), so it can never actually be shrinking; alpha 1
      // here is just completeness, not a real case this hits today.
      draws.push({ sx1, sy1, sx2, sy2, color: shrink.color, lineWidth, alpha: 1 });
    }
  }

  strokeMarkedEdges(ctx, draws);
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
  const { puzzle, edges, won, focusedRegion, keyboardCursor, anim, componentColors, ghostEdges } = state;
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

  // Mirrors `drawMarkedEdges`'s grow/shrink/pulse/comet handling (see its
  // doc comment) — `lineWidth`/`color` are resolved once here per logical
  // edge, then reapplied identically to every tile copy below, since the
  // animation's progress doesn't depend on which repeated tile it's drawn in.
  const components = won ? null : componentColors;
  const cometStyles = anim?.winComet ? computeCometStyles(anim.winComet.cells, anim.winComet.startIndex, anim.winComet.startTime, now) : null;
  const baseMarkedWidth = markedEdgeBaseWidth(layout);
  // `alpha` mirrors `drawMarkedEdges`'s own locked-edge dimming — see
  // `LOCKED_EDGE_OPACITY`'s doc comment.
  const tiledMarkedEdges: Array<TiledEdge & { color: string; lineWidth: number; alpha: number }> = [];
  for (const ek of edges) {
    const [a, b] = parseEdgeKey(ek);
    const cometStyle = cometStyles?.get(ek);
    const liveColor = cometStyle?.color ?? (components ? segmentColor(components.get(ek)!) : COLORS.markedWon);
    const classified = classifyEdge(a, b, topology, W, H);

    const growStart = anim?.growing?.get(ek);
    const pulse = growStart === undefined ? anim?.pulsing?.get(ek) : undefined;
    let color = liveColor;
    let lineWidth = baseMarkedWidth * (cometStyle?.widthMultiplier ?? 1);
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
    if (lineWidth >= MIN_VISIBLE_WIDTH) {
      const alpha = !won && puzzle.lockedEdges?.has(ek) ? LOCKED_EDGE_OPACITY : 1;
      tiledMarkedEdges.push({ ...classified, color, lineWidth, alpha });
    }
  }
  if (anim?.shrinking) {
    for (const [ek, shrink] of anim.shrinking) {
      if (edges.has(ek)) continue;
      const lineWidth = baseMarkedWidth * (1 - smoothstep((now - shrink.start) / SHRINK_MS));
      if (lineWidth < MIN_VISIBLE_WIDTH) continue;
      const [a, b] = parseEdgeKey(ek);
      const classified = classifyEdge(a, b, topology, W, H);
      // A locked edge can never become unmarked again — see the matching
      // note in `drawMarkedEdges` — so alpha 1 here is just completeness.
      tiledMarkedEdges.push({ ...classified, color: shrink.color, lineWidth, alpha: 1 });
    }
  }
  // Widest last, same reasoning (and same fix) as `drawMarkedEdges`'s own
  // `strokeMarkedEdges` — a bulging edge's rounded join should never get
  // painted over by a normal-width neighbor sharing its vertex.
  tiledMarkedEdges.sort((a, b) => a.lineWidth - b.lineWidth);

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

  // See `RenderState.ghostEdges`'s doc comment — classified once here
  // (like every other tiled overlay above), drawn further down, before the
  // ordinary candidate/node/marked-edge passes rather than after.
  const tiledGhostEdges: TiledEdge[] = [];
  if (ghostEdges) {
    for (const ek of ghostEdges) {
      const [a, b] = parseEdgeKey(ek);
      tiledGhostEdges.push(classifyEdge(a, b, topology, W, H));
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
    for (const { from, to, tileDX, tileDY, color, lineWidth, alpha } of tiledMarkedEdges) {
      const [sx1, sy1] = toScreenTiled(from, layout, tileX, tileY, W, H, oFrom);
      const [toTileX, toTileY] = wrapToTile(oFrom, tileX, tileY, tileDX, tileDY);
      const oTo = tileDX === 0 && tileDY === 0 ? oFrom : topology.tileOrientation(toTileX, toTileY);
      const [sx2, sy2] = toScreenTiled(to, layout, toTileX, toTileY, W, H, oTo);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1; // don't let a dimmed locked edge bleed into the collection badges/cursor drawn next

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

  // Same degree-warning reveal as `drawDegreeWarningReveal`'s single-tile
  // version (`drawDegreeWarningUnderlay`) — see its own doc comment — just
  // projected through `toScreenTiled` once per repeated tile copy, same as
  // every other overlay in this function. Each overfull cell's incident
  // edges are classified once, up front, rather than inside `forEachTile` —
  // `classifyEdge`'s result doesn't depend on which tile copy is being
  // drawn, only `toScreenTiled`'s projection of it does — and `view.scale`
  // is threaded through so the reveal's own offscreen canvas stays exactly
  // as crisp as everything else this function draws at the current zoom
  // (see `drawDegreeWarningReveal`'s `pixelScale` doc comment).
  if (!won) {
    const overfullCells: Array<readonly [number, number]> = [];
    for (const [ck, degree] of computeMarkedDegrees(edges)) {
      if (degree > 2) overfullCells.push(parseKey(ck));
    }
    if (overfullCells.length > 0) {
      const incidentEdgesByCell = overfullCells.map((cell) => {
        const ck = key(cell[0], cell[1]);
        const incident: TiledEdge[] = [];
        for (const nk of puzzle.adj.get(ck) ?? []) {
          incident.push(classifyEdge(cell, parseKey(nk), topology, W, H));
        }
        return incident;
      });
      // This reveal's content only varies with the cell, the tile's own
      // `Orientation` (only ever one of four flipX/flipY combos — see
      // `topology.ts`), and the current zoom (`pixelScale`, rounded to a
      // couple of decimal places so settling back to roughly the same zoom
      // level still hits the cache instead of missing on float noise) — not
      // with which particular repeated tile copy is being drawn (a fixed
      // orientation's tiles are pure translations of each other, and the
      // reveal is built pre-translated to its own local center regardless —
      // see `drawDegreeWarningReveal`'s caching doc comment) — so every tile
      // copy of the same cell reuses one cached canvas instead of building
      // its own.
      const pixelScaleKey = view.scale.toFixed(2);
      forEachTile((tileX, tileY) => {
        const orientation = topology.tileOrientation(tileX, tileY);
        const orientationKey = `${orientation.flipX ? 1 : 0}${orientation.flipY ? 1 : 0}`;
        overfullCells.forEach((cell, i) => {
          const [sx, sy] = toScreenTiled(cell, layout, tileX, tileY, W, H, orientation);
          const cacheKey = `${key(cell[0], cell[1])}::${orientationKey}::${pixelScaleKey}`;
          drawDegreeWarningReveal(ctx, sx, sy, layout, view.scale, puzzle, cacheKey, (octx) =>
            drawDegreeWarningUnderlayTiled(octx, incidentEdgesByCell[i], cell, layout, topology, tileX, tileY, W, H, orientation),
          );
        });
      });
    }
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

  // The ghost halo, drawn dead last — genuinely on top of everything else,
  // the same as the single-tile `drawGhostHalo` (see its doc comment for
  // the full offscreen-canvas + `destination-out` reasoning). The offscreen
  // canvas here mirrors `ctx`'s own currently-active pan/zoom transform
  // exactly (rather than `drawDegreeWarningReveal`'s plain `pixelScale`
  // scale-only transform), so the *same* `toScreenTiled`-projected
  // coordinates already used by every pass above land in the same place on
  // both — which is what lets the final composite be a single untransformed
  // `drawImage(off, 0, 0)`, crisp at any zoom level, with no separate
  // scale/translate math of its own to keep in sync. `ctx`'s transform has
  // to be reset to identity for that one `drawImage` call (`drawImage`
  // itself is subject to the current transform same as any other canvas
  // draw call, and `off`'s own pixels already *are* the final device-pixel
  // image) and then restored — nothing draws after this, but resetting it
  // unconditionally rather than assuming so is cheap insurance against a
  // future addition silently inheriting the wrong transform.
  if (ghostEdges && ghostEdges.size > 0) {
    const outerWidth = markedEdgeBaseWidth(layout) + 2 * ghostHaloLineWidth(layout);
    const innerWidth = markedEdgeBaseWidth(layout);

    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.ceil(canvasWidth));
    off.height = Math.max(1, Math.ceil(canvasHeight));
    const octx = off.getContext('2d');
    if (octx) {
      octx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
      octx.lineCap = 'round';
      octx.strokeStyle = COLORS.ghostSolution;
      octx.lineWidth = outerWidth;
      strokeTiledGhostEdges(octx, tiledGhostEdges, layout, topology, W, H, forEachTile);

      octx.globalCompositeOperation = 'destination-out';
      octx.lineWidth = innerWidth;
      strokeTiledGhostEdges(octx, tiledGhostEdges, layout, topology, W, H, forEachTile);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(off, 0, 0);
      ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
    }
  }

  ctx.restore();
}

/** Strokes every tiled ghost-edge segment, across every currently-visible repeated tile copy, at whichever `ctx`'s currently-set `strokeStyle`/`lineWidth` — the one piece of `drawGhostHalo`'s (wrapped-board) two passes that's actually per-edge-per-tile geometry, factored out so both passes share it instead of repeating the same nested loop body. */
function strokeTiledGhostEdges(
  ctx: CanvasRenderingContext2D,
  tiledGhostEdges: readonly TiledEdge[],
  layout: Layout,
  topology: Topology,
  W: number,
  H: number,
  forEachTile: (fn: (tileX: number, tileY: number) => void) => void,
): void {
  forEachTile((tileX, tileY) => {
    const oFrom = topology.tileOrientation(tileX, tileY);
    for (const { from, to, tileDX, tileDY } of tiledGhostEdges) {
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
}
