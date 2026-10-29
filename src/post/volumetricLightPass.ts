import * as THREE from 'three';
import { clamp } from '../core/math';
import { createFullscreenMaterial } from '../gl/fullscreen';
import type { PostContext, PostPass } from './postStack';

export interface VolumetricLightOptions {
  /** Light screen position in UV space (0..1, 0..1). Default (0.5, 0.5). */
  lightPosition?: THREE.Vector2;
  /** Ray step density. Default 0.85. */
  density?: number;
  /** Ray intensity decay per sample (0..1). Default 0.93. */
  decay?: number;
  /** Sample weight multiplier. Default 0.35. */
  weight?: number;
  /** Final ray exposure multiplier. Default 0.65. */
  exposure?: number;
  /** Maximum brightness clamp for illumination rays. Default 1.0. */
  clampThreshold?: number;
  /** Luminosity threshold above which pixels cast light rays. Default 0.25. */
  threshold?: number;
  /** Number of radial ray samples, clamped to 16..64. Default 32. Fixed at construction: it is compiled into the shader. */
  samples?: number;
}

function volumetricFragmentShader(samples: number): string {
  return `precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 lightPosition;
uniform float density;
uniform float decay;
uniform float weight;
uniform float exposure;
uniform float clampThreshold;
uniform float threshold;

in vec2 vUv;
out vec4 FragColor;

const int NUM_SAMPLES = ${samples};

void main() {
  vec4 baseColor = texture(tDiffuse, vUv);

  // Ray vector from current pixel toward light position
  vec2 deltaTextCoord = (vUv - lightPosition) * (1.0 / float(NUM_SAMPLES)) * density;
  vec2 textCoo = vUv;

  float illuminationDecay = 1.0;
  vec3 rays = vec3(0.0);

  for (int i = 0; i < NUM_SAMPLES; i++) {
    textCoo -= deltaTextCoord;
    vec3 sampleColor = texture(tDiffuse, clamp(textCoo, 0.0, 1.0)).rgb;

    // Extract highlights above threshold
    float brightness = max(sampleColor.r, max(sampleColor.g, sampleColor.b));
    if (brightness > threshold) {
      vec3 bright = sampleColor * ((brightness - threshold) / max(brightness, 1e-4));
      bright = min(bright, vec3(clampThreshold));
      bright *= illuminationDecay * weight;
      rays += bright;
    }

    illuminationDecay *= decay;
  }

  vec3 finalColor = baseColor.rgb + rays * exposure;
  FragColor = vec4(finalColor, baseColor.a);
}
`;
}

/**
 * Volumetric light scattering post pass (crepuscular rays, god rays). Each pixel marches toward the light
 * position and accumulates the bright samples it passes.
 */
export class VolumetricLightPass implements PostPass {
  readonly name = 'VolumetricLight';
  enabled = true;

  readonly lightPosition: THREE.Vector2;
  readonly samples: number;
  density: number;
  decay: number;
  weight: number;
  exposure: number;
  clampThreshold: number;
  threshold: number;

  private readonly material: THREE.RawShaderMaterial;

  constructor(options: VolumetricLightOptions = {}) {
    this.lightPosition = (options.lightPosition ?? new THREE.Vector2(0.5, 0.5)).clone();
    this.samples = Math.round(clamp(options.samples ?? 32, 16, 64));
    this.density = options.density ?? 0.85;
    this.decay = options.decay ?? 0.93;
    this.weight = options.weight ?? 0.35;
    this.exposure = options.exposure ?? 0.65;
    this.clampThreshold = options.clampThreshold ?? 1.0;
    this.threshold = options.threshold ?? 0.25;

    this.material = createFullscreenMaterial('VolumetricLight', volumetricFragmentShader(this.samples), {
      tDiffuse: { value: null },
      lightPosition: { value: this.lightPosition },
      density: { value: this.density },
      decay: { value: this.decay },
      weight: { value: this.weight },
      exposure: { value: this.exposure },
      clampThreshold: { value: this.clampThreshold },
      threshold: { value: this.threshold },
    });
  }

  setSize(_width: number, _height: number): void {
    // Resolution-independent radial ray march
  }

  render(context: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    this.material.uniforms.tDiffuse!.value = input;
    (this.material.uniforms.lightPosition!.value as THREE.Vector2).copy(this.lightPosition);
    this.material.uniforms.density!.value = this.density;
    this.material.uniforms.decay!.value = this.decay;
    this.material.uniforms.weight!.value = this.weight;
    this.material.uniforms.exposure!.value = this.exposure;
    this.material.uniforms.clampThreshold!.value = this.clampThreshold;
    this.material.uniforms.threshold!.value = this.threshold;

    context.quad.render(context.renderer, this.material, output);
  }

  dispose(): void {
    this.material.dispose();
  }
}
