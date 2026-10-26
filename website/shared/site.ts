export type Language = 'en' | 'vi';
const storageKey = 'oxygen-reference-lang';

export function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing website element: ${id}`);
  return element;
}

export function getLanguage(): Language {
  return document.documentElement.lang === 'vi' ? 'vi' : 'en';
}

export function onLanguageChange(listener: (language: Language) => void): () => void {
  const handler = (): void => listener(getLanguage());
  document.addEventListener('oxygen-language-change', handler);
  listener(getLanguage());
  return () => document.removeEventListener('oxygen-language-change', handler);
}

function applyLanguage(language: Language): void {
  document.documentElement.lang = language;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-set-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.setLang === language));
  }
  const title = language === 'vi' ? document.body.dataset.titleVi : document.body.dataset.titleEn;
  if (title) document.title = title;
  try {
    localStorage.setItem(storageKey, language);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
  document.dispatchEvent(new Event('oxygen-language-change'));
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-set-lang]')) {
  button.addEventListener('click', () => {
    const language = button.dataset.setLang;
    if (language !== 'en' && language !== 'vi') throw new RangeError('Unsupported website language');
    applyLanguage(language);
  });
}

for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-nav]')) {
  if (link.dataset.nav === document.body.dataset.page) link.setAttribute('aria-current', 'page');
}

const menuToggle = document.getElementById('site-menu-toggle');
const navigation = document.getElementById('site-navigation');
function closeNavigation(): void {
  menuToggle?.setAttribute('aria-expanded', 'false');
  navigation?.removeAttribute('data-open');
}
menuToggle?.addEventListener('click', () => {
  if (menuToggle.getAttribute('aria-expanded') === 'true') closeNavigation();
  else {
    menuToggle.setAttribute('aria-expanded', 'true');
    navigation?.setAttribute('data-open', '');
  }
});
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape' && menuToggle?.getAttribute('aria-expanded') === 'true') {
    closeNavigation();
    menuToggle.focus();
  }
});
window.matchMedia('(max-width: 760px)').addEventListener('change', closeNavigation);

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-target]')) {
  let reset: ReturnType<typeof setTimeout> | undefined;
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  if (!label) throw new Error('Missing website copy button label');
  const renderLabel = (): void => {
    const vi = getLanguage() === 'vi';
    label.textContent = button.dataset.state === 'copied' ? (vi ? 'Đã sao chép' : 'Copied')
      : button.dataset.state === 'error' ? (vi ? 'Hãy chọn đoạn mã' : 'Select code to copy') : (vi ? 'Sao chép' : 'Copy');
  };
  onLanguageChange(renderLabel);
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget ?? '');
    if (!target) throw new Error(`Missing copy source: ${button.dataset.copyTarget}`);
    clearTimeout(reset);
    try {
      if (!navigator.clipboard) throw new DOMException('Clipboard requires a secure context', 'NotAllowedError');
      await navigator.clipboard.writeText(target.textContent ?? '');
      button.dataset.state = 'copied';
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      button.dataset.state = 'error';
      console.warn('Website code could not be copied', { reason: error.name, source: target.id });
    }
    renderLabel();
    reset = setTimeout(() => { delete button.dataset.state; renderLabel(); }, 3500);
  });
}

applyLanguage(getLanguage());
