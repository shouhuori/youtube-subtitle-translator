import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const subtitleSource = readFileSync(
  resolve(import.meta.dirname, '../../extension/content-youtube-subtitles.js'),
  'utf8',
);
const youtubeSource = readFileSync(
  resolve(import.meta.dirname, '../../extension/content-youtube.js'),
  'utf8',
);
const bridgeSource = readFileSync(
  resolve(import.meta.dirname, '../../extension/content-youtube-bridge.js'),
  'utf8',
);

function extractFunction(source, name) {
  const match = source.match(new RegExp(`  (?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  if (!match) throw new Error(`Could not extract ${name}`);
  return match[0];
}

function loadSubtitleTimeline() {
  const rebuild = extractFunction(subtitleSource, 'rebuildSubtitleTimeline');
  const find = extractFunction(subtitleSource, 'findCurrentSubtitle');
  const ingest = extractFunction(subtitleSource, 'ingestItems');
  const setContext = extractFunction(subtitleSource, 'setContext');
  const reset = extractFunction(subtitleSource, 'reset');

  return new Function(`
    const subtitleStore = new Map();
    let subtitleTimeline = [];
    let subtitleTimelineMaxEnd = [];
    let lastTimelineIndex = -1;
    let videoEl = { currentTime: 0 };
    let context = { videoId: 'video-1' };
    let takeoverVideoId = null, lastRenderedKey = '', taskStatus = null, videoBound = false;
    const LAYER_ID = 'layer', HIDE_NATIVE_CLASS = 'hidden';
    const document = { getElementById: () => null, querySelector: () => null };
    const findVideoElement = () => ({ currentTime: 0 });
    const bindVideoEvents = () => {}, render = () => {}, applyHideNative = () => {}, dispatchStatus = () => {};
    const scheduleRender = () => {};
    const startKey = (s) => String(Math.round(Number(s) * 1000));
    ${rebuild}
    ${find}
    ${ingest}
    ${reset}
    ${setContext}
    return {
      seed(items) {
        subtitleStore.clear();
        for (const item of items) subtitleStore.set(startKey(item.start), item);
        rebuildSubtitleTimeline();
      },
      setTime(time) { videoEl.currentTime = time; },
      find: findCurrentSubtitle,
      ingest: (items) => ingestItems('video-1', items),
      items: () => Array.from(subtitleStore.values()).sort((a, b) => a.start - b.start),
      setContext,
      activate() { takeoverVideoId = context.videoId; },
      active: () => takeoverVideoId,
    };
  `)();
}

function loadNativeCaptionTakeover() {
  const isTakeoverActive = extractFunction(subtitleSource, 'isTakeoverActive');
  const applyHideNative = extractFunction(subtitleSource, 'applyHideNative');
  return new Function(`
    let takeoverVideoId = null;
    let mode = 'bilingual';
    let context = { videoId: 'video-1', subtitles: { segments: [{ start: 0, end: 1, text: '原文' }] } };
    const actions = [];
    const player = {
      classList: {
        add(value) { actions.push(['add', value]); },
        remove(value) { actions.push(['remove', value]); },
      },
    };
    const document = { querySelector: () => player };
    const HIDE_NATIVE_CLASS = 'yst-yt-hide-native';
    ${isTakeoverActive}
    ${applyHideNative}
    return {
      apply: applyHideNative,
      activate(videoId = 'video-1') { takeoverVideoId = videoId; },
      actions,
    };
  `)();
}

function loadSubtitleActivation() {
  const activateSubtitleTakeover = extractFunction(youtubeSource, 'activateSubtitleTakeover');
  return new Function(`
    let subtitleTakeoverVideoId = null;
    let currentContext = { videoId: 'previous-video' };
    let liveVideoId = 'current-video';
    const events = [];
    const getVideoIdFromUrl = () => liveVideoId;
    class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    }
    const window = { dispatchEvent(event) { events.push(event); } };
    ${activateSubtitleTakeover}
    return {
      activate: activateSubtitleTakeover,
      events,
      useContext(videoId) { currentContext = { videoId }; },
    };
  `)();
}

function loadChapterSeek() {
  const seek = extractFunction(youtubeSource, 'seekToChapter');
  return new Function(`
    const video = { currentTime: 0 };
    const player = { querySelector: () => video };
    const document = { querySelector: () => null };
    const getPanelPlayer = () => player;
    const getPanelAnchor = () => null;
    ${seek}
    return { seek: seekToChapter, video };
  `)();
}

function loadNavigationReset() {
  const navigate = extractFunction(youtubeSource, 'onNavigation');
  return new Function(`
    let currentVideoId = 'video-2';
    let currentContext = { videoId: 'video-1' };
    const resets = [];
    const getVideoIdFromUrl = () => 'video-2';
    const resetVideoScopedState = (videoId, options) => resets.push({ videoId, options });
    const isYouTubePlayerPage = () => false;
    const ensureContextBroadcast = () => {};
    const injectControlBarIcon = () => {};
    const ensureEmbedFloatingIcon = () => {};
    const injectTranscriptButton = () => {};
    const ICON_ID = 'icon';
    const EMBED_ICON_ID = 'embed';
    const TRANSCRIPT_BUTTON_ID = 'transcript';
    const document = { getElementById: () => null };
    ${navigate}
    return { run: onNavigation, resets };
  `)();
}

describe('YouTube low-overhead runtime', () => {
  it('uses the subtitle translation label and AI correction hint', () => {
    expect(youtubeSource).toContain("const ICON_LABEL = '字幕翻译'");
    expect(youtubeSource).toContain("btn.title = 'AI翻译矫正'");
    expect(subtitleSource).toContain('字幕未翻译，请选择双语或仅中文');
    expect(youtubeSource).toContain("const SUBTITLE_MODE_LABELS = { bilingual: '双语', target: '仅中文', off: '关闭' }");
    expect(youtubeSource).not.toContain('仅原文');
  });

  it('uses display mode wording and does not render the ready-count helper text', () => {
    const renderContext = extractFunction(youtubeSource, 'renderContext');
    const renderTaskUi = extractFunction(youtubeSource, 'renderTaskUi');
    expect(renderContext).toContain('显示模式（Shift+B 切换）');
    expect(youtubeSource).not.toContain('字幕已就绪（${cachedSubtitleItemsCount} 条），选择双语或仅中文即可加载');
    expect(renderTaskUi).not.toContain('字幕已加载（${cachedSubtitleItemsCount} 条），可在上方切换显示模式');
  });

  it('renders the translated video title between display modes and chapters', () => {
    expect(youtubeSource).toContain("apiFetch('/api/youtube/metadata/translate'");
    const renderContext = extractFunction(youtubeSource, 'renderContext');
    expect(renderContext).toContain('translatedVideoTitle');
    expect(renderContext).toContain('lr-video-title');
  });

  it('removes the empty status spacer between display buttons and the title', () => {
    expect(youtubeSource).toContain('#${PANEL_ID} .lr-task-status:empty { display: none; }');
    expect(youtubeSource).toContain('#${PANEL_ID} .lr-video-title {\n        margin-top: 0;');
  });

  it('puts translated subtitle modes first and removes source mode from the popup', () => {
    expect(youtubeSource).toContain("const SUBTITLE_MODES = ['bilingual', 'target', 'off']");
    const renderModeRow = extractFunction(youtubeSource, 'renderModeRow');
    expect(renderModeRow).not.toContain('lr-mode-source');
  });

  it('shows the factual correction step after subtitle translation reaches 100%', () => {
    const renderTaskUi = extractFunction(youtubeSource, 'renderTaskUi');
    expect(renderTaskUi).toContain("t.phase === 'factual_correction'");
    expect(renderTaskUi).toContain('正在进行事实性校正');
  });

  it('shows the subtitle regrouping step after factual correction', () => {
    const renderTaskUi = extractFunction(youtubeSource, 'renderTaskUi');
    expect(renderTaskUi).toContain("t.phase === 'resegmentation'");
    expect(renderTaskUi).toContain('正在重新断句');
  });

  it('translates chapter titles and seeks the YouTube player when a chapter is clicked', () => {
    expect(youtubeSource).toContain("apiFetch('/api/youtube/chapters/translate'");
    const renderContext = extractFunction(youtubeSource, 'renderContext');
    expect(renderContext).toContain('translatedChapterTitle');
    expect(renderContext).toContain('seekToChapter(ch.startTime)');
    const seekToChapter = extractFunction(youtubeSource, 'seekToChapter');
    expect(seekToChapter).toContain('video.currentTime = target');
    const chapter = loadChapterSeek();
    expect(chapter.seek(93)).toBe(true);
    expect(chapter.video.currentTime).toBe(93);
    expect(chapter.seek(-4)).toBe(true);
    expect(chapter.video.currentTime).toBe(0);
    expect(extractFunction(youtubeSource, 'openPanel')).toContain('!currentContext.chaptersLoaded');
    const navigation = loadNavigationReset();
    navigation.run();
    expect(navigation.resets).toEqual([{ videoId: 'video-2', options: { close: true } }]);
  });

  it('keeps video transcription independent from subtitle translation', () => {
    const injectTranscriptButton = extractFunction(youtubeSource, 'injectTranscriptButton');
    const startVideoTranscript = extractFunction(youtubeSource, 'startVideoTranscript');
    const openTranscriptPage = extractFunction(youtubeSource, 'openTranscriptPage');

    expect(youtubeSource).toContain("const TRANSCRIPT_BUTTON_ID = 'yst-yt-transcript-button'");
    expect(injectTranscriptButton).toContain('视频转写与总结');
    expect(injectTranscriptButton).toContain('#top-level-buttons-computed');
    expect(extractFunction(youtubeSource, 'renderContext')).not.toContain('class="lr-transcript-btn"');
    expect(extractFunction(youtubeSource, 'renderContext')).not.toContain('class="lr-fetch-btn"');
    expect(youtubeSource).toContain('无需先翻译字幕，直接生成独立的文字阅读页');
    expect(startVideoTranscript).toContain("apiFetch('/api/youtube/transcript/source'");
    expect(startVideoTranscript).not.toContain('/api/youtube/subtitle/task');
    expect(startVideoTranscript).toContain("title: ctx.title || ''");
    expect(startVideoTranscript).toContain("channelName: ctx.channelName || ''");
    expect(startVideoTranscript).toContain('视频转写准备失败：');
    expect(openTranscriptPage).toContain('/transcript?generate=1');
  });

  it('keeps native YouTube captions until the user explicitly enables LingRead subtitles', () => {
    const takeover = loadNativeCaptionTakeover();
    takeover.apply();
    expect(takeover.actions).toEqual([['remove', 'yst-yt-hide-native']]);

    takeover.activate();
    takeover.apply();
    expect(takeover.actions.at(-1)).toEqual(['add', 'yst-yt-hide-native']);

    takeover.activate('previous-video');
    takeover.apply();
    expect(takeover.actions.at(-1)).toEqual(['remove', 'yst-yt-hide-native']);

    const render = extractFunction(subtitleSource, 'render');
    expect(render).toContain("if (!takeoverActive || mode === 'off')");
    expect(subtitleSource).toContain("window.addEventListener('yst:yt:activate-subtitles'");
    expect(extractFunction(subtitleSource, 'activateTakeover')).toContain('context.videoId !== videoId');
  });

  it('only activates subtitle takeover from the user action and resets it on video navigation', () => {
    const activation = loadSubtitleActivation();
    expect(activation.activate('previous-video')).toBe(false);
    expect(activation.events).toHaveLength(0);
    activation.useContext('current-video');
    expect(activation.activate('current-video')).toBe(true);
    expect(activation.events[0].detail).toEqual({ videoId: 'current-video' });

    const ensureSubtitleTranslation = extractFunction(youtubeSource, 'ensureSubtitleTranslation');
    const refreshSubtitleState = extractFunction(youtubeSource, 'refreshSubtitleState');
    const ensureContextBroadcast = extractFunction(youtubeSource, 'ensureContextBroadcast');
    const onNavigation = extractFunction(youtubeSource, 'onNavigation');
    const resetVideoScopedState = extractFunction(youtubeSource, 'resetVideoScopedState');

    expect(ensureSubtitleTranslation).toContain('getVideoIdFromUrl() === videoId');
    expect(ensureSubtitleTranslation).toContain('activateSubtitleTakeover(videoId)');
    expect(refreshSubtitleState).not.toContain('activateSubtitleTakeover()');
    expect(ensureContextBroadcast).not.toContain('activateSubtitleTakeover()');
    expect(ensureContextBroadcast.match(/vid !== getVideoIdFromUrl\(\)/g)).toHaveLength(2);
    expect(onNavigation).toContain('resetVideoScopedState(newVid, { close: true })');
    expect(onNavigation).toContain('currentContext && currentContext.videoId !== newVid');
    expect(resetVideoScopedState).toContain('currentContext = null');
    expect(resetVideoScopedState).toContain('subtitleTakeoverVideoId = null');
    expect(resetVideoScopedState).toContain("new CustomEvent('yst:yt:context-cleared')");
    expect(extractFunction(youtubeSource, 'openPanel')).toContain('ctx.videoId !== vid');
  });

  it('uses navigation events instead of permanent DOM and URL polling', () => {
    expect(youtubeSource).not.toContain('function watchControlBar');
    const startSection = youtubeSource.slice(
      youtubeSource.indexOf('  function start()'),
      youtubeSource.indexOf("  if (document.readyState === 'loading')"),
    );
    expect(startSection).not.toContain('setInterval(() =>');
    expect(startSection).toContain("window.addEventListener('yt-navigate-finish'");
    expect(startSection).toContain("window.addEventListener('yt-page-data-updated'");
    expect(startSection).toContain("window.addEventListener('yt-player-updated'");
    expect(startSection).toContain("window.addEventListener('popstate'");
  });

  it('only observes YouTube network responses for timedtext requests', () => {
    expect(bridgeSource).toContain("if (TIMEDTEXT_RE.test(this.__lr_url || ''))");
    expect(bridgeSource).toContain('if (TIMEDTEXT_RE.test(reqUrl))');
  });

  it('finds the latest overlapping subtitle and supports backward seeks', () => {
    const timeline = loadSubtitleTimeline();
    timeline.seed([
      { start: 0, end: 10, text: 'outer' },
      { start: 5, end: 6, text: 'inner' },
      { start: 11, end: 12, text: 'next' },
    ]);

    timeline.setTime(5.5);
    expect(timeline.find().text).toBe('inner');
    timeline.setTime(7);
    expect(timeline.find().text).toBe('outer');
    timeline.setTime(11.5);
    expect(timeline.find().text).toBe('next');
    timeline.setTime(1);
    expect(timeline.find().text).toBe('outer');
  });

  it('restores the full source timeline after initially loading only an incremental cache', async () => {
    const timeline = loadSubtitleTimeline();
    await timeline.setContext({ videoId: 'video-1', subtitles: {
      fromCache: true, segments: [{ start: 0, end: 2, text: 'cached' }],
    } });
    timeline.activate();
    timeline.ingest([{ start: 0, end: 2, text: 'corrected', translation: '译文' }]);
    await timeline.setContext({ videoId: 'video-1', subtitles: { segments: [
      { start: 0, end: 1, text: 'first' }, { start: 1, end: 2, text: 'second' },
      { start: 635.84, end: 637, text: 'ending' },
    ] } });
    timeline.setTime(636);
    expect(timeline.find()?.text).toBe('ending');
    timeline.setTime(1.5);
    expect(timeline.find()?.translation).toBe('译文');
    expect(timeline.active()).toBe('video-1');
  });

  it('merges corrected subtitle ranges without a nested full-map scan', () => {
    const timeline = loadSubtitleTimeline();
    timeline.seed([
      { start: 0, end: 1, text: 'zero', translation: '' },
      { start: 1, end: 2, text: 'one', translation: '' },
      { start: 2, end: 3, text: 'two', translation: '' },
      { start: 3, end: 4, text: 'three', translation: '' },
    ]);

    timeline.ingest([{ start: 0, end: 3, text: 'merged', translation: '合并' }]);

    expect(timeline.items()).toEqual([
      { start: 0, end: 3, text: 'merged', translation: '合并' },
      { start: 3, end: 4, text: 'three', translation: '' },
    ]);
    expect(subtitleSource).not.toContain('for (const k of Array.from(subtitleStore.keys()))');
  });

  it('skips computed-style work while the current subtitle is unchanged', () => {
    const render = extractFunction(subtitleSource, 'render');
    expect(render.indexOf('key === lastRenderedKey')).toBeLessThan(render.indexOf('syncCaptionFontSize(layer)'));
  });
});
