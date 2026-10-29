import * as THREE from 'three';
import { onLanguageChange } from '../shared/site';
import {
  PointerTracker, bindState, createPipeline, dom, emit, listen, onFrame, setMotionPreference, setRenderFunction, setState,
  startLoop, tween,
} from '@tunakite03/oxygen';

type Lang = 'en' | 'vi';
type MotionOption = 'system' | 'reduce' | 'full';

interface ReferenceMessages {
  title: string;
  notMounted: string;
  mounted: (status: string) => string;
  readout: (x: number, y: number, speed: number, taps: number, dragging: boolean) => string;
  motion: Record<MotionOption, string>;
  search: string;
  results: (count: number) => string;
  noResults: string;
  copy: string;
  copied: string;
  copyFailed: string;
  sectionLink: string;
}

const messages = {
  en: {
    title: 'API reference · Oxygen',
    notMounted: 'Not mounted.',
    mounted: (status: string) => `Mounted (${status}).`,
    readout: (x: number, y: number, speed: number, taps: number, dragging: boolean) =>
      `ndc ${x.toFixed(2)}, ${y.toFixed(2)} · speed ${speed.toFixed(0)} px/s · taps ${taps} · dragging ${dragging}`,
    motion: { system: 'System', reduce: 'Reduce', full: 'Full' } satisfies Record<MotionOption, string>,
    search: 'Search reference…',
    results: (count: number) => `${count} matching sections. Press Enter to open the first.`,
    noResults: 'No matching sections. Try an API name such as tween or createPipeline.',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy unavailable — select the code',
    sectionLink: 'Link to this section',
  },
  vi: {
    title: 'Tài liệu API · Oxygen',
    notMounted: 'Chưa gắn.',
    mounted: (status: string) => `Đã gắn (${status}).`,
    readout: (x: number, y: number, speed: number, taps: number, dragging: boolean) =>
      `ndc ${x.toFixed(2)}, ${y.toFixed(2)} · tốc độ ${speed.toFixed(0)} px/s · lần chạm ${taps} · đang kéo ${dragging}`,
    motion: { system: 'Hệ thống', reduce: 'Giảm', full: 'Đầy đủ' } satisfies Record<MotionOption, string>,
    search: 'Tìm mục hoặc API…',
    results: (count: number) => `${count} mục phù hợp. Nhấn Enter để mở mục đầu tiên.`,
    noResults: 'Không tìm thấy mục phù hợp. Thử tên API như tween hoặc createPipeline.',
    copy: 'Sao chép',
    copied: 'Đã sao chép',
    copyFailed: 'Không thể sao chép — hãy chọn đoạn mã',
    sectionLink: 'Liên kết đến mục này',
  },
} satisfies Record<Lang, ReferenceMessages>;

function isMotionOption(value: string): value is MotionOption {
  return value === 'system' || value === 'reduce' || value === 'full';
}

/** Returns the element with `id`, or throws so a missing demo node fails loudly. */
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing demo element: ${id}`);
  return found as T;
}

let lang: Lang = document.documentElement.lang === 'vi' ? 'vi' : 'en';
const motion = element<HTMLSelectElement>('motion');
const sceneStatus = element('scene-status');
let mountedStatus: string | null = null;

function renderSceneStatus(): void {
  sceneStatus.textContent = mountedStatus === null ? messages[lang].notMounted : messages[lang].mounted(mountedStatus);
}

function applyLanguage(next: Lang): void {
  lang = next;
  document.title = messages[next].title;
  for (const option of motion.options) {
    if (isMotionOption(option.value)) option.textContent = messages[next].motion[option.value];
  }
  renderSceneStatus();
  renderReferenceLanguage();
}

const navigation = element('reference-nav');
const search = element<HTMLInputElement>('reference-search');
const searchStatus = element('search-status');
const menuToggle = element<HTMLButtonElement>('menu-toggle');
const mainContent = element('main-content');
const mobileViewport = window.matchMedia('(max-width: 760px)');
const sections = Array.from(document.querySelectorAll<HTMLElement>('main > section[id]'));
const navLinks = Array.from(navigation.querySelectorAll<HTMLAnchorElement>('ol a[href^="#"]'));
const railLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.page-rail > a:not(.back-to-top)'));
const codeButtons: HTMLButtonElement[] = [];
const sectionLinks: HTMLAnchorElement[] = [];
const searchEntries = navLinks.map((link) => {
  const section = element(link.hash.slice(1));
  const exports = Array.from(section.querySelectorAll('td:first-child')).map((cell) => cell.textContent).join(' ');
  return { link, content: normalizeSearch(`${link.textContent} ${exports}`) };
});

function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/đ/g, 'd').trim();
}

function filterNavigation(): void {
  const query = normalizeSearch(search.value);
  const terms = query.split(/\s+/);
  let matches = 0;
  for (const entry of searchEntries) {
    const visible = terms.every((term) => entry.content.includes(term));
    if (entry.link.parentElement) entry.link.parentElement.hidden = !visible;
    if (visible) matches += 1;
  }
  for (const group of navigation.querySelectorAll<HTMLElement>('.nav-group')) {
    let sibling = group.nextElementSibling;
    let hasVisibleItems = false;
    while (sibling instanceof HTMLElement && !sibling.classList.contains('nav-group')) {
      if (!sibling.hidden) hasVisibleItems = true;
      sibling = sibling.nextElementSibling;
    }
    group.hidden = !hasVisibleItems;
  }
  searchStatus.hidden = query.length === 0;
  searchStatus.textContent = matches === 0 ? messages[lang].noResults : messages[lang].results(matches);
}

function closeMenu(): void {
  delete document.body.dataset.menuOpen;
  menuToggle.setAttribute('aria-expanded', 'false');
  mainContent.inert = false;
}

function openMenu(): void {
  document.body.dataset.menuOpen = '';
  menuToggle.setAttribute('aria-expanded', 'true');
  mainContent.inert = true;
}

menuToggle.addEventListener('click', () => {
  if (menuToggle.getAttribute('aria-expanded') === 'true') closeMenu();
  else openMenu();
});
mobileViewport.addEventListener('change', closeMenu);
search.addEventListener('input', filterNavigation);
search.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    const first = navLinks.find((link) => !link.parentElement?.hidden);
    if (first) {
      event.preventDefault();
      first.click();
      element(first.hash.slice(1)).querySelector('h2')?.focus({ preventScroll: true });
    }
  }
});
navigation.addEventListener('click', (event: MouseEvent) => {
  if (event.target instanceof Element && event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event: KeyboardEvent) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'));
  if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (mobileViewport.matches) openMenu();
    search.focus();
  }
  if (event.key === 'Escape') {
    if (document.activeElement === search && search.value) {
      event.preventDefault();
      search.value = '';
      filterNavigation();
    } else if (document.body.hasAttribute('data-menu-open')) {
      closeMenu();
      menuToggle.focus();
    } else if (document.activeElement === search) search.blur();
  }
});

function updateActiveSection(): void {
  let active = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= (mobileViewport.matches ? 140 : 115)) active = section;
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) active = sections.at(-1);
  if (!active) return;
  for (const link of navLinks) {
    if (link.hash === `#${active.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  let activeRail = railLinks[0];
  const activeIndex = sections.indexOf(active);
  for (const link of railLinks) {
    const index = sections.findIndex((section) => `#${section.id}` === link.hash);
    if (index <= activeIndex) activeRail = link;
  }
  for (const link of railLinks) {
    if (link === activeRail) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

let scrollPending = false;
function scheduleActiveSection(): void {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    updateActiveSection();
    scrollPending = false;
  });
}
window.addEventListener('scroll', scheduleActiveSection, { passive: true });
window.addEventListener('resize', scheduleActiveSection, { passive: true });

for (const section of sections) {
  const heading = section.querySelector('h2');
  if (!heading) throw new Error(`Missing reference heading: ${section.id}`);
  heading.tabIndex = -1;
  const anchor = document.createElement('a');
  anchor.className = 'section-anchor';
  anchor.href = `#${section.id}`;
  anchor.textContent = '#';
  heading.append(anchor);
  sectionLinks.push(anchor);
}

function highlightCode(code: HTMLElement, source: string): void {
  const tokens = /(?<comment>\/\/[^\n]*|^\s*#[^\n]*)|(?<string>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:import|from|const|let|new|await|void|return|true|false|null|undefined|if|else|function|async|type)\b)|(?<number>\b\d+(?:\.\d+)?\b)|(?<function>\b[A-Za-z_$][\w$]*(?=\())/gm;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    fragment.append(source.slice(cursor, match.index));
    const token = document.createElement('span');
    const kind = Object.entries(match.groups ?? {}).find(([, value]) => value !== undefined)?.[0];
    token.className = `token-${kind}`;
    token.textContent = match[0];
    fragment.append(token);
    cursor = match.index + match[0].length;
  }
  fragment.append(source.slice(cursor));
  code.replaceChildren(fragment);
}

function renderCopyButton(button: HTMLButtonElement): void {
  const label = button.querySelector('span');
  if (!label) throw new Error('Missing copy button label in reference code toolbar');
  label.textContent = button.dataset.state === 'copied' ? messages[lang].copied
    : button.dataset.state === 'error' ? messages[lang].copyFailed : messages[lang].copy;
}

for (const table of document.querySelectorAll<HTMLTableElement>('main table')) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll';
  table.before(wrapper);
  wrapper.append(table);
}

for (const pre of document.querySelectorAll<HTMLPreElement>('main pre')) {
  const code = pre.querySelector('code');
  if (!code) throw new Error('Missing code element in reference example');
  const source = code.textContent ?? '';
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  const toolbar = document.createElement('div');
  toolbar.className = 'code-toolbar';
  const language = document.createElement('span');
  language.className = 'code-language';
  language.textContent = source.startsWith('npm ') ? 'Terminal' : 'TypeScript';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-code';
  copy.setAttribute('aria-live', 'polite');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 5V2h8v9h-3M2 5h9v9H2z');
  icon.append(path);
  copy.append(icon, document.createElement('span'));
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    try {
      if (!navigator.clipboard) throw new DOMException('Clipboard requires a secure browser context', 'NotAllowedError');
      await navigator.clipboard.writeText(source);
      copy.dataset.state = 'copied';
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      copy.dataset.state = 'error';
      console.warn('Reference code could not be copied', { reason: error.name, section: pre.closest('section')?.id });
    }
    renderCopyButton(copy);
    resetTimer = setTimeout(() => {
      delete copy.dataset.state;
      renderCopyButton(copy);
    }, 3500);
  });
  toolbar.append(language, copy);
  pre.before(wrapper);
  wrapper.append(toolbar, pre);
  codeButtons.push(copy);
  highlightCode(code, source);
}

function renderReferenceLanguage(): void {
  search.placeholder = messages[lang].search;
  search.setAttribute('aria-label', messages[lang].search.replace('…', ''));
  for (const copy of codeButtons) renderCopyButton(copy);
  for (const anchor of sectionLinks) anchor.setAttribute('aria-label', messages[lang].sectionLink);
  filterNavigation();
  scheduleActiveSection();
}

startLoop();

// Tweens and DOM tweens: the card moves with the DOM helper, the bar with a numeric tween on a plain object.
const card = element<HTMLDivElement>('tween-card');
const bar = element<HTMLDivElement>('tween-bar');
const meter = { value: 0 };
let open = false;
motion.addEventListener('change', () => {
  if (isMotionOption(motion.value)) setMotionPreference(motion.value);
});
element<HTMLButtonElement>('tween-toggle').addEventListener('click', () => {
  open = !open;
  void dom(card).tween({ x: open ? 160 : 0, opacity: open ? 0.6 : 1 }, 600, 'easeOutBack');
  tween(meter, { value: open ? 1 : 0 }, 900, 'easeInOutCubic').onUpdate(() => {
    bar.style.transform = `scaleX(${meter.value})`;
  });
});

// Events and state: a bus counter and a bound slider value.
let pings = 0;
const pingCount = element('ping-count');
listen<number>('Demo/ping', (count) => {
  pingCount.textContent = String(count);
});
element<HTMLButtonElement>('ping').addEventListener('click', () => {
  pings += 1;
  emit('Demo/ping', pings);
});

const gain = element<HTMLInputElement>('gain');
const gainValue = element('gain-value');
setState('demo.gain', Number(gain.value));
bindState<number>('demo.gain', (value) => {
  gainValue.textContent = value.toFixed(2);
});
gain.addEventListener('input', () => setState('demo.gain', Number(gain.value)));

// Pointer input: the tracker follows the pad; the dot eases toward the smoothed position each frame.
const pad = element<HTMLDivElement>('pointer-pad');
const dot = element<HTMLDivElement>('pointer-dot');
const readout = element('pointer-readout');
const tracker = new PointerTracker(pad);
let taps = 0;
tracker.on('tap', () => {
  taps += 1;
});
onFrame((_time, delta) => {
  tracker.update(delta);
  dot.style.transform = `translate(${tracker.smoothed.x}px, ${tracker.smoothed.y}px)`;
  readout.textContent = messages[lang].readout(
    tracker.ndc.x,
    tracker.ndc.y,
    tracker.speed,
    taps,
    tracker.drag.active,
  );
});

// Render pipeline: mount an embedded pipeline on demand and release every resource on unmount.
const host = element<HTMLDivElement>('scene-host');
let teardown: (() => void) | null = null;

function unmount(): void {
  teardown?.();
  teardown = null;
  mountedStatus = null;
  renderSceneStatus();
}

function mount(): void {
  unmount();
  const pipeline = createPipeline(host, { sizeMode: 'container', clearColor: '#14161c' });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 4;
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.25, 160, 20), new THREE.MeshNormalMaterial());
  pipeline.scene.add(knot);
  void pipeline.warmUp(camera);

  const offFrame = onFrame((_time, delta) => {
    knot.rotation.y += delta * 0.001;
  });
  const offRender = setRenderFunction(() => {
    camera.aspect = pipeline.size.width / pipeline.size.height;
    camera.updateProjectionMatrix();
    pipeline.render(camera);
  });
  teardown = () => {
    offFrame();
    offRender();
    pipeline.dispose();
    knot.geometry.dispose();
    (knot.material as THREE.Material).dispose();
  };
  mountedStatus = pipeline.status;
  renderSceneStatus();
}

element<HTMLButtonElement>('mount').addEventListener('click', mount);
element<HTMLButtonElement>('unmount').addEventListener('click', unmount);
window.addEventListener('pagehide', unmount, { once: true });

onLanguageChange(applyLanguage);
unmount();
