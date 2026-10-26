/** Global visual motion policy; browser APIs are only accessed on demand. */
export type MotionPreference = 'system' | 'reduce' | 'full';
export type MotionPurpose = 'decorative' | 'essential';
let preference: MotionPreference = 'system';
const listeners = new Set<(reduced: boolean) => void>();
let media: MediaQueryList | null = null;

export function prefersReducedMotion(): boolean {
  if (preference !== 'system') return preference === 'reduce';
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && (media ?? window.matchMedia('(prefers-reduced-motion: reduce)')).matches;
}

function publish(): void {
  for (const listener of listeners) listener(prefersReducedMotion());
}

export function setMotionPreference(value: MotionPreference): void {
  if (!['system', 'reduce', 'full'].includes(value)) throw new RangeError('Invalid motion preference');
  preference = value;
  publish();
}

/** Calls the listener immediately; release the returned subscription on unmount. */
export function onMotionChange(listener: (reduced: boolean) => void): () => void {
  if (!media && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', publish);
  }
  listeners.add(listener);
  listener(prefersReducedMotion());
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      media?.removeEventListener('change', publish);
      media = null;
    }
  };
}
