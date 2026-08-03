import { describe, expect, it } from 'vitest';
import { decodePathState, encodePathState, pathStateEquals } from './pathCodec';
import type { PathState } from './pathEdit';

describe('encodePathState / decodePathState', () => {
  it('round-trips a marked-edge set and the won flag, sorted deterministically', () => {
    const state: PathState = { edges: new Set(['5,5|5,6', '0,0|1,0']), won: true };
    const encoded = encodePathState(state);
    expect(encoded.edges).toEqual(['0,0|1,0', '5,5|5,6']);
    expect(encoded.won).toBe(true);
    expect(decodePathState(encoded)).toEqual(state);
  });

  it('round-trips an empty edge set', () => {
    const state: PathState = { edges: new Set(), won: false };
    expect(decodePathState(encodePathState(state))).toEqual(state);
  });
});

describe('pathStateEquals', () => {
  const base: PathState = { edges: new Set(['0,0|1,0']), won: false };

  it('is true for structurally identical states, even as distinct objects/insertion order', () => {
    const copy: PathState = { edges: new Set(['0,0|1,0']), won: false };
    expect(pathStateEquals(base, copy)).toBe(true);
  });

  it('is false when won differs', () => {
    expect(pathStateEquals(base, { ...base, won: true })).toBe(false);
  });

  it('is false when edge count differs', () => {
    expect(pathStateEquals(base, { edges: new Set([...base.edges, '9,9|9,8']), won: false })).toBe(false);
  });

  it('is false when the edge sets differ but have equal size', () => {
    const other: PathState = { edges: new Set(['2,2|3,2']), won: false };
    expect(pathStateEquals(base, other)).toBe(false);
  });
});
