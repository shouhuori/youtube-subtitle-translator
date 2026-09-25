export async function openSharedPage(chrome, config, path = '/dashboard?tab=video') {
  try {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return { ok: false };
    const base = new URL(config.SITE_URL);
    const url = new URL(path, base);
    const allowed = url.pathname === '/dashboard' || url.pathname === '/feedback' || url.pathname.startsWith('/youtube/');
    if (url.origin !== base.origin || !allowed) return { ok: false };
    await chrome.tabs.create({ url: url.href });
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}
