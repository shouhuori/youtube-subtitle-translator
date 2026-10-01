import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
const source = readFileSync('extension/content-youtube.js', 'utf8');
const fn = source.match(/  async function recordWatchActivity\(\) \{[\s\S]*?\n  \}/)[0];
function load() {
 let now = 100_000;
 const requests = [];
 const video = { paused: false, duration: 650.5 };
 const sandbox = { nativeLanguageReady: Promise.resolve(), nativeLanguage: 'ja', lastWatchActivity: new Map(),
  Date: { now: () => now }, currentContext: { videoId: 'video', duration: 0 },
  getVideoIdFromUrl: () => 'video', getAuthTokenLocal: async () => 'test-only',
  document: { visibilityState: 'visible', querySelector: () => video },
  apiFetch: async (path, options) => { requests.push({ path, ...options }); },
 };
 vm.runInNewContext(`${fn};globalThis.record=recordWatchActivity;`, sandbox);
 return { sandbox, requests, video, record: sandbox.record, advance: () => { now += 60_000; } };
}
it('records actual playback in the selected language, preserves player duration, and throttles repeat events', async () => {
 const app = load();
 await app.record();
 await app.record();
 expect(app.requests).toHaveLength(1);
 expect(app.requests[0].path).toBe('/api/youtube/videos/video/view?targetLanguage=ja');
 expect(JSON.parse(app.requests[0].body)).toEqual({ duration: 650.5 });
 app.advance();
 await app.record();
 expect(app.requests).toHaveLength(2);
});
it('does not record paused, hidden or anonymous playback', async () => {
 const app = load();
 app.video.paused = true;
 await app.record();
 app.video.paused = false;
 app.sandbox.document.visibilityState = 'hidden';
 await app.record();
 app.sandbox.document.visibilityState = 'visible';
 app.sandbox.getAuthTokenLocal = async () => null;
 await app.record();
 expect(app.requests).toHaveLength(0);
});
