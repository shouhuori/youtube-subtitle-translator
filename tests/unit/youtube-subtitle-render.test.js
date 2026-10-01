import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import vm from 'node:vm';

const source = readFileSync(resolve(import.meta.dirname, '../../extension/content-youtube-subtitles.js'), 'utf8');
function loadRenderer({ targetLanguage = 'zh-Hans', sourceLanguage = 'en' } = {}) {
  const scope = {};
  vm.runInNewContext(readFileSync('extension/languages.js', 'utf8'), scope);
  const render = source.match(/  function render\(\) \{[\s\S]*?\n  \}/)[0];
  const format = source.match(/  function formatCaptionText\([^)]*\) \{[\s\S]*?\n  \}/)?.[0] || '';
  return new Function('languages', `
    let item, lastRenderedKey = '';
    const mode = 'bilingual', taskStatus = 'completed', LAYER_ID = 'layer';
    const context = { targetLanguage: '${targetLanguage}', subtitles: { language: '${sourceLanguage}' } };
    const window = { YST_LANGUAGES: languages };
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
  `)(scope.YST_LANGUAGES);
}

it('cleans sentence periods from cached Chinese captions without changing source punctuation', () => {
  const renderer = loadRenderer();
  const html = renderer.show({ start: 0, text: 'Visit example.com. Version 3.14.', translation: '访问example.com。版本3.14．' });
  expect(html).toContain('>Visit example.com. Version 3.14.</div>');
  expect(html).toContain('>访问example.com版本3.14</div>');
});

it('shows only one caption line when video language is the native language', () => {
  const renderer = loadRenderer({ targetLanguage: 'ja', sourceLanguage: 'ja' });
  const html = renderer.show({ start: 0, text: 'これは日本語です。', translation: '' });
  expect(html.match(/<div/g)).toHaveLength(1);
  expect(html).toContain('これは日本語です。');
  expect(html).not.toContain('未翻译');
});

it('preserves English punctuation when the native language is English', () => {
  const renderer = loadRenderer({ targetLanguage: 'en', sourceLanguage: 'ja' });
  expect(renderer.show({ start: 0, text: 'こんにちは。', translation: 'Hello. How are you?' })).toContain('>Hello. How are you?</div>');
});

it('does not duplicate identical original and translated captions', () => {
  const renderer = loadRenderer();
  const html = renderer.show({ start: 0, text: '2026', translation: '2026' });
  expect(html.match(/<div/g)).toHaveLength(1);
});

it('repaints corrected content even when its starting time and translation presence are unchanged', () => {
  const renderer = loadRenderer();
  renderer.show({ start: 0, text: 'the same', translation: '同一件' });
  const html = renderer.show({ start: 0, text: 'the same shirt', translation: '同一件衬衫' });
  expect(html).toContain('>同一件衬衫</div>');
  expect(html).toContain('>the same shirt</div>');
});
it('clears translated timeline and restores native captions only for the matching video and language', () => {
  const handlers = new Map();
  const removed = [];
  const sandbox = {
    window: { addEventListener: (name, handler) => handlers.set(name, handler), dispatchEvent() {} },
    document: { addEventListener() {}, getElementById: () => ({ remove: () => removed.push('layer') }), querySelector: () => ({ classList: { remove: value => removed.push(value) } }) },
    chrome: { storage: { local: { get: (_keys, cb) => cb({}), set() {} }, onChanged: { addListener() {} } } },
  };
  const exposed = source.replace(/\}\)\(\);\s*$/, `
    context = { videoId: 'video-1', targetLanguage: 'zh-Hans' };
    takeoverVideoId = 'video-1';
    subtitleStore.set('0', { start: 0, end: 2, text: 'Hello', translation: '你好' });
    rebuildSubtitleTimeline();
    globalThis.state = () => ({ size: subtitleStore.size, timeline: subtitleTimeline.length, takeoverVideoId, context });
  })();`);
  vm.runInNewContext(exposed, sandbox);
  const clear = handlers.get('yst:yt:subtitles-cleared');
  expect(clear).toBeTypeOf('function');
  clear({ detail: { videoId: 'other-video', targetLanguage: 'zh-Hans' } });
  clear({ detail: { videoId: 'video-1', targetLanguage: 'ja' } });
  expect(sandbox.state().size).toBe(1);
  clear({ detail: { videoId: 'video-1', targetLanguage: 'zh-Hans' } });
  expect(sandbox.state()).toMatchObject({ size: 0, timeline: 0, takeoverVideoId: null, context: null });
  expect(removed).toContain('yst-yt-hide-native');
});
