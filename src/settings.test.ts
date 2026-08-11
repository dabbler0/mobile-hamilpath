import { beforeEach, describe, expect, it } from 'vitest';
import { clamp01, DEFAULT_MUSIC_VOLUME, DEFAULT_SFX_VOLUME, loadMusicVolume, loadSfxVolume, saveMusicVolume, saveSfxVolume } from './settings';

/** Minimal in-memory `Storage` polyfill — this project's vitest run has no DOM, so `localStorage` isn't a global by default (see `settings.ts`'s doc comment). */
function makeFakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('clamp01', () => {
  it('clamps below zero up to zero', () => {
    expect(clamp01(-0.5)).toBe(0);
  });
  it('clamps above one down to one', () => {
    expect(clamp01(1.5)).toBe(1);
  });
  it('passes through an in-range value unchanged', () => {
    expect(clamp01(0.42)).toBe(0.42);
  });
  it('treats non-finite input as zero', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
  });
});

describe('sfx volume persistence', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = makeFakeStorage();
  });

  it('falls back to the default when nothing has been saved yet', () => {
    expect(loadSfxVolume()).toBe(DEFAULT_SFX_VOLUME);
  });

  it('round-trips a saved value', () => {
    saveSfxVolume(0.3);
    expect(loadSfxVolume()).toBe(0.3);
  });

  it('clamps an out-of-range value on save', () => {
    saveSfxVolume(5);
    expect(loadSfxVolume()).toBe(1);
  });

  it('falls back to the default for a malformed stored value', () => {
    localStorage.setItem('loopit:sfxVolume', 'not-a-number');
    expect(loadSfxVolume()).toBe(DEFAULT_SFX_VOLUME);
  });
});

describe('music volume persistence', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = makeFakeStorage();
  });

  it('falls back to the default when nothing has been saved yet', () => {
    expect(loadMusicVolume()).toBe(DEFAULT_MUSIC_VOLUME);
  });

  it('round-trips a saved value', () => {
    saveMusicVolume(0.35);
    expect(loadMusicVolume()).toBe(0.35);
  });

  it('clamps an out-of-range value on save', () => {
    saveMusicVolume(5);
    expect(loadMusicVolume()).toBe(1);
  });

  it('falls back to the default for a malformed stored value', () => {
    localStorage.setItem('loopit:musicVolume', 'not-a-number');
    expect(loadMusicVolume()).toBe(DEFAULT_MUSIC_VOLUME);
  });

  it('is independent of the sfx volume', () => {
    saveSfxVolume(0.1);
    saveMusicVolume(0.9);
    expect(loadSfxVolume()).toBe(0.1);
    expect(loadMusicVolume()).toBe(0.9);
  });
});
