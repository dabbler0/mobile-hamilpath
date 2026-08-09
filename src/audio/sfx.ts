/**
 * Interaction sound effects, built with the Web Audio API (no audio files —
 * every sound is synthesized on the fly, same as the standalone prototypes
 * this was ported from).
 *
 * Architecture: call sites never name a *sound* directly — they name a
 * *role* (`SfxRole`, e.g. `'regionToggle'`), and `ROLE_SOUNDS` below is the
 * one place that says which actual sound (`SfxId`) currently plays for that
 * role. This indirection exists specifically because the click sound used
 * for menu navigation and the click sound used for toggling a region are
 * *currently* the same sound but are expected to diverge later — when that
 * happens, it's a one-line change to `ROLE_SOUNDS`, not a hunt through every
 * `playSfx('menuNav')`/`playSfx('regionToggle')` call site in `main.ts`.
 * Adding a brand-new role later (say, a distinct "undo" sound) is the same
 * one-line-plus-a-player shape, not a redesign.
 */

/** Every distinct game event that can trigger a sound. See this file's doc comment for why call sites use these, not `SfxId` directly. */
export type SfxRole = 'menuNav' | 'regionToggle' | 'componentColorChange' | 'win';

/** Every distinct synthesized sound `SOUND_PLAYERS` knows how to play. */
type SfxId = 'click' | 'chime' | 'arpeggio';

/** Which sound currently backs each role. Menu navigation and region-toggle both point at `'click'` today — deliberately kept as two separate entries rather than one shared role, so they can be repointed independently later. */
const ROLE_SOUNDS: Record<SfxRole, SfxId> = {
  menuNav: 'click',
  regionToggle: 'click',
  componentColorChange: 'chime',
  win: 'arpeggio',
};

const SOUND_PLAYERS: Record<SfxId, (ctx: AudioContext, destination: AudioNode) => void> = {
  click: playClickSound,
  chime: playChimeSound,
  arpeggio: playArpeggioSound,
};

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
/** Mirrors whatever `setSfxVolume` was last called with, even before `audioCtx` exists (it's created lazily on the first `playSfx`, not at module load — see `ensureContext`). */
let currentVolume = 1;

/** Lazily creates the shared `AudioContext` + master gain node on first use. Deliberately not done at module load: constructing (and especially resuming) an `AudioContext` before any user gesture is what mobile Safari's autoplay policy blocks — see the original prototypes' "must happen after a user gesture" comments — so this only ever runs from inside `playSfx`, itself only ever called from a real click/tap/keypress handler. */
function ensureContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null; // no Web Audio support -- sfx is a no-op, never a crash
  audioCtx = new Ctor();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = currentVolume;
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

/** Sets the global sfx volume (0-1), applied live to whichever sound plays next (and, via a short ramp, to one already in flight). Safe to call before any sound has ever played — the value is simply remembered for `ensureContext` to pick up. */
export function setSfxVolume(volume: number): void {
  currentVolume = Math.min(1, Math.max(0, volume));
  if (audioCtx && masterGain) {
    masterGain.gain.setTargetAtTime(currentVolume, audioCtx.currentTime, 0.01);
  }
}

/** Plays whichever sound `role` currently maps to (see `ROLE_SOUNDS`). Silently does nothing at zero volume (skips even creating the `AudioContext`) or when Web Audio isn't available at all. */
export function playSfx(role: SfxRole): void {
  if (currentVolume <= 0) return;
  const ctx = ensureContext();
  if (!ctx || !masterGain) return;
  if (ctx.state === 'suspended') void ctx.resume();
  SOUND_PLAYERS[ROLE_SOUNDS[role]](ctx, masterGain);
}

// ---- Sound synthesis ----
// Ported from three standalone prototypes (a click, a chime, and a win
// arpeggio), each adapted only to render into a `destination` node passed
// in — the shared master-gain bus above — instead of hardcoding
// `ctx.destination`, so every sound is subject to the same volume control
// and to a single downstream connection point.

/** A short, percussive descending square-wave blip — menu navigation and region-toggle taps. */
function playClickSound(ctx: AudioContext, destination: AudioNode): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'square';
  osc.frequency.setValueAtTime(1000, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.02);

  gain.gain.setValueAtTime(1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);

  osc.connect(gain);
  gain.connect(destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.03);
}

/** A soft three-note major chime (root/fifth/octave) with a slight per-note stagger — a connected component's color changing. */
function playChimeSound(ctx: AudioContext, destination: AudioNode): void {
  const now = ctx.currentTime;
  const freqs = [523.25, 783.99, 1046.5]; // C5, G5, C6

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(0.5, now + 0.02);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
  envelope.connect(destination);

  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const delay = i * 0.03; // slight stagger for shimmer
    gain.gain.setValueAtTime(0.0001, now + delay);
    gain.gain.exponentialRampToValueAtTime(1 / (i + 1), now + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.2);

    osc.connect(gain);
    gain.connect(envelope);

    osc.start(now + delay);
    osc.stop(now + delay + 2.3);
  });
}

/** Builds a shared echo (delay + feedback) bus that every arpeggio note routes a copy into, so the whole arpeggio trails off together instead of each note echoing alone. Returns the delay node to use as each note's echo "send". */
function createEchoBus(ctx: AudioContext, destination: AudioNode): DelayNode {
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.16; // time between echo repeats

  const feedback = ctx.createGain();
  feedback.gain.value = 0.45; // how much of each echo feeds into the next (lower = dies out faster)

  const echoFilter = ctx.createBiquadFilter();
  echoFilter.type = 'lowpass';
  echoFilter.frequency.value = 2200; // each repeat gets a little darker/softer, like real echo

  const wetGain = ctx.createGain();
  wetGain.gain.value = 0.35; // overall echo volume relative to the dry signal

  // delay -> filter -> feedback -> back into delay (the repeating loop)
  delay.connect(echoFilter);
  echoFilter.connect(feedback);
  feedback.connect(delay);

  // tap the loop out to the shared destination
  echoFilter.connect(wetGain);
  wetGain.connect(destination);

  return delay;
}

/** One smooth note: two slightly detuned oscillators (a sine for warmth + a triangle for a little body) through a gentle lowpass filter, with a soft attack and a natural exponential decay. */
function playArpeggioNote(ctx: AudioContext, freq: number, startTime: number, duration: number, peakGain: number, echoSend: AudioNode, destination: AudioNode): void {
  const noteGain = ctx.createGain();
  noteGain.gain.setValueAtTime(0, startTime);
  noteGain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02); // soft attack, no click
  noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freq * 6, startTime);
  filter.frequency.exponentialRampToValueAtTime(freq * 2, startTime + duration); // filter closes as note dies, smooths the tail
  filter.Q.value = 0.7;

  noteGain.connect(filter);
  filter.connect(destination); // dry signal
  filter.connect(echoSend); // send a copy into the echo bus

  ([
    { type: 'sine', detune: 0, mix: 0.7 },
    { type: 'triangle', detune: 6, mix: 0.3 },
  ] as const).forEach((layer) => {
    const osc = ctx.createOscillator();
    osc.type = layer.type;
    osc.frequency.setValueAtTime(freq, startTime);
    osc.detune.setValueAtTime(layer.detune, startTime);

    const layerGain = ctx.createGain();
    layerGain.gain.value = layer.mix;

    osc.connect(layerGain);
    layerGain.connect(noteGain);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  });
}

/** A fast five-note major arpeggio (root through a 10th) with a shimmering, echoing final note — winning a puzzle. */
function playArpeggioSound(ctx: AudioContext, destination: AudioNode): void {
  const now = ctx.currentTime;
  const echoSend = createEchoBus(ctx, destination);

  const baseFreq = 523.25; // C5
  const ratios = [1, 1.25, 1.5, 2, 2.5]; // root, major 3rd, 5th, octave, 10th
  const noteSpacing = 0.05; // very fast, seconds between note starts
  const noteLength = 0.5; // longer natural decay, smoothed by the filter

  ratios.forEach((ratio, i) => {
    const startTime = now + i * noteSpacing;
    playArpeggioNote(ctx, baseFreq * ratio, startTime, noteLength, 0.22, echoSend, destination);
  });

  // Shimmer on the final, highest note - a soft high sine that lingers and echoes.
  const shimmerStart = now + (ratios.length - 1) * noteSpacing;
  playArpeggioNote(ctx, baseFreq * ratios[ratios.length - 1] * 2, shimmerStart, 0.8, 0.12, echoSend, destination);
}
