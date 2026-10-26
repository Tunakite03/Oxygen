import { describe, expect, it } from 'vitest';
import { RoundRobin, crossfadeMix } from '../src/audio/audioManager';

describe('audio helpers', () => {
  it('cycles round robins with the documented sequence', () => {
    const rr = new RoundRobin();
    rr.add('odd', 3);
    rr.add('even', 4);
    expect([1, 2, 3, 4].map(() => rr.next('odd'))).toEqual([1, 3, 2, 1]);
    expect([1, 2, 3].map(() => rr.next('even'))).toEqual([1, 3, 1]);
    expect(() => rr.next('missing')).toThrow(/has not been set up/);
    expect(() => rr.add('bad', 0)).toThrow(/positive integer/);
  });

  it('maps progress into an unclamped cross-fade position', () => {
    expect(crossfadeMix(0.25, { boundStart: -0.5, boundEnd: 0.5 })).toBeCloseTo(0.75);
    expect(crossfadeMix(2)).toBe(2);
    expect(() => crossfadeMix(0, { boundStart: 1, boundEnd: 1 })).toThrow(/end > start/);
  });
});
