// The website dispatches this existing event after validating its LingRead login.
// Background independently verifies origin, frame, tab and the pending relay.
(function () {
  if (window.__YST_AUTH_BRIDGE__) return;
  window.__YST_AUTH_BRIDGE__ = true;
  window.addEventListener('__lingread_relay_complete__', event => {
    const url = new URL(location.href);
    if (url.origin !== new URL(window.APP_CONFIG.SITE_URL).origin
      || url.pathname !== '/login' || url.searchParams.get('client') !== 'youtube-tools') return;
    const detail = event.detail;
    if (!detail || typeof detail.token !== 'string' || !detail.user) return;
    chrome.runtime.sendMessage({
      action: 'auth:relayComplete', token: detail.token, user: detail.user,
    }).catch(() => {});
  });
})();
