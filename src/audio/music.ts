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

function schedulerLoop(): void {
  if (!audioCtx || !masterGain) return;
  const ctx = audioCtx;
  while (nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
    scheduleStep(ctx, masterGain, currentStep % currentPattern.length, nextNoteTime);
    nextNoteTime += 60 / currentBpm;
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
 */
export function regenerateBlitzRhythm(): void {
  if (!running) return;
  currentPattern = generateEuclideanPattern();
  currentStep = 0;
}

/** Sets the global music volume (0-1), applied live via a short ramp — same shape as `sfx.ts`'s `setSfxVolume`. Safe to call before the engine has ever started. */
export function setMusicVolume(volume: number): void {
  currentVolume = clamp01(volume);
  if (audioCtx && masterGain && running) {
    masterGain.gain.setTargetAtTime(currentVolume, audioCtx.currentTime, 0.05);
  }
}

/** Whether the engine is currently running — mostly for defensive/idempotency checks at call sites, not for any audible decision. */
export function isMusicRunning(): boolean {
  return running;
}
