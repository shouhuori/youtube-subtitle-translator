import { vi } from 'vitest';
export function fakeChrome(initial = {}) {
  const data = { ...initial };
  const tabs = new Map();
  let nextId = 10;
  return {
    data, tabsById: tabs,
    storage: { local: {
      get: vi.fn(async keys => Object.fromEntries(keys.map(k => [k, data[k]]))),
      set: vi.fn(async values => { Object.assign(data, values); }),
      remove: vi.fn(async keys => { for (const k of keys) delete data[k]; }),
    } },
    tabs: {
      create: vi.fn(async options => { const tab = { id: nextId++, ...options }; tabs.set(tab.id, tab); return tab; }),
      get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); }),
      update: vi.fn(async (id, options) => { Object.assign(tabs.get(id), options); return tabs.get(id); }),
      remove: vi.fn(async id => tabs.delete(id)),
      query: vi.fn(async () => [...tabs.values()]),
    },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
  };
}
export const config = { SITE_URL: 'https://lingread.app', API_BASE_URL: 'https://lingread.app' };
