import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(import.meta.dirname, '../../extension/content-youtube-subtitles.js'),
  'utf8',
);

function loadResolver({ nativeFontSize = null } = {}) {
  const match = source.match(
    /  function resolveYouTubeCaptionFontSize\(player\) \{[\s\S]*?\n  \}/,
  );
  if (!match) throw new Error('Could not extract resolveYouTubeCaptionFontSize');

  const nativeCaption = nativeFontSize == null ? null : {};
  const context = {
    document: {
      querySelector: () => nativeCaption,
    },
    window: {
      getComputedStyle: () => ({ fontSize: nativeFontSize }),
    },
  };
  return vm.runInNewContext(`${match[0]}; resolveYouTubeCaptionFontSize`, context);
}

describe('YouTube subtitle font sizing', () => {
  it('uses the native YouTube caption computed size when available', () => {
    const resolveFontSize = loadResolver({ nativeFontSize: '34px' });
    expect(resolveFontSize({ clientHeight: 480 })).toBe(34);
  });

  it('falls back to a player-height based size with readable bounds', () => {
    const resolveFontSize = loadResolver();
    expect(resolveFontSize({ clientHeight: 360 })).toBe(22);
    expect(resolveFontSize({ clientHeight: 720 })).toBeCloseTo(33.12);
    expect(resolveFontSize({ clientHeight: 1440 })).toBe(48);
  });

  it('uses the same computed size for source and translated captions', () => {
    expect(source.match(/font-size: var\(--lr-youtube-caption-size, 22px\);/g)).toHaveLength(2);
  });
});
