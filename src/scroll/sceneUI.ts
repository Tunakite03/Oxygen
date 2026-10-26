import { onFrame } from '../core/loop';
import { scrollState } from './scrollState';
import { stage } from '../core/stage';

/**
 * The DOM section that gives a story scene its scroll height, translated with the virtual scroll,
 * firing in-view / out-view triggers from its bounding rect (scrollTriggerOffsetIn/Out are fractions of its height).
 */
export interface SceneUIOptions {
  className: string;
  html?: string;
  useScrollTrigger?: boolean;
  scrollTriggerOffsetIn?: number;
  scrollTriggerOffsetOut?: number;
  isContinuous?: boolean;
}

export class SceneUI {
  readonly element: HTMLDivElement;
  private scrollStart = 0;
  private scrollEnd = 0;
  private inView = false;
  private outView = false;
  private inBelowTrigger = false;
  private outAboveTrigger = false;
  private outBelowTrigger = false;
  onInView: (() => void) | null = null;
  onOutView: (() => void) | null = null;
  onResize: (() => void) | null = null;
  afterScroll: ((scrollY: number) => void) | null = null;
  private readonly opts: Required<Omit<SceneUIOptions, 'html'>>;

  constructor(root: HTMLElement, options: SceneUIOptions) {
    this.opts = {
      useScrollTrigger: false,
      scrollTriggerOffsetIn: 0,
      scrollTriggerOffsetOut: 0,
      isContinuous: false,
      ...options,
    };
    this.element = document.createElement('div');
    this.element.className = options.className;
    if (options.html) this.element.innerHTML = options.html;
    root.appendChild(this.element);
    if (this.opts.useScrollTrigger) {
      queueMicrotask(() => this.computeScrollBounds());
      onFrame(() => this.loop());
    }
  }

  query<T extends Element = HTMLElement>(selector: string): T {
    const el = this.element.querySelector<T>(selector);
    if (!el) throw new Error(`${this.opts.className}: missing element ${selector}`);
    return el;
  }

  queryAll<T extends Element = HTMLElement>(selector: string): T[] {
    return [...this.element.querySelectorAll<T>(selector)];
  }

  computeScrollBounds(): void {
    if (!scrollState.ready) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const top = rect.top + scrollState.y - stage.height;
    const bottom = rect.top + scrollState.y + rect.height - stage.height;
    this.scrollStart = top + this.opts.scrollTriggerOffsetIn * rect.height;
    this.scrollEnd = bottom + this.opts.scrollTriggerOffsetOut * rect.height;
  }

  private triggerInView(): void {
    if (this.inView) return;
    if (!this.inBelowTrigger) {
      this.onInView?.();
      if (!this.opts.isContinuous) this.inBelowTrigger = true;
    }
    this.inView = true;
    if (this.outView) this.outView = false;
  }

  private triggerOutAbove(): void {
    if (!this.inView) return;
    if (!this.outAboveTrigger) {
      this.onOutView?.();
      if (!this.opts.isContinuous) this.outAboveTrigger = true;
    }
    this.inView = false;
  }

  private triggerOutBelow(): void {
    if (this.outView) return;
    if (!this.outBelowTrigger) {
      this.onOutView?.();
      if (!this.opts.isContinuous) this.outBelowTrigger = true;
    }
    this.outView = true;
    if (this.inView) this.inView = false;
  }

  private loop(): void {
    if (!scrollState.ready) return;
    const y = scrollState.y;
    if (y >= this.scrollStart && y <= this.scrollEnd) this.triggerInView();
    if (y < this.scrollStart) this.triggerOutAbove();
    if (y > this.scrollEnd + 1) {
      if (!this.inBelowTrigger) this.triggerInView();
      this.triggerOutBelow();
    }
  }

  resetFlags(): void {
    this.inView = false;
  }

  /** Follows the virtual scroll with a transform (the document itself never scrolls). */
  setScroll(scrollY: number): void {
    this.element.style.transform = `translate3d(0px, ${scrollY}px, 0px)`;
    this.afterScroll?.(scrollY);
  }

  handleUIResize(): void {
    this.computeScrollBounds();
    this.onResize?.();
  }
}
