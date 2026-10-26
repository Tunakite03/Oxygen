import type * as THREE from 'three';

/** Scalar helpers. Lerps are normalised to 60 Hz so easing speed does not depend on the display refresh rate. */
let frameHzMultiplier = 1;

/** Called once per frame by the loop with the frame delta in ms. */
export function setFrameDelta(deltaMs: number): void {
  frameHzMultiplier = Math.min(Math.max(deltaMs, 1), 100) / (1000 / 60);
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, Math.min(min, max)), Math.max(min, max));
}

export function range(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number, isClamp = false): number {
  const v = ((value - oldMin) * (newMax - newMin)) / (oldMax - oldMin) + newMin;
  return isClamp ? clamp(v, Math.min(newMin, newMax), Math.max(newMin, newMax)) : v;
}

export function mix(a: number, b: number, alpha: number): number {
  return a * (1 - alpha) + b * alpha;
}

export function normalizeLerpAlpha(alpha: number): number {
  const t = clamp(alpha);
  return 1 - Math.exp(Math.log(1 - t) * frameHzMultiplier);
}

/** Moves `value` toward `target` by `alpha` per 60 Hz frame (note the argument order: target first). */
export function lerp(target: number, value: number, alpha: number, calcHz = true): number {
  return value + (target - value) * (calcHz ? normalizeLerpAlpha(alpha) : clamp(alpha));
}

export function lerpVec<T extends THREE.Vector2 | THREE.Vector3>(value: T, target: T, alpha: number): T {
  const a = normalizeLerpAlpha(alpha);
  value.x += (target.x - value.x) * a;
  value.y += (target.y - value.y) * a;
  if ('z' in value && 'z' in target) value.z += (target.z - value.z) * a;
  return value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export const radians = (deg: number): number => (deg * Math.PI) / 180;
