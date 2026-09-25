import { it, expect, vi } from 'vitest';
import { openSharedPage } from '../../extension/lib/navigation.js';
import { fakeChrome, config } from '../helpers.js';

it('opens video library and transcript routes on the shared website', async () => {
  const chrome = fakeChrome();
  await openSharedPage(chrome, config, '/dashboard?tab=video');
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://lingread.app/dashboard?tab=video' });
  await openSharedPage(chrome, config, '/youtube/abc/transcript?generate=1#ctx=test');
  expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://lingread.app/youtube/abc/transcript?generate=1#ctx=test' });
});

it('rejects external, malformed and unrelated navigation targets', async () => {
  const chrome = fakeChrome();
  for (const path of ['//evil.example', '/\\evil.example', '/admin', '/dashboard/../../admin', 'https://evil.example']) {
    expect((await openSharedPage(chrome, config, path))?.ok).toBe(false);
  }
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});
