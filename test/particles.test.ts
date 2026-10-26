import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createRandom } from '../src/core/random';
import { UnsupportedFeatureError } from '../src/core/errors';
import { particleTextureSize, sampleEmitter, seedParticles } from '../src/particles/gpuParticles';
import { GPUSimulation, samplerName, simulationShaderHeader, simulationTextureType } from '../src/particles/gpuSimulation';
import type { SimulationRenderer } from '../src/particles/gpuSimulation';

function stubRenderer(extensions: string[]): SimulationRenderer & { draws: { material: THREE.RawShaderMaterial; target: THREE.WebGLRenderTarget | null }[] } {
  let target: THREE.WebGLRenderTarget | null = null;
  const draws: { material: THREE.RawShaderMaterial; target: THREE.WebGLRenderTarget | null }[] = [];
  return {
    draws,
    extensions: { has: (name: string) => extensions.includes(name) },
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    render: (object: THREE.Object3D) => {
      draws.push({ material: (object as THREE.Mesh).material as THREE.RawShaderMaterial, target });
    },
  } as unknown as SimulationRenderer & { draws: { material: THREE.RawShaderMaterial; target: THREE.WebGLRenderTarget | null }[] };
}

describe('particle seeding', () => {
  it('sizes a near-square texture and rejects bad counts', () => {
    expect(particleTextureSize(1)).toEqual({ width: 1, height: 1 });
    expect(particleTextureSize(65536)).toEqual({ width: 256, height: 256 });
    expect(particleTextureSize(1000)).toEqual({ width: 32, height: 32 });
    expect(() => particleTextureSize(0)).toThrow(RangeError);
    expect(() => particleTextureSize(1.5)).toThrow(RangeError);
  });

  it('samples inside every emitter shape, reproducibly', () => {
    const random = createRandom(7);
    const p = new THREE.Vector3();
    for (let i = 0; i < 500; i++) {
      expect(sampleEmitter({ type: 'sphere', center: [1, 2, 3], radius: 2 }, random, p).distanceTo(new THREE.Vector3(1, 2, 3))).toBeLessThanOrEqual(2 + 1e-9);
      sampleEmitter({ type: 'box', center: [0, 0, 0], size: [2, 4, 6] }, random, p);
      expect(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 2 && Math.abs(p.z) <= 3).toBe(true);
    }
    expect(sampleEmitter({ type: 'point', position: [4, 5, 6] }, random).toArray()).toEqual([4, 5, 6]);
    const a = sampleEmitter({ type: 'sphere', center: [0, 0, 0], radius: 1 }, createRandom(3));
    const b = sampleEmitter({ type: 'sphere', center: [0, 0, 0], radius: 1 }, createRandom(3));
    expect(a.equals(b)).toBe(true);
  });

  it('staggers initial lives within the lifetime and leaves padding texels empty', () => {
    const { width, height } = particleTextureSize(10);
    const { position, velocity } = seedParticles(10, width, height, { emitter: { type: 'point', position: [0, 0, 0] }, lifetime: [1, 3], speed: 2 }, createRandom(1));
    expect(position).toHaveLength(width * height * 4);
    const lives = Array.from({ length: 10 }, (_, i) => position[i * 4 + 3] as number);
    for (let i = 0; i < 10; i++) {
      const total = velocity[i * 4 + 3] as number;
      expect(total).toBeGreaterThanOrEqual(1);
      expect(total).toBeLessThanOrEqual(3);
      expect(lives[i]).toBeGreaterThan(0);
      expect(lives[i]).toBeLessThanOrEqual(total);
      const speed = Math.hypot(velocity[i * 4] as number, velocity[i * 4 + 1] as number, velocity[i * 4 + 2] as number);
      expect(speed).toBeCloseTo(2, 6);
    }
    expect(new Set(lives).size).toBe(10);
    expect(position[10 * 4 + 3]).toBe(0);
  });
});

describe('GPUSimulation', () => {
  it('picks float, then half float, and fails without renderable float targets', () => {
    expect(simulationTextureType(stubRenderer(['EXT_color_buffer_float']))).toBe(THREE.FloatType);
    expect(simulationTextureType(stubRenderer(['EXT_color_buffer_half_float']))).toBe(THREE.HalfFloatType);
    expect(() => simulationTextureType(stubRenderer([]))).toThrow(UnsupportedFeatureError);
  });

  it('declares one sampler per dependency', () => {
    expect(samplerName('velocity')).toBe('tVelocity');
    const header = simulationShaderHeader(['position', 'velocity']);
    expect(header).toContain('uniform sampler2D tPosition;');
    expect(header).toContain('uniform sampler2D tVelocity;');
    expect(header).toContain('out vec4 FragColor;');
  });

  it('reads the previous state of every variable and writes the other target, then swaps', () => {
    const renderer = stubRenderer(['EXT_color_buffer_float']);
    const sim = new GPUSimulation(renderer, 4, 4);
    const pos = sim.addVariable({ name: 'position', fragmentShader: 'void main(){}', initial: new Float32Array(64), dependencies: ['position', 'velocity'] });
    const vel = sim.addVariable({ name: 'velocity', fragmentShader: 'void main(){}', initial: new Float32Array(64), dependencies: ['position', 'velocity'] });
    sim.init();
    // Each variable's initial data goes into both targets.
    expect(renderer.draws).toHaveLength(4);
    renderer.draws.length = 0;
    const before = { position: sim.texture('position'), velocity: sim.texture('velocity') };
    sim.step();
    expect(renderer.draws.map((d) => d.target)).toEqual([pos.targets[1], vel.targets[1]]);
    expect(pos.material.uniforms.tVelocity?.value).toBe(before.velocity);
    expect(vel.material.uniforms.tPosition?.value).toBe(before.position);
    expect(sim.texture('position')).toBe(pos.targets[1].texture);
    expect(() => sim.addVariable({ name: 'position', fragmentShader: '', initial: new Float32Array(64) })).toThrow(/already exists/);
    expect(() => sim.addVariable({ name: 'bad', fragmentShader: '', initial: new Float32Array(3) })).toThrow(RangeError);
  });

  it('rejects unknown dependencies at init', () => {
    const sim = new GPUSimulation(stubRenderer(['EXT_color_buffer_float']), 2, 2);
    sim.addVariable({ name: 'a', fragmentShader: '', initial: new Float32Array(16), dependencies: ['b'] });
    expect(() => sim.init()).toThrow(/unknown variable "b"/);
  });
});
