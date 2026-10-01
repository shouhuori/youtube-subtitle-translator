import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
const source = readFileSync('extension/content-youtube.js', 'utf8');
const extract = name => source.match(new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0];
const context = {};
try { vm.runInNewContext(readFileSync('extension/languages.js', 'utf8'), context); } catch {}
const load = () => new Function('languages', `const window = { YST_LANGUAGES: languages }; ${extract('joinRuns')} ${extract('extractFromPlayerResponse')} ${extract('selectCaptionTrack')} return { select: selectCaptionTrack, extract: extractFromPlayerResponse };`)(context.YST_LANGUAGES);
const track = (languageCode, kind = '') => ({ languageCode, kind, baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}` });
it('uses English speech captions instead of the available Chinese manual translation', () => {
 const { select } = load();
 expect(select([track('zh-Hans'), track('en', 'asr')]).languageCode).toBe('en');
});
it('uses Japanese speech captions instead of Chinese or English translations', () => {
 const { select } = load();
 expect(select([track('zh-Hans'), track('en'), track('ja', 'asr')]).languageCode).toBe('ja');
});
it('prefers the original language manual track over ASR in that same language', () => {
 const { select } = load();
 expect(select([track('zh'), track('ja', 'asr'), track('ja')], 'ja').kind).toBe('');
});
it('uses the default audio caption language when multiple speech languages exist', () => {
 const { extract, select } = load();
 const data = extract({ videoDetails: { videoId: 'japanese' }, captions: { playerCaptionsTracklistRenderer: {
  captionTracks: [track('en', 'asr'), track('zh-Hans'), track('ja')],
  defaultAudioTrackIndex: 0, audioTracks: [{ defaultCaptionTrackIndex: 2, captionTrackIndices: [2] }],
 } } });
 expect(data.originalLanguage).toBe('ja');
 expect(select(data.captionTracks, data.originalLanguage).languageCode).toBe('ja');
});
it('does not select a YouTube translated URL as original speech', () => {
 const { select } = load();
 const translated = { ...track('zh'), baseUrl: 'https://www.youtube.com/api/timedtext?lang=en&tlang=zh' };
 expect(select([translated, track('en')]).languageCode).toBe('en');
});
