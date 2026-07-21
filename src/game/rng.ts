/** A seeded pseudo-random number generator, producing floats in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast, seeded PRNG. Same seed always yields the same sequence. */
export function mulberry32(seed: number): Rng {
  let state = seed | 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds a new generator from ambient randomness (i.e. non-deterministic across runs). */
export function randomSeed(): number {
  return (Math.random() * 1e9) | 0;
}
