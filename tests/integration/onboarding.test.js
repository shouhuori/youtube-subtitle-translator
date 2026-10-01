import fs from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { fakeChrome, config } from '../helpers.js';

function worker(initial = {}) {
 const chrome = fakeChrome(initial);
 let installed;
 const listener = { addListener() {} };
 chrome.runtime = { onMessage: listener, onInstalled: { addListener(fn) { installed = fn; } }, getURL: path => `chrome-extension://fixture/${path}` };
 chrome.alarms.onAlarm = listener; chrome.tabs.onRemoved = listener;
 chrome.webNavigation = { onCompleted: listener };
 const sandbox = { chrome, createApiProxy: () => {}, createAuthClient: () => ({ resume: async () => {} }), injectYouTubeControls: async () => {}, CONFIG: config };
 try { vm.runInNewContext(fs.readFileSync('extension/languages.js','utf8'),sandbox); } catch {}
 try { vm.runInNewContext(fs.readFileSync('extension/lib/preferences.js','utf8').replace(/^import .*;$/gm,'').replaceAll('export ',''),sandbox); } catch {}
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8').replace(/^import .*;$/gm,''),sandbox);
 return { chrome, install: async reason => { await installed({ reason }); await new Promise(resolve => setTimeout(resolve,0)); } };
}
it('defaults a fresh install to Simplified Chinese and opens the native-language setup',async () => {
 const p = worker(); await p.install('install');
 expect(p.chrome.data.nativeLanguage).toBe('zh-Hans');
 expect([...p.chrome.tabsById.values()].map(tab=>tab.url)).toContain('chrome-extension://fixture/onboarding.html');
});
it('preserves an existing native language and does not reopen setup on extension updates',async () => {
 const p = worker({ nativeLanguage: 'ja', nativeLanguageConfigured: true }); await p.install('update');
 expect(p.chrome.data.nativeLanguage).toBe('ja'); expect(p.chrome.tabsById.size).toBe(0);
});
it('gives existing users the default without opening a welcome page during updates',async () => {
 const p = worker(); await p.install('update');
 expect(p.chrome.data.nativeLanguage).toBe('zh-Hans'); expect(p.chrome.tabsById.size).toBe(0);
});
