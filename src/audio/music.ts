/**
 * Live Blitz-run background percussion, built with the Web Audio API (no
 * audio files — everything synthesized on the fly, same approach
 * `audio/sfx.ts` already uses). Ported from a standalone "Euclidean
 * Timeline Generator" prototype: Bjorklund's algorithm distributes `k`
 * onsets as evenly as possible among `n` steps (`bjorklund`), which is what
 * gives the pattern its steady-but-not-four-on-the-floor feel; a random
 * rotation of that pattern is what keeps successive rhythms from all
 * starting on an onset. Stripped of the prototype's own UI (a tempo slider,
 * n/k number inputs, a play button, an SVG ring visualizer — this module is
 * headless, `main.ts` is its only caller) and of its manual Generate/Reroll
 * buttons, replaced by `regenerateBlitzRhythm` (see below).
 *
 * This replaced an earlier ten-layer polyrhythmic-percussion-plus-drone
 * generator that played in *both* Free Play and Blitz, with its own
 * externally-driven "density" input tracking how close to finished (Free
 * Play) or how low on time (Blitz) the player was. Free Play has no
 * generative music at all now — CLAUDE.md's "Live-play music" section, and
 * `main.ts`'s call sites, no longer call anything in this file from any
 * Free Play code path. Blitz's own former density-tracking behavior is
 * gone too: this engine has no "layers" to add/remove, so there's nothing
 * for a density signal to drive — instead, a run's rhythm is simply
 * rerolled fresh every time the puzzle changes (`regenerateBlitzRhythm`,
 * called from `main.ts`'s `advanceBlitzPuzzle`), and its tempo is fixed for
 * the whole run, set once by `startMusic`'s `bpm` argument (Blitz's pace
 * preset — see `game/blitz.ts`'s `BLITZ_PACE_MUSIC_BPM`).
 *
 * **Bass line**: also ported from the same prototype (a separate "Euclidean
 * Timeline Generator" variant that added a walking bass + chord progression
 * on top of the percussion) — but only its harmonic engine (the
 * voice-leading chord walk, see "Chord walk" below) and its "every 4 pulses,
 * root/5th only" bass strategy, with a chromatic passing tone approaching
 * each note; the prototype's piano voice, and every *other* bass strategy it
 * offered, aren't ported at all. Unlike the prototype's bass (which plays
 * unconditionally, every single 4-pulse cell), this port makes each cell's
 * note a coin flip (`bassProbability`) driven by how much time is left on
 * the run's clock (`setBassRemainingMs`, called every frame from `main.ts`'s
 * `blitzTick`): silent while there's a comfortable cushion of time left,
 * then increasingly likely to sound as that cushion erodes, reaching
 * (arbitrarily close to) certain right as the clock would hit zero — a
 * rising sense of urgency that tracks the actual danger of the run ending,
 * not just elapsed wall-clock time. See `bassProbability`'s own doc comment
 * for why a fresh puzzle's own time-back bonus is what makes the bass line
 * go quiet again immediately after each puzzle starts, with no separate
 * "reset" of its own needed.
 */

// ---- Pattern generation ----
// Ported verbatim from the prototype's own `bjorklund`/`rotate`/coprime-pick
// logic.

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Bjorklund's algorithm: distributes `k` onsets as evenly as possible among `n` steps. Returns a 0/1 array of length `n`. */
function bjorklund(k: number, n: number): number[] {
  if (k <= 0) return new Array(n).fill(0);
  if (k >= n) return new Array(n).fill(1);
  let a: number[][] = [];
  let b: number[][] = [];
  for (let i = 0; i < k; i++) a.push([1]);
  for (let i = 0; i < n - k; i++) b.push([0]);
  while (b.length > 1) {
    const m = Math.min(a.length, b.length);
    const newA: number[][] = [];
    for (let i = 0; i < m; i++) newA.push(a[i].concat(b[i]));
    const remainder = a.length > b.length ? a.slice(m) : b.slice(m);
    a = newA;
    b = remainder;
    if (a.length <= 1) break;
  }
  return a.concat(b).flat();
}

function rotateSteps(steps: readonly number[], r: number): number[] {
  const n = steps.length;
  const rr = ((r % n) + n) % n;
  return steps.slice(rr).concat(steps.slice(0, rr));
}

/** The `n` range a fresh pattern's step count is drawn from — same defaults the prototype's own min/max inputs started at. */
const PATTERN_N_MIN = 8;
const PATTERN_N_MAX = 24;
/** Fallback pattern (E(3,8), no rotation) for the astronomically unlikely case `pickCoprimeNK` exhausts its attempts — keeps pattern generation total rather than ever leaving the engine without a rhythm to play. */
const FALLBACK_PATTERN = bjorklund(3, 8);

/**
 * Draws a random `n` in `[PATTERN_N_MIN, PATTERN_N_MAX]`, then a random `k`
 * uniformly among the integers in `[ceil(n/4), floor(n/2)]` that are
 * coprime with `n` (so the pattern doesn't reduce to a shorter repeated
 * cell) — retrying with a fresh `n` if that band happens to have no coprime
 * candidate for the chosen `n`. In practice this virtually always succeeds
 * on the first attempt or two; `maxAttempts` just bounds the loop so a
 * pathological range can't spin forever.
 */
function pickCoprimeNK(): { n: number; k: number } | null {
  const maxAttempts = 200;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const n = PATTERN_N_MIN + Math.floor(Math.random() * (PATTERN_N_MAX - PATTERN_N_MIN + 1));
    const kLo = Math.ceil(n / 4);
    const kHi = Math.floor(n / 2);
    const candidates: number[] = [];
    for (let k = kLo; k <= kHi; k++) {
      if (k >= 2 && k < n && gcd(n, k) === 1) candidates.push(k);
    }
    if (candidates.length > 0) {
      return { n, k: candidates[Math.floor(Math.random() * candidates.length)] };
    }
  }
  return null;
}

/** A fresh random Euclidean rhythm: `bjorklund(k, n)` at a random rotation. Always returns a non-empty 0/1 step array (falls back to `FALLBACK_PATTERN` — see its own doc comment). */
function generateEuclideanPattern(): number[] {
  const picked = pickCoprimeNK();
  if (!picked) return FALLBACK_PATTERN;
  const base = bjorklund(picked.k, picked.n);
  const rotation = Math.floor(Math.random() * picked.n);
  return rotateSteps(base, rotation);
}

// ---- Chord walk (bass line harmony) ----
// Ported from the prototype's own voice-leading chord generator, trimmed to
// only what the bass line needs: each step just wants a chord's root/3rd/
// 5th/7th in bass register (`byRole`), not a display name or a separate
// mid-register comping voicing (those existed only for the prototype's
// piano, which this port drops — see file doc comment).
//
// Home key = (tonic, mode). Foreign key = parallel minor if home is major,
// else relative major (tonic+3) if home is minor. Candidate pool = home ∪
// foreign diatonic 7ths, minus the current chord. Each candidate's cost is
// the cheapest of 24 possible voice/note reassignments from the current
// voicing (`bestVoicing`), weighted toward smooth motion; a candidate that's
// foreign-only is discounted by `CHORD_PULL`. Landing on a foreign-only
// chord moves the key there. Whenever the current chord is a dominant 7th,
// the major triad it would resolve to (a 5th below) gets a strong extra
// probability boost, so V7→I cadences happen often without being forced
// every time.
type ChordQualityId = 'maj7' | 'min7' | 'dom7' | 'm7b5' | 'minMaj7' | 'augMaj7' | 'dim7';
type KeyMode = 'major' | 'minor';

interface ChordOffset {
  offset: number;
  q: ChordQualityId;
}
interface KeyOrigin {
  tonic: number;
  mode: KeyMode;
  isHomeKey: boolean;
}
interface PoolChord {
  root: number;
  q: ChordQualityId;
  pcs: number[];
  origins: KeyOrigin[];
}
interface ChordCandidate extends PoolChord {
  cost: number;
  newVoicing: number[];
  byRole: number[];
  home: boolean;
  raw: number;
  prob: number;
}
interface VoicingResult {
  cost: number;
  newVoicing: number[];
  byRole: number[];
}

const QUALITY: Record<ChordQualityId, { intervals: number[] }> = {
  maj7: { intervals: [0, 4, 7, 11] },
  min7: { intervals: [0, 3, 7, 10] },
  dom7: { intervals: [0, 4, 7, 10] },
  m7b5: { intervals: [0, 3, 6, 10] },
  minMaj7: { intervals: [0, 3, 7, 11] },
  augMaj7: { intervals: [0, 4, 8, 11] },
  dim7: { intervals: [0, 3, 6, 9] },
};
// Diatonic 7th chords built on each scale degree, byRole-indexed [root, 3rd, 5th, 7th].
const MAJOR_OFFSETS: ChordOffset[] = [
  { offset: 0, q: 'maj7' },
  { offset: 2, q: 'min7' },
  { offset: 4, q: 'min7' },
  { offset: 5, q: 'maj7' },
  { offset: 7, q: 'dom7' },
  { offset: 9, q: 'min7' },
  { offset: 11, q: 'm7b5' },
];
const MINOR_OFFSETS: ChordOffset[] = [ // harmonic minor
  { offset: 0, q: 'minMaj7' },
  { offset: 2, q: 'm7b5' },
  { offset: 3, q: 'augMaj7' },
  { offset: 5, q: 'min7' },
  { offset: 7, q: 'dom7' },
  { offset: 8, q: 'maj7' },
  { offset: 11, q: 'dim7' },
];
const CHORD_TEMPERATURE = 2.0; // matches the prototype's default "greedy <-> chaotic" slider position
const CHORD_PULL = 0.2; // matches the prototype's default "rare <-> frequent" key-change slider position
const DOMINANT_RESOLUTION_BOOST = 40;

// The bass is locked to this fixed 2-octave window (MIDI 24-47, roughly
// C1-B2) — the voice-leading walk has no register ceiling of its own, so
// without this a long enough run could drift the bass uncomfortably high or
// low over many chord changes.
const BASS_RANGE_LOW = 24;
const BASS_RANGE_HIGH = 47;
function wrapToBassRange(midi: number): number {
  while (midi < BASS_RANGE_LOW) midi += 12;
  while (midi > BASS_RANGE_HIGH) midi -= 12;
  return midi;
}

function buildKeyChords(tonic: number, mode: KeyMode): { root: number; q: ChordQualityId; pcs: number[] }[] {
  const offsets = mode === 'major' ? MAJOR_OFFSETS : MINOR_OFFSETS;
  return offsets.map((o) => {
    const root = (tonic + o.offset + 120) % 12;
    return { root, q: o.q, pcs: QUALITY[o.q].intervals.map((iv) => (root + iv) % 12) };
  });
}

function foreignKeyFor(tonic: number, mode: KeyMode): { tonic: number; mode: KeyMode } {
  return mode === 'major' ? { tonic, mode: 'minor' } : { tonic: (tonic + 3) % 12, mode: 'major' };
}

function buildChordPool(tonic: number, mode: KeyMode): PoolChord[] {
  const foreign = foreignKeyFor(tonic, mode);
  const keyDefs: { tonic: number; mode: KeyMode; isHomeKey: boolean }[] = [
    { tonic, mode, isHomeKey: true },
    { tonic: foreign.tonic, mode: foreign.mode, isHomeKey: false },
  ];
  const map = new Map<string, PoolChord>();
  keyDefs.forEach((k) => {
    buildKeyChords(k.tonic, k.mode).forEach((ch) => {
      const key = `${ch.root}|${ch.q}`;
      if (!map.has(key)) map.set(key, { root: ch.root, q: ch.q, pcs: ch.pcs, origins: [] });
      map.get(key)!.origins.push({ tonic: k.tonic, mode: k.mode, isHomeKey: k.isHomeKey });
    });
  });
  return [...map.values()];
}

function isHomeChord(c: PoolChord, tonic: number, mode: KeyMode): boolean {
  return c.origins.some((o) => o.tonic === tonic && o.mode === mode);
}

function permutations(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr];
  const out: number[][] = [];
  arr.forEach((item, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    permutations(rest).forEach((p) => out.push([item, ...p]));
  });
  return out;
}
const PERMS4 = permutations([0, 1, 2, 3]);

function pcDist(a: number, b: number): number {
  let d = (((b - a) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  if (Math.abs(d) === 6 && Math.random() < 0.5) d = -d; // tritone: random direction
  return d;
}

/** The cheapest of the 24 ways to reassign the current 4-note voicing onto a target chord's pitch classes, by total semitone movement. */
function bestVoicing(currentVoicing: number[], targetPCs: number[]): VoicingResult {
  let best: VoicingResult | null = null;
  for (const perm of PERMS4) {
    let cost = 0;
    const newV: number[] = [0, 0, 0, 0]; // keyed by original voice index (needed for continuity into the next call)
    const byRole: number[] = [0, 0, 0, 0]; // keyed by chord-tone role: 0=root, 1=3rd, 2=5th, 3=7th
    perm.forEach((curIdx, targetIdx) => {
      const curPitch = currentVoicing[curIdx];
      const d = pcDist(((curPitch % 12) + 12) % 12, targetPCs[targetIdx]);
      cost += Math.abs(d);
      const newPitch = curPitch + d;
      newV[curIdx] = newPitch;
      byRole[targetIdx] = newPitch;
    });
    if (!best || cost < best.cost) best = { cost, newVoicing: newV, byRole };
  }
  return best as VoicingResult;
}

function weightedPick<T extends { prob: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.prob, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.prob;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// Persistent harmonic-walk state (the chord/tonic/mode this all evolves from).
let chordTonic = 0;
let chordMode: KeyMode = 'major';
let chordCurrentChord: { root: number; q: ChordQualityId } = { root: 0, q: 'maj7' };
let chordCurrentVoicing: number[] = [60, 64, 67, 71];

function initChordWalk(): void {
  chordTonic = Math.floor(Math.random() * 12);
  chordMode = 'major';
  chordCurrentChord = { root: chordTonic, q: 'maj7' };
  chordCurrentVoicing = QUALITY.maj7.intervals.map((iv) => 60 + chordTonic + iv);
}

/**
 * One step of the voice-leading walk: picks the next chord, updates the
 * persistent tonic/mode/voicing, and returns that chord's 4 tones
 * (root/3rd/5th/7th) transposed 3 octaves down into the fixed bass register
 * — everything `maybeScheduleBass` needs. Mirrors the prototype's own
 * `generateNextChordStep` exactly, minus the piano-register/display-name
 * outputs this port has no use for.
 */
function generateNextChordStep(): { byRole: number[] } {
  const pool = buildChordPool(chordTonic, chordMode);
  // V7 → I: if the current chord is a dominant 7th, the major triad a 5th below its root
  // (i.e. G7's root+5=C, the "I" it resolves to) gets a strong probability boost below.
  const dominantResolutionRoot = chordCurrentChord.q === 'dom7' ? (chordCurrentChord.root + 5) % 12 : null;
  const candidates: ChordCandidate[] = pool
    .filter((c) => !(c.root === chordCurrentChord.root && c.q === chordCurrentChord.q))
    .map((c) => {
      const { cost, newVoicing, byRole } = bestVoicing(chordCurrentVoicing, c.pcs);
      const home = isHomeChord(c, chordTonic, chordMode);
      let raw = Math.exp(-cost / CHORD_TEMPERATURE) * (home ? 1 : CHORD_PULL);
      const isDominantResolution = dominantResolutionRoot !== null && c.root === dominantResolutionRoot && c.q === 'maj7';
      if (isDominantResolution) raw *= DOMINANT_RESOLUTION_BOOST;
      return { ...c, cost, newVoicing, byRole, home, raw, prob: 0 };
    });
  const total = candidates.reduce((s, c) => s + c.raw, 0);
  candidates.forEach((c) => {
    c.prob = c.raw / total;
  });
  const chosen = weightedPick(candidates);

  chordCurrentVoicing = chosen.newVoicing;
  chordCurrentChord = { root: chosen.root, q: chosen.q };
  if (!chosen.home) {
    // A foreign-only chord was chosen: the walk moves into that key. `chosen.origins`
    // always has a non-home entry here by construction (that's exactly what "not home"
    // means), so this is never undefined in practice.
    const landing = chosen.origins.find((o) => !o.isHomeKey)!;
    chordTonic = landing.tonic;
    chordMode = landing.mode;
  }

  const bassByRole = chosen.byRole.map((p) => wrapToBassRange(p - 36));
  return { byRole: bassByRole };
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---- Bass line urgency ----
// How close to the run's clock hitting zero decides how likely the bass
// line is to actually sound on any given 4-pulse cell — see `maybeScheduleBass`.

/**
 * Above `BASS_SAFE_MS` of remaining time, the bass line is completely
 * silent (probability 0); below it, the probability of a given cell
 * sounding rises linearly, reaching 1 exactly as the remaining time hits 0.
 * "Whenever a new puzzle is started ... start without bassline" isn't a
 * separate reset anywhere in this file — it falls out of this one formula
 * for free, because a fresh puzzle's own time-back bonus
 * (`advanceBlitzPuzzle`'s `awardMs`) routinely pushes the remaining time
 * straight back over `BASS_SAFE_MS` the instant it's credited, well before
 * the bass line's own scheduler next runs.
 */
const BASS_SAFE_MS = 20000;
function bassProbability(remainingMs: number): number {
  if (remainingMs >= BASS_SAFE_MS) return 0;
  if (remainingMs <= 0) return 1;
  return 1 - remainingMs / BASS_SAFE_MS;
}

// ---- Module state ----
// One always-at-most-one-running engine, same "single shared context" shape
// as `audio/sfx.ts` and the earlier version of this file.
let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let running = false;

let currentPattern: number[] = FALLBACK_PATTERN;
let currentStep = 0;
let currentBpm = 240;
let nextNoteTime = 0;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let stopFadeTimer: ReturnType<typeof setTimeout> | null = null;

/** Mirrors whatever `setMusicVolume` was last called with, even before `audioCtx` exists — same pattern as `sfx.ts`'s `currentVolume`. */
let currentVolume = 0.5;

// Bass line playback state (see "Chord walk" and "Bass line urgency" above).
// `activeChord`/`nextChord` are one chord-change ahead of each other, same
// lookahead shape the prototype used, so a passing tone that crosses into a
// new chord always has a real target to approach.
let activeChord: { byRole: number[] } | null = null;
let nextChord: { byRole: number[] } | null = null;
/** True only for the very first `currentStep % chordChangeInterval === 0` after `startMusic` primes `activeChord`/`nextChord` — skips one redundant advance, since those two are already freshly generated. */
let isFirstChordSegment = true;
/** 0 = the next main bass note is the chord's root, 1 = its 5th. Only flips when a main note actually plays, so a skipped (probability-rolled-no) cell doesn't throw off the alternation. */
let bassRootFifthToggle = 0;
/** Decided one pulse ahead, at each cell's approach slot — whether the upcoming main slot (and the passing tone leading into it, scheduled right now) actually sounds. */
let bassNextMainWillPlay = false;
/** The last main bass note actually played — anchors which direction (up or down) the next passing tone approaches its target from. */
let lastMainBassMidi = 0;
/** Latest value from `setBassRemainingMs` — how much time is left on the run's clock, fed into `bassProbability`. `Infinity` until Blitz reports a real deadline, which reads as "always safe, never play". */
let bassRemainingMs = Infinity;

const SCHEDULE_AHEAD_SEC = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
/** Fade-out length before `stopMusic` actually tears the context down — long enough to not click/thump, short enough that a quick Play Again doesn't leave two engines briefly overlapping. */
const STOP_FADE_SEC = 0.4;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---- Synths ----
// Ported verbatim from the prototype (kick as the downbeat marker, snare for
// an onset step, shaker for a rest step), adapted only to take an explicit
// `out` destination the way `sfx.ts`'s own synths do, instead of always
// connecting straight to `ctx.destination`.

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const size = ctx.sampleRate * 1;
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseSource(ctx: AudioContext): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

/** Kick drum: always plays on step 0, the cycle's downbeat, regardless of whether the rotated pattern happens to place an onset there. Fast pitch-dropping sine body plus a tiny noise click for the beater attack. */
function playKick(ctx: AudioContext, t: number, out: AudioNode): void {
  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
  oscGain.gain.setValueAtTime(0.0001, t);
  oscGain.gain.exponentialRampToValueAtTime(0.9, t + 0.006);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  osc.connect(oscGain).connect(out);
  osc.start(t);
  osc.stop(t + 0.34);

  const click = noiseSource(ctx);
  const clickFilter = ctx.createBiquadFilter();
  clickFilter.type = 'highpass';
  clickFilter.frequency.setValueAtTime(2000, t);
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.0001, t);
  clickGain.gain.exponentialRampToValueAtTime(0.25, t + 0.001);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  click.connect(clickFilter).connect(clickGain).connect(out);
  click.start(t);
  click.stop(t + 0.02);
}

/** Snare: an onset step. `accent` (true only on the shared downbeat, step 0) brightens/thickens the hit a little so the cycle's start still reads distinctly even though the kick already marks it. */
function playSnare(ctx: AudioContext, t: number, out: AudioNode, accent: boolean): void {
  const noise = noiseSource(ctx);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(1800, t);
  noiseFilter.Q.value = 0.7;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(accent ? 0.55 : 0.4, t + 0.002);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  noise.connect(noiseFilter).connect(noiseGain).connect(out);
  noise.start(t);
  noise.stop(t + 0.16);

  const osc = ctx.createOscillator();
  const oscGain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(accent ? 210 : 180, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.08);
  oscGain.gain.setValueAtTime(0.0001, t);
  oscGain.gain.exponentialRampToValueAtTime(accent ? 0.32 : 0.22, t + 0.002);
  oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  osc.connect(oscGain).connect(out);
  osc.start(t);
  osc.stop(t + 0.12);

  const res = noiseSource(ctx);
  const resFilter = ctx.createBiquadFilter();
  resFilter.type = 'bandpass';
  resFilter.frequency.setValueAtTime(320, t);
  resFilter.Q.value = 3.5;
  const resGain = ctx.createGain();
  resGain.gain.setValueAtTime(0.0001, t);
  resGain.gain.exponentialRampToValueAtTime(accent ? 0.16 : 0.11, t + 0.01);
  resGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  res.connect(resFilter).connect(resGain).connect(out);
  res.start(t);
  res.stop(t + 0.34);
}

/** Shaker: a rest step. A soft, breathy noise decay (a gentle attack, not a sharp transient) plus a couple of tiny offset bursts to suggest beads rattling. */
function playShaker(ctx: AudioContext, t: number, out: AudioNode): void {
  const bursts = [
    { offset: 0, gain: 0.13, dur: 0.13 },
    { offset: 0.015, gain: 0.06, dur: 0.09 },
    { offset: 0.03, gain: 0.035, dur: 0.06 },
  ];
  for (const b of bursts) {
    const bt = t + b.offset;
    const noise = noiseSource(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(6500, bt);
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, bt);
    gain.gain.linearRampToValueAtTime(b.gain, bt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, bt + b.dur);
    noise.connect(filter).connect(gain).connect(out);
    noise.start(bt);
    noise.stop(bt + b.dur + 0.02);
  }
}

/**
 * Bass note: sine+triangle blend through a lowpass filter, plus a quiet
 * triangle doubling an octave up for presence this low, plus a very short
 * filtered-noise "pluck" transient at the very start — ported verbatim from
 * the prototype's `playBass`. The amplitude envelope has a proper
 * plucked-string shape: fast attack, a quick initial decay down to a lower
 * sustain plateau, then a slower fade toward `dur`.
 */
function playBass(ctx: AudioContext, t: number, freq: number, dur: number, out: AudioNode): void {
  const attack = 0.006;
  const initialDecayEnd = t + 0.05;
  const sustainUntil = t + dur * 0.55;
  const releaseEnd = t + dur;
  const peak = 0.62;
  const sustainLevel = peak * 0.62;

  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const oscUp = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  const gainUp = ctx.createGain();

  osc.type = 'sine';
  osc2.type = 'triangle';
  oscUp.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  osc2.frequency.setValueAtTime(freq, t);
  oscUp.frequency.setValueAtTime(freq * 2, t);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1900, t);
  filter.frequency.exponentialRampToValueAtTime(700, initialDecayEnd);
  filter.frequency.exponentialRampToValueAtTime(500, sustainUntil);
  filter.frequency.exponentialRampToValueAtTime(220, releaseEnd);
  filter.Q.value = 0.8;

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(sustainLevel, initialDecayEnd);
  gain.gain.setValueAtTime(sustainLevel, sustainUntil);
  gain.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

  gainUp.gain.setValueAtTime(0.0001, t);
  gainUp.gain.exponentialRampToValueAtTime(peak * 0.26, t + attack);
  gainUp.gain.exponentialRampToValueAtTime(sustainLevel * 0.26, initialDecayEnd);
  gainUp.gain.setValueAtTime(sustainLevel * 0.26, sustainUntil);
  gainUp.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gain).connect(out);
  oscUp.connect(gainUp).connect(out);
  osc.start(t);
  osc2.start(t);
  oscUp.start(t);
  osc.stop(releaseEnd + 0.05);
  osc2.stop(releaseEnd + 0.05);
  oscUp.stop(releaseEnd + 0.05);

  const pluck = noiseSource(ctx);
  const pluckFilter = ctx.createBiquadFilter();
  pluckFilter.type = 'bandpass';
  pluckFilter.frequency.setValueAtTime(1800, t);
  pluckFilter.Q.value = 0.6;
  const pluckGain = ctx.createGain();
  pluckGain.gain.setValueAtTime(0.0001, t);
  pluckGain.gain.exponentialRampToValueAtTime(0.22, t + 0.002);
  pluckGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
  pluck.connect(pluckFilter).connect(pluckGain).connect(out);
  pluck.start(t);
  pluck.stop(t + 0.02);
}

// ---- Scheduler ----
// A standard lookahead scheduler (schedule everything due within
// `SCHEDULE_AHEAD_SEC`, on a `setInterval` polling every
// `SCHEDULER_INTERVAL_MS`) — same shape the earlier version of this file
// used, just driving one pattern instead of several independent layers.

function scheduleStep(ctx: AudioContext, out: AudioNode, step: number, t: number): void {
  const onset = currentPattern[step] === 1;
  if (step === 0) playKick(ctx, t, out);
  if (onset) playSnare(ctx, t, out, step === 0);
  else playShaker(ctx, t, out);
}

/**
 * Advances the chord walk once per full percussion-pattern loop
 * (`currentPattern.length` pulses) — the prototype's default "chord changes
 * every full loop" cadence, the only one this port keeps (its other fixed
 * cadences, and the UI to pick between them, aren't ported). The very first
 * time this fires (`isFirstChordSegment`) is a no-op: `startMusic` already
 * primed both `activeChord` and `nextChord` before the scheduler's first
 * tick, so advancing here too would skip a chord.
 */
function maybeAdvanceChord(): void {
  const interval = currentPattern.length || 1;
  if (currentStep % interval !== 0) return;
  if (isFirstChordSegment) {
    isFirstChordSegment = false;
    return;
  }
  activeChord = nextChord;
  nextChord = generateNextChordStep();
}

/**
 * The bass line: a chord tone (root, then 5th, alternating) every 4 pulses,
 * each preceded by a chromatic passing tone one pulse earlier — the
 * prototype's "every 4 pulses, root/5th only" bass strategy, the only one
 * this port keeps (see file doc comment). Unlike the prototype, whether a
 * given 4-pulse cell sounds at all is a coin flip (`bassProbability`,
 * driven by `setBassRemainingMs`) rather than unconditional.
 *
 * The flip happens at the *approach* slot (`posInCell === 3`, one pulse
 * before the main note) rather than at the main slot itself, because the
 * passing tone has to be scheduled a pulse ahead of the note it approaches
 * — so there has to be something to decide before that scheduling call.
 * `bassNextMainWillPlay` carries the decision forward exactly one pulse to
 * the main slot. `bassRootFifthToggle` only flips when a main note actually
 * plays, so a skipped cell doesn't disturb the root/5th alternation — the
 * next cell that *does* play picks up right where it left off.
 */
function maybeScheduleBass(ctx: AudioContext, out: AudioNode, t: number, secondsPerPulse: number): void {
  if (!activeChord || !nextChord) return;
  const posInCell = currentStep % 4;
  if (posInCell === 0) {
    if (!bassNextMainWillPlay) return;
    bassNextMainWillPlay = false;
    const roleIdx = bassRootFifthToggle ? 2 : 0; // byRole: [root, 3rd, 5th, 7th]
    const note = activeChord.byRole[roleIdx];
    lastMainBassMidi = note;
    const dur = Math.min(secondsPerPulse * 3.6, 3.0); // ring for most of the 4-pulse cell
    playBass(ctx, t, midiToFreq(note), dur, out);
    bassRootFifthToggle = bassRootFifthToggle ? 0 : 1;
  } else if (posInCell === 3) {
    if (Math.random() >= bassProbability(bassRemainingMs)) return;
    bassNextMainWillPlay = true;
    // Peek at which chord the *upcoming* main note (one pulse from now) belongs to — it may
    // already be `nextChord` if that pulse crosses a chord-change boundary.
    const interval = currentPattern.length || 1;
    const crossesChord = Math.floor(currentStep / interval) !== Math.floor((currentStep + 1) / interval);
    const targetChord = crossesChord ? nextChord : activeChord;
    const peekRoleIdx = bassRootFifthToggle ? 2 : 0; // the toggle hasn't flipped yet, so it already previews the upcoming role
    const target = targetChord.byRole[peekRoleIdx];
    const direction = target >= lastMainBassMidi ? 1 : -1;
    const passingPitch = target - direction;
    const dur = Math.min(secondsPerPulse * 0.9, 1.0);
    playBass(ctx, t, midiToFreq(passingPitch), dur, out);
  }
}

function schedulerLoop(): void {
  if (!audioCtx || !masterGain) return;
  const ctx = audioCtx;
  const secondsPerPulse = 60 / currentBpm;
  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
    maybeAdvanceChord();
    scheduleStep(ctx, masterGain, currentStep % currentPattern.length, nextNoteTime);
    maybeScheduleBass(ctx, masterGain, nextNoteTime, secondsPerPulse);
    nextNoteTime += secondsPerPulse;
    currentStep++;
  }
}

// ---- Public API ----

/**
 * Lazily creates the `AudioContext` + master gain, rolls a fresh random
 * Euclidean pattern, and starts the scheduler at `bpm` (Blitz's chosen pace
 * — see `game/blitz.ts`'s `BLITZ_PACE_MUSIC_BPM`; tempo is fixed for the
 * whole run, only the rhythm itself changes mid-run, via
 * `regenerateBlitzRhythm`). Deliberately only ever called from a real
 * live-play entry point (`main.ts`'s `startBlitzRun`), itself only ever
 * reached from a button click — constructing an `AudioContext` before any
 * user gesture is what mobile Safari's autoplay policy blocks, same
 * reasoning as `audio/sfx.ts`'s `ensureContext`. A no-op if already running
 * (so a defensive extra call from some other code path can't double-start
 * it) or if Web Audio isn't available at all.
 */
export function startMusic(bpm: number): void {
  if (running) return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  if (stopFadeTimer !== null) {
    // A stop's fade-out was still pending (a very fast Play Again) — cancel
    // it outright rather than letting it tear down the engine we're about to
    // (re)build a moment later.
    clearTimeout(stopFadeTimer);
    stopFadeTimer = null;
  }

  audioCtx = new Ctor();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = currentVolume;
  masterGain.connect(audioCtx.destination);
  noiseBuffer = makeNoiseBuffer(audioCtx);

  currentBpm = bpm;
  currentPattern = generateEuclideanPattern();
  currentStep = 0;
  nextNoteTime = audioCtx.currentTime + 0.05;

  // Bass line: a fresh harmonic walk each run, primed one chord-change ahead
  // (`activeChord`/`nextChord`) the same way the prototype's own
  // `startPlayback` did — see `maybeAdvanceChord`'s doc comment for why that
  // makes its first invocation a no-op. Starts silent (`bassNextMainWillPlay
  // = false`) regardless of `bassRemainingMs`, which is exactly the "start
  // without bassline" state a run's very first puzzle wants.
  initChordWalk();
  isFirstChordSegment = true;
  activeChord = generateNextChordStep();
  nextChord = generateNextChordStep();
  bassRootFifthToggle = 0;
  bassNextMainWillPlay = false;
  lastMainBassMidi = activeChord.byRole[0];

  schedulerTimer = setInterval(schedulerLoop, SCHEDULER_INTERVAL_MS);
  schedulerLoop(); // schedule the first steps immediately rather than waiting a full interval

  running = true;
}

/**
 * Fades the engine out and tears it down `STOP_FADE_SEC` later. Safe to
 * call even when not running. See `startMusic`'s doc comment for why a
 * near-immediate restart (cancelling the pending teardown) is handled
 * safely rather than racing it.
 */
export function stopMusic(): void {
  if (!running) return;
  running = false;
  const ctx = audioCtx;
  if (schedulerTimer !== null) clearInterval(schedulerTimer);
  schedulerTimer = null;
  if (ctx && masterGain) {
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setTargetAtTime(0, ctx.currentTime, STOP_FADE_SEC / 3);
  }
  stopFadeTimer = setTimeout(() => {
    stopFadeTimer = null;
    void ctx?.close();
    if (audioCtx === ctx) {
      audioCtx = null;
      masterGain = null;
      noiseBuffer = null;
    }
  }, STOP_FADE_SEC * 1000);
}

/**
 * Rerolls the current run's rhythm to a brand-new random Euclidean pattern
 * (fresh `n`/`k`/rotation — see `generateEuclideanPattern`), at the same
 * tempo the engine already started at. `main.ts`'s `advanceBlitzPuzzle`
 * calls this every time a new puzzle appears (including the very first one
 * of a run — though that one's initial pattern already comes from
 * `startMusic` itself, since it's called before the engine exists yet, so
 * this is a harmless no-op there). A no-op while the engine isn't running,
 * so a stray call after `stopMusic()` can't resurrect a pattern nothing is
 * scheduling any more.
 *
 * Resets `currentStep` back to 0 so the new pattern (and the bass line's own
 * 4-pulse cell grid, which shares this same running step count — see
 * `maybeScheduleBass`) both start fresh from the new puzzle's own downbeat,
 * and clears any bass note that was mid-decision (`bassNextMainWillPlay`) so
 * a stale approach-slot decision from the old pattern's phase can't land on
 * the new one's differently-aligned main slot. The harmonic walk itself
 * (`activeChord`/`nextChord`/the persistent chord/tonic/mode state) is left
 * completely untouched — the chord progression keeps evolving across the
 * whole run, only the rhythm resets per puzzle. One side effect of resetting
 * `currentStep` to exactly 0: `maybeAdvanceChord`'s own "once per loop"
 * check (`currentStep % currentPattern.length === 0`) is trivially true on
 * the very next pulse, so a new puzzle also advances the chord one step —
 * fitting, since the percussion loop that "once per loop" is counted
 * against just restarted too.
 */
export function regenerateBlitzRhythm(): void {
  if (!running) return;
  currentPattern = generateEuclideanPattern();
  currentStep = 0;
  bassNextMainWillPlay = false;
}

/** Sets the global music volume (0-1), applied live via a short ramp — same shape as `sfx.ts`'s `setSfxVolume`. Safe to call before the engine has ever started. */
export function setMusicVolume(volume: number): void {
  currentVolume = clamp01(volume);
  if (audioCtx && masterGain && running) {
    masterGain.gain.setTargetAtTime(currentVolume, audioCtx.currentTime, 0.05);
  }
}

/**
 * Feeds the run's current remaining-time cushion into the bass line's own
 * urgency curve (`bassProbability`). `main.ts`'s `blitzTick` calls this
 * every frame — the same rAF loop that already recomputes "remaining" for
 * the on-screen countdown — so the bass line always reacts to the live
 * clock rather than a stale snapshot from whenever the current puzzle
 * started. Safe to call before the engine has ever started (the value is
 * just held for whenever `maybeScheduleBass` next reads it); harmless to
 * keep calling after `stopMusic()` too, since nothing reads it once the
 * scheduler isn't running.
 */
export function setBassRemainingMs(remainingMs: number): void {
  bassRemainingMs = remainingMs;
}

/** Whether the engine is currently running — mostly for defensive/idempotency checks at call sites, not for any audible decision. */
export function isMusicRunning(): boolean {
  return running;
}
