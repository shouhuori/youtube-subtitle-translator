(async function () {
  const form = document.getElementById('languageForm');
  const select = document.getElementById('nativeLanguage');
  const status = document.getElementById('languageStatus');
  const languages = globalThis.YST_LANGUAGES;
  for (const language of languages.options) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    select.appendChild(option);
  }
  try {
    const saved = await chrome.storage.local.get([languages.key]);
    select.value = languages.normalize(saved[languages.key]);
  } catch {
    status.textContent = '无法读取母语设置，请重新打开插件。';
  }
  async function save() {
    try {
      await chrome.storage.local.set({ nativeLanguage: languages.normalize(select.value), nativeLanguageConfigured: true });
      status.textContent = '已保存。字幕将翻译成你选择的母语。';
      if (form.dataset.onboarding === 'true') {
        document.getElementById('continueBtn').hidden = false;
      }
    } catch {
      status.textContent = '保存失败，请重试。';
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });
  if (form.dataset.autosave === 'true') select.addEventListener('change', save);
  document.getElementById('continueBtn')?.addEventListener('click', () => window.close());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.nativeLanguage) select.value = languages.normalize(changes.nativeLanguage.newValue);
  });
})();
