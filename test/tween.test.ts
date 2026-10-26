import { describe, expect, it } from 'vitest';
import { addCustomEase, getEase, tween, updateTweens } from '../src/core/tween';

const flush = (): Promise<void> => Promise.resolve();

describe('tween', () => {
  it('interpolates numeric properties and resolves its promise on completion', async () => {
    const target = { x: 0 };
    const t = tween(target, { x: 10 }, 100, 'linear');
    const done = t.promise();
    await flush();
    updateTweens(50);
    expect(target.x).toBeCloseTo(5);
    updateTweens(50);
    expect(target.x).toBe(10);
    await expect(done).resolves.toBeUndefined();
  });

  it('honours the delay before moving', async () => {
    const target = { x: 0 };
    tween(target, { x: 1 }, 100, 'linear', 50);
    await flush();
    updateTweens(50);
    expect(target.x).toBe(0);
    updateTweens(50);
    expect(target.x).toBeCloseTo(0.5);
  });

  it('replaces an earlier tween on the same object', async () => {
    const target = { x: 0, y: 0 };
    tween(target, { x: 10 }, 100, 'linear');
    await flush();
    tween(target, { y: 10 }, 100, 'linear');
    await flush();
    updateTweens(100);
    expect(target.x).toBe(0);
    expect(target.y).toBe(10);
  });

  it('keeps tweens on other properties when the object opts into multiTween', async () => {
    const target = { x: 0, y: 0, multiTween: true };
    tween(target, { x: 10 }, 100, 'linear');
    await flush();
    tween(target, { y: 10 }, 100, 'linear');
    await flush();
    updateTweens(100);
    expect(target).toMatchObject({ x: 10, y: 10 });
  });

  it('solves named cubic-bezier eases and rejects malformed curves', () => {
    addCustomEase('test-linear', 'cubic-bezier(0.25, 0.25, 0.75, 0.75)');
    expect(getEase('test-linear')(0.3)).toBeCloseTo(0.3);
    addCustomEase('test-ease', 'cubic-bezier(0.42, 0, 0.58, 1)');
    expect(getEase('test-ease')(0.5)).toBeCloseTo(0.5);
    expect(getEase('test-ease')(0.25)).toBeLessThan(0.25);
    expect(() => addCustomEase('broken', 'cubic-bezier(1, 2)')).toThrow(/Invalid cubic-bezier/);
  });
});
