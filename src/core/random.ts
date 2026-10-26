/** Seeded pseudo-random numbers for reproducible layouts and particle seeds. */
export type RandomFn = () => number;

/** Mulberry32: a fast 32-bit generator with a full 2^32 period. Returns floats in [0, 1). */
export function createRandom(seed: number): RandomFn {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomRange(random: RandomFn, min: number, max: number): number {
  return min + (max - min) * random();
}
