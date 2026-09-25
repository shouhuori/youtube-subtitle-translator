import './config.js';
import { createApiProxy } from './lib/api.js';
import { createAuthClient, RELAY_ALARM } from './lib/auth.js';
import { openSharedPage } from './lib/navigation.js';
import { injectYouTubeControls, isYouTubePlayerUrl, openPlayerAction } from './lib/player.js';

const config = globalThis.CONFIG;
const proxy = createApiProxy(chrome, config);
const auth = createAuthClient(chrome, config);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  let task;
  switch (request?.action) {
    case 'http:apiRequest': task = proxy(request, sender); break;
    case 'auth:startRelay': task = auth.start(); break;
    case 'auth:relayComplete': task = auth.complete(request, sender); break;
    case 'nav:openHistory': task = openSharedPage(chrome, config, request.path); break;
    case 'youtube:openTools':
    case 'youtube:transcript': task = openPlayerAction(chrome, request.action); break;
    default: return;
  }
  Promise.resolve(task).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RELAY_ALARM) void auth.resume().catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => { void auth.cancelForTab(tabId).catch(() => {}); });
chrome.webNavigation.onCompleted.addListener(details => {
  if (details.tabId >= 0 && isYouTubePlayerUrl(details.url)) {
    void injectYouTubeControls(chrome, details.tabId).catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab =>
    injectYouTubeControls(chrome, tab.id).catch(() => {})
  )));
});
// Evaluation runs whenever Chrome wakes this MV3 worker, not only browser startup.
void auth.resume().catch(() => {});
