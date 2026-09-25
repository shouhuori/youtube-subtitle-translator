// Keep the server's existing JSON protocol. No arbitrary URL proxying.
export function createApiProxy(chrome, config, fetcher = fetch) {
  return async function proxy(request, sender = {}) {
    try {
      const path = request.path;
      const method = String(request.method || 'GET').toUpperCase();
      if (typeof path !== 'string' || !path.startsWith('/api/youtube/')) {
        return { error: true, message: 'Invalid path' };
      }
      if (!['GET', 'POST'].includes(method)) return { error: true, message: 'Invalid method' };
      const configured = new URL(config.API_BASE_URL);
      let base = configured;
      // Preserve LingRead's embedded-player development behavior, without sending
      // production credentials to a different origin.
      if (sender.tab?.url) {
        const parent = new URL(sender.tab.url);
        if (parent.protocol === 'http:' && parent.port === '3100' && ['localhost', '127.0.0.1'].includes(parent.hostname)) {
          base = new URL(`http://${parent.hostname}:4100`);
        }
      }
      const url = new URL(path, base);
      if (url.origin !== base.origin || !url.pathname.startsWith('/api/youtube/') || path.includes('\\')) {
        return { error: true, message: 'Invalid path' };
      }
      const { auth_token: token } = await chrome.storage.local.get(['auth_token']);
      const headers = { Accept: 'application/json' };
      if (token && base.origin === configured.origin) headers.Authorization = `Bearer ${token}`;
      const options = { method, headers };
      if (method === 'POST' && request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      }
      const response = await fetcher(url.href, options);
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      return { error: !response.ok, status: response.status, data };
    } catch (error) {
      return { error: true, message: error.message || '网络请求失败' };
    }
  };
}
