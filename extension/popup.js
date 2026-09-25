const statusEl = document.getElementById('status');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');

function showStatus(text) {
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
}

async function renderAccount() {
  const { auth_token: token, auth_user: user, pendingRelayId } = await chrome.storage.local.get(['auth_token', 'auth_user', 'pendingRelayId']);
  document.getElementById('accountLabel').textContent = token
    ? user?.email || '已登录 LingRead'
    : pendingRelayId ? '等待 LingRead 登录完成' : '尚未登录';
  loginBtn.hidden = !!token;
  logoutBtn.hidden = !token;
  loginBtn.textContent = pendingRelayId ? '继续登录' : '登录';
}

async function send(request) {
  const response = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error || '操作失败，请稍后重试。');
  return response;
}

function bind(id, action) {
  const button = document.getElementById(id);
  button.addEventListener('click', async () => {
    button.disabled = true;
    showStatus('');
    try { await action(); } catch (error) { showStatus(error.message); }
    finally { button.disabled = false; }
  });
}

bind('subtitlesBtn', async () => { await send({ action: 'youtube:openTools' }); window.close(); });
bind('transcriptBtn', async () => { await send({ action: 'youtube:transcript' }); window.close(); });
bind('loginBtn', async () => { await send({ action: 'auth:startRelay' }); await renderAccount(); });
bind('logoutBtn', async () => { await chrome.storage.local.remove(['auth_token', 'auth_user']); await renderAccount(); });
bind('libraryBtn', () => send({ action: 'nav:openHistory', path: '/dashboard?tab=video' }));
bind('feedbackBtn', () => send({ action: 'nav:openHistory', path: '/feedback' }));
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void renderAccount().catch(() => {}); });
document.getElementById('version').textContent = `v${window.APP_CONFIG.VERSION}`;
void renderAccount().catch(() => showStatus('无法读取登录状态，请重新打开插件。'));
