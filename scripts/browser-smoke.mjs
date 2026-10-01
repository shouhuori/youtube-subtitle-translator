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
    // Exercise the actual isolated-world UI and MAIN-world caption bridge with
    // controlled responses. Intercept worker fetch too; no paid APIs are called.
    const subtitleFixture = { task: null, items: [], requests: [] };
    await worker.evaluate(() => chrome.storage.local.set({ nativeLanguage: 'zh-Hans', youtubeSubtitleMode: 'target' }));
    // Fetch interception on the extension worker catches requests that page
    // routing cannot intercept; the production API never receives test tasks.
    const browserCdp = await context.browser().newBrowserCDPSession();
    const targets = await browserCdp.send('Target.getTargets');
    const workerTarget = targets.targetInfos.find(target => target.url === worker.url());
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: false });
    let commandId = 0;
    const pendingCommands = new Map();
    const workerCommand = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      pendingCommands.set(id, { resolve, reject });
      browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
    browserCdp.on('Target.receivedMessageFromTarget', async event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id) {
        const pending = pendingCommands.get(message.id);
        pendingCommands.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result);
        return;
      }
      if (message.method !== 'Fetch.requestPaused') return;
      const { request, requestId } = message.params;
      const parsed = new URL(request.url);
      const input = request.postData ? JSON.parse(request.postData) : {};
      subtitleFixture.requests.push({ path: parsed.pathname, method: request.method, input });
      let data;
      if (parsed.pathname === '/api/youtube/subtitle/quote') {
        data = { videoId: 'fixture-video', targetLanguage: 'zh-Hans', requiredPointCents: 125, freePointCents: 75, payablePointCents: 50, balanceCents: 100, canAfford: true, force: false, reuseTaskId: null };
      } else if (parsed.pathname === '/api/youtube/subtitle/task') {
        subtitleFixture.task = { taskId: 'fixture-task', status: 'idle', totalSegments: 2, completedSegments: 0 };
        data = subtitleFixture.task;
      } else if (parsed.pathname.endsWith('/start')) {
        subtitleFixture.task = { taskId: 'fixture-task', status: 'running', totalSegments: 2, completedSegments: 1 };
        data = subtitleFixture.task;
      } else if (parsed.pathname === '/api/youtube/subtitle/fixture-video') {
        data = { videoId: 'fixture-video', targetLanguage: 'zh-Hans', items: subtitleFixture.items, task: subtitleFixture.task, terminology: [] };
      } else if (parsed.pathname === '/api/youtube/metadata/translate') {
        data = { title: '字幕交互测试', description: '' };
      } else data = { error: `Unexpected fixture API ${parsed.pathname}` };
      await workerCommand('Fetch.fulfillRequest', { requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') });
    });
    await workerCommand('Fetch.enable', { patterns: [{ urlPattern: 'https://lingread.app/api/youtube/*', requestStage: 'Request' }] });
    await context.route('https://www.youtube.com/api/timedtext?**', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ events: [
        { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello and welcome.' }] },
        { tStartMs: 5000, dDurationMs: 5000, segs: [{ utf8: 'This is the final caption.' }] },
      ] }),
    }));
    await context.route('https://www.youtube.com/watch?v=fixture-video', route => route.fulfill({
      contentType: 'text/html', body: `<html><head><title>Subtitle fixture - YouTube</title><style>
        body{margin:0;background:#151515;color:white} #movie_player{position:relative;width:960px;height:560px;margin:32px}
        video{width:100%;height:100%;background:#222} .ytp-chrome-bottom{position:absolute;bottom:0;width:100%;height:40px}
        .ytp-right-controls{float:right;height:40px;display:flex} .ytp-subtitles-button{width:40px;background:#333;color:white}
      </style></head><body><div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video>
        <div class="ytp-chrome-bottom"><div class="ytp-right-controls"><button class="ytp-subtitles-button">CC</button></div></div></div>
        <script>
          window.ytInitialPlayerResponse={videoDetails:{videoId:'fixture-video',title:'Subtitle fixture',author:'Test',lengthSeconds:'10',defaultAudioLanguage:'en'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=fixture-video&lang=en&pot=fixture'}]}}};
          const player=document.getElementById('movie_player');player.getPlayerResponse=()=>window.ytInitialPlayerResponse;player.getPlayerState=()=>2;
          player.getAudioTrack=()=>({captionTracks:[{url:'https://www.youtube.com/api/timedtext?v=fixture-video&lang=en&pot=fixture'}]});
        </script></body></html>`,
    }));
    const video = await context.newPage();
    await video.setViewportSize({ width: 1024, height: 700 });
    video.on('pageerror', error => errors.push(error.message));
    video.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') console.log('Video console:', message.text()); });
    await video.goto('https://www.youtube.com/watch?v=fixture-video');
    await video.locator('#yst-yt-button').click();
    await video.getByRole('button', { name: '确认翻译', exact: true }).waitFor({ timeout: 10000 }).catch(async error => { console.log(await video.locator('#yst-yt-panel').innerHTML()); console.log(subtitleFixture.requests); await video.screenshot({ path: '/tmp/yst-browser-failed.png' }); throw error; });
    await video.getByText('预计扣点 1.25 点', { exact: true }).waitFor();
    const beforeConfirm = subtitleFixture.requests;
    if (beforeConfirm.some(r => r.path !== '/api/youtube/subtitle/fixture-video' && r.path !== '/api/youtube/subtitle/quote')) throw new Error('Quote triggered a model call or task creation');
    await video.screenshot({ path: `${root}/docs/subtitle-confirm-preview.png` });
    await video.getByRole('button', { name: '取消', exact: true }).click();
    await video.locator('#yst-yt-panel').waitFor({ state: 'hidden' });
    await video.locator('#yst-yt-button').click();
    await video.getByRole('button', { name: '确认翻译', exact: true }).click();
    await video.getByText('翻译中 50%', { exact: true }).waitFor();
    if (context.pages().some(p => p.url().includes('/dashboard'))) throw new Error('Dashboard opened automatically');
    await video.screenshot({ path: `${root}/docs/subtitle-progress-preview.png` });
    const started = subtitleFixture.requests.filter(r => r.path.endsWith('/start')).length;
    if (started !== 1) throw new Error('Expected one start request');
    {
      subtitleFixture.task = { ...subtitleFixture.task, status: 'completed', completedSegments: 2 };
      subtitleFixture.items = [
        { start: 0, end: 5, text: 'Hello and welcome.', translation: '你好，欢迎。' },
        { start: 5, end: 10, text: 'This is the final caption.', translation: '这是最后一条字幕。' },
      ];
    }
    await video.getByText('字幕翻译已完成', { exact: true }).waitFor({ timeout: 12000 });
    await video.getByRole('tab', { name: '仅译文', exact: true }).waitFor();
    if (await video.getByRole('tab', { name: '仅译文', exact: true }).getAttribute('aria-selected') !== 'true') throw new Error('Display preference was not retained');
    await video.locator('#yst-yt-subtitles-layer').getByText('你好，欢迎', { exact: true }).waitFor();
    await video.getByRole('tab', { name: '双语', exact: true }).click();
    await video.locator('#yst-yt-subtitles-layer').getByText('Hello and welcome.', { exact: true }).waitFor();
    await video.locator('#yst-yt-subtitles-layer').getByText('你好，欢迎', { exact: true }).waitFor();
    await video.screenshot({ path: `${root}/docs/subtitle-completed-preview.png` });
    await context.route('https://lingread.app/dashboard?**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Dashboard fixture</body></html>' }));
    const dashboardTab = context.waitForEvent('page');
    await video.getByRole('button', { name: '查看后台详情', exact: true }).click();
    const details = await dashboardTab;
    await details.waitForURL('https://lingread.app/dashboard?**');
    if (!details.url().includes('videoId=fixture-video')) throw new Error('Wrong dashboard video');
    console.log('PASS actual video entry, read-only quote, cancel, confirm once, inline progress, completed captions, display preference, bilingual mode and optional dashboard details (controlled API fixtures)');

    const data = await worker.evaluate(() => ({ name: chrome.runtime.getManifest().name, config: globalThis.CONFIG, token: undefined }));
    console.log(JSON.stringify({ ...data, pageErrors: errors }, null, 2));
    if (errors.length) throw new Error('Popup emitted errors');
    console.log('PASS real extension load, popup signed-out/signed-in/logout, non-YouTube guard');
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
