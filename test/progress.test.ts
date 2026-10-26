import { describe, expect, it } from 'vitest';
import { createLoadProgress } from '../src/assets/progress';

describe('createLoadProgress', () => {
  it('combines weighted stages and never moves backwards', () => {
    const values: number[] = [];
    const progress = createLoadProgress({ base: 1, scenes: 3 }, (v) => values.push(v));
    progress.report('base', 1, 2);
    progress.report('scenes', 2, 4);
    progress.report('scenes', 1, 4);
    progress.report('base', 2, 2);
    progress.report('scenes', 4, 4);
    expect(values.map((v) => Number(v.toFixed(3)))).toEqual([0.125, 0.5, 0.625, 1]);
    expect(progress.value).toBe(1);
  });

  it('rejects unknown stages and invalid totals or weights', () => {
    const progress = createLoadProgress({ a: 1 }, () => {});
    expect(() => progress.report('b', 1, 1)).toThrow(/Unknown load stage/);
    expect(() => progress.report('a', 1, 0)).toThrow(/non-positive total/);
    expect(() => createLoadProgress({ a: 0 }, () => {})).toThrow(/positive weight/);
    expect(() => createLoadProgress({}, () => {})).toThrow(/at least one stage/);
  });
});
