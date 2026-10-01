// content-youtube-subtitles.js — YouTube 双语字幕注入与渲染（isolated world）
//
// 纯渲染器：不做任何网络请求，也不再"边播边按需翻译"。字幕翻译已改为后台
// 任务模式（见 content-youtube.js + 服务端 /api/youtube/subtitle/task）。本模块
// 只负责：
//   - 接收 yst:yt:context-ready 拿到视频上下文（含已合并的原始字幕轨）
//   - 接收 yst:yt:subtitles-data 拿到服务端已翻译矫正的字幕条目并合并
//   - 监听 video timeupdate，匹配并渲染当前应显示的字幕
//   - 双语 / 仅译文 / 关闭三种模式，持久化在 chrome.storage.local
//
// 事件（与 content-youtube.js 通过 window CustomEvent 通信）：
//   in:  yst:yt:context-ready   { detail: VideoContext }      // 原文就位
//        yst:yt:subtitles-data  { detail: { videoId, targetLanguage, items } } // 译文增量
//        yst:yt:subtitles-cleared { detail: { videoId, targetLanguage } }
//        yst:yt:context-cleared
//        yst:yt:set-mode        { detail: { mode } }
//        yst:yt:activate-subtitles { detail: { videoId } }      // 用户主动接管字幕
//   out: yst:yt:status          { detail: { status } }         // ready | error

(function () {
  if (window.__YST_YT_SUBTITLES__) return;
  window.__YST_YT_SUBTITLES__ = true;

  // ── 常量 ─────────────────────────────────────────────────
  const MODES = ['bilingual', 'source', 'target', 'off'];
  const DEFAULT_MODE = 'bilingual';
  const STORAGE_KEY = 'youtubeSubtitleMode';
  const LAYER_ID = 'yst-yt-subtitles-layer';
  const STYLE_ID = 'yst-yt-subtitles-style';
  const HIDE_NATIVE_CLASS = 'yst-yt-hide-native';

  // ── 状态 ─────────────────────────────────────────────────
  let videoEl = null;
  let context = null;
  const subtitleStore = new Map(); // startKey -> { start, end, text, translation }
  let subtitleTimeline = [];
  let subtitleTimelineMaxEnd = [];
  let lastTimelineIndex = -1;
  let mode = DEFAULT_MODE;
  // 每个视频都必须由用户主动选择字幕模式后才能接管 YouTube 原生字幕。
  let takeoverVideoId = null;
  let videoBound = false;
  let lastRenderedKey = '';
  let taskStatus = null; // 翻译任务状态：进行中时未译行显示"翻译中…"

  // ── 工具 ─────────────────────────────────────────────────
  function startKey(s) { return String(Math.round(Number(s) * 1000)); }

  function isTakeoverActive() {
    return !!(context && context.videoId && takeoverVideoId === context.videoId);
  }

  function rebuildSubtitleTimeline() {
    subtitleTimeline = Array.from(subtitleStore.values())
      .filter((item) => (
        item
        && Number.isFinite(item.start)
        && Number.isFinite(item.end)
        && item.end > item.start
      ))
      .sort((a, b) => a.start - b.start);
    subtitleTimelineMaxEnd = [];
    let maxEnd = -Infinity;
    for (let i = 0; i < subtitleTimeline.length; i++) {
      maxEnd = Math.max(maxEnd, subtitleTimeline[i].end);
      subtitleTimelineMaxEnd[i] = maxEnd;
    }
    lastTimelineIndex = -1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function dispatchStatus(status, detail) {
    try {
      window.dispatchEvent(new CustomEvent('yst:yt:status', { detail: { status, ...(detail || {}) } }));
    } catch (_e) {}
  }

  // 用 rAF 节流 render：字幕分批回填时每批都会触发 store 更新，rAF 合并成每帧一次。
  let renderRafId = 0;
  function scheduleRender() {
    if (renderRafId) return;
    renderRafId = requestAnimationFrame(() => {
      renderRafId = 0;
      render();
    });
  }

  // ── 模式持久化 ────────────────────────────────────────────
  function loadMode() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (r) => {
          const m = r && r[STORAGE_KEY];
          resolve(MODES.includes(m) ? m : DEFAULT_MODE);
        });
      } catch (_e) { resolve(DEFAULT_MODE); }
    });
  }

  function saveMode(m) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: m }, () => resolve());
      } catch (_e) { resolve(); }
    });
  }

  // ── 译文合并 ─────────────────────────────────────────────
  // 服务端最终字幕会重新智能断句，边界可以跨越或落在原 ASR cue 内部。新条目的
  // [start, end] 会覆盖若干旧 cue 的 start；这里删掉被覆盖的原文条目，防止旧 raw
  // 条与最终句组同时落在 currentTime 上互抢。
  function ingestItems(videoId, items) {
    if (!context || (videoId && context.videoId !== videoId)) return;
    if (!Array.isArray(items) || !items.length) return;
    const normalizedItems = items
      .filter((item) => item && Number.isFinite(item.start))
      .map((item) => ({
        start: item.start,
        end: item.end,
        text: item.text || '',
        translation: item.translation || '',
      }))
      .sort((a, b) => a.start - b.start);
    if (!normalizedItems.length) return;

    // 服务端矫正条目可能覆盖多个原始 cue。旧实现对每个新条目完整扫描一次
    // Map，长视频会退化为 O(n²)；这里按时间顺序一次合并完成。
    const coveringRanges = normalizedItems.filter(item => Number.isFinite(item.end) && item.end > item.start);
    if (coveringRanges.length) {
      const existingItems = Array.from(subtitleStore.values()).sort((a, b) => a.start - b.start);
      let rangeIndex = 0;
      for (const existing of existingItems) {
        while (rangeIndex < coveringRanges.length && coveringRanges[rangeIndex].end <= existing.start) {
          rangeIndex++;
        }
        const range = coveringRanges[rangeIndex];
        if (range && existing.start > range.start && existing.start < range.end) {
          subtitleStore.delete(startKey(existing.start));
        }
      }
    }
    for (const item of normalizedItems) {
      subtitleStore.set(startKey(item.start), item);
    }
    rebuildSubtitleTimeline();
    scheduleRender();
  }

  // ── 渲染 ─────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIDE_NATIVE_CLASS} .caption-window,
      .${HIDE_NATIVE_CLASS} .ytp-caption-window-container > div {
        display: none !important;
      }
      #${LAYER_ID} {
        position: absolute;
        left: 0; right: 0;
        bottom: 8%;
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 50;
        text-align: center;
        padding: 0 4%;
        font-family: 'Roboto', 'YouTube Sans', 'Helvetica Neue', Arial, sans-serif;
        font-weight: 500;
      }
      #${LAYER_ID} .lr-line {
        display: inline-block;
        max-width: 100%;
        background: rgba(8, 8, 8, 0.78);
        padding: 4px 14px;
        margin-top: 4px;
        border-radius: 4px;
        line-height: 1.45;
        white-space: pre-wrap;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
      }
      #${LAYER_ID} .lr-line-source {
        color: #fff;
        font-size: var(--lr-youtube-caption-size, 22px);
      }
      #${LAYER_ID} .lr-line-target {
        color: #ffd9a8;
        font-size: var(--lr-youtube-caption-size, 22px);
      }
      #${LAYER_ID} .lr-line-pending {
        color: #cfcfcf;
        opacity: 0.75;
        font-style: italic;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureLayer() {
    let layer = document.getElementById(LAYER_ID);
    if (layer) return layer;
    const player = document.querySelector('.html5-video-player');
    if (!player) return null;
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    player.appendChild(layer);
    // 关键：YouTube 切剧场/全屏/迷你播放器时会重建 player DOM，原 layer 被删；
    // 重建后必须把 lastRenderedKey 清掉，否则 render 会因 key 没变而早返回，
    // 新 layer 一直空着——表现为"播着播着字幕没了"。
    lastRenderedKey = '';
    return layer;
  }

  function applyHideNative() {
    const player = document.querySelector('.html5-video-player');
    if (!player) return;
    if (!isTakeoverActive() || mode === 'off' || !context.subtitles) {
      player.classList.remove(HIDE_NATIVE_CLASS);
    } else {
      player.classList.add(HIDE_NATIVE_CLASS);
    }
  }

  function findCurrentSubtitle() {
    if (!videoEl || !subtitleTimeline.length) return null;
    const t = videoEl.currentTime || 0;

    const current = subtitleTimeline[lastTimelineIndex];
    const next = subtitleTimeline[lastTimelineIndex + 1];
    if (current && current.start <= t && t < current.end && (!next || next.start > t)) {
      return current;
    }

    // 二分找到最后一个 start <= currentTime 的条目。prefix maxEnd 允许在存在
    // 少量重叠 cue 时向前检查，同时在普通无重叠字幕上保持 O(log n)。
    let low = 0;
    let high = subtitleTimeline.length - 1;
    let index = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (subtitleTimeline[mid].start <= t) {
        index = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    while (index >= 0 && subtitleTimelineMaxEnd[index] > t) {
      const item = subtitleTimeline[index];
      if (t < item.end) {
        lastTimelineIndex = index;
        return item;
      }
      index--;
    }
    lastTimelineIndex = -1;
    return null;
  }

  // 优先复用 YouTube 原生字幕的实际计算字号，这样也能跟随用户在播放器中设置的
  // 字幕大小。原生字幕 DOM 尚未生成时，按播放器高度估算一个接近默认字幕的字号。
  function resolveYouTubeCaptionFontSize(player) {
    try {
      const nativeCaption = document.querySelector('.ytp-caption-segment');
      if (nativeCaption) {
        const nativeSize = parseFloat(window.getComputedStyle(nativeCaption).fontSize || '');
        if (Number.isFinite(nativeSize) && nativeSize > 0) return nativeSize;
      }
    } catch (_e) {}
    const playerHeight = player && Number.isFinite(player.clientHeight) ? player.clientHeight : 0;
    if (playerHeight > 0) return Math.min(48, Math.max(22, playerHeight * 0.046));
    return 22;
  }

  function syncCaptionFontSize(layer) {
    const player = document.querySelector('.html5-video-player');
    const fontSize = resolveYouTubeCaptionFontSize(player);
    layer.style.setProperty('--lr-youtube-caption-size', `${Math.round(fontSize * 10) / 10}px`);
  }

  // 也处理旧缓存与翻译中的临时字幕；保留小数和名称内部的点。
  function formatCaptionText(text) {
    if (!/^zh\b/i.test(context?.targetLanguage || 'zh-Hans')) return (text || '').replace(/\s+/g, ' ').trim();
    return (text || '').replace(/[。．]|\./g, (char, index, value) => {
      if (char === '.' && /[A-Za-z0-9]/.test(value[index - 1] || '') && /[A-Za-z0-9]/.test(value[index + 1] || '')) return char;
      return '';
    }).replace(/\s+/g, ' ').trim();
  }

  function render() {
    const takeoverActive = isTakeoverActive();
    if (!takeoverActive || mode === 'off') {
      const layer = document.getElementById(LAYER_ID);
      if (layer && layer.innerHTML !== '') layer.innerHTML = '';
      lastRenderedKey = takeoverActive ? 'off' : 'inactive';
      return;
    }
    const item = findCurrentSubtitle();
    // 事实校正或重新断句可能保留相同起点，内容更新也必须触发重绘。
    const key = item
      ? JSON.stringify([mode, startKey(item.start), item.text, item.translation])
      : `${mode}::none`;
    let layer = document.getElementById(LAYER_ID);
    if (key === lastRenderedKey && (!item || (layer && layer.isConnected))) return;

    if (!item) {
      if (layer) layer.innerHTML = '';
      lastRenderedKey = key;
      return;
    }
    ensureStyles();
    layer = layer || ensureLayer();
    if (!layer) return;
    // 仅在字幕真正切换时读取计算样式，不再在每次 timeupdate 上强制计算布局。
    syncCaptionFontSize(layer);
    const sourceText = (item.text || '').replace(/\s+/g, ' ').trim();
    const targetText = formatCaptionText(item.translation);
    const hasTranslation = !!targetText;
    const translating = taskStatus === 'pending' || taskStatus === 'running';
    const pendingText = translating ? '翻译中…' : '字幕未翻译，请选择双语或仅译文';
    const sameLanguage = window.YST_LANGUAGES.sameLanguage(context?.subtitles?.language, context?.targetLanguage || 'zh-Hans');
    const duplicateText = hasTranslation && sourceText.replace(/[\p{P}\s]/gu, '') === targetText.replace(/[\p{P}\s]/gu, '');
    let html = '';
    if (sameLanguage) {
      if (sourceText) html = `<div class="lr-line lr-line-source">${escapeHtml(sourceText)}</div>`;
    } else if (mode === 'bilingual') {
      if (sourceText) html += `<div class="lr-line lr-line-source">${escapeHtml(sourceText)}</div>`;
      if (hasTranslation) {
        if (!duplicateText || !sourceText) html += `<div class="lr-line lr-line-target">${escapeHtml(targetText)}</div>`;
      } else {
        html += `<div class="lr-line lr-line-target lr-line-pending">${escapeHtml(pendingText)}</div>`;
      }
    } else if (mode === 'source') {
      if (sourceText) html += `<div class="lr-line lr-line-source">${escapeHtml(sourceText)}</div>`;
    } else if (mode === 'target') {
      if (hasTranslation) {
        html += `<div class="lr-line lr-line-target">${escapeHtml(targetText)}</div>`;
      } else if (sourceText) {
        // 仅译文模式下译文还没到，先把原文以淡色显示，避免画面空白
        html += `<div class="lr-line lr-line-source lr-line-pending">${escapeHtml(sourceText)}</div>`;
      }
    }
    layer.innerHTML = html;
    lastRenderedKey = key;
  }

  // ── 视频元素绑定 ─────────────────────────────────────────
  function findVideoElement() {
    return document.querySelector('.html5-video-player video');
  }

  function waitForVideoElement(timeoutMs = 30000) {
    return new Promise((resolve) => {
      const v = findVideoElement();
      if (v) return resolve(v);
      let elapsed = 0;
      const intv = setInterval(() => {
        const el = findVideoElement();
        elapsed += 100;
        if (el) { clearInterval(intv); resolve(el); }
        else if (elapsed >= timeoutMs) { clearInterval(intv); resolve(null); }
      }, 100);
    });
  }

  function bindVideoEvents() {
    if (!videoEl || videoBound) return;
    videoBound = true;
    videoEl.addEventListener('timeupdate', render);
    videoEl.addEventListener('seeked', render);
  }

  // ── 重置 ─────────────────────────────────────────────────
  function reset() {
    takeoverVideoId = null;
    if (videoEl && videoBound) {
      videoEl.removeEventListener('timeupdate', render);
      videoEl.removeEventListener('seeked', render);
    }
    videoEl = null;
    subtitleStore.clear();
    subtitleTimeline = [];
    subtitleTimelineMaxEnd = [];
    lastTimelineIndex = -1;
    lastRenderedKey = '';
    taskStatus = null;
    videoBound = false;
    const layer = document.getElementById(LAYER_ID);
    if (layer) layer.remove();
    const player = document.querySelector('.html5-video-player');
    if (player) player.classList.remove(HIDE_NATIVE_CLASS);
  }

  async function setContext(newContext) {
    const sameVideo = context && newContext && context.videoId === newContext.videoId;
    const hadSegments =
      sameVideo
      && context.subtitles
      && Array.isArray(context.subtitles.segments)
      && context.subtitles.segments.length > 0;
    const nextSegments =
      newContext
      && newContext.subtitles
      && Array.isArray(newContext.subtitles.segments)
        ? newContext.subtitles.segments
        : [];
    const upgradingCachedContext = sameVideo && hadSegments && nextSegments.length > 0
      && context.subtitles.fromCache && !newContext.subtitles.fromCache;
    if (sameVideo && hadSegments && nextSegments.length > 0 && !upgradingCachedContext) {
      context = newContext;
      applyHideNative();
      return;
    }
    // 首次轮询可能只拿到部分译文；完整原始轨到达时补全时间轴，并保留
    // 用户的字幕模式接管和已经加载的译文（最终断句可覆盖多个原始 cue）。
    const previousTranslations = upgradingCachedContext
      ? Array.from(subtitleStore.values()).filter(item => item.translation) : [];
    const previousTakeoverVideoId = takeoverVideoId;
    const previousTaskStatus = taskStatus;
    reset();
    context = newContext || null;
    if (upgradingCachedContext) {
      takeoverVideoId = previousTakeoverVideoId;
      taskStatus = previousTaskStatus;
    }
    if (!context || !nextSegments.length) {
      return;
    }

    // 立即把原文塞进 store：render() 找到当前时间对应的原文条就能马上显示，
    // 不必等译文。译文到位后用同 startKey 覆盖即可。
    for (const seg of nextSegments) {
      if (typeof seg.start !== 'number') continue;
      subtitleStore.set(startKey(seg.start), {
        start: seg.start,
        end: seg.end,
        text: seg.text || '',
        translation: '',
      });
    }
    rebuildSubtitleTimeline();
    if (previousTranslations.length) ingestItems(context.videoId, previousTranslations);

    applyHideNative();
    videoEl = findVideoElement() || (await waitForVideoElement());
    if (!videoEl) return;
    bindVideoEvents();
    render();
    dispatchStatus('ready');
  }

  function setMode(m) {
    if (!MODES.includes(m)) return;
    mode = m;
    saveMode(m);
    applyHideNative();
    lastRenderedKey = '';
    render();
  }

  function activateTakeover(videoId) {
    if (!videoId || !context || context.videoId !== videoId) return;
    if (takeoverVideoId === videoId) return;
    takeoverVideoId = videoId;
    applyHideNative();
    lastRenderedKey = '';
    render();
  }

  // ── 事件总线 ─────────────────────────────────────────────
  window.addEventListener('yst:yt:context-ready', (e) => {
    setContext(e && e.detail ? e.detail : null);
  });

  window.addEventListener('yst:yt:subtitles-data', (e) => {
    const d = e && e.detail;
    if (!d) return;
    if (d.targetLanguage && context?.targetLanguage && d.targetLanguage !== context.targetLanguage) return;
    ingestItems(d.videoId, d.items);
  });

  window.addEventListener('yst:yt:subtitles-cleared', (e) => {
    const d = e && e.detail;
    if (!d || !context || d.videoId !== context.videoId) return;
    if (d.targetLanguage && context.targetLanguage && d.targetLanguage !== context.targetLanguage) return;
    reset();
    context = null;
  });

  window.addEventListener('yst:yt:task-state', (e) => {
    const d = e && e.detail;
    if (!d) return;
    if (context && d.videoId && context.videoId !== d.videoId) return;
    if (d.status === taskStatus) return;
    taskStatus = d.status || null;
    lastRenderedKey = ''; // 状态变化需重绘当前行的占位文案
    scheduleRender();
  });

  window.addEventListener('yst:yt:context-cleared', () => {
    reset();
    context = null;
  });

  window.addEventListener('yst:yt:set-mode', (e) => {
    const m = e && e.detail ? e.detail.mode : null;
    if (MODES.includes(m)) setMode(m);
  });

  window.addEventListener('yst:yt:activate-subtitles', (e) => {
    const videoId = e && e.detail ? e.detail.videoId : null;
    activateTakeover(videoId);
  });

  // 模式同步：popup / 其他 tab 改了 storage 也要同步
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      const m = changes[STORAGE_KEY].newValue;
      if (MODES.includes(m) && m !== mode) {
        mode = m;
        applyHideNative();
        lastRenderedKey = '';
        render();
      }
    });
  } catch (_e) {}

  // 全屏切换：YouTube 会重排播放器 DOM，layer 随之失效
  document.addEventListener('fullscreenchange', () => {
    const layer = document.getElementById(LAYER_ID);
    if (layer) layer.remove();
    if (isTakeoverActive() && context.subtitles && mode !== 'off') {
      ensureLayer();
      lastRenderedKey = '';
      render();
    }
  });

  // ── 启动：读模式 ────────────────────────────────────────
  loadMode().then((m) => { mode = m; });
})();
