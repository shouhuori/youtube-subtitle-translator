// content-youtube-bridge.js — 在 YouTube 页面世界（MAIN world）运行
//
// 通过 manifest 的 content_scripts 注入：world="MAIN"，run_at="document_start"。
// 仅暴露 YouTube 页面级数据 + 在页面上下文里发 fetch 给 isolated world 使用。
// 不直接访问 chrome.* API（MAIN world 中不可用）；通信全部走 window.postMessage。
//
// 协议（统一 source: 'yst-youtube'）：
//   isolated -> main:  { type: 'request-context', requestId }
//   main -> isolated:  { type: 'context', requestId, payload }
//
//   isolated -> main:  { type: 'fetch-captions', requestId, expectedVideoId, languageCode, kind }
//   main -> isolated:  { type: 'fetch-captions-result', requestId, ok, status, text, url, error? }
//
//   main -> isolated:  { type: 'navigate', payload: { url } }
//
// 字幕抓取的细节实现参考 read-frog
// (https://github.com/mengxi-ream/read-frog/tree/main/src/utils/subtitles/fetchers/youtube)：
//   1. YouTube 对没有 PoToken 的字幕请求会静默返回 200+空响应
//   2. PoToken 在 ytInitialPlayerResponse 里没有，要从 player.getAudioTrack()
//      .captionTracks[i].url 这种运行时 player API 里取
//   3. 还需要 cver / device / 一组固定 query 参数，否则部分视频也拿不到

(function () {
  if (window.__YST_YT_BRIDGE__) return;
  window.__YST_YT_BRIDGE__ = true;

  const SOURCE = 'yst-youtube';

  const FIXED_PARAMS = {
    fmt: 'json3',
    xorb: '2',
    xobt: '3',
    xovt: '3',
    c: 'WEB',
    cplayer: 'UNIPLAYER',
  };
  const DEVICE_PARAM_KEYS = ['cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'];

  // ── timedtext 拦截器 ─────────────────────────────────────
  // 在 document_start 装好钩子，被动捕获 YouTube 自身发出的 api/timedtext 请求，
  // 把里面的 PoToken 缓存下来（按 videoId）。LingRead 抓字幕时优先使用缓存的
  // PoToken，免去轮询 player.getAudioTrack() 等待 PoToken 就绪的几秒钟。
  // 实现参考 read-frog 的 timedtext-observer。
  const timedtextUrlCache = new Map();
  const timedtextWaiters = new Map(); // videoId -> resolver[]
  const TIMEDTEXT_RE = /\/api\/timedtext/;

  function cacheTimedtextUrl(rawUrl) {
    if (!rawUrl || !TIMEDTEXT_RE.test(rawUrl)) return;
    try {
      const u = new URL(rawUrl, location.origin);
      const v = u.searchParams.get('v');
      const pot = u.searchParams.get('pot');
      if (!v || !pot) return;
      const urlStr = u.toString();
      timedtextUrlCache.set(v, urlStr);
      const ws = timedtextWaiters.get(v);
      if (ws) {
        timedtextWaiters.delete(v);
        ws.forEach((r) => { try { r(urlStr); } catch (_e) {} });
      }
    } catch (_e) {}
  }

  // 事件驱动地等 XHR 拦截器把对应 videoId 的 timedtext URL 入缓存。
  // 命中即立即返回；超时返回 null。比 setInterval 轮询省去 100-300ms 抖动。
  function waitForTimedtextCache(videoId, maxMs) {
    if (!videoId) return Promise.resolve(null);
    const cached = timedtextUrlCache.get(videoId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const arr = timedtextWaiters.get(videoId) || [];
      const wrap = (url) => { cleanup(); resolve(url); };
      arr.push(wrap);
      timedtextWaiters.set(videoId, arr);
      const timer = setTimeout(() => {
        cleanup();
        resolve(timedtextUrlCache.get(videoId) || null);
      }, maxMs);
      function cleanup() {
        clearTimeout(timer);
        const cur = timedtextWaiters.get(videoId);
        if (!cur) return;
        const idx = cur.indexOf(wrap);
        if (idx !== -1) cur.splice(idx, 1);
        if (cur.length === 0) timedtextWaiters.delete(videoId);
      }
    });
  }

  (function setupTimedtextObserver() {
    try {
      const xhrOpen = XMLHttpRequest.prototype.open;
      const xhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__lr_url = typeof url === 'string' ? url : (url && url.toString && url.toString()) || ''; } catch (_e) {}
        return xhrOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        // YouTube 自身会产生大量 XHR。只有字幕请求才需要 load 回调，避免给每个
        // 日志、推荐和广告请求都额外挂一个监听器。
        if (TIMEDTEXT_RE.test(this.__lr_url || '')) {
          try {
            this.addEventListener('load', () => {
              cacheTimedtextUrl(this.responseURL || this.__lr_url);
            }, { once: true });
          } catch (_e) {}
        }
        return xhrSend.apply(this, arguments);
      };
    } catch (_e) {}

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          const reqUrl = typeof input === 'string' ? input : (input && input.url) || '';
          const p = origFetch.apply(this, arguments);
          if (TIMEDTEXT_RE.test(reqUrl)) {
            try {
              p.then((res) => {
                try { cacheTimedtextUrl((res && res.url) || reqUrl); } catch (_e) {}
              }).catch(() => {});
            } catch (_e) {}
          }
          return p;
        };
      }
    } catch (_e) {}
  })();

  // ── ytInitialPlayerResponse / chapters 提取 ─────────────
  function getUrlVideoId() {
    try {
      if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
      const match = location.pathname.match(/^\/embed\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_e) {
      return null;
    }
  }

  function getResponseVideoId(playerResponse) {
    return playerResponse?.videoDetails?.videoId || null;
  }

  function pickPlayerResponse(expectedVideoId) {
    const expected = expectedVideoId || getUrlVideoId();
    const player = findPlayer();
    const runtimeResponse = safe(() => player && player.getPlayerResponse && player.getPlayerResponse());
    if (runtimeResponse && (!expected || getResponseVideoId(runtimeResponse) === expected)) {
      return runtimeResponse;
    }

    const initialResponse = window.ytInitialPlayerResponse || null;
    if (initialResponse && (!expected || getResponseVideoId(initialResponse) === expected)) {
      return initialResponse;
    }

    return runtimeResponse || initialResponse || null;
  }

  function pickChapters() {
    try {
      const data = window.ytInitialData;
      if (!data) return null;
      const contents =
        data.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
          ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer
          ?.markersMap;
      if (!Array.isArray(contents)) return null;
      const chapterEntry = contents.find(
        (m) => m && (m.key === 'DESCRIPTION_CHAPTERS' || m.key === 'AUTO_CHAPTERS')
      );
      const markers = chapterEntry?.value?.chapters;
      if (!Array.isArray(markers)) return null;
      return markers
        .map((c) => {
          const r = c.chapterRenderer;
          if (!r) return null;
          const title = r.title?.simpleText || '';
          const startMs = Number(r.timeRangeStartMillis ?? 0);
          if (!title) return null;
          return { title, startTime: Math.floor(startMs / 1000) };
        })
        .filter(Boolean);
    } catch (_e) {
      return null;
    }
  }

  function buildContextPayload() {
    const playerResponse = pickPlayerResponse();
    return {
      playerResponse,
      chapters: pickChapters(),
      url: location.href,
      readyState: document.readyState,
    };
  }

  function replyContext(requestId) {
    window.postMessage(
      { source: SOURCE, type: 'context', requestId, payload: buildContextPayload() },
      location.origin
    );
  }

  // ── 字幕抓取（核心）─────────────────────────────────────
  function findPlayer() {
    return (
      document.querySelector('.html5-video-player.playing-mode, .html5-video-player.paused-mode') ||
      document.querySelector('.html5-video-player')
    );
  }

  function safe(fn) {
    try { return fn(); } catch (_e) { return undefined; }
  }

  function getDeviceParams() {
    const raw = safe(() => window.ytcfg && window.ytcfg.get && window.ytcfg.get('DEVICE'));
    if (!raw || typeof raw !== 'string') return null;
    try { return new URLSearchParams(raw); } catch (_e) { return null; }
  }

  function selectTrackOnPlayer(playerResponse, languageCode, kind) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return null;
    // 1. 精确匹配 language + kind
    let t = tracks.find((x) => x.languageCode === languageCode && (x.kind || '') === (kind || ''));
    if (t) return t;
    // 2. 仅匹配 language
    t = tracks.find((x) => x.languageCode === languageCode);
    if (t) return t;
    // 3. 兜底返回首个
    return tracks[0];
  }

  function extractPotToken(player, selectedTrack, videoId) {
    try {
      const audio = player && player.getAudioTrack && player.getAudioTrack();
      const audioCaptionTracks = (audio && audio.captionTracks) || [];
      if (audioCaptionTracks.length) {
        const match =
          audioCaptionTracks.find((t) => t.vssId && selectedTrack.vssId && t.vssId === selectedTrack.vssId) ||
          audioCaptionTracks.find((t) => t.languageCode === selectedTrack.languageCode && (t.kind || '') === (selectedTrack.kind || '')) ||
          audioCaptionTracks.find((t) => t.languageCode === selectedTrack.languageCode) ||
          audioCaptionTracks[0];

        if (match && match.url) {
          const u = new URL(match.url);
          const pot = u.searchParams.get('pot');
          if (pot) return { pot, potc: u.searchParams.get('potc') };
        }
      }
    } catch (_e) {}

    // 兜底：使用 XHR 拦截器缓存的 timedtext URL 里的 PoToken
    if (videoId) {
      const cached = timedtextUrlCache.get(videoId);
      if (cached) {
        try {
          const u = new URL(cached);
          const pot = u.searchParams.get('pot');
          if (pot) return { pot, potc: u.searchParams.get('potc') };
        } catch (_e) {}
      }
    }

    return { pot: null, potc: null };
  }

  function buildCaptionUrl(track, player, potToken) {
    const baseUrl = track.baseUrl.startsWith('http') ? track.baseUrl : `${location.origin}${track.baseUrl}`;
    const u = new URL(baseUrl);

    Object.entries(FIXED_PARAMS).forEach(([k, v]) => u.searchParams.set(k, v));

    const device = getDeviceParams();
    if (device) {
      DEVICE_PARAM_KEYS.forEach((k) => {
        const v = device.get(k);
        if (v) u.searchParams.set(k, v);
      });
    }

    const cver = safe(() => player.getWebPlayerContextConfig && player.getWebPlayerContextConfig()?.innertubeContextClientVersion);
    if (cver) u.searchParams.set('cver', cver);

    if (potToken.pot) u.searchParams.set('pot', potToken.pot);
    if (potToken.potc) u.searchParams.set('potc', potToken.potc);

    return u.toString();
  }

  function ensureSubtitlesEnabled(player) {
    // 我们后面会用 CSS 隐藏原生字幕；这里只是要触发 player 加载 caption 数据
    // 以便 audioCaptionTracks 里出现 pot。
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') !== 'true') {
        if (player && typeof player.toggleSubtitles === 'function') player.toggleSubtitles();
        else btn.click();
      }
    } catch (_e) {}
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitForPlayerReady(expectedVideoId, maxMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const player = findPlayer();
      if (player) {
        const state = safe(() => player.getPlayerState && player.getPlayerState());
        const playerResponse = safe(() => player.getPlayerResponse && player.getPlayerResponse());
        const videoId = getResponseVideoId(playerResponse);
        if (
          playerResponse
          && (!expectedVideoId || videoId === expectedVideoId)
          && typeof state === 'number'
          && state >= 1
        ) {
          return player;
        }
      }
      await delay(100);
    }
    const player = findPlayer();
    const playerResponse = safe(() => player && player.getPlayerResponse && player.getPlayerResponse());
    const videoId = getResponseVideoId(playerResponse);
    if (playerResponse && (!expectedVideoId || videoId === expectedVideoId)) return player;
    return null;
  }

  // 校验返回内容是否为有效字幕。YouTube 对缺 PoToken / 无效请求常返回
  // 200 + 空体或空 JSON——这种必须当失败，否则会显示"无法获取字幕"。
  function isValidCaptionText(text) {
    if (!text) return false;
    const t = text.trim();
    if (!t) return false;
    if (t[0] === '{') return t.includes('"events"');
    if (t[0] === '<') return t.includes('<text');
    return false;
  }

  async function fetchCaptionText(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const text = res.ok ? await res.text() : '';
      return { status: res.status, text, valid: res.ok && isValidCaptionText(text) };
    } catch (err) {
      return { status: 0, text: '', valid: false, error: String(err) };
    }
  }

  // 单次尝试：用当前 player 状态拼 URL 抓字幕。不强制要求 PoToken——很多视频
  // 不需要 pot 也能直接拿到（参考 read-frog 的 fast path）。只有返回内容
  // 校验为有效字幕才算成功，否则返回 null，交给重试/慢路径。
  async function attemptFetch(req) {
    const player = findPlayer();
    if (!player) return null;
    const playerResponse = safe(() => player.getPlayerResponse && player.getPlayerResponse());
    if (!playerResponse) return null;
    const videoId = playerResponse?.videoDetails?.videoId;
    if (req.expectedVideoId && videoId !== req.expectedVideoId) return null;
    const track = selectTrackOnPlayer(playerResponse, req.languageCode, req.kind);
    if (!track || !track.baseUrl) return null;
    const pot = extractPotToken(player, track, videoId);
    const url = buildCaptionUrl(track, player, pot);
    const r = await fetchCaptionText(url);
    if (r.valid) return { ok: true, status: r.status, text: r.text, url };
    return null;
  }

  const POT_WAIT_INTERVAL_MS = 700;
  const MAX_FETCH_ROUNDS = 16; // 配合 700ms ≈ 最多 ~11s 重试

  async function handleFetchCaptions(req) {
    const requestId = req.requestId;
    const reply = (payload) => {
      window.postMessage(
        Object.assign({ source: SOURCE, type: 'fetch-captions-result', requestId }, payload),
        location.origin
      );
    };

    try {
      // 快路径：很多视频不需要 PoToken，直接抓就成功，秒回。
      const fast = await attemptFetch(req);
      if (fast) return reply(fast);

      // 慢路径：等 player 就绪
      const player = await waitForPlayerReady(req.expectedVideoId);
      if (!player) return reply({ ok: false, status: 0, text: '', url: '', error: 'PLAYER_NOT_FOUND' });

      const playerResponse = safe(() => player.getPlayerResponse && player.getPlayerResponse());
      const videoId = playerResponse?.videoDetails?.videoId;
      if (req.expectedVideoId && videoId !== req.expectedVideoId) {
        return reply({ ok: false, status: 0, text: '', url: '', error: 'VIDEO_ID_MISMATCH' });
      }
      const track = selectTrackOnPlayer(playerResponse, req.languageCode, req.kind);
      if (!track || !track.baseUrl) {
        return reply({ ok: false, status: 0, text: '', url: '', error: 'TRACK_NOT_FOUND' });
      }

      // 触发 YouTube 自己去拉 timedtext，XHR 拦截器会截获 PoToken。
      ensureSubtitlesEnabled(player);

      // 反复尝试：每轮等 PoToken 落地（事件驱动）或固定间隔后再抓一次，
      // 直到拿到有效字幕或超时。容忍 PoToken 延迟到达与上游偶发空响应。
      for (let i = 0; i < MAX_FETCH_ROUNDS; i++) {
        await Promise.race([
          waitForTimedtextCache(videoId, POT_WAIT_INTERVAL_MS),
          delay(POT_WAIT_INTERVAL_MS),
        ]);
        const r = await attemptFetch(req);
        if (r) return reply(r);
      }

      reply({ ok: false, status: 0, text: '', url: '', error: 'NO_CAPTIONS_AFTER_RETRY' });
    } catch (err) {
      reply({ ok: false, status: 0, text: '', url: '', error: String(err) });
    }
  }

  // ── 消息分发 ─────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.source !== SOURCE) return;
    if (data.type === 'request-context') {
      replyContext(data.requestId);
      return;
    }
    if (data.type === 'fetch-captions' && data.requestId) {
      handleFetchCaptions(data);
      return;
    }
  });

  // YouTube SPA 切视频后会重新设置 ytInitialPlayerResponse。
  // 主动广播一次方便 isolated 端无需轮询。
  window.addEventListener(
    'yt-navigate-finish',
    () => {
      window.postMessage(
        { source: SOURCE, type: 'navigate', payload: { url: location.href } },
        location.origin
      );
    },
    true
  );
})();
