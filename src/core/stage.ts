import { UnsupportedFeatureError } from './errors';

/** Import-safe viewport snapshot. Browser listeners are installed by initializeStage(). */
export const stage = { width: typeof window === 'undefined' ? 1 : window.innerWidth, height: typeof window === 'undefined' ? 1 : window.innerHeight };
export const pointer = { x: stage.width / 2, y: stage.height / 2, down: false };
const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints;
export const device = {
  mobile: /iPhone|iPad|iPod|Android/i.test(userAgent) || (touchPoints > 1 && /Macintosh/.test(userAgent)),
  touch: (typeof window !== 'undefined' && 'ontouchstart' in window) || touchPoints > 0,
  safari: /^((?!chrome|android).)*safari/i.test(userAgent),
};

export function getDPR(): number {
  return typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
}

const resizeListeners = new Set<() => void>();
let events: AbortController | null = null;

/** Installs one shared set of viewport listeners. Call in the browser, after mounting. */
export function initializeStage(): void {
  if (typeof window === 'undefined') throw new UnsupportedFeatureError('Viewport', 'initializeStage requires a browser');
  if (events) return;
  events = new AbortController();
  const { signal } = events;
  stage.width = window.innerWidth;
  stage.height = window.innerHeight;
  window.addEventListener('resize', () => {
    stage.width = window.innerWidth;
    stage.height = window.innerHeight;
    for (const listener of resizeListeners) listener();
  }, { signal });
  const move = (event: PointerEvent): void => { pointer.x = event.clientX; pointer.y = event.clientY; };
  window.addEventListener('pointermove', move, { passive: true, signal });
  window.addEventListener('pointerdown', (event) => { pointer.down = true; move(event); }, { signal });
  const release = (): void => {
    pointer.down = false;
    if (device.mobile) { pointer.x = stage.width / 2; pointer.y = stage.height / 2; }
  };
  window.addEventListener('pointerup', release, { signal });
  window.addEventListener('pointercancel', release, { signal });
}

/** Releases shared browser listeners and subscribers when the entire application unmounts. */
export function disposeStage(): void {
  events?.abort();
  events = null;
  resizeListeners.clear();
  pointer.down = false;
}

export function onResize(listener: () => void): () => void {
  initializeStage();
  resizeListeners.add(listener);
  return () => resizeListeners.delete(listener);
}
