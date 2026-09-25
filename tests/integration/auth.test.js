import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAuthClient } from '../../extension/lib/auth.js';
import { config, fakeChrome } from '../helpers.js';

const session = { pendingRelayId: 'our-relay', relayLoginTabId: 11, relayExpiresAt: Date.now() + 300000 };
const sender = { url: 'https://lingread.app/login?relay=our-relay&client=youtube-tools', frameId: 0, tab: { id: 11 } };
function setup(initial = {}, fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'pending' }) }))) {
  vi.useFakeTimers();
  const chrome = fakeChrome(initial);
  return { chrome, fetcher, auth: createAuthClient(chrome, config, fetcher) };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('independent relay session, shared LingRead identity', () => {
  it('creates its own session without reusing another extension login tab', async () => {
    const { chrome, auth } = setup();
    chrome.tabsById.set(1, { id: 1, url: 'https://lingread.app/login?relay=lingread-relay' });
    const result = await auth.start();
    expect(result?.ok).toBe(true);
    expect(chrome.data.pendingRelayId).not.toBe('lingread-relay');
    expect(chrome.data.relayLoginTabId).not.toBe(1);
    const url = new URL(chrome.tabsById.get(chrome.data.relayLoginTabId).url);
    expect(url.origin).toBe('https://lingread.app');
    expect(url.searchParams.get('relay')).toBe(chrome.data.pendingRelayId);
    expect(url.searchParams.get('client')).toBe('youtube-tools');
    expect(chrome.tabsById.has(1)).toBe(true);
  });
  it('stores relay state before navigating to the auto-sync login page', async () => {
    const { chrome, auth } = setup();
    chrome.tabs.update.mockImplementation(async (id, opts) => {
      if (opts.url) {
        expect(chrome.data.relayLoginTabId).toBe(id);
        expect(chrome.data.pendingRelayId).toBeTruthy();
      }
      return { id, ...opts };
    });
    expect((await auth.start())?.ok).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalled();
  });
  it('coalesces concurrent starts and reuses only its own pending session', async () => {
    const { chrome, auth } = setup();
    const [a, b] = await Promise.all([auth.start(), auth.start()]);
    expect(a?.ok).toBe(true);
    expect(a?.relayId).toBe(b?.relayId);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect((await auth.start())?.relayId).toBe(a.relayId);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  });
  it('accepts a matching top-level website callback and saves shared account credentials', async () => {
    const { auth, chrome } = setup(session);
    expect(await auth.complete({ token: 'account-token', user: { id: 'user-1' } }, sender)).toEqual({ ok: true });
    expect(chrome.data.auth_token).toBe('account-token');
    expect(chrome.data.auth_user).toEqual({ id: 'user-1' });
    expect(chrome.data.pendingRelayId).toBeUndefined();
  });
  it('rejects callbacks from another client, tab, iframe or website', async () => {
    const invalidSenders = [
      { ...sender, url: 'https://lingread.app/login?relay=other' },
      { ...sender, tab: { id: 12 } },
      { ...sender, frameId: 3 },
      { ...sender, url: 'https://evil.example/login?relay=our-relay' },
      { ...sender, url: 'https://lingread.app.evil.example/login?relay=our-relay' },
    ];
    for (const candidate of invalidSenders) {
      const { auth, chrome } = setup(session);
      expect(await auth.complete({ token: 'wrong', user: { id: 'wrong' } }, candidate)).toEqual({ ok: false });
      expect(chrome.data.auth_token).toBeUndefined();
    }
  });
  it('resumes polling after worker restart and completes a server relay response', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'completed', token: 'same-user-token', user: { id: 'u1' } }) }));
    const { auth, chrome } = setup(session, fetcher);
    await auth.resume();
    expect(chrome.data.auth_token).toBe('same-user-token');
    expect(fetcher.mock.calls[0][0]).toBe('https://lingread.app/api/auth/relay/our-relay');
  });
  it('does not save stale polling results after the login tab is cancelled', async () => {
    let resolveFetch;
    const fetcher = vi.fn(() => new Promise(r => { resolveFetch = r; }));
    const { auth, chrome } = setup(session, fetcher);
    const polling = auth.poll();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await auth.cancelForTab(11);
    resolveFetch({ ok: true, json: async () => ({ status: 'completed', token: 'stale', user: {} }) });
    await polling;
    expect(chrome.data.auth_token).toBeUndefined();
    expect(chrome.data.pendingRelayId).toBeUndefined();
  });
  it('expires abandoned sessions without consuming a relay', async () => {
    const { auth, chrome, fetcher } = setup({ ...session, relayExpiresAt: Date.now() - 1 });
    await auth.resume();
    expect(chrome.data.pendingRelayId).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
