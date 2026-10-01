import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import vm from 'node:vm';
const scope = {};
vm.runInNewContext(readFileSync('extension/languages.js', 'utf8'), scope);

const source = readFileSync(resolve(import.meta.dirname, '../../extension/content-youtube.js'), 'utf8');
const extract = name => source.match(new RegExp(`  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || '';

function loadState(data, { context = null, native = null, token = null } = {}) {
  return new Function('data', 'initialContext', 'native', 'token', 'languages', `
    const nativeLanguageReady = Promise.resolve(), nativeLanguage = 'zh-Hans';
    let currentContext = initialContext, subtitleTask, subtitleTaskFromAuth;
    let cachedSubtitleItemsReady = false, cachedSubtitleItemsCount = 0;
    let cachedSubtitleItemsIncomplete = false;
    let cachedSubtitleSourceMismatch = false;
    let subtitleStateRequestId = 0;
    let panelOpen = false;
    const events = [], broadcasts = [];
    const getVideoIdFromUrl = () => 'video';
    const getAuthTokenLocal = async () => token;
    const apiFetch = async () => data;
    const buildContext = async () => native;
    const broadcastContext = ctx => broadcasts.push(ctx);
    const document = { querySelector: () => null, title: 'Video' };
    const renderContext = () => {}, renderTaskUi = () => {}, updateButtonBadge = () => {};
    const startTaskPoll = () => {}, stopTaskPoll = () => {};
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
    const window = { dispatchEvent: event => events.push(event) };
    ${extract('hasCompleteSubtitleCoverage')}
    ${extract('isSubtitleSourceCompatible')}
    ${extract('buildCachedSubtitleContext')}
    ${extract('refreshSubtitleState')}
    return {
      refresh: () => refreshSubtitleState('video'),
      respondWith(value) { data = value; },
      state: () => ({ ready: cachedSubtitleItemsReady, incomplete: cachedSubtitleItemsIncomplete, task: subtitleTask, context: currentContext, events, broadcasts }),
    };
  `)(data, context, native, token, scope.YST_LANGUAGES);
}

const raw = { videoId: 'video', subtitles: { segments: [
  { start: 0, end: 2, text: 'Opening' },
  { start: 2, end: 4, text: 'Middle' },
  { start: 635.84, end: 637, text: 'So go take a look.' },
] } };
const translated = raw.subtitles.segments.map(item => ({ ...item, translation: '译文' }));

it('does not call an anonymous partial cache ready when its task has been deleted', async () => {
  const runtime = loadState({ items: translated.slice(0, 2), task: null }, { native: raw });
  expect(await runtime.refresh()).toBe(true);
  expect(runtime.state().ready).toBe(false);
  expect(runtime.state().incomplete).toBe(true);
  expect(runtime.state().context.subtitles.segments.at(-1).end).toBe(637);
  expect(runtime.state().events.some(event => event.type === 'yst:yt:subtitles-data')).toBe(false);
});

it('detects a missing middle range even when the last translated cue reaches the end', async () => {
  const runtime = loadState({ items: [translated[0], translated[2]], task: { status: 'completed' } }, { context: raw, token: 'test' });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(false);
});

it('accepts a complete cache whose corrected sentence boundaries differ from the original cues', async () => {
  const items = [
    { start: 0, end: 1, text: 'A', translation: '甲' },
    { start: 1, end: 4, text: 'B', translation: '乙' },
    translated[2],
  ];
  const runtime = loadState({ items, task: null }, { native: raw });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(true);
  expect(runtime.state().events.find(event => event.type === 'yst:yt:subtitles-data').detail.items).toEqual(items);
});

it('does not use a partial cached context as evidence that its own translation is complete', async () => {
  const context = { videoId: 'video', subtitles: { fromCache: true, segments: raw.subtitles.segments.slice(0, 2) } };
  const runtime = loadState({ items: translated.slice(0, 2), task: null }, { context, native: raw });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(false);
  expect(runtime.state().context.subtitles.fromCache).not.toBe(true);
});

it('does not certify an unknown cache when the original track cannot be loaded', async () => {
  const runtime = loadState({ items: translated, task: null });
  expect(await runtime.refresh()).toBe(false);
  expect(runtime.state().ready).toBe(false);
});

it('keeps incremental translations available during a running task', async () => {
  const runtime = loadState({ items: translated.slice(0, 1), task: { status: 'running' } }, { context: raw, token: 'test' });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(false);
  expect(runtime.state().events.find(event => event.type === 'yst:yt:subtitles-data').detail.items).toHaveLength(1);
});

it.each([NaN, Infinity, 0])('does not accept an invalid final translated end %s', async end => {
  const runtime = loadState({ items: [...translated.slice(0, 2), { ...translated[2], end }], task: null }, { context: raw });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(false);
});

it('does not count empty translations as coverage', async () => {
  const runtime = loadState({ items: translated.map(item => ({ ...item, translation: ' ' })), task: null }, { context: raw });
  await runtime.refresh();
  expect(runtime.state().ready).toBe(false);
});

it('ignores an older cache check that finishes loading its source after a newer running task', async () => {
  let resolveNative;
  const native = new Promise(resolve => { resolveNative = resolve; });
  const runtime = loadState({ items: translated, task: null }, { native, token: 'test' });
  const oldRefresh = runtime.refresh();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  runtime.respondWith({ items: translated.slice(0, 1), task: { taskId: 'new-task', status: 'running' } });
  await runtime.refresh();
  expect(runtime.state().task.status).toBe('running');
  resolveNative(raw);
  await oldRefresh;
  expect(runtime.state().task?.status).toBe('running');
  expect(runtime.state().ready).toBe(false);
});
