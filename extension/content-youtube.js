// YouTube player tools, extracted from LingRead. Uses the shared LingRead API.
(function () {
  if (window.__YST_YT_LOADED__) return;
  window.__YST_YT_LOADED__ = true;

  const BRIDGE_SOURCE = 'yst-youtube';
  const ICON_ID = 'yst-yt-button';
  const EMBED_ICON_ID = 'yst-yt-embed-button';
  const TRANSCRIPT_BUTTON_ID = 'yst-yt-transcript-button';
  const PANEL_ID = 'yst-yt-panel';
  const STYLE_ID = 'yst-yt-style';
  const BRAND_ICON_URL = window.APP_CONFIG?.BRAND?.logoUrl || chrome.runtime.getURL('icons/icon48.png');
  const SUBTITLE_MODE_KEY = 'youtubeSubtitleMode';
  const SUBTITLE_MODES = ['bilingual', 'target', 'off'];
  const SUBTITLE_MODE_LABELS = { bilingual: '双语', target: '仅中文', off: '关闭' };

  let currentVideoId = null;
  let currentContext = null; // 见 buildContext 返回结构
  let panelOpen = false;
  let outsideClickHandler = null;
  let currentMode = 'bilingual';
  let lastBroadcastVideoId = null;
  let contextBuildInFlight = false;
  // 字幕翻译任务：最新任务摘要 + 轮询句柄。任务在服务端后台跑，扩展只做轻量进度提示。
  let subtitleTask = null; // { taskId, status, totalSegments, completedSegments, ... }
  let subtitleTaskFromAuth = false;
  let cachedSubtitleItemsReady = false;
  let cachedSubtitleItemsIncomplete = false;
  let cachedSubtitleItemsCount = 0;
  let subtitleTakeoverVideoId = null;
  let taskPollTimer = null;
  let subtitleStateRequestId = 0;
  let pendingSubtitleFetchAfterLogin = false;
  let subtitleSelectionRequest = null;
  let chapterTranslations = new Map();
  let chapterTranslationRequest = null;
  let translatedVideoTitles = new Map();
  let videoTitleTranslationRequest = null;
  let pendingTranscriptVideoId = null;
  let transcriptButtonLabel = '视频转写与总结';
  let transcriptButtonDisabled = false;
  let transcriptButtonTitle = '将视频内容整理成文字文章';
  let transcriptStatusMessage = '无需先翻译字幕，直接生成独立的文字阅读页';
  let transcriptStatusIsError = false;
  let relayLoginInFlight = false;
  let controlBarInjectionInFlight = false;
  let embedIconInjectionInFlight = false;
  let transcriptButtonInjectionInFlight = false;
  let panelPlayerResizeObserver = null;

  // ── 路由 ────────────────────────────────────────────────
  function isYouTubePlayerPage() {
    if (!/(^|\.)youtube\.com$/.test(location.hostname) && !/(^|\.)youtube-nocookie\.com$/.test(location.hostname)) return false;
    return location.pathname === '/watch' || location.pathname.startsWith('/embed/');
  }

  function getVideoIdFromUrl() {
    if (!isYouTubePlayerPage()) return null;
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    const match = location.pathname.match(/^\/embed\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function isEmbedPlayerPage() {
    return isYouTubePlayerPage() && location.pathname.startsWith('/embed/');
  }

  // ── 与 page world 桥接 ─────────────────────────────────
  function fetchCaptionsViaBridge({ expectedVideoId, languageCode, kind }, timeoutMs = 22000) {
    return new Promise((resolve) => {
      const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const onMessage = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== BRIDGE_SOURCE || d.type !== 'fetch-captions-result' || d.requestId !== requestId) return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve({
          ok: !!d.ok,
          status: d.status || 0,
          text: d.text || '',
          url: d.url || '',
          error: d.error || null,
        });
      };
      window.addEventListener('message', onMessage);
      window.postMessage(
        { source: BRIDGE_SOURCE, type: 'fetch-captions', requestId, expectedVideoId, languageCode, kind },
        location.origin
      );
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ ok: false, status: 0, text: '', url: '', error: 'TIMEOUT' });
      }, timeoutMs);
    });
  }

  function requestPageContext(timeoutMs = 4000) {
    return new Promise((resolve) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const onMessage = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.source !== BRIDGE_SOURCE || d.type !== 'context' || d.requestId !== requestId) return;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(d.payload || null);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({ source: BRIDGE_SOURCE, type: 'request-context', requestId }, location.origin);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, timeoutMs);
    });
  }

  // ── 上下文抽取 ──────────────────────────────────────────
  function extractFromPlayerResponse(playerResponse) {
    if (!playerResponse) return null;
    const vd = playerResponse.videoDetails || {};
    const microformat = (playerResponse.microformat || {}).playerMicroformatRenderer || {};
    const captions = playerResponse.captions || {};
    const tracklist = captions.playerCaptionsTracklistRenderer || {};
    const captionTracks = Array.isArray(tracklist.captionTracks) ? tracklist.captionTracks : [];

    const description =
      vd.shortDescription ||
      (microformat.description && (microformat.description.simpleText || joinRuns(microformat.description.runs))) ||
      '';

    return {
      videoId: vd.videoId || null,
      title: vd.title || (microformat.title && microformat.title.simpleText) || '',
      description,
      channelName: vd.author || microformat.ownerChannelName || '',
      duration: parseInt(vd.lengthSeconds || '0', 10) || 0,
      isLive: !!vd.isLive || !!vd.isLiveContent,
      hasNativeSubtitles: captionTracks.length > 0,
      captionTracks: captionTracks.map((t) => ({
        languageCode: t.languageCode || '',
        name:
          (t.name && (t.name.simpleText || joinRuns(t.name.runs))) ||
          t.languageCode ||
          '',
        kind: t.kind || '',
        baseUrl: t.baseUrl || '',
        isTranslatable: !!t.isTranslatable,
      })),
    };
  }

  function joinRuns(runs) {
    if (!Array.isArray(runs)) return '';
    return runs.map((r) => (r && r.text) || '').join('');
  }

  // §5.2 字幕轨选择优先级
  function selectCaptionTrack(tracks, preferredLang = 'zh') {
    if (!tracks || !tracks.length) return null;
    const startsWith = (lang) => (t) => (t.languageCode || '').toLowerCase().startsWith(lang);
    const isAsr = (t) => t.kind === 'asr';
    const isManual = (t) => t.kind !== 'asr';

    return (
      tracks.find((t) => startsWith(preferredLang)(t) && isManual(t)) ||
      tracks.find((t) => startsWith(preferredLang)(t) && isAsr(t)) ||
      tracks.find((t) => startsWith('en')(t) && isManual(t)) ||
      tracks.find((t) => startsWith('en')(t) && isAsr(t)) ||
      tracks[0] ||
      null
    );
  }

  async function fetchCaptionSegments(track, videoId) {
    if (!track || !track.baseUrl) return null;
    // YouTube 静默拒绝缺 PoToken 的字幕请求；必须由 MAIN world bridge
    // 拼接 pot/potc/cver/device + fmt=json3 后再 fetch，详见 bridge 注释。
    const r = await fetchCaptionsViaBridge({
      expectedVideoId: videoId,
      languageCode: track.languageCode || '',
      kind: track.kind || '',
    });
    const sample = (r.text || '').slice(0, 200).replace(/\s+/g, ' ');
    console.debug('[LingRead YT] caption fetch via bridge', {
      url: (r.url || '').slice(0, 240),
      status: r.status,
      ok: r.ok,
      length: (r.text || '').length,
      sample,
      error: r.error,
    });
    if (!r.ok || !r.text) {
      console.warn('[LingRead YT] caption fetch failed', {
        videoId,
        lang: track.languageCode,
        kind: track.kind,
        status: r.status,
        error: r.error,
        textLen: (r.text || '').length,
      });
      return null;
    }
    const trimmed = r.text.trim();
    if (trimmed.startsWith('{')) return parseCaptionJson3(trimmed);
    if (trimmed.startsWith('<')) return parseCaptionXml(trimmed);
    return null;
  }

  function parseCaptionJson3(text) {
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.events)) return null;
      const segments = [];
      for (const ev of data.events) {
        if (!ev || typeof ev.tStartMs !== 'number') continue;
        const start = ev.tStartMs / 1000;
        const dur = (ev.dDurationMs || 0) / 1000;
        const segs = Array.isArray(ev.segs) ? ev.segs : [];
        const txt = segs.map((s) => (s && s.utf8) || '').join('').replace(/\n/g, ' ').trim();
        if (!txt) continue;
        segments.push({ start, end: start + dur, text: txt });
      }
      return segments;
    } catch (_e) {
      return null;
    }
  }

  function parseCaptionXml(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.getElementsByTagName('parsererror').length) return null;
      const els = doc.getElementsByTagName('text');
      const segments = [];
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const start = parseFloat(el.getAttribute('start') || '0');
        const dur = parseFloat(el.getAttribute('dur') || '0');
        const text = decodeEntities((el.textContent || '').trim());
        if (!text) continue;
        segments.push({ start, end: start + (Number.isFinite(dur) ? dur : 0), text });
      }
      return segments;
    } catch (_err) {
      return null;
    }
  }

  function decodeEntities(s) {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    return ta.value;
  }

  // YouTube 自动字幕（尤其滚动式 ASR）的 dDurationMs 往往远超实际显示时长，相邻
  // 条目时间区间严重重叠。重叠会导致同一时刻多条命中、相互遮挡，并在矫正后留下
  // 未被覆盖的原文（表现为只有英文、中文显示"未翻译"）。这里把每条的 end 截断到
  // 下一条的 start，得到不重叠、时长正常的字幕，再做合并。
  function clampCueOverlaps(cues) {
    const arr = cues
      .filter((c) => c && typeof c.start === 'number' && typeof c.end === 'number')
      .slice()
      .sort((a, b) => a.start - b.start);
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].end > arr[i + 1].start) {
        arr[i] = { ...arr[i], end: arr[i + 1].start };
      }
    }
    return arr.filter((c) => c.end > c.start);
  }

  // ASR 字幕碎片合并（人工字幕不参与）。YouTube 自动字幕通常每 ~1 秒一条、只有
  // 1-3 个词，逐条翻译会把短语切碎。先按阈值贪心合并到合理粒度，再交给翻译任务。
  // 合并结果既用于上传建任务、也用于本地渲染存储，保证两边 cue 一致。
  // 字数上限直接决定单条字幕的显示长度，控制在易读范围内（避免一条过长）。
  const ASR_MERGE_TARGET_DURATION = 3.5; // 达到此长度主动收口
  const ASR_MERGE_MAX_DURATION = 6.0;    // 硬上限
  const ASR_MERGE_MAX_CHARS = 90;        // 单条源文字数上限（显示长度上限）
  const ASR_MERGE_MAX_GAP = 1.0;         // 间隙 > 此值视为换句，强制分段
  function mergeAsrCues(cues) {
    if (!Array.isArray(cues) || !cues.length) return [];
    const out = [];
    let curr = null;
    for (const cue of cues) {
      if (!cue || typeof cue.start !== 'number' || typeof cue.end !== 'number') continue;
      const text = (cue.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!curr) { curr = { start: cue.start, end: cue.end, text }; continue; }
      const gap = cue.start - curr.end;
      const candidateText = `${curr.text} ${text}`;
      const candidateDur = cue.end - curr.start;
      const currDur = curr.end - curr.start;
      const tooFar = gap > ASR_MERGE_MAX_GAP;
      const exceedsLimits = candidateDur > ASR_MERGE_MAX_DURATION || candidateText.length > ASR_MERGE_MAX_CHARS;
      const reachedTarget = currDur >= ASR_MERGE_TARGET_DURATION;
      if (tooFar || exceedsLimits || reachedTarget) {
        out.push(curr);
        curr = { start: cue.start, end: cue.end, text };
      } else {
        curr.end = cue.end;
        curr.text = candidateText;
      }
    }
    if (curr) out.push(curr);
    return out;
  }

  async function buildContext() {
    const bridgePayload = await requestPageContext();
    const fromPlayer = extractFromPlayerResponse(bridgePayload && bridgePayload.playerResponse);
    if (!fromPlayer || !fromPlayer.videoId) return null;

    const track = selectCaptionTrack(fromPlayer.captionTracks);
    let subtitles = null;
    if (track) {
      const segments = await fetchCaptionSegments(track, fromPlayer.videoId);
      if (segments && segments.length) {
        const isAsr = track.kind === 'asr';
        const clamped = clampCueOverlaps(segments);
        subtitles = {
          language: track.languageCode,
          isAutoGenerated: isAsr,
          segments: isAsr ? mergeAsrCues(clamped) : clamped,
        };
      }
    }

    return {
      videoId: fromPlayer.videoId,
      title: fromPlayer.title,
      description: fromPlayer.description,
      channelName: fromPlayer.channelName,
      duration: fromPlayer.duration,
      isLive: fromPlayer.isLive,
      chapters: bridgePayload && bridgePayload.chapters ? bridgePayload.chapters : null,
      chaptersLoaded: true,
      hasNativeSubtitles: fromPlayer.hasNativeSubtitles,
      subtitles,
    };
  }

  function broadcastContext(ctx) {
    if (!ctx) return;
    if (ctx.videoId) lastBroadcastVideoId = ctx.videoId;
    try {
      window.dispatchEvent(new CustomEvent('yst:yt:context-ready', { detail: ctx }));
    } catch (_e) {}
  }

  function buildCachedSubtitleContext(videoId, items) {
    const existing = currentContext && currentContext.videoId === videoId ? currentContext : null;
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const segments = (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item.start === 'number' && typeof item.end === 'number' && item.end > item.start)
      .map((item) => ({
        start: item.start,
        end: item.end,
        text: item.text || '',
      }));
    return {
      videoId,
      title: existing?.title || document.title.replace(/\s*-\s*YouTube\s*$/i, '') || 'YouTube 视频',
      description: existing?.description || '',
      channelName: existing?.channelName || 'YouTube',
      duration: existing?.duration || (video && Number.isFinite(video.duration) ? video.duration : 0),
      isLive: existing?.isLive || false,
      chapters: existing?.chapters || null,
      chaptersLoaded: !!existing?.chaptersLoaded,
      hasNativeSubtitles: true,
      subtitles: {
        language: existing?.subtitles?.language || 'cached',
        isAutoGenerated: !!existing?.subtitles?.isAutoGenerated,
        fromCache: true,
        segments,
      },
    };
  }

  // ── 控制栏图标 ──────────────────────────────────────────
  const ICON_LABEL = '字幕翻译';

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${ICON_ID} {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        position: relative !important;
        vertical-align: top !important;
        width: auto !important;
        min-width: 72px !important;
        max-width: none !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 10px !important;
        border: 0 !important;
        background: transparent !important;
        color: #fff !important;
        cursor: pointer !important;
        opacity: 0.92;
        transition: opacity 0.15s ease, color 0.15s ease;
        font-family: 'Roboto', 'YouTube Sans', 'Helvetica Neue', Arial, sans-serif !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        letter-spacing: 0 !important;
        line-height: 1 !important;
        white-space: nowrap !important;
        overflow: visible !important;
        text-indent: 0 !important;
        text-overflow: clip !important;
        flex: 0 0 auto !important;
      }
      #${ICON_ID}:hover { opacity: 1; }
      #${ICON_ID}.yst-active { opacity: 1; color: #fff !important; }
      #${ICON_ID} .lr-control-text {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        box-sizing: border-box !important;
        color: currentColor !important;
        font-size: 13px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        letter-spacing: 0 !important;
      }
      #${ICON_ID} .lr-control-badge {
        position: absolute !important;
        top: 6px !important;
        right: 1px !important;
        min-width: 20px !important;
        height: 14px !important;
        padding: 0 3px !important;
        border-radius: 999px !important;
        background: rgba(255, 255, 255, 0.92) !important;
        color: #181818 !important;
        font-size: 9px !important;
        font-weight: 700 !important;
        line-height: 14px !important;
        text-align: center !important;
        box-sizing: border-box !important;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35) !important;
      }
      #${EMBED_ICON_ID} {
        position: relative !important;
        z-index: 1 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: auto !important;
        min-width: 74px !important;
        height: 48px !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: transparent !important;
        color: #fff !important;
        box-shadow: none !important;
        cursor: pointer !important;
        opacity: 0.92 !important;
        pointer-events: auto !important;
        transform: translateZ(0) !important;
        transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease !important;
        font-family: 'Roboto', 'YouTube Sans', 'Helvetica Neue', Arial, sans-serif !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        letter-spacing: 0 !important;
        line-height: 1 !important;
        white-space: nowrap !important;
        flex: 0 0 auto !important;
      }
      #${EMBED_ICON_ID}:hover {
        opacity: 1 !important;
        background: transparent !important;
      }
      #${EMBED_ICON_ID}.yst-active {
        opacity: 1 !important;
        color: #fff !important;
      }
      #${EMBED_ICON_ID} .lr-control-text {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        box-sizing: border-box !important;
        color: currentColor !important;
        font-size: 13px !important;
        font-weight: 700 !important;
        line-height: 1 !important;
        letter-spacing: 0 !important;
      }
      #${EMBED_ICON_ID} .lr-control-badge {
        position: absolute !important;
        top: -4px !important;
        right: -6px !important;
        min-width: 22px !important;
        height: 15px !important;
        padding: 0 4px !important;
        border-radius: 999px !important;
        background: rgba(255, 255, 255, 0.92) !important;
        color: #181818 !important;
        font-size: 9px !important;
        font-weight: 700 !important;
        line-height: 15px !important;
        text-align: center !important;
        box-sizing: border-box !important;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.38) !important;
      }
      #${TRANSCRIPT_BUTTON_ID} {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 7px !important;
        flex: 0 0 auto !important;
        min-width: 0 !important;
        height: 36px !important;
        margin: 0 8px 0 0 !important;
        padding: 0 14px !important;
        border: 0 !important;
        border-radius: 18px !important;
        background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.05)) !important;
        color: var(--yt-spec-text-primary, #0f0f0f) !important;
        cursor: pointer !important;
        font-family: 'Roboto', 'YouTube Sans', 'Helvetica Neue', Arial, sans-serif !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        line-height: 36px !important;
        white-space: nowrap !important;
      }
      #${TRANSCRIPT_BUTTON_ID}:hover {
        background: var(--yt-spec-button-chip-background-hover, rgba(0, 0, 0, 0.1)) !important;
      }
      #${TRANSCRIPT_BUTTON_ID}:disabled {
        cursor: progress !important;
        opacity: 0.65 !important;
      }
      #${TRANSCRIPT_BUTTON_ID} img {
        display: block !important;
        width: 20px !important;
        height: 20px !important;
        flex: 0 0 auto !important;
      }
      #${PANEL_ID} {
        position: absolute;
        right: 12px;
        bottom: 60px;
        width: min(360px, calc(100% - 24px));
        max-height: min(480px, calc(100% - 84px));
        background: rgba(28, 28, 28, 0.72);
        backdrop-filter: blur(12px) saturate(120%);
        -webkit-backdrop-filter: blur(12px) saturate(120%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.48);
        color: #f1f1f1;
        font-family: 'Roboto', 'YouTube Sans', 'Helvetica Neue', Arial, sans-serif;
        font-size: 13px;
        line-height: 1.55;
        z-index: 2147483646 !important;
        visibility: hidden;
        opacity: 0;
        pointer-events: none !important;
        overflow: hidden;
        padding: 12px;
        box-sizing: border-box;
        transform: translateY(12px) scale(0.98);
        transform-origin: bottom right;
        transition:
          opacity 0.16s ease,
          transform 0.16s ease,
          visibility 0s linear 0.16s;
      }
      #${PANEL_ID}.lingread-open {
        visibility: visible;
        opacity: 1;
        pointer-events: auto !important;
        transform: translateY(0) scale(1);
        transition-delay: 0s;
      }
      #${PANEL_ID} .lr-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      #${ICON_ID} .lr-control-logo,
      #${EMBED_ICON_ID} .lr-control-logo {
        display: block !important;
        width: 18px !important;
        height: 18px !important;
        flex: 0 0 auto !important;
      }
      #${PANEL_ID} .lr-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      #${PANEL_ID} .lr-title img {
        display: block;
        width: 22px;
        height: 22px;
        flex: 0 0 auto;
      }
      #${PANEL_ID} button {
        pointer-events: auto !important;
        touch-action: manipulation;
      }
      #${PANEL_ID} .lr-close {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 0;
        background: rgba(255, 255, 255, 0.06); border: 0; border-radius: 50%; color: #bbb;
        font-size: 18px; line-height: 1; cursor: pointer;
      }
      #${PANEL_ID} .lr-close:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }
      #${PANEL_ID} .lr-body {
        max-height: calc(var(--lr-panel-max-height, 480px) - 52px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
      }
      #${PANEL_ID} .lr-badge {
        display: inline-block; padding: 3px 8px; border-radius: 999px;
        font-size: 11px; line-height: 1.4;
      }
      #${PANEL_ID} .lr-badge-info { background: rgba(255, 255, 255, 0.12); color: #f1f1f1; }
      #${PANEL_ID} .lr-badge-warn { background: rgba(255, 255, 255, 0.1); color: #d8d8d8; }
      #${PANEL_ID} .lr-badge-muted { background: rgba(160, 160, 160, 0.15); color: #c8c8c8; }
      #${PANEL_ID} .lr-section { margin-top: 12px; }
      #${PANEL_ID} .lr-placeholder {
        margin-top: 14px; padding: 10px 12px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px dashed rgba(255, 255, 255, 0.12);
        border-radius: 8px; color: #a0a0a0; font-size: 12px;
      }
      #${PANEL_ID} .lr-error { color: #ff8c8c; }
      #${PANEL_ID} .lr-loading { color: #a0a0a0; }
      #${PANEL_ID} .lr-chapters { max-height: 160px; overflow-y: auto; margin-top: 8px; }
      #${PANEL_ID} .lr-chapter {
        display: flex; align-items: baseline; gap: 8px;
        padding: 4px 0; font-size: 12px; color: #d4d4d4;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      #${PANEL_ID} .lr-chapter:last-child { border-bottom: 0; }
      #${PANEL_ID} .lr-chapter-time {
        color: #aaa; font-variant-numeric: tabular-nums; min-width: 48px;
      }
      #${PANEL_ID} .lr-mode-row {
        display: flex; gap: 6px; flex-wrap: wrap;
      }
      #${PANEL_ID} .lr-mode-btn {
        flex: 1 1 auto; min-width: 56px;
        padding: 6px 10px;
        background: rgba(255, 255, 255, 0.06);
        color: #d4d4d4;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      #${PANEL_ID} .lr-mode-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
      #${PANEL_ID} .lr-mode-btn.lr-mode-active {
        background: rgba(255, 255, 255, 0.2);
        border-color: rgba(255, 255, 255, 0.28);
        color: #fff;
      }
      #${PANEL_ID} .lr-task-status {
        margin-top: 8px;
        font-size: 12px;
        color: #b8b8b8;
        line-height: 1.4;
        min-height: 14px;
      }
      #${PANEL_ID} .lr-task-status.lr-error { color: #ff8c8c; }
      #${PANEL_ID} .lr-task-status:empty { display: none; }
      #${PANEL_ID} .lr-video-title {
        margin-top: 0;
        color: #f1f1f1;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.45;
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      @media (prefers-reduced-motion: reduce) {
        #${PANEL_ID} { transition: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function waitForElement(selector, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const found = document.querySelector(selector);
      if (found) return resolve(found);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function bindLingReadButton(btn) {
    if (!btn || btn.__ystBound) return;
    btn.__ystBound = true;
    btn.title = 'AI翻译矫正';
    btn.setAttribute('aria-label', '字幕翻译：AI翻译矫正');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
  }

  async function injectControlBarIcon() {
    if (!isYouTubePlayerPage()) return;
    if (isEmbedPlayerPage()) return;
    if (document.getElementById(ICON_ID)) return;
    if (controlBarInjectionInFlight) return;
    controlBarInjectionInFlight = true;
    try {
      const rightControls = await waitForElement('.ytp-right-controls');
      const controls = rightControls || document.querySelector('.ytp-chrome-controls');
      if (!controls || document.getElementById(ICON_ID)) return;

      ensureStyles();

      const btn = document.createElement('button');
      btn.id = ICON_ID;
      btn.className = 'ytp-button';
      renderControlButton(btn);
      bindLingReadButton(btn);

      const captionsBtn = controls.querySelector('.ytp-subtitles-button');
      const settingsBtn = controls.querySelector('.ytp-settings-button');
      if (captionsBtn && captionsBtn.parentNode === controls) {
        captionsBtn.insertAdjacentElement('afterend', btn);
      } else if (settingsBtn && settingsBtn.parentNode === controls) {
        settingsBtn.insertAdjacentElement('beforebegin', btn);
      } else if (rightControls) {
        rightControls.insertBefore(btn, rightControls.firstChild);
      } else {
        controls.appendChild(btn);
      }
    } finally {
      controlBarInjectionInFlight = false;
    }
  }

  async function ensureEmbedFloatingIcon() {
    if (!isEmbedPlayerPage()) return;
    if (document.getElementById(EMBED_ICON_ID)) return;
    if (embedIconInjectionInFlight) return;
    embedIconInjectionInFlight = true;
    try {
      const controls = await waitForElement('.quick-actions-wrapper');
      if (!controls || !isEmbedPlayerPage() || document.getElementById(EMBED_ICON_ID)) return;
      ensureStyles();
      const btn = document.createElement('button');
      btn.id = EMBED_ICON_ID;
      btn.type = 'button';
      renderControlButton(btn);
      bindLingReadButton(btn);
      controls.appendChild(btn);
      updateButtonBadge();
    } finally {
      embedIconInjectionInFlight = false;
    }
  }

  async function injectTranscriptButton() {
    if (!isYouTubePlayerPage() || isEmbedPlayerPage()) return;
    if (document.getElementById(TRANSCRIPT_BUTTON_ID)) return;
    if (transcriptButtonInjectionInFlight) return;
    transcriptButtonInjectionInFlight = true;
    try {
      const controls = await waitForElement([
        'ytd-watch-metadata #actions-inner #top-level-buttons-computed',
        'ytd-watch-metadata #actions #top-level-buttons-computed',
        '#actions-inner #top-level-buttons-computed',
      ].join(', '));
      if (!controls || !isYouTubePlayerPage() || document.getElementById(TRANSCRIPT_BUTTON_ID)) return;

      ensureStyles();
      const btn = document.createElement('button');
      btn.id = TRANSCRIPT_BUTTON_ID;
      btn.type = 'button';
      btn.innerHTML = `<img src="${BRAND_ICON_URL}" alt=""><span>视频转写与总结</span>`;
      btn.title = '将视频内容整理成文字文章';
      btn.setAttribute('aria-label', '视频转写与总结');
      bindTranscriptButton(btn);
      controls.insertBefore(btn, controls.firstChild);
      setTranscriptButtonState(
        transcriptButtonLabel,
        transcriptButtonDisabled,
        transcriptButtonTitle,
        transcriptStatusMessage,
        transcriptStatusIsError
      );
    } finally {
      transcriptButtonInjectionInFlight = false;
    }
  }

  function renderControlButton(btn, badgeText = '') {
    if (!btn) return;
    const badge = badgeText ? `<span class="lr-control-badge">${escapeHtml(badgeText)}</span>` : '';
    btn.innerHTML = `<span class="lr-control-text"><img class="lr-control-logo" src="${BRAND_ICON_URL}" alt="">${ICON_LABEL}</span>${badge}`;
  }

  // ── QuickPanel ─────────────────────────────────────────
  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    ensureStyles();
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'YouTube 字幕翻译与总结');
    panel.innerHTML = `
      <div class="lr-header">
        <div class="lr-title"><img src="${BRAND_ICON_URL}" alt=""><span>YouTube 字幕翻译</span></div>
        <button class="lr-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="lr-body"></div>
    `;
    const player = getPanelPlayer(getPanelAnchor());
    const panelHost = isEmbedPlayerPage() ? document.body : player || document.body;
    panelHost.appendChild(panel);
    ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick'].forEach((eventName) => {
      panel.addEventListener(eventName, (event) => event.stopPropagation());
    });
    panel.querySelector('.lr-close').addEventListener('click', closePanel);
    return panel;
  }

  function getPanelPlayer(anchor) {
    const closest = anchor && typeof anchor.closest === 'function'
      ? anchor.closest('.html5-video-player')
      : null;
    if (closest) return closest;
    const candidates = document.querySelectorAll('#movie_player, .html5-video-player');
    for (const player of candidates) {
      const r = player.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return player;
    }
    return null;
  }

  function positionPanel(panel) {
    const btn = getPanelAnchor();
    const margin = 12;
    const controlGap = 8;
    const player = getPanelPlayer(btn);

    // embed 播放器会在 .html5-video-player 上接管鼠标事件。面板挂在播放器内部时
    // 虽然能够显示，但模式按钮的 click 会被播放器消费；提升到 iframe 根层后，
    // 仍按入口按钮的位置从底部弹出，同时与播放器的事件容器隔离。
    if (isEmbedPlayerPage()) {
      if (panel.parentElement !== document.body) document.body.appendChild(panel);
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const btnRect = btn ? btn.getBoundingClientRect() : null;
      const panelWidth = Math.max(160, Math.min(360, viewportWidth - margin * 2));
      const preferredRight = btnRect ? viewportWidth - btnRect.right : margin;
      const maxRight = Math.max(margin, viewportWidth - panelWidth - margin);
      const right = Math.max(margin, Math.min(preferredRight, maxRight));
      const preferredBottom = btnRect ? viewportHeight - btnRect.top + controlGap : 60;
      const maxBottom = Math.max(56, viewportHeight - margin - 96);
      const bottom = Math.max(56, Math.min(preferredBottom, maxBottom));
      const panelMaxHeight = Math.max(96, Math.min(480, viewportHeight - bottom - margin));

      panel.style.position = 'fixed';
      panel.style.width = `${Math.round(panelWidth)}px`;
      panel.style.maxHeight = `${Math.round(panelMaxHeight)}px`;
      panel.style.setProperty('--lr-panel-max-height', `${Math.round(panelMaxHeight)}px`);
      panel.style.right = `${Math.round(right)}px`;
      panel.style.bottom = `${Math.round(bottom)}px`;
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      return;
    }

    if (player) {
      if (panel.parentElement !== player) player.appendChild(panel);
      const playerRect = player.getBoundingClientRect();
      const btnRect = btn ? btn.getBoundingClientRect() : null;
      const panelWidth = Math.max(160, Math.min(360, playerRect.width - margin * 2));
      const preferredRight = btnRect ? playerRect.right - btnRect.right : margin;
      const maxRight = Math.max(margin, playerRect.width - panelWidth - margin);
      const right = Math.max(margin, Math.min(preferredRight, maxRight));
      const preferredBottom = btnRect ? playerRect.bottom - btnRect.top + controlGap : 60;
      const maxBottom = Math.max(56, playerRect.height - margin - 96);
      const bottom = Math.max(56, Math.min(preferredBottom, maxBottom));
      const panelMaxHeight = Math.max(96, Math.min(480, playerRect.height - bottom - margin));

      panel.style.position = 'absolute';
      panel.style.width = `${Math.round(panelWidth)}px`;
      panel.style.maxHeight = `${Math.round(panelMaxHeight)}px`;
      panel.style.setProperty('--lr-panel-max-height', `${Math.round(panelMaxHeight)}px`);
      panel.style.right = `${Math.round(right)}px`;
      panel.style.bottom = `${Math.round(bottom)}px`;
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      return;
    }

    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    const panelWidth = Math.max(160, Math.min(360, window.innerWidth - margin * 2));
    const panelMaxHeight = Math.max(96, Math.min(480, window.innerHeight - 84));
    panel.style.position = 'fixed';
    panel.style.width = `${Math.round(panelWidth)}px`;
    panel.style.maxHeight = `${Math.round(panelMaxHeight)}px`;
    panel.style.setProperty('--lr-panel-max-height', `${Math.round(panelMaxHeight)}px`);
    panel.style.right = `${margin}px`;
    panel.style.bottom = `${margin + 60}px`;
    panel.style.left = 'auto';
    panel.style.top = 'auto';
  }

  function repositionOpenPanel() {
    if (!panelOpen) return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    window.requestAnimationFrame(() => {
      if (panelOpen && panel.isConnected) positionPanel(panel);
    });
  }

  function observePanelPlayer(player) {
    if (panelPlayerResizeObserver) panelPlayerResizeObserver.disconnect();
    panelPlayerResizeObserver = null;
    if (!player || typeof ResizeObserver !== 'function') return;
    panelPlayerResizeObserver = new ResizeObserver(repositionOpenPanel);
    panelPlayerResizeObserver.observe(player);
  }

  function stopObservingPanelPlayer() {
    if (!panelPlayerResizeObserver) return;
    panelPlayerResizeObserver.disconnect();
    panelPlayerResizeObserver = null;
  }

  function setActiveButton(active) {
    [document.getElementById(ICON_ID), document.getElementById(EMBED_ICON_ID)].forEach((btn) => {
      if (btn) btn.classList.toggle('yst-active', active);
    });
  }

  function bindOutsideClick() {
    if (outsideClickHandler) return;
    outsideClickHandler = (e) => {
      if (!panelOpen) return;
      const panel = document.getElementById(PANEL_ID);
      const btn = document.getElementById(ICON_ID);
      const embedBtn = document.getElementById(EMBED_ICON_ID);
      if (
        panel
        && !panel.contains(e.target)
        && (!btn || !btn.contains(e.target))
        && (!embedBtn || !embedBtn.contains(e.target))
      ) {
        closePanel();
      }
    };
    document.addEventListener('mousedown', outsideClickHandler, true);
  }

  function resetVideoScopedState(videoId, { close = false } = {}) {
    currentVideoId = videoId;
    currentContext = null;
    subtitleTask = null;
    subtitleTaskFromAuth = false;
    cachedSubtitleItemsReady = false;
    cachedSubtitleItemsIncomplete = false;
    subtitleStateRequestId++;
    cachedSubtitleItemsCount = 0;
    subtitleTakeoverVideoId = null;
    subtitleSelectionRequest = null;
    chapterTranslations = new Map();
    chapterTranslationRequest = null;
    translatedVideoTitles = new Map();
    videoTitleTranslationRequest = null;
    pendingSubtitleFetchAfterLogin = false;
    if (pendingTranscriptVideoId && pendingTranscriptVideoId !== videoId) {
      pendingTranscriptVideoId = null;
    }
    lastBroadcastVideoId = null;
    stopTaskPoll();
    updateButtonBadge();
    setTranscriptButtonState(
      '视频转写与总结',
      false,
      '将视频内容整理成文字文章',
      '无需先翻译字幕，直接生成独立的文字阅读页',
      false
    );
    if (close) closePanel();
    try {
      window.dispatchEvent(new CustomEvent('yst:yt:context-cleared'));
    } catch (_e) {}
  }

  function unbindOutsideClick() {
    if (!outsideClickHandler) return;
    document.removeEventListener('mousedown', outsideClickHandler, true);
    outsideClickHandler = null;
  }

  function getPanelAnchor() {
    const candidates = isEmbedPlayerPage()
      ? [document.getElementById(EMBED_ICON_ID), document.getElementById(ICON_ID)]
      : [document.getElementById(ICON_ID), document.getElementById(EMBED_ICON_ID)];
    for (const el of candidates) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  async function openPanel() {
    if (!isYouTubePlayerPage()) return;
    const panel = ensurePanel();
    panel.classList.add('lingread-open');
    panelOpen = true;
    setActiveButton(true);
    positionPanel(panel);
    observePanelPlayer(getPanelPlayer(getPanelAnchor()));
    bindOutsideClick();
    renderLoading();

    const vid = getVideoIdFromUrl();
    if (vid !== currentVideoId || (currentContext && currentContext.videoId !== vid)) {
      resetVideoScopedState(vid);
    }
    if (vid) {
      await refreshSubtitleState(vid);
      if (!panelOpen || getVideoIdFromUrl() !== vid) return;
    }
    if (!currentContext || currentContext.videoId !== vid || !currentContext.chaptersLoaded) {
      currentVideoId = vid;
      const ctx = await buildContext();
      if (!panelOpen || getVideoIdFromUrl() !== vid) return;
      if (!ctx || ctx.videoId !== vid) {
        currentContext = null;
        renderLoading();
        void ensureContextBroadcast();
        return;
      }
      currentContext = ctx;
      broadcastContext(ctx);
    }
    if (vid && (!cachedSubtitleItemsReady || !currentContext?.subtitles?.fromCache)) {
      await refreshSubtitleState(vid);
      if (!panelOpen || getVideoIdFromUrl() !== vid) return;
    }
    if (!currentContext || currentContext.videoId !== vid) return;
    renderContext();
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('lingread-open');
    panelOpen = false;
    setActiveButton(false);
    stopObservingPanelPlayer();
    unbindOutsideClick();
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function panelBody() {
    const panel = document.getElementById(PANEL_ID);
    return panel ? panel.querySelector('.lr-body') : null;
  }

  function renderLoading() {
    const body = panelBody();
    if (!body) return;
    body.innerHTML = `<div class="lr-loading">读取视频信息…</div>`;
  }

  function renderContext() {
    const body = panelBody();
    if (!body) return;
    if (!currentContext) {
      body.innerHTML = `<div class="lr-error">无法读取视频信息，请刷新页面后重试。</div>`;
      return;
    }
    if (currentContext.isLive) {
      body.innerHTML = `<div class="lr-error">直播或直播回放暂不支持。</div>`;
      return;
    }
    if (!currentContext.hasNativeSubtitles && !cachedSubtitleItemsReady) {
      body.innerHTML = `<div class="lr-error">该视频没有任何字幕轨，暂不支持。</div>`;
      return;
    }
    const c = currentContext;
    void ensureVideoTitleTranslation(c);
    void ensureChapterTranslations(c);
    const subtitleBadge = renderSubtitleBadge(c);
    const translatedVideoTitle = translatedVideoTitles.get(c.videoId) || c.title || c.videoId;
    const chapterCount = c.chapters ? c.chapters.length : 0;

    body.innerHTML = `
      <div>${subtitleBadge}</div>
      <div class="lr-section">
        <div style="font-size:12px;color:#9a9a9a;margin-bottom:6px;">显示模式（Shift+B 切换）</div>
        <div class="lr-mode-row" role="tablist"></div>
        <div class="lr-task-status"></div>
      </div>
      <div class="lr-video-title" title="${escapeHtml(translatedVideoTitle)}">${escapeHtml(translatedVideoTitle)}</div>
      <div class="lr-section lr-chapters-wrap" style="display:none;">
        <div style="font-size:12px;color:#9a9a9a;margin-bottom:4px;">章节（${chapterCount}）</div>
        <div class="lr-chapters"></div>
      </div>
    `;
    renderModeRow(body.querySelector('.lr-mode-row'));
    renderTaskUi(); // 重画时把当前任务状态恢复，避免关闭再打开后空白
    if (chapterCount > 0) {
      const wrap = body.querySelector('.lr-chapters-wrap');
      const list = body.querySelector('.lr-chapters');
      wrap.style.display = '';
      const frag = document.createDocumentFragment();
      c.chapters.forEach((ch) => {
        const row = document.createElement('div');
        row.className = 'lr-chapter';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.title = '跳转到此章节';
        const seek = () => seekToChapter(ch.startTime);
        row.addEventListener('click', seek);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            seek();
          }
        });
        const time = document.createElement('span');
        time.className = 'lr-chapter-time';
        time.textContent = formatDuration(ch.startTime);
        const title = document.createElement('span');
        title.textContent = translatedChapterTitle(c.videoId, ch);
        row.appendChild(time);
        row.appendChild(title);
        frag.appendChild(row);
      });
      list.appendChild(frag);
    }
  }

  function chapterTranslationKey(chapter) {
    return `${Number(chapter?.startTime) || 0}:${String(chapter?.title || '')}`;
  }

  async function ensureVideoTitleTranslation(ctx) {
    if (!ctx || !ctx.videoId || !ctx.title) return;
    if (translatedVideoTitles.has(ctx.videoId)) return;
    if (videoTitleTranslationRequest?.videoId === ctx.videoId) return;
    const request = { videoId: ctx.videoId };
    videoTitleTranslationRequest = request;
    const token = await getAuthTokenLocal();
    if (!token || getVideoIdFromUrl() !== ctx.videoId) {
      if (videoTitleTranslationRequest === request) videoTitleTranslationRequest = null;
      return;
    }
    try {
      const data = await apiFetch('/api/youtube/metadata/translate', {
        method: 'POST',
        body: JSON.stringify({
          videoId: ctx.videoId,
          title: ctx.title,
          description: ctx.description || '',
          targetLanguage: 'zh-Hans',
        }),
      });
      if (videoTitleTranslationRequest !== request || getVideoIdFromUrl() !== ctx.videoId) return;
      if (typeof data?.title === 'string' && data.title.trim()) {
        translatedVideoTitles.set(ctx.videoId, data.title.trim());
        if (panelOpen && currentContext?.videoId === ctx.videoId) renderContext();
      }
    } catch (_e) {
      // 标题翻译失败时保留 YouTube 原标题，避免阻塞弹窗内容。
    } finally {
      if (videoTitleTranslationRequest === request) videoTitleTranslationRequest = null;
    }
  }

  function translatedChapterTitle(videoId, chapter) {
    const translations = chapterTranslations.get(videoId);
    return translations?.get(chapterTranslationKey(chapter)) || chapter.title;
  }

  async function ensureChapterTranslations(ctx) {
    if (!ctx || !ctx.videoId || !Array.isArray(ctx.chapters) || !ctx.chapters.length) return;
    const chapters = ctx.chapters
      .filter((chapter) => chapter && typeof chapter.title === 'string' && Number.isFinite(Number(chapter.startTime)))
      .map((chapter) => ({ title: chapter.title, startTime: Number(chapter.startTime) }));
    if (!chapters.length) return;
    const existing = chapterTranslations.get(ctx.videoId);
    if (existing && chapters.every((chapter) => existing.has(chapterTranslationKey(chapter)))) return;
    if (chapterTranslationRequest?.videoId === ctx.videoId) return;
    const request = { videoId: ctx.videoId };
    chapterTranslationRequest = request;
    const token = await getAuthTokenLocal();
    if (!token || getVideoIdFromUrl() !== ctx.videoId) {
      if (chapterTranslationRequest === request) chapterTranslationRequest = null;
      return;
    }
    try {
      const data = await apiFetch('/api/youtube/chapters/translate', {
        method: 'POST',
        body: JSON.stringify({
          videoId: ctx.videoId,
          chapters,
          targetLanguage: 'zh-Hans',
        }),
      });
      if (chapterTranslationRequest !== request || getVideoIdFromUrl() !== ctx.videoId) return;
      const translated = Array.isArray(data?.chapters) ? data.chapters : [];
      const map = new Map();
      translated.forEach((chapter, index) => {
        const original = chapters[index];
        if (!original || typeof chapter?.title !== 'string') return;
        map.set(chapterTranslationKey(original), chapter.title.trim() || original.title);
      });
      if (map.size) {
        chapterTranslations.set(ctx.videoId, map);
        if (panelOpen && currentContext?.videoId === ctx.videoId) renderContext();
      }
    } catch (_e) {
      // 章节翻译失败时保留原始标题，避免阻塞字幕模式和章节跳转。
    } finally {
      if (chapterTranslationRequest === request) chapterTranslationRequest = null;
    }
  }

  function seekToChapter(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    const player = getPanelPlayer(getPanelAnchor());
    const video = player?.querySelector?.('video')
      || document.querySelector('video.html5-main-video')
      || document.querySelector('video');
    if (video) {
      video.currentTime = target;
      return true;
    }
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(target, true);
      return true;
    }
    return false;
  }

  function renderModeRow(container) {
    if (!container) return;
    container.innerHTML = '';
    SUBTITLE_MODES.forEach((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lr-mode-btn'
        + (m === currentMode ? ' lr-mode-active' : '');
      btn.dataset.mode = m;
      btn.textContent = SUBTITLE_MODE_LABELS[m] || m;
      btn.addEventListener('click', () => setSubtitleMode(m));
      container.appendChild(btn);
    });
  }

  function refreshModeRow() {
    const row = document.querySelector(`#${PANEL_ID} .lr-mode-row`);
    if (row) renderModeRow(row);
  }

  function normalizeSubtitleMode(mode) {
    return mode === 'source' ? 'bilingual' : mode;
  }

  async function setSubtitleMode(m) {
    if (!SUBTITLE_MODES.includes(m)) return;
    currentMode = m;
    try {
      chrome.storage.local.set({ [SUBTITLE_MODE_KEY]: m });
    } catch (_e) {}
    try {
      window.dispatchEvent(new CustomEvent('yst:yt:set-mode', { detail: { mode: m } }));
    } catch (_e) {}
    refreshModeRow();
    if (m === 'bilingual' || m === 'target') {
      await ensureSubtitleTranslation();
    } else {
      subtitleSelectionRequest = null;
      pendingSubtitleFetchAfterLogin = false;
      renderTaskUi();
    }
  }

  function activateSubtitleTakeover(videoId) {
    if (!videoId || videoId !== getVideoIdFromUrl()) return false;
    if (!currentContext || currentContext.videoId !== videoId) return false;
    if (subtitleTakeoverVideoId === videoId) return false;
    subtitleTakeoverVideoId = videoId;
    window.dispatchEvent(new CustomEvent('yst:yt:activate-subtitles', {
      detail: { videoId },
    }));
    return true;
  }

  function cycleSubtitleMode() {
    const idx = SUBTITLE_MODES.indexOf(currentMode);
    const next = SUBTITLE_MODES[(idx + 1) % SUBTITLE_MODES.length];
    setSubtitleMode(next);
  }

  // ── 字幕翻译任务 ────────────────────────────────────────
  // 字幕翻译是耗时的后台任务（质量优先，服务端用 pro 模型逐段处理整段视频）。
  // 这里只负责：创建任务、打开网站进度页、轻量轮询进度并把已翻译字幕推给渲染器。
  function getAuthTokenLocal() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['auth_token'], (r) => resolve(r && r.auth_token ? r.auth_token : null));
      } catch (_e) { resolve(null); }
    });
  }

  async function apiFetch(path, options) {
    const action = window.LINGREAD_MESSAGES?.MSG?.HTTP_API_REQUEST || 'http:apiRequest';
    const result = await chrome.runtime.sendMessage({
      action,
      path,
      method: (options && options.method) || 'GET',
      body: options && options.body,
    });
    if (!result || result.error) {
      const body = result && result.data ? result.data : null;
      const status = result && result.status ? result.status : 0;
      const err = new Error(
        (body && (body.message || body.error))
        || (result && result.message)
        || (status ? `HTTP ${status}` : '请求失败')
      );
      err.status = status;
      err.body = body;
      throw err;
    }
    return result.data;
  }

  function openVideoInDashboard(videoId) {
    const siteUrl = (window.APP_CONFIG && window.APP_CONFIG.SITE_URL) || 'https://lingread.app';
    const trimmed = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
    const q = `tab=video&videoId=${encodeURIComponent(videoId)}&targetLanguage=zh-Hans`;
    const path = `/dashboard?${q}`;
    const action = window.LINGREAD_MESSAGES?.MSG?.NAV_OPEN_HISTORY || 'nav:openHistory';
    try {
      chrome.runtime.sendMessage({ action, path });
    } catch (_e) {
      window.open(`${trimmed}${path}`, '_blank', 'noopener');
    }
  }

  function bindTranscriptButton(btn) {
    if (!btn || btn.__ystBound) return;
    btn.__ystBound = true;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void startVideoTranscript();
    });
  }

  function setTranscriptButtonState(label, disabled, title, statusMessage, isError) {
    transcriptButtonLabel = label || '视频转写与总结';
    transcriptButtonDisabled = !!disabled;
    transcriptButtonTitle = title || '将视频内容整理成文字文章';
    transcriptStatusMessage = statusMessage || '无需先翻译字幕，直接生成独立的文字阅读页';
    transcriptStatusIsError = !!isError;
    const buttons = [
      document.getElementById(TRANSCRIPT_BUTTON_ID),
    ].filter(Boolean);
    buttons.forEach((btn) => {
      const labelEl = btn.querySelector('span');
      if (labelEl) labelEl.textContent = transcriptButtonLabel;
      btn.disabled = transcriptButtonDisabled;
      btn.title = transcriptButtonTitle;
    });
  }

  function encodeTranscriptContext(ctx) {
    const payload = JSON.stringify({
      title: ctx.title || ctx.videoId,
      description: (ctx.description || '').slice(0, 4000),
      channelName: ctx.channelName || '',
      duration: ctx.duration || 0,
      chapters: Array.isArray(ctx.chapters) ? ctx.chapters : [],
      targetLanguage: 'zh-Hans',
    });
    const bytes = new TextEncoder().encode(payload);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function openTranscriptPage(ctx) {
    const path = `/youtube/${encodeURIComponent(ctx.videoId)}/transcript?generate=1&targetLanguage=zh-Hans#ctx=${encodeTranscriptContext(ctx)}`;
    const action = window.LINGREAD_MESSAGES?.MSG?.NAV_OPEN_HISTORY || 'nav:openHistory';
    try {
      chrome.runtime.sendMessage({ action, path });
    } catch (_e) {
      const siteUrl = (window.APP_CONFIG && window.APP_CONFIG.SITE_URL) || 'https://lingread.app';
      const trimmed = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
      window.open(`${trimmed}${path}`, '_blank', 'noopener');
    }
  }

  async function startVideoTranscript() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) return;
    setTranscriptButtonState(
      '正在读取字幕',
      true,
      '正在读取当前视频字幕',
      '正在读取当前视频字幕…',
      false
    );

    let ctx = currentContext;
    if (
      !ctx
      || ctx.videoId !== videoId
      || (!ctx.subtitles?.fromCache && (!Array.isArray(ctx.subtitles?.segments) || !ctx.subtitles.segments.length))
    ) {
      ctx = await buildContext();
      if (ctx && ctx.videoId === videoId) {
        currentContext = ctx;
        broadcastContext(ctx);
      }
    }

    if (!ctx || ctx.videoId !== videoId || ctx.isLive) {
      setTranscriptButtonState(
        '重试视频转写',
        false,
        '未读取到当前视频信息，请刷新后重试',
        '未读取到当前视频信息，请刷新 YouTube 页面后重试',
        true
      );
      return;
    }

    const usesTranslatedCache = !!ctx.subtitles?.fromCache && cachedSubtitleItemsReady;
    const sourceItems = Array.isArray(ctx.subtitles?.segments) ? ctx.subtitles.segments : [];
    if (!usesTranslatedCache && !sourceItems.length) {
      setTranscriptButtonState(
        '字幕不可用',
        false,
        '该视频没有可用于转写的字幕轨',
        '该视频没有可用于转写的字幕轨',
        true
      );
      return;
    }

    const token = await getAuthTokenLocal();
    if (!token) {
      pendingTranscriptVideoId = videoId;
      setTranscriptButtonState(
        '登录后继续',
        true,
        '请先登录，登录后会继续打开视频转写',
        '请先登录 LingRead，登录完成后会自动继续',
        false
      );
      const loginStarted = await startRelayLogin();
      if (!loginStarted) {
        pendingTranscriptVideoId = null;
        setTranscriptButtonState(
          '重试视频转写',
          false,
          '无法打开登录页面，请稍后重试',
          '无法打开登录页面，请稍后重试',
          true
        );
      }
      return;
    }

    try {
      setTranscriptButtonState(
        '正在准备转写',
        true,
        '正在把当前视频加入文章库',
        '字幕已读取，正在准备独立转写页面…',
        false
      );
      // 即使命中共享的字幕翻译缓存，也要登记当前用户的视频库归属；
      // subtitles 为空时，服务端会复用现有的矫正字幕，不会创建字幕翻译任务。
      await apiFetch('/api/youtube/transcript/source', {
        method: 'POST',
        body: JSON.stringify({
          videoId: ctx.videoId,
          subtitles: sourceItems,
          source: ctx.subtitles.isAutoGenerated ? 'youtube_asr' : 'manual',
          sourceLanguage: ctx.subtitles.language || '',
          targetLanguage: 'zh-Hans',
          title: ctx.title || '',
          description: ctx.description || '',
          channelName: ctx.channelName || '',
        }),
      });
      pendingTranscriptVideoId = null;
      setTranscriptButtonState(
        '正在打开转写页',
        true,
        '正在打开独立转写页面',
        '准备完成，正在打开独立转写页面…',
        false
      );
      openTranscriptPage(ctx);
      window.setTimeout(() => setTranscriptButtonState(
        '视频转写与总结',
        false,
        '将视频内容整理成文字文章',
        '无需先翻译字幕，直接生成独立的文字阅读页',
        false
      ), 800);
    } catch (err) {
      if (err && err.status === 401) {
        pendingTranscriptVideoId = videoId;
        relayLoginInFlight = false;
        try { chrome.storage.local.remove(['auth_token', 'auth_user']); } catch (_e) {}
        setTranscriptButtonState(
          '登录后继续',
          true,
          '登录状态已失效，请重新登录',
          '登录状态已失效，请重新登录，完成后会自动继续',
          true
        );
        await startRelayLogin();
        return;
      }
      const message = err && err.message
        ? `视频转写准备失败：${err.message}`
        : '视频转写准备失败，请稍后重试';
      setTranscriptButtonState(
        '重试视频转写',
        false,
        message,
        message,
        true
      );
    }
  }

  async function resumeTranscriptAfterLogin() {
    const videoId = pendingTranscriptVideoId;
    if (!videoId) return;
    const token = await getAuthTokenLocal();
    if (!token) return;
    if (videoId !== getVideoIdFromUrl()) {
      pendingTranscriptVideoId = null;
      return;
    }
    await startVideoTranscript();
  }

  async function startRelayLogin() {
    if (relayLoginInFlight) return true;
    relayLoginInFlight = true;
    const relayId = crypto.randomUUID ? crypto.randomUUID() : `relay-${Date.now()}`;
    const action = window.LINGREAD_MESSAGES?.MSG?.AUTH_START_RELAY || 'auth:startRelay';
    try {
      const result = await chrome.runtime.sendMessage({ action, relayId });
      if (!result || result.ok !== true) {
        relayLoginInFlight = false;
        return false;
      }
      return true;
    } catch (_e) {
      relayLoginInFlight = false;
      return false;
    }
  }

  function stopTaskPoll() {
    if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
  }

  function startTaskPoll(videoId) {
    if (taskPollTimer) return;
    taskPollTimer = setInterval(() => {
      if (getVideoIdFromUrl() !== videoId) { stopTaskPoll(); return; }
      refreshSubtitleState(videoId);
    }, 6000);
  }

  // 重新断句会改变 cue 数量和边界，因此核对时间覆盖，而不是比较条目数。
  // 只核对原字幕的有声区间，保留视频本来的无字幕间隙。
  function hasCompleteSubtitleCoverage(source, items) {
    if (!Array.isArray(source) || !source.length) return false;
    const ranges = items
      .filter(item => item && Number.isFinite(item.start) && Number.isFinite(item.end)
        && item.end > item.start && typeof item.translation === 'string' && item.translation.trim())
      .map(item => ({ start: Math.round(item.start * 1000), end: Math.round(item.end * 1000) }))
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    let index = 0;
    for (const cue of [...source].sort((a, b) => a.start - b.start)) {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return false;
      const start = Math.round(cue.start * 1000);
      const end = Math.round(cue.end * 1000);
      while (index < merged.length && merged[index].end < start - 1) index++;
      if (!merged[index] || merged[index].start > start + 1 || merged[index].end < end - 1) return false;
    }
    return true;
  }

  // 拉取该视频已翻译字幕 + 最新任务摘要：把字幕推给渲染器，更新面板与按钮提示，
  // 并按任务状态启停轮询。任务在服务端后台跑，关掉面板/页面不影响。
  async function refreshSubtitleState(videoId) {
    if (!videoId || getVideoIdFromUrl() !== videoId) return false;
    const requestId = ++subtitleStateRequestId;
    const isCurrent = () => requestId === subtitleStateRequestId && getVideoIdFromUrl() === videoId;
    try {
      const hasAuthToken = !!(await getAuthTokenLocal());
      const data = await apiFetch(`/api/youtube/subtitle/${encodeURIComponent(videoId)}?targetLanguage=zh-Hans`, { method: 'GET' });
      if (!isCurrent()) return false;
      const items = Array.isArray(data.items) ? data.items : [];
      const task = hasAuthToken ? data.task || null : null;
      const mayBeComplete = items.length > 0 && (!task || task.status === 'completed');
      let shouldRenderContext = false;
      let sourceContext = currentContext?.videoId === videoId && !currentContext.subtitles?.fromCache
        ? currentContext : null;
      if (mayBeComplete && !sourceContext?.subtitles?.segments?.length) {
        // 删除任务或匿名访问都会拿到 task:null；缓存本身不能证明翻译已完成。
        // 不能拿由该缓存生成的 context 来验证自身，必须读取原始字幕轨。
        const nativeContext = await buildContext();
        if (!isCurrent()) return false;
        if (nativeContext?.videoId === videoId && nativeContext.subtitles?.segments?.length) {
          sourceContext = currentContext = nativeContext;
          broadcastContext(currentContext);
          shouldRenderContext = true;
        }
      }
      subtitleTask = task;
      subtitleTaskFromAuth = hasAuthToken && !!subtitleTask;
      cachedSubtitleItemsReady = mayBeComplete
        && hasCompleteSubtitleCoverage(sourceContext?.subtitles?.segments, items);
      cachedSubtitleItemsIncomplete = mayBeComplete
        && !!sourceContext?.subtitles?.segments?.length && !cachedSubtitleItemsReady;
      // 无法读取原轨时是校验失败，不是缺少译文；不要误建重复翻译任务。
      if (mayBeComplete && !sourceContext?.subtitles?.segments?.length) return false;
      const inProgress = task && ['pending', 'running'].includes(task.status);
      const usableItems = cachedSubtitleItemsReady || inProgress ? items : [];
      cachedSubtitleItemsCount = usableItems.length;
      if (!usableItems.length && currentContext?.videoId === videoId && currentContext.subtitles?.fromCache) {
        currentContext = null;
      }
      if (usableItems.length) {
        const hasUsableContext =
          currentContext
          && currentContext.videoId === videoId
          && currentContext.subtitles
          && Array.isArray(currentContext.subtitles.segments)
          && currentContext.subtitles.segments.length > 0;
        if (!hasUsableContext) {
          currentContext = buildCachedSubtitleContext(videoId, usableItems);
          shouldRenderContext = true;
        }
        if (currentContext && currentContext.videoId === videoId) {
          broadcastContext(currentContext);
        }
      }
      // 把任务状态告诉渲染器：进行中时未译行占位显示"翻译中…"而非"未翻译"
      try {
        window.dispatchEvent(new CustomEvent('yst:yt:task-state', {
          detail: { videoId, status: subtitleTask ? subtitleTask.status : null },
        }));
      } catch (_e) {}
      if (usableItems.length) {
        try {
          window.dispatchEvent(new CustomEvent('yst:yt:subtitles-data', { detail: { videoId, items: usableItems } }));
        } catch (_e) {}
      }
      if (panelOpen && shouldRenderContext) renderContext();
      else renderTaskUi();
      updateButtonBadge();
      if (subtitleTask && (subtitleTask.status === 'pending' || subtitleTask.status === 'running')) {
        startTaskPoll(videoId);
      } else {
        stopTaskPoll();
      }
      return true;
    } catch (_e) {
      // 后台刷新失败保持静默；主动选择模式时由调用方显示重试提示。
      if (isCurrent()) subtitleTaskFromAuth = false;
      return false;
    }
  }

  async function createTask(force) {
    const c = currentContext;
    if (!c || !c.subtitles || !Array.isArray(c.subtitles.segments) || !c.subtitles.segments.length) return null;
    if (c.subtitles.fromCache) return null;
    // 只创建待开始任务。真正翻译需用户在网站控制台文章库里点击"开始翻译"。
    return apiFetch('/api/youtube/subtitle/task', {
      method: 'POST',
      body: JSON.stringify({
        videoId: c.videoId,
        subtitles: c.subtitles.segments,
        source: c.subtitles.isAutoGenerated ? 'youtube_asr' : 'manual',
        sourceLanguage: c.subtitles.language || 'en',
        targetLanguage: 'zh-Hans',
        title: c.title,
        description: c.description,
        channelName: c.channelName,
        force: !!force,
      }),
    });
  }

  async function saveSubtitleTaskAndOpenDashboard(force, statusEl, options = {}) {
    const allowRelayLogin = options.allowRelayLogin !== false;
    const isCurrent = options.isCurrent || (() => true);
    if (!isCurrent()) return;
    let c = currentContext;
    const currentVid = getVideoIdFromUrl();
    if (cachedSubtitleItemsReady && c?.videoId === currentVid && c?.subtitles?.fromCache) {
      if (statusEl) { statusEl.classList.remove('lr-error'); statusEl.textContent = '中文字幕已就绪，正在打开控制台'; }
      openVideoInDashboard(currentVid);
      return;
    }
    if (!c || c.videoId !== currentVid || !c.subtitles || c.subtitles.fromCache || !Array.isArray(c.subtitles.segments) || !c.subtitles.segments.length) {
      c = await buildContext();
      if (!isCurrent() || getVideoIdFromUrl() !== currentVid) return;
      if (c && c.videoId === currentVid) currentContext = c;
    }
    if (!c || c.videoId !== currentVid || !c.subtitles || !Array.isArray(c.subtitles.segments) || !c.subtitles.segments.length) {
      if (statusEl) {
        statusEl.classList.add('lr-error');
        statusEl.textContent = '未读取到可用字幕，请刷新页面后重试';
      }
      return;
    }
    currentContext = c;
    broadcastContext(c);
    activateSubtitleTakeover(c.videoId);
    if (statusEl) { statusEl.classList.remove('lr-error'); statusEl.textContent = '正在保存字幕任务...'; }
    try {
      const data = await createTask(force);
      if (!isCurrent()) return;
      if (data && data.taskId) {
        await refreshSubtitleState(c.videoId);
        if (isCurrent()) openVideoInDashboard(c.videoId);
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (statusEl) {
        statusEl.classList.add('lr-error');
        statusEl.textContent = err && err.status === 401
          ? '请先登录后再获取 YouTube 字幕'
          : err && err.status === 429
          ? '请求过于频繁，请稍后再试或登录后使用'
          : `失败：${err && err.message ? err.message : err}`;
      }
      if (err && err.status === 401) {
        pendingSubtitleFetchAfterLogin = allowRelayLogin ? currentVid : false;
        relayLoginInFlight = false;
        try { chrome.storage.local.remove(['auth_token', 'auth_user']); } catch (_e) {}
        if (allowRelayLogin) {
          await startRelayLogin();
        } else if (statusEl) {
          statusEl.textContent = '登录状态已失效，请重新登录后再试';
        }
      }
      throw err;
    }
  }

  async function resumeSubtitleFetchAfterLogin() {
    const videoId = pendingSubtitleFetchAfterLogin;
    if (!videoId || videoId !== getVideoIdFromUrl()) return;
    const token = await getAuthTokenLocal();
    if (!token || pendingSubtitleFetchAfterLogin !== videoId) return;
    pendingSubtitleFetchAfterLogin = false;
    await ensureSubtitleTranslation({ allowRelayLogin: false });
  }

  async function ensureSubtitleTranslation(options = {}) {
    const videoId = getVideoIdFromUrl();
    if (!videoId || !['bilingual', 'target'].includes(currentMode)) return;
    if (subtitleSelectionRequest?.videoId === videoId) return;
    const request = { videoId };
    subtitleSelectionRequest = request;
    const isCurrent = () => subtitleSelectionRequest === request
      && getVideoIdFromUrl() === videoId
      && ['bilingual', 'target'].includes(currentMode);
    const statusEl = document.querySelector(`#${PANEL_ID} .lr-task-status`);
    const setStatus = (text, isError = false) => {
      if (!isCurrent() || !statusEl) return;
      statusEl.classList.toggle('lr-error', isError);
      statusEl.textContent = text;
    };
    try {
      setStatus('正在检查字幕翻译…');
      const refreshed = await refreshSubtitleState(videoId);
      if (!isCurrent()) return;
      if (!refreshed) {
        setStatus('字幕检查失败，请重新选择双语或仅中文重试', true);
        return;
      }
      if (cachedSubtitleItemsReady) {
        activateSubtitleTakeover(videoId);
        renderTaskUi();
        return;
      }
      const token = await getAuthTokenLocal();
      if (!isCurrent()) return;
      if (!token) {
        if (options.allowRelayLogin === false) {
          setStatus('登录状态已失效，请重新登录后再试', true);
          return;
        }
        pendingSubtitleFetchAfterLogin = videoId;
        setStatus('请先登录，登录后会继续打开翻译页面');
        const loginStarted = await startRelayLogin();
        if (!isCurrent()) return;
        if (!loginStarted) {
          pendingSubtitleFetchAfterLogin = false;
          setStatus('无法打开登录页面，请重新选择字幕模式重试', true);
        }
        return;
      }
      activateSubtitleTakeover(videoId);
      const t = subtitleTask;
      if (subtitleTaskFromAuth && t?.taskId && ['idle', 'pending', 'running'].includes(t.status)) {
        openVideoInDashboard(videoId);
        return;
      }
      await saveSubtitleTaskAndOpenDashboard(false, statusEl, { ...options, isCurrent });
    } catch (_e) {
      // 保存失败时，已有流程会显示错误并按需启动登录。
    } finally {
      if (subtitleSelectionRequest === request) subtitleSelectionRequest = null;
    }
  }

  // 面板内的任务状态提示（简单进度）
  function renderTaskUi() {
    const statusEl = document.querySelector(`#${PANEL_ID} .lr-task-status`);
    if (!statusEl) return;
    const t = subtitleTask;
    const setStatus = (text, isErr) => {
      if (!statusEl) return;
      statusEl.classList.toggle('lr-error', !!isErr);
      statusEl.textContent = text;
    };
    const takeoverActive = !!(
      currentContext
      && currentContext.videoId
      && subtitleTakeoverVideoId === currentContext.videoId
    );
    if (cachedSubtitleItemsIncomplete) {
      setStatus('字幕翻译不完整，重新选择双语或仅中文可继续翻译', true);
      return;
    }
    if (cachedSubtitleItemsReady && !takeoverActive) {
      setStatus('');
      return;
    }
    if (!t) {
      if (cachedSubtitleItemsReady) {
        setStatus('');
        return;
      }
      setStatus('');
    } else if (t.status === 'idle') {
      setStatus('字幕任务已保存，请在控制台文章库中确认点数后开始翻译');
    } else if (t.status === 'canceled') {
      setStatus('上次任务已取消，选择双语或仅中文可重新翻译');
    } else if (t.status === 'pending' || t.status === 'running') {
      if (t.phase === 'resegmentation') {
        setStatus('事实性校正已完成，正在重新断句，可关闭页面，任务在后台继续');
      } else if (t.phase === 'factual_correction') {
        setStatus('字幕翻译已完成，正在进行事实性校正，可关闭页面，任务在后台继续');
      } else {
        const pct = t.totalSegments > 0 ? Math.round((t.completedSegments / t.totalSegments) * 100) : 0;
        setStatus(`翻译中 ${t.completedSegments}/${t.totalSegments} 段（${pct}%），可关闭页面，任务在后台继续`);
      }
    } else if (t.status === 'completed') {
      setStatus(cachedSubtitleItemsReady
        ? ''
        : '字幕任务已完成，但字幕数据尚未加载，可稍后重试');
    } else if (t.status === 'failed') {
      setStatus('翻译任务失败，重新选择双语或仅中文可重试', true);
    }
  }

  // 控制栏 LingRead 按钮角标：任务进行中显示百分比
  function updateButtonBadge() {
    const t = subtitleTask;
    let badgeText = '';
    if (t && (t.status === 'pending' || t.status === 'running') && t.totalSegments > 0) {
      const pct = Math.round((t.completedSegments / t.totalSegments) * 100);
      badgeText = `${pct}%`;
    }
    [document.getElementById(ICON_ID), document.getElementById(EMBED_ICON_ID)].forEach((btn) => {
      if (btn) renderControlButton(btn, badgeText);
    });
  }

  function renderSubtitleBadge(c) {
    if (c.subtitles && c.subtitles.fromCache) {
      return `<span class="lr-badge lr-badge-info">中文字幕已就绪</span>`;
    }
    if (cachedSubtitleItemsReady) {
      return `<span class="lr-badge lr-badge-info">中文字幕已就绪</span>`;
    }
    if (!c.subtitles) {
      // 走到这里通常说明 ytInitialPlayerResponse 里有字幕轨但 timedtext 拉不下来。
      // 浏览器控制台会有 [LingRead YT] caption fetch failed 的警告。
      return `<span class="lr-badge lr-badge-warn">字幕加载失败，请刷新或检查控制台</span>`;
    }
    if (c.subtitles.isAutoGenerated) {
      return `<span class="lr-badge lr-badge-warn">YouTube 自动字幕（待生成中文字幕）</span>`;
    }
    return `<span class="lr-badge lr-badge-info">人工字幕 · ${escapeHtml(c.subtitles.language || '')}</span>`;
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── 视频/路由切换 ───────────────────────────────────────
  function onNavigation() {
    const newVid = getVideoIdFromUrl();
    if (newVid !== currentVideoId || (currentContext && currentContext.videoId !== newVid)) {
      resetVideoScopedState(newVid, { close: true });
    }
    if (isYouTubePlayerPage()) {
      injectControlBarIcon();
      ensureEmbedFloatingIcon();
      injectTranscriptButton();
      // 主动构建 context 并广播给字幕模块（不依赖 QuickPanel 打开）
      ensureContextBroadcast();
    } else {
      const btn = document.getElementById(ICON_ID);
      if (btn) btn.remove();
      const embedBtn = document.getElementById(EMBED_ICON_ID);
      if (embedBtn) embedBtn.remove();
      const transcriptBtn = document.getElementById(TRANSCRIPT_BUTTON_ID);
      if (transcriptBtn) transcriptBtn.remove();
    }
  }

  async function ensureContextBroadcast() {
    if (!isYouTubePlayerPage()) return;
    const vid = getVideoIdFromUrl();
    if (!vid) return;
    if (lastBroadcastVideoId === vid && currentContext && currentContext.subtitles) return;
    if (contextBuildInFlight) return;
    contextBuildInFlight = true;
    try {
      void refreshSubtitleState(vid);
      // 直接打开播放器页时 ytInitialPlayerResponse 可能还没就绪，
      // 或字幕轨在视频播放器初始化后才挂上来；最长重试 24 秒
      // （bridge 抓字幕本身也会等 PoToken 落地并重试）。
      const startTime = Date.now();
      let attempt = 0;
      let lastCtx = null;
      while (Date.now() - startTime < 24000) {
        if (vid !== getVideoIdFromUrl()) return; // 用户已切走
        const ctx = await buildContext();
        if (vid !== getVideoIdFromUrl()) return; // buildContext 等待期间可能发生 SPA 切换
        attempt++;
        if (ctx) lastCtx = ctx;
        if (ctx && ctx.videoId === vid && (ctx.subtitles || ctx.isLive || (!ctx.hasNativeSubtitles && !cachedSubtitleItemsReady))) {
          currentContext = ctx;
          lastBroadcastVideoId = vid;
          broadcastContext(ctx);
          if (panelOpen) renderContext();
          // 拉取已翻译字幕并加载（若已完成）+ 恢复任务进度提示
          refreshSubtitleState(vid);
          return;
        }
        await new Promise((r) => setTimeout(r, attempt < 3 ? 600 : 1500));
      }
      // 超时仍把已拿到的 context 广播一次，至少 QuickPanel 能显示"字幕加载失败"
      if (lastCtx && lastCtx.videoId === vid && (lastCtx.subtitles || !cachedSubtitleItemsReady)) {
        currentContext = lastCtx;
        lastBroadcastVideoId = vid;
        broadcastContext(lastCtx);
        if (panelOpen) renderContext();
        refreshSubtitleState(vid);
      }
      if (cachedSubtitleItemsReady) {
        return;
      }
      console.warn('[LingRead YT] context build timed out', { videoId: vid });
    } finally {
      contextBuildInFlight = false;
      // 用户可能在上一条字幕仍在抓取时快速切换视频。此前 1 秒 URL 轮询会偶然
      // 补上这次导航；改为事件驱动后，在旧任务退出时显式接续最新视频。
      const latestVideoId = getVideoIdFromUrl();
      if (latestVideoId && latestVideoId !== vid) {
        ensureContextBroadcast();
      }
    }
  }

  function ensurePlayerEntry() {
    if (!isYouTubePlayerPage()) return;
    if (isEmbedPlayerPage()) {
      ensureEmbedFloatingIcon();
    } else {
      injectControlBarIcon();
      injectTranscriptButton();
    }
  }

  // ── 键盘快捷键 ──────────────────────────────────────────
  function onKeyDown(e) {
    if (!isYouTubePlayerPage()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.altKey && e.shiftKey && e.code === 'KeyY') {
      e.preventDefault();
      togglePanel();
      return;
    }
    if (e.altKey && e.shiftKey && e.code === 'KeyB') {
      e.preventDefault();
      cycleSubtitleMode();
    }
  }

  // ── 启动 ───────────────────────────────────────────────
  function start() {
    // 读字幕模式（默认 bilingual）
    try {
      chrome.storage.local.get([SUBTITLE_MODE_KEY], (r) => {
        const stored = r && r[SUBTITLE_MODE_KEY];
        const m = normalizeSubtitleMode(stored);
        if (SUBTITLE_MODES.includes(m)) {
          currentMode = m;
          if (stored !== m) chrome.storage.local.set({ [SUBTITLE_MODE_KEY]: m });
          refreshModeRow();
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SUBTITLE_MODE_KEY]) {
          const stored = changes[SUBTITLE_MODE_KEY].newValue;
          const m = normalizeSubtitleMode(stored);
          if (stored !== m) chrome.storage.local.set({ [SUBTITLE_MODE_KEY]: m });
          if (SUBTITLE_MODES.includes(m) && m !== currentMode) {
            currentMode = m;
            refreshModeRow();
          }
        }
        if (changes.auth_token && changes.auth_token.newValue) {
          relayLoginInFlight = false;
          void resumeSubtitleFetchAfterLogin();
          void resumeTranscriptAfterLogin();
        }
        if (changes.pendingRelayId && !changes.pendingRelayId.newValue) {
          relayLoginInFlight = false;
          if (!changes.auth_token?.newValue) renderTaskUi();
        }
      });
    } catch (_e) {}

    onNavigation();
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', repositionOpenPanel, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      repositionOpenPanel();
      ensurePlayerEntry();
    }, true);

    // 切回 YouTube 标签时立即重新拉取字幕。选择翻译模式可能打开进度页新标签，
    // YouTube 标签转入后台后 setInterval 轮询会被浏览器节流甚至暂停，导致任务
    // 在后台完成时最后一次"推送完整字幕"没跑到；切回时主动同步一次即可补齐。
    document.addEventListener('visibilitychange', () => {
      const vid = getVideoIdFromUrl();
      if (document.visibilityState === 'visible' && vid) {
        refreshSubtitleState(vid);
      }
    });

    // SPA 导航：监听 page world 通过 bridge 转发的 navigate 事件
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== BRIDGE_SOURCE || d.type !== 'navigate') return;
      onNavigation();
    });

    // 兜底：监听 yt-navigate-finish（content script 也能收到此事件）
    window.addEventListener('yt-navigate-finish', onNavigation, true);
    // 某些 YouTube 导航只触发数据或播放器更新事件；两者都能覆盖 SPA 切视频。
    window.addEventListener('yt-page-data-updated', onNavigation, true);
    window.addEventListener('yt-player-updated', onNavigation, true);
    // 浏览器前进/后退不一定触发 YouTube 自定义事件，保留标准导航兜底。
    window.addEventListener('popstate', onNavigation, true);
  }

  // Popup commands use the same player workflow as the in-page buttons.
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!['youtube:openTools', 'youtube:transcript'].includes(request.action)) return;
    if (!isYouTubePlayerPage()) {
      sendResponse({ ok: false, error: '请先打开一个 YouTube 视频' });
      return;
    }
    if (request.action === 'youtube:openTools') {
      if (!panelOpen) togglePanel();
    } else {
      void startVideoTranscript();
    }
    sendResponse({ ok: true });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
