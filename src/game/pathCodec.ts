import type { Cell } from './hamiltonianCycle';
import type { PathState, Segment } from './pathDrag';

/** One grid step, as a single character: the four orthogonal directions every puzzle edge can connect. */
const DIR_DELTA: Record<string, Cell> = { R: [1, 0], L: [-1, 0], D: [0, 1], U: [0, -1] };

function dirChar(dx: number, dy: number): string {
  if (dx === 1 && dy === 0) return 'R';
  if (dx === -1 && dy === 0) return 'L';
  if (dx === 0 && dy === 1) return 'D';
  if (dx === 0 && dy === -1) return 'U';
  throw new Error(`non-adjacent segment step (${dx},${dy})`);
}

/**
 * Compactly encodes a segment as its starting cell plus one direction
 * character per subsequent step (every later cell is grid-adjacent to the
 * one before it, so a single char suffices), e.g. "3,4:RRDU" instead of an
 * array of `[x,y]` pairs — this is what keeps stored path history small
 * even for long segments on the largest boards.
 */
export function encodeSegment(seg: Segment): string {
  const [x0, y0] = seg[0];
  let head = `${x0},${y0}`;
  if (seg.length > 1) {
    let dirs = '';
    for (let i = 1; i < seg.length; i++) {
      const [px, py] = seg[i - 1];
      const [x, y] = seg[i];
      dirs += dirChar(x - px, y - py);
    }
    head += `:${dirs}`;
  }
  return head;
}

export function decodeSegment(encoded: string): Segment {
  const colon = encoded.indexOf(':');
  const head = colon === -1 ? encoded : encoded.slice(0, colon);
  const dirs = colon === -1 ? '' : encoded.slice(colon + 1);
  const [x0, y0] = head.split(',').map(Number);
  const seg: Segment = [[x0, y0]];
  for (const ch of dirs) {
    const [dx, dy] = DIR_DELTA[ch];
    const [px, py] = seg[seg.length - 1];
    seg.push([px + dx, py + dy]);
  }
  return seg;
}

export interface EncodedPathState {
  segments: string[];
  won: boolean;
}

export function encodePathState(state: PathState): EncodedPathState {
  return { segments: state.segments.map(encodeSegment), won: state.won };
}

export function decodePathState(encoded: EncodedPathState): PathState {
  return { segments: encoded.segments.map(decodeSegment), won: encoded.won };
}

export function pathStateEquals(a: PathState, b: PathState): boolean {
  if (a.won !== b.won) return false;
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    if (encodeSegment(a.segments[i]) !== encodeSegment(b.segments[i])) return false;
  }
  return true;
}
