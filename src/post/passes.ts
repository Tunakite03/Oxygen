import * as THREE from 'three';
import { createFullscreenMaterial } from '../gl/fullscreen';
import type { PostContext, PostPass } from './postStack';
import { ShaderPass } from './shaderPass';

/**
 * Built-in post passes: bloom (dual-filter mip chain), FXAA, colour grading with tone mapping, and a lens pass
 * (chromatic aberration, vignette, film grain).
 */

// ---------------------------------------------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------------------------------------------

export interface BloomOptions {
  /** Brightness (max channel) above which pixels bloom. Default 0.8. */
  threshold?: number;
  /** Width of the soft transition below the threshold. Default 0.3. */
  knee?: number;
  /** Strength of the bloom added to the image. Default 1. */
  intensity?: number;
  /** How much each coarser level spreads into the finer one (0..1). Larger is a wider glow. Default 0.75. */
  radius?: number;
  /** Mip levels, each half the size of the previous. Default 6. */
  levels?: number;
}

const PREFILTER_FS = `uniform sampler2D tDiffuse;
uniform vec2 texel;
uniform float threshold;
uniform float knee;
in vec2 vUv;
out vec4 FragColor;
vec3 prefilter(vec3 c) {
  float brightness = max(c.r, max(c.g, c.b));
  float soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float contribution = max(soft, brightness - threshold) / max(brightness, 1e-5);
  return c * contribution;
}
void main() {
  // 4-tap box downsample; each tap is weighted by 1 / (1 + luma) so single bright texels do not flicker.
  vec3 a = texture(tDiffuse, vUv + texel * vec2(-0.5, -0.5)).rgb;
  vec3 b = texture(tDiffuse, vUv + texel * vec2(0.5, -0.5)).rgb;
  vec3 c = texture(tDiffuse, vUv + texel * vec2(-0.5, 0.5)).rgb;
  vec3 d = texture(tDiffuse, vUv + texel * vec2(0.5, 0.5)).rgb;
  vec4 w = 1.0 / (1.0 + vec4(dot(a, vec3(0.2126, 0.7152, 0.0722)), dot(b, vec3(0.2126, 0.7152, 0.0722)), dot(c, vec3(0.2126, 0.7152, 0.0722)), dot(d, vec3(0.2126, 0.7152, 0.0722))));
  vec3 color = (a * w.x + b * w.y + c * w.z + d * w.w) / (w.x + w.y + w.z + w.w);
  FragColor = vec4(min(prefilter(color), vec3(256.0)), 1.0);
}`;

const DOWNSAMPLE_FS = `uniform sampler2D tDiffuse;
uniform vec2 texel;
in vec2 vUv;
out vec4 FragColor;
void main() {
  vec3 sum = texture(tDiffuse, vUv).rgb * 4.0;
  sum += texture(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(1.0, -1.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(-1.0, 1.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(1.0, 1.0)).rgb;
  FragColor = vec4(sum / 8.0, 1.0);
}`;

const UPSAMPLE_FS = `uniform sampler2D tDiffuse;
uniform sampler2D tCurrent;
uniform vec2 texel;
uniform float radius;
in vec2 vUv;
out vec4 FragColor;
void main() {
  // 8-tap tent of the coarser level, added onto this level.
  vec3 sum = texture(tDiffuse, vUv + texel * vec2(-2.0, 0.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(2.0, 0.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(0.0, -2.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(0.0, 2.0)).rgb;
  sum += texture(tDiffuse, vUv + texel * vec2(-1.0, -1.0)).rgb * 2.0;
  sum += texture(tDiffuse, vUv + texel * vec2(1.0, -1.0)).rgb * 2.0;
  sum += texture(tDiffuse, vUv + texel * vec2(-1.0, 1.0)).rgb * 2.0;
  sum += texture(tDiffuse, vUv + texel * vec2(1.0, 1.0)).rgb * 2.0;
  vec3 coarse = sum / 12.0;
  FragColor = vec4(texture(tCurrent, vUv).rgb + coarse * radius, 1.0);
}`;

const BLOOM_COMPOSITE_FS = `uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float intensity;
uniform float normalization;
in vec2 vUv;
out vec4 FragColor;
void main() {
  vec4 base = texture(tDiffuse, vUv);
  vec3 bloom = texture(tBloom, vUv).rgb * normalization;
  FragColor = vec4(base.rgb + bloom * intensity, base.a);
}`;

export class BloomPass implements PostPass {
  readonly name: string;
  enabled = true;
  threshold: number;
  knee: number;
  intensity: number;
  radius: number;
  readonly levels: number;
  private readonly down: THREE.WebGLRenderTarget[] = [];
  private readonly up: THREE.WebGLRenderTarget[] = [];
  private readonly prefilter = createFullscreenMaterial('BloomPrefilter', PREFILTER_FS, {
    tDiffuse: { value: null },
    texel: { value: new THREE.Vector2() },
    threshold: { value: 0 },
    knee: { value: 0 },
  });
  private readonly downsample = createFullscreenMaterial('BloomDownsample', DOWNSAMPLE_FS, { tDiffuse: { value: null }, texel: { value: new THREE.Vector2() } });
  private readonly upsample = createFullscreenMaterial('BloomUpsample', UPSAMPLE_FS, {
    tDiffuse: { value: null },
    tCurrent: { value: null },
    texel: { value: new THREE.Vector2() },
    radius: { value: 0 },
  });
  private readonly composite = createFullscreenMaterial('BloomComposite', BLOOM_COMPOSITE_FS, {
    tDiffuse: { value: null },
    tBloom: { value: null },
    intensity: { value: 1 },
    normalization: { value: 1 },
  });

  constructor(options: BloomOptions = {}, name = 'bloom') {
    this.name = name;
    this.threshold = options.threshold ?? 0.8;
    this.knee = options.knee ?? 0.3;
    this.intensity = options.intensity ?? 1;
    this.radius = options.radius ?? 0.75;
    this.levels = Math.max(1, Math.min(10, Math.round(options.levels ?? 6)));
    const make = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
    for (let i = 0; i < this.levels; i++) this.down.push(make());
    for (let i = 0; i < this.levels - 1; i++) this.up.push(make());
  }

  setSize(width: number, height: number): void {
    for (let i = 0; i < this.levels; i++) {
      const w = Math.max(1, Math.floor(width / 2 ** (i + 1)));
      const h = Math.max(1, Math.floor(height / 2 ** (i + 1)));
      this.down[i]?.setSize(w, h);
      this.up[i]?.setSize(w, h);
    }
  }

  render(context: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    const { renderer, quad } = context;
    const u = (m: THREE.RawShaderMaterial, name: string): THREE.IUniform => m.uniforms[name] as THREE.IUniform;
    const first = this.down[0] as THREE.WebGLRenderTarget;

    u(this.prefilter, 'tDiffuse').value = input;
    (u(this.prefilter, 'texel').value as THREE.Vector2).set(1 / context.width, 1 / context.height);
    u(this.prefilter, 'threshold').value = this.threshold;
    u(this.prefilter, 'knee').value = Math.max(this.knee, 1e-4);
    quad.render(renderer, this.prefilter, first);

    for (let i = 1; i < this.levels; i++) {
      const src = this.down[i - 1] as THREE.WebGLRenderTarget;
      u(this.downsample, 'tDiffuse').value = src.texture;
      (u(this.downsample, 'texel').value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      quad.render(renderer, this.downsample, this.down[i] as THREE.WebGLRenderTarget);
    }

    // Walk back up: each level adds the tent-filtered coarser result onto its own downsample.
    let coarse = this.down[this.levels - 1] as THREE.WebGLRenderTarget;
    for (let i = this.levels - 2; i >= 0; i--) {
      const target = this.up[i] as THREE.WebGLRenderTarget;
      u(this.upsample, 'tDiffuse').value = coarse.texture;
      u(this.upsample, 'tCurrent').value = (this.down[i] as THREE.WebGLRenderTarget).texture;
      (u(this.upsample, 'texel').value as THREE.Vector2).set(0.5 / coarse.width, 0.5 / coarse.height);
      u(this.upsample, 'radius').value = this.radius;
      quad.render(renderer, this.upsample, target);
      coarse = target;
    }

    // Normalise by the geometric sum of the level weights so `radius` changes the shape more than the brightness.
    let weight = 1;
    for (let i = 1; i < this.levels; i++) weight += this.radius ** i;
    u(this.composite, 'tDiffuse').value = input;
    u(this.composite, 'tBloom').value = coarse.texture;
    u(this.composite, 'intensity').value = this.intensity;
    u(this.composite, 'normalization').value = 1 / weight;
    quad.render(renderer, this.composite, output);
  }

  dispose(): void {
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of [this.prefilter, this.downsample, this.upsample, this.composite]) m.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FXAA
// ---------------------------------------------------------------------------------------------------------------

const FXAA_FS = `uniform sampler2D tDiffuse;
uniform vec2 resolution;
in vec2 vUv;
out vec4 FragColor;
const float REDUCE_MIN = 1.0 / 128.0;
const float REDUCE_MUL = 1.0 / 8.0;
const float SPAN_MAX = 8.0;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 texel = 1.0 / resolution;
  vec4 center = texture(tDiffuse, vUv);
  float lNW = luma(texture(tDiffuse, vUv + vec2(-1.0, -1.0) * texel).rgb);
  float lNE = luma(texture(tDiffuse, vUv + vec2(1.0, -1.0) * texel).rgb);
  float lSW = luma(texture(tDiffuse, vUv + vec2(-1.0, 1.0) * texel).rgb);
  float lSE = luma(texture(tDiffuse, vUv + vec2(1.0, 1.0) * texel).rgb);
  float lM = luma(center.rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  // Edge direction from the luma gradient of the four diagonal neighbours.
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * texel;
  vec3 a = 0.5 * (texture(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(tDiffuse, vUv - dir * 0.5).rgb + texture(tDiffuse, vUv + dir * 0.5).rgb);
  float lB = luma(b);
  FragColor = vec4((lB < lMin || lB > lMax) ? a : b, center.a);
}`;

/** Fast approximate anti-aliasing along luma edges. Run it after tone mapping, on display-range colours. */
export class FXAAPass extends ShaderPass {
  constructor(name = 'fxaa') {
    super(name, FXAA_FS);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Colour grading
// ---------------------------------------------------------------------------------------------------------------

export type ToneMapping = 'none' | 'reinhard' | 'aces';

export interface ColorGradeOptions {
  /** Exposure in stops. Default 0. */
  exposure?: number;
  /** 1 is neutral. Default 1. */
  contrast?: number;
  /** 1 is neutral, 0 is greyscale. Default 1. */
  saturation?: number;
  /** Multiplies the graded colour. Default white. */
  tint?: THREE.ColorRepresentation;
  toneMapping?: ToneMapping;
  /** Encodes the output to sRGB. Use it when the scene renders linear colour. Default false. */
  outputSRGB?: boolean;
}

const TONE_MAPPING_IDS: Record<ToneMapping, number> = { none: 0, reinhard: 1, aces: 2 };

function colorGradeShader(toneMapping: ToneMapping, outputSRGB: boolean): string {
  return `#define TONE_MAPPING ${TONE_MAPPING_IDS[toneMapping]}
#define OUTPUT_SRGB ${outputSRGB ? 1 : 0}
uniform sampler2D tDiffuse;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform vec3 tint;
in vec2 vUv;
out vec4 FragColor;
vec3 acesFitted(vec3 x) {
  // Narkowicz's curve fit of the ACES reference rendering transform.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
void main() {
  vec4 src = texture(tDiffuse, vUv);
  vec3 c = src.rgb * exp2(exposure);
#if TONE_MAPPING == 1
  c = c / (1.0 + c);
#elif TONE_MAPPING == 2
  c = acesFitted(c);
#endif
  c = (c - 0.5) * contrast + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation) * tint;
  c = max(c, vec3(0.0));
#if OUTPUT_SRGB == 1
  c = linearToSRGB(c);
#endif
  FragColor = vec4(c, src.a);
}`;
}

export class ColorGradePass extends ShaderPass {
  private _toneMapping: ToneMapping;
  private _outputSRGB: boolean;

  constructor(options: ColorGradeOptions = {}, name = 'colorGrade') {
    const toneMapping = options.toneMapping ?? 'aces';
    const outputSRGB = options.outputSRGB ?? false;
    super(name, colorGradeShader(toneMapping, outputSRGB), {
      exposure: { value: options.exposure ?? 0 },
      contrast: { value: options.contrast ?? 1 },
      saturation: { value: options.saturation ?? 1 },
      tint: { value: new THREE.Color(options.tint ?? 0xffffff) },
    });
    this._toneMapping = toneMapping;
    this._outputSRGB = outputSRGB;
  }

  get exposure(): number {
    return this.uniform<number>('exposure').value;
  }
  set exposure(v: number) {
    this.uniform<number>('exposure').value = v;
  }
  get contrast(): number {
    return this.uniform<number>('contrast').value;
  }
  set contrast(v: number) {
    this.uniform<number>('contrast').value = v;
  }
  get saturation(): number {
    return this.uniform<number>('saturation').value;
  }
  set saturation(v: number) {
    this.uniform<number>('saturation').value = v;
  }
  get tint(): THREE.Color {
    return this.uniform<THREE.Color>('tint').value;
  }

  get toneMapping(): ToneMapping {
    return this._toneMapping;
  }
  set toneMapping(v: ToneMapping) {
    if (v === this._toneMapping) return;
    this._toneMapping = v;
    this.rebuild();
  }
  get outputSRGB(): boolean {
    return this._outputSRGB;
  }
  set outputSRGB(v: boolean) {
    if (v === this._outputSRGB) return;
    this._outputSRGB = v;
    this.rebuild();
  }

  private rebuild(): void {
    this.material.fragmentShader = `precision highp float;\nprecision highp int;\n${colorGradeShader(this._toneMapping, this._outputSRGB)}`;
    this.material.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lens: chromatic aberration, vignette, grain
// ---------------------------------------------------------------------------------------------------------------

export interface LensOptions {
  /** Radial RGB split in UV units at the corners. Default 0.002. */
  chromaticAberration?: number;
  /** Darkening at the corners (0..1). Default 0.25. */
  vignette?: number;
  /** Distance from the centre where the vignette starts (0..1). Default 0.4. */
  vignetteOffset?: number;
  /** Animated film grain strength. Default 0.04. */
  grain?: number;
}

const LENS_FS = `uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float time;
uniform float chromaticAberration;
uniform float vignette;
uniform float vignetteOffset;
uniform float grain;
in vec2 vUv;
out vec4 FragColor;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered);
  vec2 offset = centered * dist * chromaticAberration * 2.0;
  vec4 base = texture(tDiffuse, vUv);
  vec3 color = vec3(texture(tDiffuse, vUv + offset).r, base.g, texture(tDiffuse, vUv - offset).b);
  float v = smoothstep(vignetteOffset, vignetteOffset + 0.6, dist * 1.41421);
  color *= 1.0 - v * vignette;
  float n = hash(vUv * resolution + fract(time * 61.0) * 1000.0) - 0.5;
  color += n * grain;
  FragColor = vec4(color, base.a);
}`;

export class LensPass extends ShaderPass {
  constructor(options: LensOptions = {}, name = 'lens') {
    super(name, LENS_FS, {
      chromaticAberration: { value: options.chromaticAberration ?? 0.002 },
      vignette: { value: options.vignette ?? 0.25 },
      vignetteOffset: { value: options.vignetteOffset ?? 0.4 },
      grain: { value: options.grain ?? 0.04 },
    });
  }

  get chromaticAberration(): number {
    return this.uniform<number>('chromaticAberration').value;
  }
  set chromaticAberration(v: number) {
    this.uniform<number>('chromaticAberration').value = v;
  }
  get vignette(): number {
    return this.uniform<number>('vignette').value;
  }
  set vignette(v: number) {
    this.uniform<number>('vignette').value = v;
  }
  get vignetteOffset(): number {
    return this.uniform<number>('vignetteOffset').value;
  }
  set vignetteOffset(v: number) {
    this.uniform<number>('vignetteOffset').value = v;
  }
  get grain(): number {
    return this.uniform<number>('grain').value;
  }
  set grain(v: number) {
    this.uniform<number>('grain').value = v;
  }
}
