export const RELAY_ALARM = 'youtube-tools-relay';
const SESSION_KEYS = ['pendingRelayId', 'relayLoginTabId', 'relayExpiresAt'];
const LOGIN_TTL = 5 * 60 * 1000;

export function createAuthClient(chrome, config, fetcher = fetch) {
  let startPromise = null;
  let pollPromise = null;
  let timer = null;
  const siteOrigin = new URL(config.SITE_URL).origin;
  const apiOrigin = new URL(config.API_BASE_URL).origin;
  const session = () => chrome.storage.local.get(SESSION_KEYS);

  function matchesLogin(url, state) {
    try {
      const parsed = new URL(url);
      return parsed.origin === siteOrigin && parsed.pathname === '/login'
        && parsed.searchParams.get('relay') === state.pendingRelayId
        && parsed.searchParams.get('client') === 'youtube-tools';
    } catch { return false; }
  }

  async function clearSession() {
    clearTimeout(timer);
    timer = null;
    await chrome.storage.local.remove(SESSION_KEYS);
    await chrome.alarms.clear(RELAY_ALARM);
  }

  async function finish(state, payload) {
    if (typeof payload.token !== 'string' || !payload.token || !payload.user || typeof payload.user !== 'object') return false;
    const latest = await session();
    if (!state.pendingRelayId || latest.pendingRelayId !== state.pendingRelayId || latest.relayExpiresAt <= Date.now()) return false;
    await chrome.storage.local.set({ auth_token: payload.token, auth_user: payload.user });
    await clearSession();
    // Give the website time to finish its existing relay POST before closing.
    setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(state.relayLoginTabId);
        if (matchesLogin(tab.url, state)) await chrome.tabs.remove(tab.id);
      } catch { /* Tab already closed or navigated away. */ }
    }, 700);
    return true;
  }

  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(() => { void poll(); }, 2000);
  }

  async function pollOnce() {
    const state = await session();
    if (!state.pendingRelayId) return;
    if (!state.relayExpiresAt || state.relayExpiresAt <= Date.now()) { await clearSession(); return; }
    try {
      const response = await fetcher(`${apiOrigin}/api/auth/relay/${encodeURIComponent(state.pendingRelayId)}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = await response.json();
        const latest = await session();
        if (latest.pendingRelayId !== state.pendingRelayId) return;
        if (data.status === 'completed' && await finish(state, data)) return;
        if (data.status === 'expired') { await clearSession(); return; }
      }
    } catch { /* Offline or timeout: resume within this session's TTL. */ }
    if ((await session()).pendingRelayId === state.pendingRelayId) schedulePoll();
  }

  function poll() {
    if (pollPromise) return pollPromise;
    pollPromise = pollOnce().finally(() => { pollPromise = null; });
    return pollPromise;
  }

  async function startSession() {
    const existing = await session();
    if (existing.pendingRelayId && existing.relayExpiresAt > Date.now()) {
      try {
        const tab = await chrome.tabs.get(existing.relayLoginTabId);
        if (matchesLogin(tab.pendingUrl || tab.url, existing)) {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.alarms.create(RELAY_ALARM, { periodInMinutes: 0.5 });
          schedulePoll();
          return { ok: true, reused: true, relayId: existing.pendingRelayId };
        }
      } catch { /* The old login tab no longer exists. */ }
    }
    await clearSession();
    const relayId = crypto.randomUUID();
    // Register before navigating: an already signed-in website can sync at once.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    try {
      await chrome.storage.local.set({ pendingRelayId: relayId, relayLoginTabId: tab.id, relayExpiresAt: Date.now() + LOGIN_TTL });
      await chrome.alarms.create(RELAY_ALARM, { periodInMinutes: 0.5 });
      await chrome.tabs.update(tab.id, { url: `${siteOrigin}/login?relay=${relayId}&client=youtube-tools` });
      schedulePoll();
      return { ok: true, reused: false, relayId };
    } catch (error) {
      await clearSession();
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = startSession().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function complete(payload, sender) {
    const state = await session();
    if (sender.frameId !== 0 || sender.tab?.id !== state.relayLoginTabId
      || !state.pendingRelayId || !matchesLogin(sender.url, state)) return { ok: false };
    return { ok: await finish(state, payload) };
  }

  async function resume() {
    if ((await session()).pendingRelayId) {
      await chrome.alarms.create(RELAY_ALARM, { periodInMinutes: 0.5 });
      await poll();
    }
  }

  async function cancelForTab(tabId) {
    if ((await session()).relayLoginTabId === tabId) await clearSession();
  }
  return { start, complete, poll, resume, cancelForTab };
}
