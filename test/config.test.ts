import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/assets/config';
import { ConfigValueError } from '../src/core/errors';

describe('ConfigStore', () => {
  const store = ConfigStore.from({
    count: 3,
    countText: '4.5',
    position: [1, 2, 3],
    title: 'Hello',
    enabled: true,
    texture: { src: 'assets/images/a.png?v=2', extra: 1 },
    plainFile: 'assets/images/b.jpg?cache',
    'layer@one': 1,
    'layer@two': 2,
  });

  it('reads typed values and coerces numeric strings', () => {
    expect(store.number('count')).toBe(3);
    expect(store.number('countText')).toBe(4.5);
    expect(store.vec('position')).toEqual([1, 2, 3]);
    expect(store.string('title')).toBe('Hello');
    expect(store.bool('enabled')).toBe(true);
  });

  it('strips query strings from file references', () => {
    expect(store.file('texture')).toBe('assets/images/a.png');
    expect(store.file('plainFile')).toBe('assets/images/b.jpg');
  });

  it('returns undefined for missing keys and throws for wrong types', () => {
    expect(store.number('missing')).toBeUndefined();
    expect(() => store.number('title')).toThrow(ConfigValueError);
    expect(() => store.vec('title')).toThrow(/not a valid number\[\]/);
  });

  it('lists keys by prefix', () => {
    expect(store.keys('layer@')).toEqual(['layer@one', 'layer@two']);
  });

  it('rejects documents that are not objects', () => {
    expect(() => ConfigStore.from([1, 2])).toThrow();
  });
});
