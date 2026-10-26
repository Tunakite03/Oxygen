import { setState } from '../core/events';
import { frame, onFrame } from '../core/loop';
import type { QualityTier } from './gpuTier';

/**
 * Quality levels with adaptive switching. Levels are ordered from cheapest to richest and carry whatever settings the
 * site needs (`dpr` is required; add bloom levels, particle counts, shadow sizes). `AdaptiveQuality` watches frame
 * times in windows and steps down after sustained slow windows, up after a longer run of fast ones, ignores
 * background-tab gaps, and locks when it starts oscillating.
 *
 * Published: state `Quality/level` (the active level object) and `Quality/index`.
 */
export interface QualityLevel {
  name: string;
  /** Pixel-ratio cap; the canvas uses min(devicePixelRatio, dpr). */
  dpr: number;
}

export interface AdaptiveOptions {
  /** Frame rate to hold. The display refresh rate caps it. Default 60. */
  targetFps?: number;
  /** Step down when a window's fps is below target × this. Default 0.85. */
  downgradeRatio?: number;
  /** Count a window as fast when its fps is at least target × this. Default 0.97. */
  upgradeRatio?: number;
  /** Window length in ms. Default 1000. */
  windowMs?: number;
  /** Consecutive slow windows before stepping down. Default 2. */
  downgradeAfter?: number;
  /** Consecutive fast windows before stepping up. Default 8. */
  upgradeAfter?: number;
  /** Direction changes allowed before the level locks. Default 3. */
  maxFlips?: number;
  /** Frames this long (ms) are treated as gaps (tab switch, GC pause) and skipped. Default 250. */
  gapMs?: number;
  /** Time after start that is not sampled (shader compiles, first uploads). Default 2000. */
  warmupMs?: number;
}

export class AdaptiveQuality {
  index: number;
  locked = false;
  private readonly options: Required<AdaptiveOptions>;
  private windowTime = 0;
  private windowFrames = 0;
  private elapsed = 0;
  private slow = 0;
  private fast = 0;
  private lastDirection = 0;
  private flips = 0;

  constructor(
    readonly levelCount: number,
    initial: number,
    options: AdaptiveOptions = {},
  ) {
    if (!(Number.isInteger(levelCount) && levelCount > 0)) throw new RangeError(`Level count must be a positive integer, got ${levelCount}`);
    this.index = Math.min(Math.max(Math.round(initial), 0), levelCount - 1);
    this.options = {
      targetFps: 60,
      downgradeRatio: 0.85,
      upgradeRatio: 0.97,
      windowMs: 1000,
      downgradeAfter: 2,
      upgradeAfter: 8,
      maxFlips: 3,
      gapMs: 250,
      warmupMs: 2000,
      ...options,
    };
  }

  /** Feeds one frame delta. Returns the new level index when it changes, otherwise null. */
  sample(deltaMs: number, refreshRate = 60): number | null {
    const o = this.options;
    if (this.locked || deltaMs <= 0 || deltaMs >= o.gapMs) return null;
    this.elapsed += deltaMs;
    if (this.elapsed < o.warmupMs) return null;
    this.windowTime += deltaMs;
    this.windowFrames++;
    if (this.windowTime < o.windowMs) return null;
    const fps = (this.windowFrames * 1000) / this.windowTime;
    this.windowTime = 0;
    this.windowFrames = 0;
    const target = Math.min(o.targetFps, refreshRate);
    if (fps < target * o.downgradeRatio) {
      this.slow++;
      this.fast = 0;
    } else if (fps >= target * o.upgradeRatio) {
      this.fast++;
      this.slow = 0;
    } else {
      this.slow = 0;
      this.fast = 0;
    }
    if (this.slow >= o.downgradeAfter && this.index > 0) return this.move(-1);
    if (this.fast >= o.upgradeAfter && this.index < this.levelCount - 1) {
      // Going back up after having come down counts as a flip; past the budget, stay on the stable lower level.
      if (this.lastDirection === -1 && this.flips + 1 >= o.maxFlips) {
        this.locked = true;
        return null;
      }
      return this.move(1);
    }
    return null;
  }

  private move(direction: -1 | 1): number {
    if (this.lastDirection !== 0 && direction !== this.lastDirection) this.flips++;
    this.lastDirection = direction;
    this.index += direction;
    this.slow = 0;
    this.fast = 0;
    return this.index;
  }
}

/** Default level index for a GPU tier, spread over the available levels. */
export function levelForTier(tier: QualityTier, levelCount: number): number {
  return Math.round((tier / 3) * (levelCount - 1));
}

/** What `QualityManager.bindPipeline` needs. */
export interface PixelRatioTarget {
  setPixelRatio(dpr: number): void;
}

export interface QualityManagerOptions<T extends QualityLevel> {
  /** Cheapest first. */
  levels: readonly T[];
  /** Starting level index, or a GPU tier to map onto the levels. */
  initial: number | { tier: QualityTier };
  /** Adaptive switching; false keeps the level fixed. Default enabled. */
  adaptive?: AdaptiveOptions | false;
}

export class QualityManager<T extends QualityLevel> {
  readonly levels: readonly T[];
  readonly adaptive: AdaptiveQuality | null;
  private _index: number;
  private readonly listeners = new Set<(level: T, index: number) => void>();
  private stopFrame: (() => void) | null = null;

  constructor(options: QualityManagerOptions<T>) {
    if (options.levels.length === 0) throw new RangeError('QualityManager needs at least one level');
    for (const l of options.levels) if (!(l.dpr > 0)) throw new RangeError(`Quality level "${l.name}" has an invalid dpr ${l.dpr}`);
    this.levels = options.levels;
    const initial = typeof options.initial === 'number' ? options.initial : levelForTier(options.initial.tier, options.levels.length);
    this._index = Math.min(Math.max(Math.round(initial), 0), options.levels.length - 1);
    this.adaptive = options.adaptive === false ? null : new AdaptiveQuality(options.levels.length, this._index, options.adaptive);
    this.publish();
  }

  get index(): number {
    return this._index;
  }

  get level(): T {
    return this.levels[this._index] as T;
  }

  /** Calls `listener` now and on every change. */
  onChange(listener: (level: T, index: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.level, this._index);
    return () => this.listeners.delete(listener);
  }

  /** Forces a level; adaptive switching stops so the choice sticks. */
  set(index: number): void {
    if (!(Number.isInteger(index) && index >= 0 && index < this.levels.length)) throw new RangeError(`Quality level index ${index} is out of range`);
    if (this.adaptive) {
      this.adaptive.locked = true;
      this.adaptive.index = index;
    }
    this.apply(index);
  }

  /** Feeds a frame delta to the adaptive controller (done automatically after `start`). */
  sample(deltaMs: number, refreshRate = 60): void {
    const next = this.adaptive?.sample(deltaMs, refreshRate);
    if (next !== null && next !== undefined) this.apply(next);
  }

  /** Samples every frame from the engine loop. */
  start(): void {
    if (this.stopFrame) return;
    this.stopFrame = onFrame((_t, delta) => this.sample(delta, 60 / frame.hzMultiplier), 'postRender');
  }

  stop(): void {
    this.stopFrame?.();
    this.stopFrame = null;
  }

  /** Keeps the target's pixel ratio at min(devicePixelRatio, level.dpr). */
  bindPipeline(target: PixelRatioTarget, maxDpr: () => number = () => window.devicePixelRatio || 1): () => void {
    return this.onChange((level) => target.setPixelRatio(Math.min(maxDpr(), level.dpr)));
  }

  private apply(index: number): void {
    if (index === this._index) return;
    this._index = index;
    this.publish();
    for (const l of [...this.listeners]) l(this.level, index);
  }

  private publish(): void {
    setState('Quality/level', this.level);
    setState('Quality/index', this._index);
  }
}

export { prefersReducedMotion } from '../accessibility/motion';
