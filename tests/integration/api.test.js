import { describe, it, expect, vi } from 'vitest';
import { createApiProxy } from '../../extension/lib/api.js';
import { config, fakeChrome } from '../helpers.js';

function setup(response = { ok: true, status: 200, json: async () => ({ items: [] }) }) {
  const chrome = fakeChrome({ auth_token: 'shared-account-token' });
  const fetcher = vi.fn(async () => response);
  return { fetcher, proxy: createApiProxy(chrome, config, fetcher) };
}

describe('shared LingRead YouTube API', () => {
  it('sends the account token to the existing API and returns its JSON', async () => {
    const { proxy, fetcher } = setup();
    expect(await proxy({ path: '/api/youtube/subtitle/video?targetLanguage=zh-Hans' }, {}))
      .toEqual({ error: false, status: 200, data: { items: [] } });
    expect(fetcher.mock.calls[0][0]).toBe('https://lingread.app/api/youtube/subtitle/video?targetLanguage=zh-Hans');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer shared-account-token');
  });
  it('preserves the subtitle task request body', async () => {
    const { proxy, fetcher } = setup();
    const body = { videoId: 'abc', subtitles: [{ start: 0, end: 2, text: 'hello' }] };
    await proxy({ path: '/api/youtube/subtitle/task', method: 'POST', body }, {});
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(body);
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
  });
  it('returns 401 and 429 without losing the server error payload', async () => {
    for (const status of [401, 429]) {
      const { proxy } = setup({ ok: false, status, json: async () => ({ error: 'request rejected' }) });
      expect(await proxy({ path: '/api/youtube/subtitle/task' }, {}))
        .toEqual({ error: true, status, data: { error: 'request rejected' } });
    }
  });
  it('uses localhost cache in a local iframe without leaking the production token', async () => {
    const { proxy, fetcher } = setup();
    await proxy({ path: '/api/youtube/subtitle/abc' }, { tab: { url: 'http://localhost:3100/dashboard?tab=video' } });
    expect(fetcher.mock.calls[0][0]).toBe('http://localhost:4100/api/youtube/subtitle/abc');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('retains authentication for a configured development server', async () => {
    const chrome = fakeChrome({ auth_token: 'dev-token' });
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const proxy = createApiProxy(chrome, { ...config, API_BASE_URL: 'http://localhost:4100' }, fetcher);
    await proxy({ path: '/api/youtube/subtitle/abc' }, { tab: { url: 'http://localhost:3100/dashboard' } });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer dev-token');
  });
  it('rejects non-YouTube routes, traversal, external URLs and unsupported methods', async () => {
    const { proxy, fetcher } = setup();
    for (const path of ['/api/admin/users', '/api/youtube/../admin', '/api/youtube/%2e%2e/admin', '//evil.example/api/youtube/x', '/api/youtube/../../auth/me']) {
      expect((await proxy({ path }, {})).error).toBe(true);
    }
    expect((await proxy({ path: '/api/youtube/subtitle/task', method: 'DELETE' }, {})).error).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
