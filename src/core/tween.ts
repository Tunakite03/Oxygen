import { prefersReducedMotion, type MotionPurpose } from '../accessibility/motion';
/**
 * Numeric property tweens with Penner eases and named CSS cubic-bezier eases. A tween starts on the next microtask
 * (so `onUpdate` / `onComplete` can be chained) and replaces earlier tweens on the same object, or only those on the
 * same property set when the object opts into `multiTween`.
 */
export type EaseFn = (k: number) => number;

const Penner: Record<string, EaseFn> = {
  linear: (k) => k,
  easeInQuad: (k) => k * k,
  easeOutQuad: (k) => k * (2 - k),
  easeInOutQuad: (k) => ((k *= 2) < 1 ? 0.5 * k * k : -0.5 * (--k * (k - 2) - 1)),
  easeInCubic: (k) => k * k * k,
  easeOutCubic: (k) => --k * k * k + 1,
  easeInOutCubic: (k) => ((k *= 2) < 1 ? 0.5 * k * k * k : 0.5 * ((k -= 2) * k * k + 2)),
  easeInQuart: (k) => k * k * k * k,
  easeOutQuart: (k) => 1 - --k * k * k * k,
  easeInOutQuart: (k) => ((k *= 2) < 1 ? 0.5 * k * k * k * k : -0.5 * ((k -= 2) * k * k * k - 2)),
  easeInQuint: (k) => k * k * k * k * k,
  easeOutQuint: (k) => --k * k * k * k * k + 1,
  easeInOutQuint: (k) => ((k *= 2) < 1 ? 0.5 * k * k * k * k * k : 0.5 * ((k -= 2) * k * k * k * k + 2)),
  easeInSine: (k) => 1 - Math.cos((k * Math.PI) / 2),
  easeOutSine: (k) => Math.sin((k * Math.PI) / 2),
  easeInOutSine: (k) => 0.5 * (1 - Math.cos(Math.PI * k)),
  easeInExpo: (k) => (k === 0 ? 0 : Math.pow(1024, k - 1)),
  easeOutExpo: (k) => (k === 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  easeInOutExpo: (k) => (k === 0 ? 0 : k === 1 ? 1 : (k *= 2) < 1 ? 0.5 * Math.pow(1024, k - 1) : 0.5 * (2 - Math.pow(2, -10 * (k - 1)))),
  easeInCirc: (k) => 1 - Math.sqrt(1 - k * k),
  easeOutCirc: (k) => Math.sqrt(1 - --k * k),
  easeInOutCirc: (k) => ((k *= 2) < 1 ? -0.5 * (Math.sqrt(1 - k * k) - 1) : 0.5 * (Math.sqrt(1 - (k -= 2) * k) + 1)),
  easeInBack: (k) => k * k * (2.70158 * k - 1.70158),
  easeOutBack: (k) => --k * k * (2.70158 * k + 1.70158) + 1,
  easeInOutBack: (k) => {
    const s = 2.5949095;
    return (k *= 2) < 1 ? k * k * ((s + 1) * k - s) * 0.5 : 0.5 * ((k -= 2) * k * ((s + 1) * k + s) + 2);
  },
  easeOutElastic: (k) => {
    if (k === 0 || k === 1) return k;
    const p = 0.4;
    return Math.pow(2, -10 * k) * Math.sin(((k - p / 4) * (2 * Math.PI)) / p) + 1;
  },
  easeInElastic: (k) => {
    if (k === 0 || k === 1) return k;
    const p = 0.4;
    return -Math.pow(2, 10 * (k -= 1)) * Math.sin(((k - p / 4) * (2 * Math.PI)) / p);
  },
};

function bezierA(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1;
}
function bezierB(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1;
}
function bezierC(a1: number): number {
  return 3 * a1;
}
function calcBezier(t: number, a1: number, a2: number): number {
  return ((bezierA(a1, a2) * t + bezierB(a1, a2)) * t + bezierC(a1)) * t;
}

/** Cubic-bezier easing: 4 Newton iterations on the x curve. */
export function solveBezier(v: readonly [number, number, number, number], x: number): number {
  if (v[0] === v[1] && v[2] === v[3]) return x;
  let t = x;
  for (let i = 0; i < 4; i++) {
    const slope = 3 * bezierA(v[0], v[2]) * t * t + 2 * bezierB(v[0], v[2]) * t + bezierC(v[0]);
    if (slope === 0) break;
    t -= (calcBezier(t, v[0], v[2]) - x) / slope;
  }
  return calcBezier(t, v[1], v[3]);
}

const customEases = new Map<string, EaseFn>();

export function addCustomEase(name: string, curve: string): void {
  if (customEases.has(name)) return;
  const values = (curve.split('(')[1] ?? '')
    .replace(')', '')
    .split(',')
    .map((s) => parseFloat(s));
  if (values.length !== 4 || values.some((n) => Number.isNaN(n))) throw new Error(`Invalid cubic-bezier curve for ease "${name}": ${curve}`);
  const v = values as [number, number, number, number];
  customEases.set(name, (k) => solveBezier(v, k));
}

export function getEase(name: string): EaseFn {
  return Penner[name] ?? customEases.get(name) ?? (Penner.easeOutCubic as EaseFn);
}

/** Math.interpolate(start, end, alpha, ease). */
export function interpolate(start: number, end: number, alpha: number, ease: string): number {
  const k = getEase(ease)(alpha);
  return start + (end - start) * k;
}

type NumericProps<T> = { [K in keyof T]?: T[K] extends number ? number : never };

interface TweenTarget {
  multiTween?: boolean;
}

const active = new Set<Tween<object>>();
const byObject = new WeakMap<object, Set<Tween<object>>>();

export class Tween<T extends object> {
  readonly object: T;
  private readonly endValues: Record<string, number>;
  private readonly startValues: Record<string, number> = {};
  private readonly time: number;
  private readonly delay: number;
  private readonly ease: EaseFn;
  private readonly propKey: string;
  private elapsedMs = -1;
  private started = false;
  private paused = false;
  stopped = false;
  private updateCb: ((k: number) => void) | null = null;
  private completeCb: (() => void) | null = null;
  private resolveDone: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private settled = false;

  constructor(object: T, props: Record<string, number>, time: number, ease: string, delay: number, private readonly motion: MotionPurpose = 'decorative') {
    this.object = object;
    this.endValues = props;
    this.time = time;
    this.delay = delay;
    this.ease = getEase(ease || 'linear');
    this.propKey = Object.keys(props).sort().join(' ');
    const multi = (this.object as TweenTarget).multiTween === true;
    const existing = byObject.get(this.object);
    if (existing) {
      for (const t of existing) if (t !== this && (!multi || t.propKey === this.propKey)) t.stop();
    }
    let set = byObject.get(this.object);
    if (!set) {
      set = new Set();
      byObject.set(this.object, set);
    }
    set.add(this as Tween<object>);
    // Register immediately for cancellation; defer value capture and execution for chaining.
    queueMicrotask(() => this.start());
  }

  private start(): void {
    if (this.stopped) return;
    const obj = this.object as Record<string, unknown>;
    for (const key of Object.keys(this.endValues)) {
      const v = obj[key];
      if (typeof v === 'number') this.startValues[key] = v;
    }
    this.elapsedMs = -this.delay;
    this.started = true;
    active.add(this as Tween<object>);
  }

  /** Advances by `dt` ms; returns false once finished. */
  update(dt: number): boolean {
    if (this.stopped) return false;
    if (this.paused || !this.started) return true;
    const reduced = this.motion === 'decorative' && prefersReducedMotion();
    this.elapsedMs = reduced ? this.time : this.elapsedMs + dt;
    if (this.elapsedMs < 0) return true;
    const e = this.time <= 0 ? 1 : Math.min(this.elapsedMs / this.time, 1);
    const k = this.ease(e);
    const obj = this.object as Record<string, number>;
    for (const key of Object.keys(this.startValues)) {
      const s = this.startValues[key] as number;
      const end = this.endValues[key] as number;
      obj[key] = s + (end - s) * k;
    }
    this.updateCb?.(k);
    if (e >= 1) {
      this.settled = true;
      this.completeCb?.();
      this.resolveDone?.();
      this.clear();
      return false;
    }
    return true;
  }

  private clear(): void {
    active.delete(this as Tween<object>);
    byObject.get(this.object)?.delete(this as Tween<object>);
  }

  onUpdate(cb: (k: number) => void): this {
    this.updateCb = cb;
    return this;
  }

  onComplete(cb: () => void): this {
    this.completeCb = cb;
    return this;
  }

  promise(): Promise<void> {
    if (this.settled) return Promise.resolve();
    if (!this.donePromise) this.donePromise = new Promise<void>((resolve) => (this.resolveDone = resolve));
    return this.donePromise;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  stop(): void {
    this.stopped = true;
    this.settled = true;
    this.resolveDone?.();
    this.clear();
  }
}

export function tween<T extends object>(object: T, props: NumericProps<T> | Record<string, number>, time: number, ease = 'linear', delay = 0, motion: MotionPurpose = 'decorative'): Tween<T> {
  return new Tween(object, props as Record<string, number>, time, ease, delay, motion);
}

export function clearTween(object: object): void {
  const set = byObject.get(object);
  if (set) for (const t of [...set]) t.stop();
}

/** Called once per frame by the render loop with the frame delta in ms. */
export function updateTweens(dt: number): void {
  for (const t of [...active]) t.update(dt);
}

/** Tweens a float uniform: `uniforms[name].value`. */
export function tweenUniform(uniforms: Record<string, { value: unknown }>, name: string, value: number, time: number, ease = 'linear', delay = 0): Tween<{ value: number }> {
  const u = uniforms[name];
  if (!u || typeof u.value !== 'number') throw new Error(`Cannot tween uniform "${name}": missing or not a float`);
  return tween(u as { value: number }, { value }, time, ease, delay);
}

/** Resolves after `ms`. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves on the next animation frame. */
export function defer(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
