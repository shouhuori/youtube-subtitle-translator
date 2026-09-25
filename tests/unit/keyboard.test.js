import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
const source = readFileSync(new URL('../../extension/content-youtube.js', import.meta.url), 'utf8');
function keyboard() {
  const fn = source.match(/  function onKeyDown\(e\) \{[\s\S]*?\n  \}/)[0];
  return new Function(`
    const calls = [];
    const isYouTubePlayerPage = () => true;
    const togglePanel = () => calls.push('panel');
    const cycleSubtitleMode = () => calls.push('mode');
    ${fn}
    return { press: onKeyDown, calls };
  `)();
}
it('opens tools and cycles subtitles using the new non-conflicting Alt+Shift shortcuts', () => {
  const key = keyboard();
  let prevented = 0;
  for (const letter of ['Y', 'B']) key.press({ key: letter === 'Y' ? 'Á' : 'ı', code: `Key${letter}`, altKey: true, shiftKey: true, target: { tagName: 'BODY' }, preventDefault() { prevented++; } });
  expect(key.calls).toEqual(['panel', 'mode']);
  expect(prevented).toBe(2);
});
it('does not intercept typing or the old LingRead shortcuts', () => {
  const key = keyboard();
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
    key.press({ key: 'Y', altKey: true, shiftKey: true, target, preventDefault() {} });
  }
  key.press({ key: 'L', shiftKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  expect(key.calls).toEqual([]);
});
