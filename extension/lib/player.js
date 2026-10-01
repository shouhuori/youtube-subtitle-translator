export function isYouTubePlayerUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol)
      && ['www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)
      && (url.pathname === '/watch' || url.pathname.startsWith('/embed/'));
  } catch { return false; }
}

// Manifest injection covers navigation. This handles tabs already open on install.
export async function injectYouTubeControls(chrome, tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const frameIds = (frames || []).filter(frame => isYouTubePlayerUrl(frame.url)).map(frame => frame.frameId);
  if (!frameIds.length) return;
  const bridgeStates = await chrome.scripting.executeScript({
    target: { tabId, frameIds }, world: 'MAIN', func: () => !!window.__YST_YT_BRIDGE__,
  });
  const bridgeReady = new Set(bridgeStates.filter(item => item.result).map(item => item.frameId));
  const missingBridge = frameIds.filter(id => !bridgeReady.has(id));
  if (missingBridge.length) await chrome.scripting.executeScript({
    target: { tabId, frameIds: missingBridge }, world: 'MAIN', files: ['content-youtube-bridge.js'],
  });
  const states = await chrome.scripting.executeScript({
    target: { tabId, frameIds }, func: () => !!window.__YST_YT_LOADED__ && !!window.__YST_YT_SUBTITLES__,
  });
  const ready = new Set(states.filter(item => item.result).map(item => item.frameId));
  const missing = frameIds.filter(id => !ready.has(id));
  if (missing.length) await chrome.scripting.executeScript({
    target: { tabId, frameIds: missing },
    files: ['config.js', 'languages.js', 'messages.js', 'content-youtube.js', 'content-youtube-subtitles.js'],
  });
}

export async function openPlayerAction(chrome, action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isYouTubePlayerUrl(tab.url)) return { ok: false, error: '请先打开一个 YouTube 视频，再使用此功能。' };
  try {
    await injectYouTubeControls(chrome, tab.id);
    return await chrome.tabs.sendMessage(tab.id, { action }, { frameId: 0 });
  } catch {
    return { ok: false, error: '视频页面尚未就绪，请刷新页面后重试。' };
  }
}
