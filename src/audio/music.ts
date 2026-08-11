/**
 * Generative background percussion + drone music for live play, built with
 * the Web Audio API (no audio files — every sound is synthesized on the
 * fly). Ported from a standalone proof-of-concept (ten polyrhythmic
 * percussion layers on coprime/irrational tick subdivisions of a shared
 * cycle, plus three fifth-stacked drone tones), stripped of its own UI (the
 * prototype had a play button, LEDs, and a density arc canvas — this module
 * is headless; `main.ts` is the only caller) and given one addition the
 * prototype didn't need: an externally-driven density input.
 *
 * Architecture, mirroring `audio/sfx.ts`'s own indirection: nothing outside
 * this file names a synth function directly. `LAYER_DEFS` is the one list
 * of "what layers exist" (id, role, base volume, tick subdivision or drone
 * root frequency); `SYNTH_MAP` is the one place mapping a layer's `id` to
 * the function that actually renders it. Adding a brand-new layer later is
 * exactly a two-line change — one entry in each — not a redesign; the
 * scheduler/evolution logic below never needs to know a new layer exists
 * beyond that.
 *
 * The prototype decided how many layers should be audible at any moment
 * from its own internal sawtooth "build up, drop, repeat" arc. That arc is
 * gone: `setMusicDensity` is the replacement input, and it's deliberately
 * just a plain 0-1 number with no opinion about *why* it's that value —
 * `main.ts` is what decides the actual policy (Blitz's countdown clock vs.
 * Free Play's unmarked-cell count, see its own "Live-play music" section),
 * so a future third policy (a new game mode, a difficulty-based one, ...)
 * is purely a `main.ts`-side change, never one here. `evolve()` still adds
 * a little per-cycle jitter around whatever target it's given, for the same
 * organic "never quite repeats" feel the original arc had — see
 * `DENSITY_JITTER`.
 */

// ---- Layer definitions ----
// ticks = subdivisions per shared cycle. Mix of small integers, coprime
// primes, and one irrational ratio (never re-syncs, gives a shimmering
// non-repeating texture) — same set as the prototype, verbatim.
type MusicLayerRole = 'anchor' | 'rhythm' | 'texture' | 'color' | 'drone';

interface LayerDef {
  id: string;
  /** Subdivisions per shared cycle; `null` for a drone layer (continuously running, not tick-scheduled). */
  ticks: number | null;
  role: MusicLayerRole;
  baseGain: number;
  /** Drone layers only: the fundamental this drone's oscillator stack is built from. */
  rootFreq?: number;
}

const LAYER_DEFS: readonly LayerDef[] = [
  { id: 'anchor', ticks: 2, role: 'anchor', baseGain: 0.85 },
  { id: 'wood3', ticks: 3, role: 'rhythm', baseGain: 0.55 },
  { id: 'conga4', ticks: 4, role: 'rhythm', baseGain: 0.45 },
  { id: 'snare5', ticks: 5, role: 'rhythm', baseGain: 0.5 },
  { id: 'tom6', ticks: 6, role: 'rhythm', baseGain: 0.42 },
  { id: 'hat7', ticks: 7, role: 'texture', baseGain: 0.38 },
  { id: 'rim9', ticks: 9, role: 'texture', baseGain: 0.3 },
  { id: 'shaker', ticks: 1.6180339887, role: 'texture', baseGain: 0.32 }, // phi
  { id: 'hat_pi', ticks: Math.PI, role: 'texture', baseGain: 0.3 },
  { id: 'tap11', ticks: 11, role: 'color', baseGain: 0.16 },
  { id: 'drone', ticks: null, role: 'drone', baseGain: 0.1, rootFreq: 110 },
  { id: 'drone2', ticks: null, role: 'drone', baseGain: 0.09, rootFreq: 165 },
  { id: 'drone3', ticks: null, role: 'drone', baseGain: 0.08, rootFreq: 247.5 },
];

interface DroneNodes {
  oscs: OscillatorNode[];
  lfo: OscillatorNode;
}

interface Layer extends LayerDef {
  active: boolean;
  tickIndex: number;
  period: number;
  gainNode: GainNode | null;
  droneNodes?: DroneNodes;
}

// ---- Module state ----
// Deliberately a single always-at-most-one-running engine (there's only
// ever one live puzzle/run on screen at a time) rather than something
// instantiable — same "one shared context" shape as `audio/sfx.ts`, just
// with a start/stop lifecycle instead of always-ready fire-and-forget.
let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let layers: Layer[] = [];
let running = false;

let cycleDuration = 2.0; // seconds -- fixed for now; see this file's doc comment for tempo as a future extension point
let globalStart = 0;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let evolveTimer: ReturnType<typeof setInterval> | null = null;
let stopFadeTimer: ReturnType<typeof setTimeout> | null = null;

/** Mirrors whatever `setMusicVolume` was last called with, even before `audioCtx` exists — same pattern as `sfx.ts`'s `currentVolume`. */
let currentVolume = 0.5;
/** The latest value passed to `setMusicDensity` — read by `evolve()`, not applied directly (see `DENSITY_JITTER`). */
let externalDensityTarget = 0;

const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULER_LOOKAHEAD_SEC = 0.12;
/** How far `evolve()`'s actual per-cycle density is allowed to wander from `externalDensityTarget`, for a bit of organic variation instead of a perfectly mechanical mapping. */
const DENSITY_JITTER = 0.12;
/** Fade-out length before `stopMusic` actually tears the context down — long enough to not click/thump, short enough that a quick Rematch doesn't leave two engines briefly overlapping. */
const STOP_FADE_SEC = 0.4;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---- Synths ----
// Ported verbatim from the prototype (see this file's doc comment), only
// adapted to read `audioCtx`/`noiseBuffer` off module state instead of a
// script-global, and to take an explicit `out` destination the way
// `sfx.ts`'s own synths do.

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const size = ctx.sampleRate * 1;
  const buf = ctx.createBuffer(1, size, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < size; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function playKick(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9 * vel, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
}

function playWood(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  // sharp noise click for the "stick contact" transient
  const click = ctx.createBufferSource();
  click.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.exponentialRampToValueAtTime(0.45 * vel, t + 0.001);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
  click.connect(hp).connect(cg).connect(out);
  click.start(t);
  click.stop(t + 0.02);

  // fixed-pitch resonant body — no sweep, so it reads as a knock, not a zap
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 1400;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1400;
  bp.Q.value = 6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  osc.connect(bp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.05);
}

function playSnare(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.6 * vel, t + 0.005);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  noise.connect(bp).connect(ng).connect(out);
  noise.start(t);
  noise.stop(t + 0.16);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 190;
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(0.25 * vel, t + 0.004);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(og).connect(out);
  osc.start(t);
  osc.stop(t + 0.1);
}

function playHat(ctx: AudioContext, t: number, out: AudioNode, vel: number, open: boolean): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  const dur = open ? 0.22 : 0.055;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35 * vel, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  noise.connect(hp).connect(g).connect(out);
  noise.start(t);
  noise.stop(t + dur + 0.02);
}

function playConga(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  // noisy attack transient — the "hand hitting skin" contact sound
  const attack = ctx.createBufferSource();
  attack.buffer = noiseBuffer;
  const abp = ctx.createBiquadFilter();
  abp.type = 'bandpass';
  abp.frequency.value = 1000;
  abp.Q.value = 1.2;
  const ag = ctx.createGain();
  ag.gain.setValueAtTime(0.0001, t);
  ag.gain.exponentialRampToValueAtTime(0.35 * vel, t + 0.002);
  ag.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  attack.connect(abp).connect(ag).connect(out);
  attack.start(t);
  attack.stop(t + 0.03);

  // pitched membrane body — low-passed to tame the sweep so it reads as a
  // drum thump rather than a synth glide
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(170, t + 0.05);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.16);
}

function playTom(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, t);
  osc.frequency.exponentialRampToValueAtTime(85, t + 0.22);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6 * vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.32);
}

function playRimClick(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3500;
  bp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4 * vel, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  noise.connect(bp).connect(g).connect(out);
  noise.start(t);
  noise.stop(t + 0.04);
}

function playShaker(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 5000;
  bp.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.28 * vel, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  noise.connect(bp).connect(g).connect(out);
  noise.start(t);
  noise.stop(t + 0.12);
}

function playMutedTap(ctx: AudioContext, t: number, out: AudioNode, vel: number): void {
  // soft, short, low-pass-filtered thud — deliberately unobtrusive since
  // this layer fires more often (11 ticks/cycle) than any other
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.45 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(160, t + 0.05);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.06);
}

/** Which sound-synthesis function renders each `LAYER_DEFS` id — see this file's doc comment for why call sites never reach past this map. */
const SYNTH_MAP: Record<string, (ctx: AudioContext, t: number, out: AudioNode, vel: number) => void> = {
  anchor: playKick,
  wood3: playWood,
  conga4: playConga,
  snare5: playSnare,
  tom6: playTom,
  hat7: (ctx, t, out, vel) => playHat(ctx, t, out, vel, false),
  rim9: playRimClick,
  shaker: playShaker,
  hat_pi: (ctx, t, out, vel) => playHat(ctx, t, out, vel, true),
  tap11: playMutedTap,
};

// Drones: not tick-scheduled like the percussion layers — a few
// continuously running oscillators through a slow-moving filter, gated by
// the layer's own gain node exactly like everything else, so each fades
// in/out independently. Each drone layer has its own rootFreq; the three
// are stacked a fifth apart (root, +5th, +5th again), so any combination
// that's active still sounds in tune.
function setupDrone(ctx: AudioContext, layer: Layer): void {
  const now = ctx.currentTime + 0.1;
  const root = layer.rootFreq!;
  const freqs = [root, root * 1.5, root * 2]; // root, fifth, octave
  const mix = ctx.createGain();
  mix.gain.value = 0.12;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 450;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.05 + Math.random() * 0.03;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 140;
  lfo.connect(lfoGain).connect(lp.frequency);
  const oscs = freqs.map((f, i) => {
    const o = ctx.createOscillator();
    o.type = i === 0 ? 'sawtooth' : 'sine';
    o.frequency.value = f;
    o.detune.value = (Math.random() - 0.5) * 6;
    o.connect(mix);
    return o;
  });
  mix.connect(lp).connect(layer.gainNode!);
  oscs.forEach((o) => o.start(now));
  lfo.start(now);
  layer.droneNodes = { oscs, lfo };
}

// ---- Layer lifecycle ----
function activateLayer(ctx: AudioContext, layer: Layer): void {
  if (layer.active) return;
  layer.active = true;
  const now = ctx.currentTime;
  if (layer.role !== 'drone') {
    layer.period = cycleDuration / layer.ticks!;
    layer.tickIndex = Math.ceil((now + 0.1 - globalStart) / layer.period);
  }
  const rampTime = layer.role === 'drone' ? 1.4 : 0.6;
  const target = layer.role === 'drone' ? layer.baseGain : 1.0;
  layer.gainNode!.gain.cancelScheduledValues(now);
  layer.gainNode!.gain.setTargetAtTime(target, now, rampTime);
}

function deactivateLayer(ctx: AudioContext, layer: Layer, hard = false): void {
  if (!layer.active) return;
  layer.active = false;
  const now = ctx.currentTime;
  const rampTime = hard ? (layer.role === 'drone' ? 0.35 : 0.12) : layer.role === 'drone' ? 1.8 : 0.6;
  layer.gainNode!.gain.cancelScheduledValues(now);
  layer.gainNode!.gain.setTargetAtTime(0.0, now, rampTime);
}

function buildLayers(ctx: AudioContext): void {
  layers = LAYER_DEFS.map((def) => {
    const layer: Layer = { ...def, active: false, tickIndex: 0, period: 0, gainNode: null };
    layer.gainNode = ctx.createGain();
    layer.gainNode.gain.value = 0;
    layer.gainNode.connect(masterGain!);
    if (layer.role === 'drone') setupDrone(ctx, layer);
    return layer;
  });
}

// ---- Scheduler ----
function scheduleTick(ctx: AudioContext, layer: Layer, t: number): void {
  const jitter = layer.role === 'anchor' ? 0 : (Math.random() - 0.5) * layer.period * 0.03;
  const vel = layer.role === 'anchor' ? 1 : 0.85 + Math.random() * 0.3;
  const playT = t + jitter;
  SYNTH_MAP[layer.id](ctx, playT, layer.gainNode!, (vel * layer.baseGain) / 0.85);
}

function schedulerLoop(): void {
  if (!audioCtx) return;
  const ctx = audioCtx;
  const now = ctx.currentTime;
  layers.forEach((layer) => {
    if (!layer.active || layer.role === 'drone') return;
    let nextTime = globalStart + layer.tickIndex * layer.period;
    while (nextTime < now + SCHEDULER_LOOKAHEAD_SEC) {
      scheduleTick(ctx, layer, nextTime);
      layer.tickIndex++;
      nextTime = globalStart + layer.tickIndex * layer.period;
    }
  });
}

// ---- Evolution ----
// Decides, roughly every couple of musical cycles, which layers should be
// audible right now. `densityTarget` is `externalDensityTarget` (the
// caller's density input) plus a little jitter (`DENSITY_JITTER`) for
// organic variation — see this file's doc comment for why the target
// itself is entirely the caller's decision, not this module's.
function evolve(): void {
  if (!audioCtx) return;
  const ctx = audioCtx;
  const densityTarget = clamp01(externalDensityTarget + (Math.random() - 0.5) * DENSITY_JITTER);

  const desired = Math.round(1 + densityTarget * (layers.length - 1));
  const activeLayers = layers.filter((l) => l.active);
  const inactiveLayers = layers.filter((l) => !l.active);
  const dropCount = activeLayers.length - desired;

  if (dropCount > 0) {
    // Remove however many are needed to hit the target in ONE step, not one
    // per evolve() call — otherwise a big density drop trickles off over
    // many calls and layers stop at different times.
    const isBreakdown = dropCount >= 2;
    let candidates = activeLayers.filter((l) => l.role !== 'anchor');
    candidates.sort(() => Math.random() - 0.5);
    let toRemove = candidates.slice(0, dropCount);
    if (toRemove.length < dropCount && densityTarget < 0.1) {
      const anchorCandidates = activeLayers.filter((l) => l.role === 'anchor');
      toRemove = toRemove.concat(anchorCandidates.slice(0, dropCount - toRemove.length));
    }
    toRemove.forEach((l) => deactivateLayer(ctx, l, isBreakdown));
  } else if (dropCount < 0) {
    const addCount = -dropCount;
    const shuffled = [...inactiveLayers].sort(() => Math.random() - 0.5);
    shuffled.slice(0, addCount).forEach((l) => activateLayer(ctx, l));
  } else if (Math.random() < 0.25) {
    // swap a texture/color layer for variety even at stable density
    const swappable = activeLayers.filter((l) => l.role !== 'anchor');
    if (swappable.length && inactiveLayers.length) {
      deactivateLayer(ctx, swappable[Math.floor(Math.random() * swappable.length)]);
      activateLayer(ctx, inactiveLayers[Math.floor(Math.random() * inactiveLayers.length)]);
    }
  }

  // safety net: never let everything go silent for long
  if (layers.every((l) => !l.active)) {
    activateLayer(ctx, layers.find((l) => l.role === 'anchor')!);
  }
}

// ---- Public API ----

/**
 * Lazily creates the `AudioContext` + master gain and starts the engine.
 * Deliberately only ever called from a real live-play entry point
 * (`main.ts`'s `beginPuzzle`/`startBlitzRun`), themselves only ever reached
 * from a button click — constructing an `AudioContext` before any user
 * gesture is what mobile Safari's autoplay policy blocks, same reasoning as
 * `audio/sfx.ts`'s `ensureContext`. A no-op if already running (so a
 * defensive extra call from some other code path can't double-start it) or
 * if Web Audio isn't available at all.
 */
export function startMusic(): void {
  if (running) return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  if (stopFadeTimer !== null) {
    // A stop's fade-out was still pending (a very fast Rematch/Play Again) —
    // cancel it outright rather than letting it tear down the engine we're
    // about to (re)build a moment later.
    clearTimeout(stopFadeTimer);
    stopFadeTimer = null;
  }

  audioCtx = new Ctor();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = currentVolume;
  masterGain.connect(audioCtx.destination);
  noiseBuffer = makeNoiseBuffer(audioCtx);

  cycleDuration = 2.0;
  globalStart = audioCtx.currentTime + 0.2;
  buildLayers(audioCtx);

  // kick anchor off immediately; everything else starts silent and evolves in
  activateLayer(audioCtx, layers.find((l) => l.role === 'anchor')!);

  schedulerTimer = setInterval(schedulerLoop, SCHEDULER_INTERVAL_MS);
  evolveTimer = setInterval(evolve, cycleDuration * 1000 * 2);
  evolve(); // kick off the first evolution immediately rather than waiting a full interval

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
  if (evolveTimer !== null) clearInterval(evolveTimer);
  schedulerTimer = null;
  evolveTimer = null;
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
      layers = [];
    }
  }, STOP_FADE_SEC * 1000);
}

/**
 * Sets the density input `evolve()` builds each cycle's layer mix around
 * (0 = sparsest, 1 = densest — see this file's doc comment for who decides
 * what this value should be). Cheap and safe to call every frame (Blitz's
 * live countdown does exactly that) — it only ever writes a number; the
 * actual layer add/remove work happens on `evolve()`'s own slower cadence.
 * A no-op before `startMusic()` — the value is simply remembered for the
 * first `evolve()` call to pick up once the engine starts.
 */
export function setMusicDensity(target: number): void {
  externalDensityTarget = clamp01(target);
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
