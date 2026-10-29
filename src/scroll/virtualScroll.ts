import { prefersReducedMotion } from '../accessibility/motion';
import { onFrame } from '../core/loop';
import { clamp } from '../core/math';
import { device, initializeStage, stage } from '../core/stage';
import { clearTween, tween } from '../core/tween';

/**
 * Virtual scroll: wheel / touch-drag / keyboard feed a target that `y` eases toward by
 * half the remaining distance per frame; wheel deltas get per-platform multipliers with 0.9 inertia decay.
 */
export interface ScrollOptions {
  drag: boolean;
  mouseWheel: boolean;
  limit: boolean;
  keyboard: boolean;
  scale: number;
  touchScale: number;
}

const PROHIBITED = ['prevent_interactionScroll'];
const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const os = /Mac/.test(ua) && !device.mobile ? 'mac' : /Windows/.test(ua) ? 'windows' : /Android/.test(ua) ? 'android' : 'other';
const browser = /Firefox/.test(ua) ? 'firefox' : /Edg\//.test(ua) || /Chrome/.test(ua) ? 'chrome' : /Safari/.test(ua) ? 'safari' : 'other';

function prohibitedAt(x: number, y: number): boolean {
  let el: Element | null = document.elementFromPoint(clamp(x, 0, stage.width), clamp(y, 0, stage.height));
  while (el) {
    for (const c of PROHIBITED) if (el.classList?.contains(c)) return true;
    el = el.parentElement;
  }
  return false;
}

export class VirtualScroll {
  y = 0;
  readonly max = { y: 0 };
  readonly delta = { y: 0 };
  enabled = true;
  isDragging = false;
  private readonly target = { y: 0 };
  private readonly inertia = { y: 0 };
  private isInertia = false;
  private lastDelta = 0;
  private deltaChange = 0;
  private block = false;
  private hardBlock = false;
  private lastPointerY = 0;
  private pointerDeltaY = 0;
  private mouseX = 0;
  private mouseY = 0;
  private readonly events = new AbortController();
  private readonly offFrame: () => void;

  constructor(private readonly opts: ScrollOptions) {
    initializeStage();
    const { signal } = this.events;
    window.addEventListener('pointermove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    }, { passive: true, signal });
    if (!device.mobile) {
      window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal });
      if (opts.keyboard) window.addEventListener('keydown', (e) => this.onKey(e), { signal });
    }
    if (opts.drag) {
      window.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (t && !prohibitedAt(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
      }, { passive: false, signal });
      window.addEventListener('pointerdown', (e) => this.onDown(e), { signal });
      window.addEventListener('pointermove', (e) => this.onDrag(e), { signal });
      window.addEventListener('pointerup', (e) => this.onUp(e), { signal });
      window.addEventListener('pointercancel', (e) => this.onUp(e), { signal });
    }
    this.offFrame = onFrame(() => this.loop());
  }

  destroy(): void {
    this.events.abort();
    this.offFrame();
    this.stopInertia();
    this.enabled = false;
    this.isDragging = false;
  }

  private stopInertia(): void {
    this.isInertia = false;
    clearTween(this.target);
  }

  private loop(): void {
    const reduced = prefersReducedMotion();
    if (reduced) this.isInertia = false;
    if (this.isInertia) {
      this.inertia.y *= 0.9;
      this.target.y += this.inertia.y;
    }
    const scale = this.scale;
    if (this.opts.limit) this.target.y = Math.min(Math.max(this.target.y, 0), this.max.y / scale);
    this.delta.y = this.block ? 0 : (reduced ? 1 : 0.5) * (this.target.y * scale - this.y);
    this.y += this.delta.y;
    if (Math.abs(this.delta.y) < 0.01) this.delta.y = 0;
    if (Math.abs(this.y) < 0.001) this.y = 0;
    if (this.block) {
      this.target.y = 0;
      this.delta.y = 0;
      this.y = 0;
    }
  }

  private onWheel(e: WheelEvent): void {
    if (prohibitedAt(this.mouseX, this.mouseY)) return;
    if (!this.enabled) return;
    if (this.opts.limit && e.cancelable) e.preventDefault();
    if (!this.opts.mouseWheel) return;
    this.stopInertia();
    let newDelta = 0;
    const d = e.deltaY;
    const withInertia = (v: number): void => {
      this.target.y += v;
      this.inertia.y = v;
      this.isInertia = true;
      newDelta = v;
    };
    if (os === 'mac' && browser === 'firefox') {
      if (e.deltaMode === 1) withInertia(4 * d);
      else this.target.y += d;
    } else if (os === 'mac' && (browser === 'chrome' || browser === 'safari')) withInertia(0.33 * d);
    else if (os === 'windows' && browser === 'firefox' && e.deltaMode === 1) withInertia(10 * d);
    else if (os === 'windows' && browser === 'chrome') withInertia(0.25 * d);
    else {
      this.target.y += d;
      newDelta = this.inertia.y;
    }
    newDelta = Math.abs(newDelta);
    if (newDelta !== this.lastDelta) this.deltaChange++;
    if (!this.hardBlock) {
      if (this.deltaChange > 3 ? newDelta > this.lastDelta : newDelta >= this.lastDelta) this.block = false;
    }
    this.lastDelta = newDelta;
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled || prohibitedAt(e.clientX, e.clientY)) return;
    this.stopInertia();
    this.isDragging = true;
    this.lastPointerY = e.clientY;
    this.pointerDeltaY = 0;
  }

  private onDrag(e: PointerEvent): void {
    if (!this.enabled || !this.isDragging) return;
    if (prohibitedAt(e.clientX, e.clientY)) return;
    this.pointerDeltaY = e.clientY - this.lastPointerY;
    this.lastPointerY = e.clientY;
    const newDelta = Math.abs(this.pointerDeltaY);
    if (!this.hardBlock && newDelta > this.lastDelta) this.block = false;
    this.lastDelta = newDelta;
    this.target.y -= this.pointerDeltaY;
  }

  private onUp(e: PointerEvent): void {
    if (!this.enabled || !this.isDragging) return;
    this.isDragging = false;
    if (prohibitedAt(e.clientX, e.clientY)) return;
    if (prefersReducedMotion()) { this.pointerDeltaY = 0; return; }
    const m = os === 'android' ? 35 : 25;
    tween(this.target, { y: this.target.y - this.pointerDeltaY * m }, 2500, 'easeOutQuint');
    this.pointerDeltaY = 0;
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.enabled || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.composedPath().some((target) => target instanceof Element && (
      target.matches('input, textarea, select, button, a[href], .prevent_interactionScroll') ||
      (target instanceof HTMLElement && target.isContentEditable)
    ))) return;
    let dst: number | null = null;
    switch (event.key) {
      case 'Up':
      case 'ArrowUp':
        dst = this.targetY - 150;
        break;
      case 'Down':
      case 'ArrowDown':
        dst = this.targetY + 150;
        break;
      case 'Home':
        dst = 0;
        break;
      case 'End':
        dst = this.max.y;
        break;
      case 'PageUp':
        dst = this.targetY - stage.height;
        break;
      case 'PageDown':
        dst = this.targetY + stage.height;
        break;
      case ' ':
      case 'Spacebar':
        dst = this.targetY + (event.shiftKey ? -stage.height : stage.height);
        break;
    }
    if (dst !== null) {
      event.preventDefault();
      this.scrollTo(dst, 400, 'easeOutCubic');
    }
  }

  /** Output scale for the current input mode: `y` equals the internal target times this factor. */
  private get scale(): number {
    return device.mobile ? this.opts.touchScale : this.opts.scale;
  }

  /** Eases toward `value`, in the same units as `y` and `max.y`. */
  scrollTo(value: number, time = 800, ease = 'easeInOutCubic'): void {
    tween(this.target, { y: value / this.scale }, time, ease);
  }

  /** Jumps the target to `value`, in the same units as `y` and `max.y`. */
  setTarget(value: number): void {
    this.target.y = value / this.scale;
  }

  /** Where `y` is heading, in the same units as `y` and `max.y`. */
  get targetY(): number {
    return this.target.y * this.scale;
  }

  reset(): void {
    this.target.y = 0;
    this.inertia.y = 0;
    this.stopInertia();
  }
}
