// --- ЕЗИК НА САЙТА ---
// Текстовете в кода са на български. Ако браузърът е на друг език, се показват на английски (речникът е в
// i18n-en.js). I18n.t('Профил {n}', { n: 2 }) връща превода или българския текст с попълнени стойности.
// Статичният текст в HTML страниците се превежда от translateTree() преди останалите скриптове.
// За проверка: ?lang=en или ?lang=bg в адреса.
const I18n = (() => {
  const requested = new URLSearchParams(location.search).get('lang');
  const preferred = requested || navigator.languages?.[0] || navigator.language || 'en';
  const lang = /^bg\b/i.test(preferred) ? 'bg' : 'en';
  const locale = lang === 'bg' ? 'bg-BG' : 'en-GB';
  document.documentElement.lang = lang;

  const dictionary = {};

  const fill = (text, values) => (values
    ? text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    : text);

  const t = (text, values) => fill(lang === 'bg' ? text : dictionary[text] ?? text, values);

  const add = (entries) => {
    Object.assign(dictionary, entries);
  };

  // Текстови възли и атрибути, чийто текст (без интервалите около него) е ключ в речника
  const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'data-menu-title'];
  const translateTree = (root) => {
    if (lang === 'bg') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text && dictionary[text]) node.nodeValue = node.nodeValue.replace(text, dictionary[text]);
    }
    root.querySelectorAll?.('*').forEach((element) => {
      ATTRIBUTES.forEach((name) => {
        const value = element.getAttribute(name);
        if (value && dictionary[value.trim()]) element.setAttribute(name, dictionary[value.trim()]);
      });
    });
    if (root === document.body && dictionary[document.title]) document.title = dictionary[document.title];
  };

  return { lang, locale, t, add, translateTree };
})();
