import { describe, expect, it } from 'vitest';
import { bindState, emit, listen, requireState, setState, whenState } from '../src/core/events';

describe('events and state', () => {
  it('delivers events until the listener is removed', () => {
    const seen: number[] = [];
    const off = listen<number>('test/event', (v) => seen.push(v));
    emit('test/event', 1);
    off();
    emit('test/event', 2);
    expect(seen).toEqual([1]);
  });

  it('binds to the current value and to changes only', () => {
    setState('test/bound', 1);
    const seen: number[] = [];
    bindState<number>('test/bound', (v) => seen.push(v));
    setState('test/bound', 1);
    setState('test/bound', 2);
    expect(seen).toEqual([1, 2]);
  });

  it('resolves whenState once a value arrives and rejects reads of unset state', async () => {
    const pending = whenState<string>('test/later');
    expect(() => requireState('test/later')).toThrow(/read before it was set/);
    setState('test/later', 'ready');
    await expect(pending).resolves.toBe('ready');
  });
});
