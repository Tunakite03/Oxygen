import * as THREE from 'three';
import { tween } from '../core/tween';
import { createFullscreenMaterial } from '../gl/fullscreen';
import type { PostContext, PostPass } from './postStack';

/**
 * Screen transition between two moments of the same canvas. `capture()` snapshots the next rendered frame; after that
 * the pass blends from the snapshot to the live image as `progress` goes 0 → 1, with a fade, a directional wipe or a
 * noise dissolve with a glowing edge. Typical page transition: `await pass.capture()`, swap the scene content, then
 * `await pass.play(900)`. The pass disables itself when idle so it costs nothing between transitions.
 */
export type TransitionEffect = 'fade' | 'wipe' | 'noise';

export interface TransitionOptions {
  effect?: TransitionEffect;
  /** Width of the blend band (0..0.5). Default 0.1. */
  softness?: number;
  /** Colour added along the moving edge (wipe / noise). Default black (no glow). */
  edgeColor?: THREE.ColorRepresentation;
  /** Multiplier of `edgeColor`; above 1 the edge blooms when bloom runs after the transition. Default 1. */
  edgeIntensity?: number;
  /** Wipe direction in screen space. Default left to right. */
  direction?: THREE.Vector2Tuple;
  /** Noise feature count across the screen height. Default 4. */
  noiseScale?: number;
}

const EFFECT_IDS: Record<TransitionEffect, number> = { fade: 0, wipe: 1, noise: 2 };

const TRANSITION_FS = `uniform sampler2D tDiffuse;
uniform sampler2D tFrom;
uniform vec2 resolution;
uniform float progress;
uniform int effect;
uniform float softness;
uniform vec3 edgeColor;
uniform float edgeIntensity;
uniform vec2 direction;
uniform float noiseScale;
in vec2 vUv;
out vec4 FragColor;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += valueNoise(p) * amp;
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum / 0.9375;
}
void main() {
  vec4 from = texture(tFrom, vUv);
  vec4 to = texture(tDiffuse, vUv);
  float s = max(softness, 1e-4);
  float field = progress;
  if (effect == 1) {
    vec2 d = normalize(direction);
    field = dot(vUv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  } else if (effect == 2) {
    vec2 aspect = vec2(resolution.x / resolution.y, 1.0);
    field = fbm(vUv * aspect * noiseScale);
  }
  float m = progress;
  float edge = 0.0;
  if (effect != 0) {
    float t = progress * (1.0 + 2.0 * s) - s;
    m = 1.0 - smoothstep(t - s, t + s, field);
    edge = 1.0 - abs(m * 2.0 - 1.0);
  }
  FragColor = vec4(mix(from.rgb, to.rgb, m) + edgeColor * edgeIntensity * edge, mix(from.a, to.a, m));
}`;

export class TransitionPass implements PostPass {
  readonly name: string;
  /** Off until `capture`; turned off again when `play` finishes. */
  enabled = false;
  private readonly material: THREE.RawShaderMaterial;
  private readonly snapshot = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  private readonly copy = createFullscreenMaterial('TransitionCapture', 'uniform sampler2D tDiffuse;\nin vec2 vUv;\nout vec4 FragColor;\nvoid main() { FragColor = texture(tDiffuse, vUv); }', { tDiffuse: { value: null } });
  private captureResolvers: (() => void)[] = [];
  private playId = 0;

  constructor(options: TransitionOptions = {}, name = 'transition') {
    this.name = name;
    this.material = createFullscreenMaterial('Transition', TRANSITION_FS, {
      tDiffuse: { value: null },
      tFrom: { value: this.snapshot.texture },
      resolution: { value: new THREE.Vector2(1, 1) },
      progress: { value: 1 },
      effect: { value: EFFECT_IDS[options.effect ?? 'noise'] },
      softness: { value: options.softness ?? 0.1 },
      edgeColor: { value: new THREE.Color(options.edgeColor ?? 0x000000) },
      edgeIntensity: { value: options.edgeIntensity ?? 1 },
      direction: { value: new THREE.Vector2(...(options.direction ?? [1, 0])) },
      noiseScale: { value: options.noiseScale ?? 4 },
    });
  }

  private u<T>(name: string): THREE.IUniform<T> {
    return this.material.uniforms[name] as THREE.IUniform<T>;
  }

  /** 0 shows the snapshot, 1 the live image. */
  get progress(): number {
    return this.u<number>('progress').value;
  }
  set progress(v: number) {
    this.u<number>('progress').value = THREE.MathUtils.clamp(v, 0, 1);
  }

  set effect(effect: TransitionEffect) {
    this.u<number>('effect').value = EFFECT_IDS[effect];
  }

  get edgeColor(): THREE.Color {
    return this.u<THREE.Color>('edgeColor').value;
  }

  get edgeIntensity(): number {
    return this.u<number>('edgeIntensity').value;
  }
  set edgeIntensity(v: number) {
    this.u<number>('edgeIntensity').value = v;
  }

  get direction(): THREE.Vector2 {
    return this.u<THREE.Vector2>('direction').value;
  }

  set softness(v: number) {
    this.u<number>('softness').value = v;
  }

  set noiseScale(v: number) {
    this.u<number>('noiseScale').value = v;
  }

  /** Snapshots the next frame and holds it on screen (progress 0). Resolves once the snapshot is taken. */
  capture(): Promise<void> {
    this.enabled = true;
    this.playId++;
    this.progress = 0;
    return new Promise((resolve) => this.captureResolvers.push(resolve));
  }

  /** Animates progress to 1, then disables the pass. A newer `capture` or `play` cancels this one. */
  async play(durationMs: number, ease = 'easeInOutCubic'): Promise<void> {
    const id = ++this.playId;
    const state = { progress: this.progress };
    await tween(state, { progress: 1 }, durationMs, ease)
      .onUpdate(() => {
        if (id === this.playId) this.progress = state.progress;
      })
      .promise();
    if (id !== this.playId) return;
    this.progress = 1;
    this.enabled = false;
  }

  setSize(width: number, height: number): void {
    this.snapshot.setSize(width, height);
    this.u<THREE.Vector2>('resolution').value.set(width, height);
  }

  render(context: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    if (this.captureResolvers.length) {
      (this.copy.uniforms.tDiffuse as THREE.IUniform).value = input;
      context.quad.render(context.renderer, this.copy, this.snapshot);
      const resolvers = this.captureResolvers;
      this.captureResolvers = [];
      for (const r of resolvers) r();
    }
    this.u<THREE.Texture | null>('tDiffuse').value = input;
    context.quad.render(context.renderer, this.material, output);
  }

  dispose(): void {
    this.material.dispose();
    this.copy.dispose();
    this.snapshot.dispose();
  }
}
