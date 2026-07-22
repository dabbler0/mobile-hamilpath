import { describe, expect, it } from 'vitest';
import { decodePathState, decodeSegment, encodePathState, encodeSegment, pathStateEquals } from './pathCodec';
import type { PathState, Segment } from './pathDrag';

describe('encodeSegment / decodeSegment', () => {
  it('round-trips a single-cell segment', () => {
    const seg: Segment = [[3, 4]];
    const encoded = encodeSegment(seg);
    expect(encoded).toBe('3,4');
    expect(decodeSegment(encoded)).toEqual(seg);
  });

  it('round-trips a straight multi-cell segment', () => {
    const seg: Segment = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    const encoded = encodeSegment(seg);
    expect(encoded).toBe('0,0:RRR');
    expect(decodeSegment(encoded)).toEqual(seg);
  });

  it('round-trips a segment that turns in every direction', () => {
    const seg: Segment = [
      [5, 5],
      [6, 5], // R
      [6, 6], // D
      [5, 6], // L
      [5, 5], // U
    ];
    const encoded = encodeSegment(seg);
    expect(encoded).toBe('5,5:RDLU');
    expect(decodeSegment(encoded)).toEqual(seg);
  });

  it('encodes negative coordinates fine', () => {
    const seg: Segment = [
      [-2, -3],
      [-1, -3],
    ];
    expect(decodeSegment(encodeSegment(seg))).toEqual(seg);
  });
});

describe('encodePathState / decodePathState', () => {
  it('round-trips multiple segments and the won flag', () => {
    const state: PathState = {
      segments: [
        [
          [0, 0],
          [1, 0],
        ],
        [[5, 5]],
      ],
      won: true,
    };
    const encoded = encodePathState(state);
    expect(encoded.segments).toEqual(['0,0:R', '5,5']);
    expect(encoded.won).toBe(true);
    expect(decodePathState(encoded)).toEqual(state);
  });

  it('round-trips an empty-ish path (single starting cell)', () => {
    const state: PathState = { segments: [[[2, 2]]], won: false };
    expect(decodePathState(encodePathState(state))).toEqual(state);
  });
});

describe('pathStateEquals', () => {
  const base: PathState = {
    segments: [
      [
        [0, 0],
        [1, 0],
      ],
    ],
    won: false,
  };

  it('is true for structurally identical states, even as distinct objects', () => {
    const copy: PathState = { segments: [[[0, 0], [1, 0]]], won: false };
    expect(pathStateEquals(base, copy)).toBe(true);
  });

  it('is false when won differs', () => {
    expect(pathStateEquals(base, { ...base, won: true })).toBe(false);
  });

  it('is false when segment count differs', () => {
    expect(pathStateEquals(base, { segments: [...base.segments, [[9, 9]]], won: false })).toBe(false);
  });

  it('is false when a segment differs in cells', () => {
    const other: PathState = { segments: [[[0, 0], [1, 0], [2, 0]]], won: false };
    expect(pathStateEquals(base, other)).toBe(false);
  });
});
