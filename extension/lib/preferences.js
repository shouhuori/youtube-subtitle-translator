import '../languages.js';

export async function initializeLanguageSettings(chrome, details) {
  const { nativeLanguage, nativeLanguageConfigured } = await chrome.storage.local.get(['nativeLanguage', 'nativeLanguageConfigured']);
  const normalized = globalThis.YST_LANGUAGES.normalize(nativeLanguage);
  if (nativeLanguage !== normalized) await chrome.storage.local.set({ nativeLanguage: normalized });
  if (details.reason === 'install' && !nativeLanguageConfigured) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
}
