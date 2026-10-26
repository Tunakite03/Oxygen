import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { QuadRenderer } from '../src/gl/fullscreen';
import { BloomPass, ColorGradePass, LensPass } from '../src/post/passes';
import { PostStack } from '../src/post/postStack';
import type { PostContext, PostPass } from '../src/post/postStack';
import { ShaderPass } from '../src/post/shaderPass';
import { TransitionPass } from '../src/post/transitionPass';

/** Records every draw: the material and the bound render target (null = canvas). */
function recordingRenderer(): { renderer: QuadRenderer; draws: { material: string; target: THREE.WebGLRenderTarget | null; inputs: unknown[] }[] } {
  let target: THREE.WebGLRenderTarget | null = null;
  const draws: { material: string; target: THREE.WebGLRenderTarget | null; inputs: unknown[] }[] = [];
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    render: (object: THREE.Object3D) => {
      const material = (object as THREE.Mesh).material as THREE.RawShaderMaterial;
      const inputs = Object.values(material.uniforms ?? {})
        .map((u) => u.value)
        .filter((v) => v instanceof THREE.Texture);
      draws.push({ material: material.name, target, inputs });
    },
  } as unknown as QuadRenderer;
  return { renderer, draws };
}

class SpyPass implements PostPass {
  enabled = true;
  size = { width: 0, height: 0 };
  calls: { input: THREE.Texture; output: THREE.WebGLRenderTarget | null }[] = [];
  constructor(readonly name: string) {}
  setSize(width: number, height: number): void {
    this.size = { width, height };
  }
  render(_c: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    this.calls.push({ input, output });
  }
  dispose(): void {}
}

describe('PostStack', () => {
  it('chains enabled passes through ping-pong targets and writes the last one to the output', () => {
    const { renderer } = recordingRenderer();
    const stack = new PostStack(renderer);
    const a = stack.add(new SpyPass('a'));
    const b = stack.add(new SpyPass('b'));
    const c = stack.add(new SpyPass('c'));
    const d = stack.add(new SpyPass('d'));
    c.enabled = false;
    stack.setSize(320.7, 200);
    expect(a.size).toEqual({ width: 320, height: 200 });
    const input = new THREE.Texture();
    stack.render(input, null);
    expect(c.calls).toHaveLength(0);
    const [ra, rb, rd] = [a.calls[0], b.calls[0], d.calls[0]];
    expect(ra?.input).toBe(input);
    expect(rb?.input).toBe(ra?.output?.texture);
    expect(rd?.input).toBe(rb?.output?.texture);
    expect(rd?.output).toBeNull();
    // No pass reads the target it writes.
    for (const call of [ra, rb, rd]) expect(call?.output?.texture).not.toBe(call?.input);
  });

  it('copies the input when every pass is disabled and rejects duplicate names', () => {
    const { renderer, draws } = recordingRenderer();
    const stack = new PostStack(renderer);
    stack.add(new SpyPass('a')).enabled = false;
    const input = new THREE.Texture();
    stack.render(input, null);
    expect(draws).toHaveLength(1);
    expect(draws[0]?.material).toBe('PostCopy');
    expect(draws[0]?.inputs).toContain(input);
    expect(() => stack.add(new SpyPass('a'))).toThrow(/already in the stack/);
  });

  it('runs bloom as prefilter, downsample chain, upsample chain and composite', () => {
    const { renderer, draws } = recordingRenderer();
    const stack = new PostStack(renderer);
    stack.add(new BloomPass({ levels: 4 }));
    stack.setSize(256, 128);
    stack.render(new THREE.Texture(), null);
    expect(draws.map((d) => d.material)).toEqual(['BloomPrefilter', 'BloomDownsample', 'BloomDownsample', 'BloomDownsample', 'BloomUpsample', 'BloomUpsample', 'BloomUpsample', 'BloomComposite']);
    expect(draws[0]?.target?.width).toBe(128);
    expect(draws[3]?.target?.width).toBe(16);
    expect(draws[7]?.target).toBeNull();
  });

  it('exposes typed uniforms on built-in passes and rebuilds the grade shader on mode changes', () => {
    const grade = new ColorGradePass({ exposure: 1, toneMapping: 'none' });
    expect(grade.exposure).toBe(1);
    expect(grade.material.fragmentShader).toContain('#define TONE_MAPPING 0');
    grade.toneMapping = 'aces';
    grade.outputSRGB = true;
    expect(grade.material.fragmentShader).toContain('#define TONE_MAPPING 2');
    expect(grade.material.fragmentShader).toContain('#define OUTPUT_SRGB 1');
    const lens = new LensPass({ vignette: 0.5 });
    lens.grain = 0.1;
    expect(lens.uniform<number>('grain').value).toBe(0.1);
    expect(lens.vignette).toBe(0.5);
    expect(() => new ShaderPass('x', 'void main(){}').uniform('missing')).toThrow(/no uniform/);
  });
});

describe('TransitionPass', () => {
  it('snapshots the next frame on capture, then plays back to the live image and disables itself', async () => {
    const { renderer, draws } = recordingRenderer();
    const pass = new TransitionPass({ effect: 'wipe' });
    const stack = new PostStack(renderer);
    stack.add(pass);
    expect(pass.enabled).toBe(false);
    const captured = pass.capture();
    expect(pass.enabled).toBe(true);
    expect(pass.progress).toBe(0);
    stack.render(new THREE.Texture(), null);
    await captured;
    expect(draws.map((d) => d.material)).toEqual(['TransitionCapture', 'Transition']);
    const { updateTweens } = await import('../src/core/tween');
    const playing = pass.play(100);
    await Promise.resolve();
    updateTweens(50);
    expect(pass.progress).toBeGreaterThan(0);
    expect(pass.progress).toBeLessThan(1);
    updateTweens(60);
    await playing;
    expect(pass.progress).toBe(1);
    expect(pass.enabled).toBe(false);
  });
});
