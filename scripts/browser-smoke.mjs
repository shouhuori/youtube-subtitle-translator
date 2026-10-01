import { chromium } from 'playwright-core';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const profile = await fs.mkdtemp(path.join(tmpdir(), 'yst-browser-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    viewport: { width: 352, height: 620 },
    headless: true,
    args: [`--disable-extensions-except=${root}/dist/production`, `--load-extension=${root}/dist/production`],
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 5000 }).catch(() => null);
    console.log('Extension worker:', worker?.url() || 'not available in installed Chrome');
    if (!worker) throw new Error('Extension did not load; install Chrome for Testing with npm exec playwright-core install chromium --no-shell');
    const id = new URL(worker.url()).host;
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/onboarding.html`);
    await setup.locator('#nativeLanguage').filter({ has: setup.locator('option[value="zh-Hans"]') }).waitFor();
    if (await setup.locator('#nativeLanguage').inputValue() !== 'zh-Hans') throw new Error('Native language default is incorrect');
    await setup.locator('#nativeLanguage').selectOption('ja');
    await setup.getByRole('button', { name: '保存母语', exact: true }).click();
    await setup.getByText('已保存。字幕将翻译成你选择的母语。', { exact: true }).waitFor();
    await setup.close();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.getByText('尚未登录', { exact: true }).waitFor();
    if (await page.locator('#nativeLanguage').inputValue() !== 'ja') throw new Error('Saved native language not restored');
    await page.locator('#nativeLanguage').selectOption('en');
    await page.getByText('已保存。字幕将翻译成你选择的母语。', { exact: true }).waitFor();
    const preferences = await worker.evaluate(() => chrome.storage.local.get(['nativeLanguage', 'nativeLanguageConfigured']));
    if (preferences.nativeLanguage !== 'en' || !preferences.nativeLanguageConfigured) throw new Error('Native language changes were not persisted');
    console.log('PASS first-install language setup and later popup changes');
    await page.locator('body').screenshot({ path: `${root}/docs/popup-preview.png` });
    await page.getByRole('button', { name: '字幕翻译', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '请先打开一个 YouTube 视频' }).waitFor();
    await page.evaluate(() => chrome.storage.local.set({ auth_token: 'browser-fixture-token', auth_user: { id: 'fixture', email: 'reader@example.com' } }));
    await page.getByText('reader@example.com', { exact: true }).waitFor();
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.getByText('尚未登录', { exact: true }).waitFor();
    // Simulate the existing website's login callback at its real origin. No account
    // credentials or network requests are used for this controlled bridge test.
    await context.route('https://lingread.app/login?**', route => route.fulfill({
      contentType: 'text/html',
      body: `<html><body>Login fixture<script>window.addEventListener('DOMContentLoaded', () => {
        window.dispatchEvent(new CustomEvent('__lingread_relay_complete__', { detail: {
          token: 'fixture-relay-token', user: { id: 'fixture-relay-user', email: 'relay@example.com' }
        } }));
      });</script></body></html>`,
    }));
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText('relay@example.com', { exact: true }).waitFor();
    const loginState = await worker.evaluate(() => chrome.storage.local.get(['auth_token', 'pendingRelayId']));
    if (loginState.auth_token !== 'fixture-relay-token' || loginState.pendingRelayId) throw new Error('Relay bridge failed');
    console.log('PASS real extension relay tab, document_start callback bridge and session cleanup (simulated website response)');
    const data = await worker.evaluate(() => ({ name: chrome.runtime.getManifest().name, config: globalThis.CONFIG, token: undefined }));
    console.log(JSON.stringify({ ...data, pageErrors: errors }, null, 2));
    if (errors.length) throw new Error('Popup emitted errors');
    console.log('PASS real extension load, popup signed-out/signed-in/logout, non-YouTube guard');
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
