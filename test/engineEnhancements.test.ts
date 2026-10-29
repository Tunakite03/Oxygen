import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  AudioVisualizer,
  PostStack,
  SplineCarousel3D,
  VideoTextureController,
  VolumetricLightPass,
  createIridescentMaterial,
} from '../src/index';

/** Mock quad renderer for post stack tests */
function createMockRenderer() {
  let target: THREE.WebGLRenderTarget | null = null;
  const draws: { material: string; target: THREE.WebGLRenderTarget | null }[] = [];
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    render: (object: THREE.Object3D) => {
      const mat = (object as THREE.Mesh).material as THREE.RawShaderMaterial;
      draws.push({ material: mat.name, target });
    },
  } as unknown as THREE.WebGLRenderer;
  return { renderer, draws };
}

describe('VolumetricLightPass', () => {
  it('initializes with default options and updates uniforms', () => {
    const pass = new VolumetricLightPass({
      lightPosition: new THREE.Vector2(0.3, 0.7),
      decay: 0.95,
      density: 0.9,
    });
    expect(pass.name).toBe('VolumetricLight');
    expect(pass.enabled).toBe(true);
    expect(pass.lightPosition.x).toBe(0.3);
    expect(pass.lightPosition.y).toBe(0.7);
    expect(pass.decay).toBe(0.95);
    expect(pass.density).toBe(0.9);

    const { renderer, draws } = createMockRenderer();
    const stack = new PostStack(renderer as any);
    stack.add(pass);
    stack.render(new THREE.Texture(), null);
    expect(draws).toHaveLength(1);
    expect(draws[0]?.material).toBe('VolumetricLight');
    pass.dispose();
  });
});

describe('AudioVisualizer', () => {
  it('computes frequency bands and updates material uniforms', () => {
    // Provide AudioContext mock in happy-dom
    const mockGain = {
      gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      disconnect: () => {},
    };
    const mockAnalyser = {
      fftSize: 128,
      smoothingTimeConstant: 0.8,
      frequencyBinCount: 64,
      getByteFrequencyData: (arr: Uint8Array) => arr.fill(128),
      getByteTimeDomainData: (arr: Uint8Array) => arr.fill(128),
      connect: () => {},
    };
    const mockCtx = {
      state: 'running',
      currentTime: 0,
      destination: {},
      createAnalyser: () => mockAnalyser,
      createGain: () => mockGain,
      createOscillator: () => ({
        type: 'sine',
        frequency: { setValueAtTime: () => {} },
        connect: () => {},
        start: () => {},
        stop: () => {},
        disconnect: () => {},
      }),
      createStereoPanner: () => ({
        pan: { setValueAtTime: () => {} },
        connect: () => {},
      }),
    };
    (globalThis as any).AudioContext = function () {
      return mockCtx;
    };

    const visualizer = new AudioVisualizer({ fftSize: 128 });
    expect(visualizer.fftSize).toBe(128);
    expect(visualizer.bass).toBe(0);
    expect(visualizer.mid).toBe(0);

    const bands = visualizer.update(16.67);
    expect(bands).toBeDefined();
    expect(bands.energy).toBeGreaterThanOrEqual(0);

    const uniforms: Record<string, THREE.IUniform> = {
      uAudioBass: { value: 0 },
      uAudioMid: { value: 0 },
      uAudioTreble: { value: 0 },
      uAudioEnergy: { value: 0 },
    };
    visualizer.updateUniforms(uniforms);
    expect(uniforms.uAudioBass!.value).toBe(visualizer.bass);

    // Test synthesizer functions
    expect(() => visualizer.playChime([440, 550], 0.2)).not.toThrow();
    visualizer.dispose();
  });
});

describe('createIridescentMaterial', () => {
  it('creates ShaderMaterial with thin-film interference uniforms', () => {
    const mat = createIridescentMaterial({
      baseColor: 0x050814,
      iridescence: 1.5,
      metalness: 0.9,
      roughness: 0.1,
    });
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect(mat.uniforms.uIridescence!.value).toBe(1.5);
    expect(mat.uniforms.uMetalness!.value).toBe(0.9);
    expect(mat.uniforms.uRoughness!.value).toBe(0.1);
    expect(mat.uniforms.uAudioBass!.value).toBe(0);
    expect(mat.vertexShader).toContain('vWorldPosition');
    expect(mat.fragmentShader).toContain('spectralPalette');
    mat.dispose();
  });
});

describe('SplineCarousel3D', () => {
  it('positions items along 3D curve with spring inertia', () => {
    const carousel = new SplineCarousel3D<string>({
      itemSpacing: 0.25,
    });
    const meshA = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const meshB = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    carousel.addItem('a', meshA, 'Project A');
    carousel.addItem('b', meshB, 'Project B');

    expect(carousel.items).toHaveLength(2);
    expect(carousel.container.children).toContain(meshA);
    expect(carousel.container.children).toContain(meshB);

    carousel.scrollBy(0.25);
    expect(carousel.targetProgress).toBe(0.25);

    carousel.update(100);
    expect(carousel.progress).toBeGreaterThan(0);

    carousel.scrollToIndex(1);
    expect(carousel.targetProgress).toBe(0.25);
    expect(carousel.activeIndex).toBe(1);

    carousel.dispose();
    expect(carousel.items).toHaveLength(0);
  });
});

describe('VideoTextureController', () => {
  it('initializes HTML5 video and THREE.VideoTexture with aspect calculations', () => {
    const ctrl = new VideoTextureController({
      src: 'blob:https://test.local/video.mp4',
      fit: 'cover',
      targetAspect: 16 / 9,
    });
    expect(ctrl.video).toBeDefined();
    expect(ctrl.texture).toBeInstanceOf(THREE.VideoTexture);
    expect(ctrl.fit).toBe('cover');
    ctrl.setMuted(true);
    expect(ctrl.video.muted).toBe(true);
    ctrl.dispose();
  });
});

describe('VolumetricLightPass samples', () => {
  it('clamps the ray sample count into 16..64 and rounds it to an integer', () => {
    const low = new VolumetricLightPass({ samples: 4 });
    const high = new VolumetricLightPass({ samples: 500 });
    const fractional = new VolumetricLightPass({ samples: 40.6 });
    expect(low.samples).toBe(16);
    expect(high.samples).toBe(64);
    expect(fractional.samples).toBe(41);
    low.dispose();
    high.dispose();
    fractional.dispose();
  });
});

describe('SplineCarousel3D.pick', () => {
  it('returns the index of the visible item under the pointer, or null on a miss', () => {
    const carousel = new SplineCarousel3D({
      curve: new THREE.LineCurve3(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)),
    });
    carousel.addItem('card', new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)), null);
    carousel.container.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();

    expect(carousel.pick(new THREE.Vector2(0, 0), camera)).toBe(0);
    expect(carousel.pick(new THREE.Vector2(0.9, 0.9), camera)).toBeNull();
    carousel.dispose();
  });
});
