import type * as THREE from 'three';

/**
 * Damped springs solved in closed form. A step of any length lands exactly where the continuous spring would be, so
 * motion is identical at 30, 60 or 144 Hz and never blows up on a long frame. Tune with `frequency` (oscillations
 * per second when undamped) and `damping` (ratio: < 1 bounces, 1 is the fastest settle without overshoot, > 1 is
 * sluggish).
 */
export interface SpringOptions {
  /** Natural frequency in Hz. Default 3. */
  frequency?: number;
  /** Damping ratio. Default 1 (critical). */
  damping?: number;
}

/**
 * Advances a spring whose resting point is 0 by `dt` seconds. Returns the new displacement and velocity.
 * `frequency` is in Hz, `damping` is the damping ratio.
 */
export function springStep(displacement: number, velocity: number, dt: number, frequency: number, damping: number): [number, number] {
  if (dt <= 0) return [displacement, velocity];
  const w = 2 * Math.PI * frequency;
  if (w <= 0) return [displacement + velocity * dt, velocity];
  const z = Math.max(0, damping);
  const x0 = displacement;
  const v0 = velocity;
  if (Math.abs(z - 1) < 1e-4) {
    const e = Math.exp(-w * dt);
    const c = v0 + w * x0;
    return [e * (x0 + c * dt), e * (v0 - w * c * dt)];
  }
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * dt);
    const cos = Math.cos(wd * dt);
    const sin = Math.sin(wd * dt);
    return [e * (x0 * cos + ((v0 + z * w * x0) / wd) * sin), e * (v0 * cos - ((w * w * x0 + z * w * v0) / wd) * sin)];
  }
  const s = Math.sqrt(z * z - 1);
  const r1 = -w * (z - s);
  const r2 = -w * (z + s);
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  const e1 = Math.exp(r1 * dt);
  const e2 = Math.exp(r2 * dt);
  return [c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2];
}

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  frequency: number;
  damping: number;

  constructor(value = 0, options: SpringOptions = {}) {
    this.value = value;
    this.target = value;
    this.frequency = options.frequency ?? 3;
    this.damping = options.damping ?? 1;
  }

  /** Advances by `deltaMs` and returns the new value. */
  update(deltaMs: number): number {
    const [d, v] = springStep(this.value - this.target, this.velocity, deltaMs / 1000, this.frequency, this.damping);
    this.value = this.target + d;
    this.velocity = v;
    return this.value;
  }

  /** Jumps to `value` at rest. */
  snap(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Adds an instantaneous velocity kick. */
  impulse(velocity: number): void {
    this.velocity += velocity;
  }

  settled(epsilon = 1e-4): boolean {
    return Math.abs(this.value - this.target) < epsilon && Math.abs(this.velocity) < epsilon;
  }
}

type Vec = THREE.Vector2 | THREE.Vector3;

/** A spring per component of a `Vector2` or `Vector3`. `value` is updated in place toward `target`. */
export class VectorSpring<T extends Vec> {
  readonly velocity: T;
  frequency: number;
  damping: number;

  constructor(
    readonly value: T,
    readonly target: T,
    options: SpringOptions = {},
  ) {
    this.velocity = value.clone().setScalar(0) as T;
    this.frequency = options.frequency ?? 3;
    this.damping = options.damping ?? 1;
  }

  update(deltaMs: number): T {
    const dt = deltaMs / 1000;
    const target = this.target.toArray();
    const velocity = this.velocity.toArray();
    const next = this.value.toArray().map((x, i) => springStep(x - (target[i] ?? 0), velocity[i] ?? 0, dt, this.frequency, this.damping));
    this.value.fromArray(next.map(([d], i) => (target[i] ?? 0) + d));
    this.velocity.fromArray(next.map(([, v]) => v));
    return this.value;
  }

  snap(to: T): void {
    this.value.fromArray(to.toArray());
    this.target.fromArray(to.toArray());
    this.velocity.setScalar(0);
  }

  settled(epsilon = 1e-4): boolean {
    const target = this.target.toArray();
    const offset = Math.hypot(...this.value.toArray().map((x, i) => x - (target[i] ?? 0)));
    return offset < epsilon && this.velocity.length() < epsilon;
  }
}
