/** Viewport size, device flags and pointer position. */
export const stage = { width: window.innerWidth, height: window.innerHeight };

export const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2, down: false };

export const device = {
  /** Touch-first phones and tablets (iPadOS reports as Macintosh with touch points). */
  mobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)),
  touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  safari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
};

/** Device pixel ratio capped at 2. */
export function getDPR(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

type ResizeListener = () => void;
const resizeListeners = new Set<ResizeListener>();

export function onResize(listener: ResizeListener): () => void {
  resizeListeners.add(listener);
  return () => resizeListeners.delete(listener);
}

function handleResize(): void {
  stage.width = window.innerWidth;
  stage.height = window.innerHeight;
  for (const l of resizeListeners) l();
}

function handlePointer(e: PointerEvent): void {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}

window.addEventListener('resize', handleResize);
window.addEventListener('pointermove', handlePointer, { passive: true });
window.addEventListener('pointerdown', (e) => {
  pointer.down = true;
  handlePointer(e);
});
window.addEventListener('pointerup', () => {
  pointer.down = false;
  if (device.mobile) {
    pointer.x = stage.width / 2;
    pointer.y = stage.height / 2;
  }
});
