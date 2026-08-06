import { computeEdgeComponents } from './edgeComponents';
import { key, type CellKey } from './puzzle';
import { parseEdgeKey, type EdgeKey } from './regions';

/**
 * Persistent color-index assignment for connected components of marked
 * edges, layered on top of `edgeComponents.ts`'s `computeEdgeComponents`
 * (whose ids are only meaningful within a single call — see its doc
 * comment). Without this, a component's *displayed* color can change even
 * when nothing touching it changed, purely because some unrelated
 * component elsewhere merged or vanished and shifted the iteration-order
 * numbering (`segmentColor(component id)`) everything else happens to be
 * keyed by.
 *
 * `state.cellsByColor` is the previous snapshot's `color -> member cells`
 * (a component's identity, for matching purposes, is just the cells it
 * currently spans): `updateComponentColors` re-derives this frame's
 * components fresh via union-find (cheap, and it has to happen every frame
 * regardless — edges can change from any of several unrelated call sites),
 * then matches each one back to whichever old color(s) its cells overlap,
 * so a color index persists across edits rather than being reassigned by
 * arbitrary iteration order every time.
 */
export interface ComponentColorState {
  cellsByColor: Map<number, Set<CellKey>>;
}

export function createComponentColorState(): ComponentColorState {
  return { cellsByColor: new Map() };
}

/** Drops all remembered color assignments — call this whenever the board a state is tracking colors for is swapped for a genuinely different one (a new/resumed puzzle, a different completed puzzle opened in review), so an unrelated old component's color can't spuriously "persist" onto a new puzzle's component just because their cell coordinates happen to coincide. */
export function resetComponentColorState(state: ComponentColorState): void {
  state.cellsByColor.clear();
}

function cellsByComponentOf(edges: ReadonlySet<EdgeKey>, components: ReadonlyMap<EdgeKey, number>): Map<number, Set<CellKey>> {
  const cellsByComponent = new Map<number, Set<CellKey>>();
  for (const ek of edges) {
    const cid = components.get(ek)!;
    let cells = cellsByComponent.get(cid);
    if (!cells) {
      cells = new Set();
      cellsByComponent.set(cid, cells);
    }
    const [a, b] = parseEdgeKey(ek);
    cells.add(key(a[0], a[1]));
    cells.add(key(b[0], b[1]));
  }
  return cellsByComponent;
}

/**
 * Recomputes connected components for `edges` (fresh union-find, same as
 * `computeEdgeComponents`) and assigns each one a *persistent* color index,
 * updating `state` in place to remember the new snapshot:
 *
 * - A component that shares cells with exactly one previous color (grew,
 *   shrank, or is simply unchanged) keeps that color.
 * - A **merge** (a component now overlaps cells from more than one old
 *   color) keeps the *lowest* of those colors — "blue wins" — regardless of
 *   which side contributed more cells.
 * - A **split** (one old color's cells now spread across more than one new
 *   component) lets whichever new piece kept the most of those cells keep
 *   the color; the other piece(s) are treated as brand new.
 * - A component touching no old color at all (brand new, or the losing side
 *   of a split) gets the lowest color index not already claimed by anything
 *   else this frame — so a color that just freed up (its old component
 *   vanished, or lost a split/merge collision) is exactly what a new
 *   component picks up.
 * - A color no longer claimed by anything this frame is simply absent from
 *   the updated `state` — freeing it for reuse next time, and leaving every
 *   *other* still-live color's assignment completely undisturbed (this is
 *   what makes a vanished component's neighbor's color stay put instead of
 *   shifting down to fill the gap).
 *
 * Returns a fresh `EdgeKey -> persistent color index` map for immediate use
 * as `segmentColor`'s argument.
 */
export function updateComponentColors(state: ComponentColorState, edges: ReadonlySet<EdgeKey>): Map<EdgeKey, number> {
  const components = computeEdgeComponents(edges);
  const cellsByComponent = cellsByComponentOf(edges, components);

  const oldColorOfCell = new Map<CellKey, number>();
  for (const [color, cells] of state.cellsByColor) {
    for (const cell of cells) oldColorOfCell.set(cell, color);
  }

  // Each component's preferred old color is the *lowest* one any of its
  // cells belonged to (blue wins on a merge); `overlapCount` — how many of
  // its cells actually had that color — is only used to break a collision
  // below (a split, where more than one new component prefers the same old
  // color).
  const preferredColor = new Map<number, number>();
  const overlapCount = new Map<number, number>();
  for (const [cid, cells] of cellsByComponent) {
    let preferred: number | undefined;
    for (const cell of cells) {
      const c = oldColorOfCell.get(cell);
      if (c !== undefined && (preferred === undefined || c < preferred)) preferred = c;
    }
    if (preferred === undefined) continue;
    let count = 0;
    for (const cell of cells) if (oldColorOfCell.get(cell) === preferred) count++;
    preferredColor.set(cid, preferred);
    overlapCount.set(cid, count);
  }

  const colorOwner = new Map<number, number>(); // old color -> the component id that keeps it
  for (const [cid, color] of preferredColor) {
    const incumbent = colorOwner.get(color);
    if (incumbent === undefined) {
      colorOwner.set(color, cid);
      continue;
    }
    const count = overlapCount.get(cid)!;
    const incumbentCount = overlapCount.get(incumbent)!;
    if (count > incumbentCount || (count === incumbentCount && cid < incumbent)) colorOwner.set(color, cid);
  }

  const colorForComponent = new Map<number, number>();
  const usedColors = new Set<number>();
  for (const [color, cid] of colorOwner) {
    colorForComponent.set(cid, color);
    usedColors.add(color);
  }

  // Everything else -- brand new components, and the losing side of a split
  // -- gets the lowest color index not already claimed this frame.
  const remaining = [...cellsByComponent.keys()].filter((cid) => !colorForComponent.has(cid)).sort((a, b) => a - b);
  let nextFree = 0;
  for (const cid of remaining) {
    while (usedColors.has(nextFree)) nextFree++;
    colorForComponent.set(cid, nextFree);
    usedColors.add(nextFree);
  }

  state.cellsByColor = new Map();
  for (const [cid, cells] of cellsByComponent) state.cellsByColor.set(colorForComponent.get(cid)!, cells);

  const edgeColors = new Map<EdgeKey, number>();
  for (const [ek, cid] of components) edgeColors.set(ek, colorForComponent.get(cid)!);
  return edgeColors;
}

/**
 * Reads back the persistent color of every edge in `edges` from `state`
 * *without* recomputing or mutating anything — valid only when `state` is
 * already known to reflect exactly this edge set (i.e. the last call to
 * `updateComponentColors` was for these same edges), which is always true
 * of "the state right before a toggle" since `render()` calls
 * `updateComponentColors` with the live edge set on every frame, including
 * the one right before a new toggle is applied. Used by `main.ts`'s
 * `scheduleToggleAnimation` to freeze a shrinking edge's color and set a
 * pulsing edge's `fromColor` to what was actually on screen, without
 * needing its own separate union-find pass.
 */
export function snapshotEdgeColors(state: ComponentColorState, edges: ReadonlySet<EdgeKey>): Map<EdgeKey, number> {
  const colorOfCell = new Map<CellKey, number>();
  for (const [color, cells] of state.cellsByColor) {
    for (const cell of cells) colorOfCell.set(cell, color);
  }
  const edgeColors = new Map<EdgeKey, number>();
  for (const ek of edges) {
    const [a] = parseEdgeKey(ek);
    const color = colorOfCell.get(key(a[0], a[1]));
    if (color !== undefined) edgeColors.set(ek, color);
  }
  return edgeColors;
}
