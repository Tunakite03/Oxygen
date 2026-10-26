import { describe, expect, it } from 'vitest';
import { getState } from '../src/core/events';
import { classifyGPU } from '../src/quality/gpuTier';
import { AdaptiveQuality, QualityManager, levelForTier } from '../src/quality/qualityManager';

describe('GPU tiers', () => {
  const desktop = { mobile: false };
  const mobile = { mobile: true };
  it.each([
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', desktop, 0],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', desktop, 0],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', desktop, 3],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', desktop, 3],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', desktop, 3],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', desktop, 2],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', desktop, 1],
    ['Apple GPU', mobile, 2],
    ['Adreno (TM) 740', mobile, 2],
    ['Mali-G78 MP14', mobile, 2],
    ['Adreno (TM) 610', mobile, 1],
    ['Mali-G52', mobile, 1],
  ] as const)('%s → tier %i', (renderer, hints, tier) => {
    expect(classifyGPU(renderer, hints).tier).toBe(tier);
  });

  it('drops a tier on constrained devices and handles unknown strings', () => {
    expect(classifyGPU('Adreno (TM) 740', { mobile: true, deviceMemory: 2 }).tier).toBe(1);
    expect(classifyGPU('Some New GPU', { mobile: false }).tier).toBe(2);
    expect(classifyGPU('', { mobile: false })).toEqual({ tier: 1, reason: 'unknown renderer' });
  });

  it('spreads tiers over the levels', () => {
    expect([0, 1, 2, 3].map((t) => levelForTier(t as 0 | 1 | 2 | 3, 4))).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((t) => levelForTier(t as 0 | 1 | 2 | 3, 3))).toEqual([0, 1, 1, 2]);
  });
});

const run = (q: AdaptiveQuality, fps: number, seconds: number): (number | null)[] => {
  const changes: (number | null)[] = [];
  const frames = Math.round(fps * seconds);
  for (let i = 0; i < frames; i++) {
    const next = q.sample(1000 / fps);
    if (next !== null) changes.push(next);
  }
  return changes;
};

describe('AdaptiveQuality', () => {
  it('skips the warm-up, then steps down after two slow windows', () => {
    const q = new AdaptiveQuality(3, 2, { warmupMs: 1000 });
    expect(run(q, 30, 1)).toEqual([]);
    expect(run(q, 30, 2.1)).toEqual([1]);
    expect(run(q, 30, 2.1)).toEqual([0]);
    expect(run(q, 30, 5)).toEqual([]);
  });

  it('steps up only after a long fast run', () => {
    const q = new AdaptiveQuality(3, 0, { warmupMs: 0 });
    expect(run(q, 60, 7.5)).toEqual([]);
    expect(run(q, 60, 1)).toEqual([1]);
  });

  it('ignores long gaps and holds steady inside the tolerance band', () => {
    const q = new AdaptiveQuality(3, 1, { warmupMs: 0 });
    for (let i = 0; i < 20; i++) expect(q.sample(1000)).toBeNull();
    expect(run(q, 54, 20)).toEqual([]);
  });

  it('locks on the lower level once it starts oscillating', () => {
    const q = new AdaptiveQuality(3, 1, { warmupMs: 0, upgradeAfter: 2, maxFlips: 2 });
    expect(run(q, 60, 2.1)).toEqual([2]);
    expect(run(q, 30, 2.1)).toEqual([1]);
    expect(run(q, 60, 5)).toEqual([]);
    expect(q.locked).toBe(true);
    expect(q.index).toBe(1);
  });

  it('uses the display refresh rate as the ceiling of the target', () => {
    const q = new AdaptiveQuality(2, 1, { warmupMs: 0, targetFps: 60 });
    for (let i = 0; i < 300; i++) expect(q.sample(1000 / 30, 30)).toBeNull();
  });
});

describe('QualityManager', () => {
  const levels = [
    { name: 'low', dpr: 1, bloom: false },
    { name: 'high', dpr: 2, bloom: true },
  ] as const;

  it('maps the GPU tier, publishes state and drives the pixel ratio', () => {
    const manager = new QualityManager({ levels, initial: { tier: 3 } });
    expect(manager.level.name).toBe('high');
    expect(getState('Quality/index')).toBe(1);
    const ratios: number[] = [];
    manager.bindPipeline({ setPixelRatio: (d) => ratios.push(d) }, () => 1.5);
    manager.set(0);
    expect(ratios).toEqual([1.5, 1]);
    expect(manager.adaptive?.locked).toBe(true);
    expect(getState<{ bloom: boolean }>('Quality/level')?.bloom).toBe(false);
    expect(() => manager.set(5)).toThrow(RangeError);
  });

  it('applies adaptive changes from sampled frames', () => {
    const manager = new QualityManager({ levels, initial: 1, adaptive: { warmupMs: 0 } });
    const seen: string[] = [];
    manager.onChange((l) => seen.push(l.name));
    for (let i = 0; i < 70; i++) manager.sample(1000 / 30);
    expect(seen).toEqual(['high', 'low']);
  });

  it('validates levels', () => {
    expect(() => new QualityManager({ levels: [], initial: 0 })).toThrow(RangeError);
    expect(() => new QualityManager({ levels: [{ name: 'x', dpr: 0 }], initial: 0 })).toThrow(/invalid dpr/);
  });
});
