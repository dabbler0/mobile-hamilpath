/**
 * Player-adjustable app settings, persisted to `localStorage` — sound-effect
 * volume (see `audio/sfx.ts`) and live-play music volume (see
 * `audio/music.ts`), kept independent of one another (and of each other's
 * defaults) since a player may want the generative music quiet or off while
 * still hearing taps/wins, or vice versa. Kept as its own small module
 * (mirroring `persistence/gameStore.ts`'s separation from the pure game
 * logic it wraps) so a future setting doesn't have to be bolted onto
 * `main.ts`'s existing pile of `localStorage` keys. Every read/write here is
 * defensive about running outside a browser (no `localStorage` global) the
 * same way `puzzleGen.ts`'s `randomSeed` is defensive about missing
 * `crypto` — harmless in practice, but keeps this module importable from a
 * plain Node test run without a DOM.
 */

const SFX_VOLUME_STORAGE_KEY = 'loopit:sfxVolume';
const MUSIC_VOLUME_STORAGE_KEY = 'loopit:musicVolume';

/** Default volume (0-1) for a first-time player who's never touched the settings screen. */
export const DEFAULT_SFX_VOLUME = 0.6;
/** Default volume (0-1) for the generative live-play music — a little lower than sfx's own default, since it's meant to sit underneath everything else rather than compete with it. */
export const DEFAULT_MUSIC_VOLUME = 0.5;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Reads the persisted sfx volume, falling back to `DEFAULT_SFX_VOLUME` if nothing's been saved yet (or the saved value is malformed). */
export function loadSfxVolume(): number {
  const store = storage();
  const raw = store?.getItem(SFX_VOLUME_STORAGE_KEY);
  if (raw === null || raw === undefined) return DEFAULT_SFX_VOLUME;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clamp01(parsed) : DEFAULT_SFX_VOLUME;
}

/** Persists the sfx volume (clamped to [0, 1]) for future sessions. */
export function saveSfxVolume(volume: number): void {
  storage()?.setItem(SFX_VOLUME_STORAGE_KEY, String(clamp01(volume)));
}

/** Reads the persisted music volume, falling back to `DEFAULT_MUSIC_VOLUME` if nothing's been saved yet (or the saved value is malformed). */
export function loadMusicVolume(): number {
  const store = storage();
  const raw = store?.getItem(MUSIC_VOLUME_STORAGE_KEY);
  if (raw === null || raw === undefined) return DEFAULT_MUSIC_VOLUME;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clamp01(parsed) : DEFAULT_MUSIC_VOLUME;
}

/** Persists the music volume (clamped to [0, 1]) for future sessions. */
export function saveMusicVolume(volume: number): void {
  storage()?.setItem(MUSIC_VOLUME_STORAGE_KEY, String(clamp01(volume)));
}
