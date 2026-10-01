(function (scope) {
  const options = Object.freeze([
    ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'],
    ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'],
    ['ar', 'العربية'], ['hi', 'हिन्दी'], ['id', 'Bahasa Indonesia'],
    ['vi', 'Tiếng Việt'], ['th', 'ไทย'],
  ].map(([code, label]) => Object.freeze({ code, label })));
  function normalize(value) {
    return options.find(option => option.code === value)?.code || 'zh-Hans';
  }
  function sameLanguage(a, b) {
    if (!a || !b || a === 'cached' || b === 'cached') return false;
    return a.toLowerCase().split('-')[0] === b.toLowerCase().split('-')[0];
  }
  // 只区分可靠的文字体系，用于发现把中文翻译轨当成日语/英语原文的旧缓存。
  function textLanguage(value) {
    const text = String(value || '');
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
    if (/\p{Script=Hangul}/u.test(text)) return 'ko';
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 12) return null;
    if ((text.match(/\p{Script=Han}/gu) || []).length > letters.length / 2) return 'zh';
    if ((text.match(/\p{Script=Latin}/gu) || []).length > letters.length / 2) return 'latin';
    return null;
  }
  scope.YST_LANGUAGES = Object.freeze({
    key: 'nativeLanguage', defaultLanguage: 'zh-Hans', options, normalize, sameLanguage, textLanguage,
    label: code => options.find(option => option.code === normalize(code)).label,
  });
})(globalThis);
