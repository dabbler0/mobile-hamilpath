/**
 * Wraparound topologies for a board's cell/face grid. A board of size
 * W x H (doubled cells) or m x n (blocks) can wrap its edges together in
 * different ways, giving different closed surfaces:
 *
 *  - **torus**: right edge glues straight to left edge, top glues straight
 *    to bottom. Both gluings preserve orientation.
 *  - **klein bottle**: right glues straight to left (like a torus), but top
 *    glues to bottom with a horizontal flip — crossing that seam mirrors
 *    the x-coordinate. One orientation-reversing gluing.
 *  - **projective plane**: *both* gluings are flips — crossing left/right
 *    mirrors y, crossing top/bottom mirrors x. This is the standard
 *    "antipodal square" model of RP^2.
 *
 * Only the klein/projective gluings are orientation-reversing, which is why
 * `Orientation` exists at all: `hamiltonianCycle.ts`'s wall-follower needs
 * to track, as it walks, whether it has crossed an odd number of
 * orientation-reversing seams, so it can keep interpreting "turn right"
 * consistently in its own frame even though that no longer corresponds to
 * the same fixed global direction once you're on the "other side" of a
 * flip. Everything else (adjacency for regions/distractor-edges/rendering)
 * only needs the *position* a wrap lands on, never the orientation, since
 * adjacency is a fixed structural fact independent of how you got there.
 */

export type TopologyKind = 'torus' | 'klein' | 'projective';

/**
 * An element of the Klein four-group Z2 x Z2 (independent x/y reflection
 * bits) — the only orientation-changes that ever arise here, since every
 * seam this game defines is an axis-aligned reflection, never a rotation.
 * Composing is just per-bit XOR (abelian).
 */
export interface Orientation {
  flipX: boolean;
  flipY: boolean;
}

export const IDENTITY_ORIENTATION: Orientation = { flipX: false, flipY: false };

export function composeOrientation(a: Orientation, b: Orientation): Orientation {
  return { flipX: a.flipX !== b.flipX, flipY: a.flipY !== b.flipY };
}

export interface WrapResult {
  x: number;
  y: number;
  /** The orientation change contributed by crossing this seam (identity for a torus gluing). */
  flip: Orientation;
}

/**
 * Defines how a board of size W x H (or, for `tileOrientation`, m x n
 * blocks) glues its edges together. `wrapX` is called whenever a step's x
 * lands outside [0, W) (y is always already in range — every step here is
 * a single axis-aligned unit move, so x and y are never simultaneously out
 * of range); `wrapY` is the same for y landing outside [0, H).
 */
export interface Topology {
  kind: TopologyKind;
  wrapX(rawX: number, y: number, W: number, H: number): WrapResult;
  wrapY(x: number, rawY: number, W: number, H: number): WrapResult;
  /**
   * The orientation a repeated tile copy at (tileX, tileY) — relative to
   * the primary tile at (0,0) — should render with, for the seamless
   * infinite-scroll view (`render.ts`). Follows directly from how many
   * orientation-reversing seams are crossed getting there: independent of
   * path (Z2 x Z2 is abelian), so it only depends on the parity of tileX
   * and tileY, never their actual magnitude.
   */
  tileOrientation(tileX: number, tileY: number): Orientation;
}

function wrapIndex(v: number, size: number): number {
  return ((v % size) + size) % size;
}

export const TORUS: Topology = {
  kind: 'torus',
  wrapX: (rawX, y, W) => ({ x: wrapIndex(rawX, W), y, flip: IDENTITY_ORIENTATION }),
  wrapY: (x, rawY, _W, H) => ({ x, y: wrapIndex(rawY, H), flip: IDENTITY_ORIENTATION }),
  tileOrientation: () => IDENTITY_ORIENTATION,
};

/** Right~left straight (like a torus); top~bottom glued with a horizontal (x) flip. */
export const KLEIN_BOTTLE: Topology = {
  kind: 'klein',
  wrapX: (rawX, y, W) => ({ x: wrapIndex(rawX, W), y, flip: IDENTITY_ORIENTATION }),
  wrapY: (x, rawY, W, H) => ({ x: W - 1 - x, y: wrapIndex(rawY, H), flip: { flipX: true, flipY: false } }),
  tileOrientation: (_tileX, tileY) => ({ flipX: wrapIndex(tileY, 2) === 1, flipY: false }),
};

/** Both gluings flip: right~left mirrors y, top~bottom mirrors x (the "antipodal square" model of RP^2). */
export const PROJECTIVE_PLANE: Topology = {
  kind: 'projective',
  wrapX: (rawX, y, W, H) => ({ x: wrapIndex(rawX, W), y: H - 1 - y, flip: { flipX: false, flipY: true } }),
  wrapY: (x, rawY, W, H) => ({ x: W - 1 - x, y: wrapIndex(rawY, H), flip: { flipX: true, flipY: false } }),
  tileOrientation: (tileX, tileY) => ({ flipX: wrapIndex(tileY, 2) === 1, flipY: wrapIndex(tileX, 2) === 1 }),
};

export function topologyFor(kind: TopologyKind): Topology {
  switch (kind) {
    case 'torus':
      return TORUS;
    case 'klein':
      return KLEIN_BOTTLE;
    case 'projective':
      return PROJECTIVE_PLANE;
  }
}

/**
 * The neighbor of (x, y) one step in direction (dx, dy) — exactly one of
 * dx/dy is ±1, the other 0 — wrapping via `topology` if the step falls
 * outside [0, W) x [0, H). Orientation-independent (see file doc comment):
 * this is a fixed structural fact about the grid, used for regions,
 * distractor edges, and hit-testing, as opposed to `hamiltonianCycle.ts`'s
 * walker, which additionally tracks orientation for its own turn-preference
 * bookkeeping.
 */
export function wrappedNeighbor(topology: Topology, x: number, y: number, dx: number, dy: number, W: number, H: number): { x: number; y: number } {
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || nx >= W) {
    const { x: wx, y: wy } = topology.wrapX(nx, ny, W, H);
    return { x: wx, y: wy };
  }
  if (ny < 0 || ny >= H) {
    const { x: wx, y: wy } = topology.wrapY(nx, ny, W, H);
    return { x: wx, y: wy };
  }
  return { x: nx, y: ny };
}
