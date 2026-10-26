import { afterEach, describe, expect, it } from 'vitest';
import { clamp, lerp, range, setFrameDelta } from '../src/core/math';

describe('math', () => {
  afterEach(() => setFrameDelta(1000 / 60));

  it('clamps with reversed bounds', () => {
    expect(clamp(5, 10, 0)).toBe(5);
    expect(clamp(-1, 10, 0)).toBe(0);
    expect(clamp(11, 10, 0)).toBe(10);
  });

  it('maps ranges and clamps to the output interval when asked', () => {
    expect(range(5, 0, 10, 100, 200)).toBe(150);
    expect(range(20, 0, 10, 200, 100, true)).toBe(100);
  });

  it('normalises lerp to 60 Hz frames', () => {
    setFrameDelta(1000 / 60);
    expect(lerp(10, 0, 0.5)).toBeCloseTo(5);
    // Two 120 Hz frames must cover the same distance as one 60 Hz frame.
    setFrameDelta(1000 / 120);
    const half = lerp(10, 0, 0.5);
    expect(lerp(10, half, 0.5)).toBeCloseTo(5);
  });
});
