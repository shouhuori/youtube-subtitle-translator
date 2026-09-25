// Source checkout uses local LingRead; `npm run build` creates a production package.
(function (scope) {
  const DEV_MODE = true;
  const CONFIG = Object.freeze({
    SITE_URL: DEV_MODE ? 'http://localhost:3100' : 'https://lingread.app',
    API_BASE_URL: DEV_MODE ? 'http://localhost:4100' : 'https://lingread.app',
    NAME: 'YouTube Subtitle Translator, Transcript & Summary',
    VERSION: chrome.runtime.getManifest().version,
    BRAND: {
      name: 'YouTube Subtitle Translator, Transcript & Summary',
      description: '字幕翻译、视频转写与总结',
      logoUrl: chrome.runtime.getURL('icons/icon48.png'),
    },
  });
  scope.CONFIG = CONFIG;
  if (typeof window !== 'undefined') window.APP_CONFIG = CONFIG;
})(globalThis);
