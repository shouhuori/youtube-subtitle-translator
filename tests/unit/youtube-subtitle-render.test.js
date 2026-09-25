import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../../extension/content-youtube-subtitles.js'), 'utf8');
function loadRenderer() {
  const render = source.match(/  function render\(\) \{[\s\S]*?\n  \}/)[0];
  const format = source.match(/  function formatCaptionText\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] || '';
  return new Function(`
    let item, lastRenderedKey = '';
    const mode = 'bilingual', taskStatus = 'completed', LAYER_ID = 'layer';
    const layer = { innerHTML: '', isConnected: true };
    const document = { getElementById: () => layer };
    const isTakeoverActive = () => true;
    const findCurrentSubtitle = () => item;
    const startKey = value => String(value);
    const ensureStyles = () => {}, syncCaptionFontSize = () => {};
    const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    ${format}
    ${render}
    return { show(value) { item = value; render(); return layer.innerHTML; } };
  `)();
}

it('cleans sentence periods from cached Chinese captions without changing source punctuation', () => {
  const renderer = loadRenderer();
  const html = renderer.show({ start: 0, text: 'Visit example.com. Version 3.14.', translation: '访问example.com。版本3.14．' });
  expect(html).toContain('>Visit example.com. Version 3.14.</div>');
  expect(html).toContain('>访问example.com版本3.14</div>');
});

it('repaints corrected content even when its starting time and translation presence are unchanged', () => {
  const renderer = loadRenderer();
  renderer.show({ start: 0, text: 'the same', translation: '同一件' });
  const html = renderer.show({ start: 0, text: 'the same shirt', translation: '同一件衬衫' });
  expect(html).toContain('>同一件衬衫</div>');
  expect(html).toContain('>the same shirt</div>');
});
