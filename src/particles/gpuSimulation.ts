import * as THREE from 'three';
import { UnsupportedFeatureError } from '../core/errors';
import { FullscreenQuad, createFullscreenMaterial } from '../gl/fullscreen';
import type { QuadRenderer } from '../gl/fullscreen';
import type { UniformMap } from '../gl/shaderLibrary';

/**
 * GPGPU simulation on ping-pong float render targets. Each variable is one RGBA texture of `width` × `height` texels
 * computed by a fragment shader. Every `step` computes all variables from the previous step's textures (so the order
 * of variables does not matter), then swaps.
 *
 * A variable shader is a GLSL ES 3.00 body. It receives `in vec2 vUv`, `out vec4 FragColor`,
 * `uniform vec2 simResolution` and one `uniform sampler2D t<Name>` per dependency (its own previous state included
 * when it lists itself). Extra uniforms come from the variable's `uniforms`.
 */
export interface SimulationVariableOptions {
  name: string;
  fragmentShader: string;
  /** RGBA float data, `width * height * 4` values. */
  initial: Float32Array;
  /** Variables whose previous textures this shader samples. Default: only itself. */
  dependencies?: readonly string[];
  uniforms?: UniformMap;
}

export interface SimulationVariable {
  readonly name: string;
  readonly material: THREE.RawShaderMaterial;
  readonly dependencies: readonly string[];
  readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
}

export type SimulationRenderer = QuadRenderer & { extensions: Pick<THREE.WebGLExtensions, 'has'> };

export interface GPUSimulationOptions {
  /** Texel type. Default: FloatType when float targets are renderable, else HalfFloatType. */
  type?: THREE.TextureDataType;
}

/** Name of the sampler uniform a dependency is bound to: `position` → `tPosition`. */
export function samplerName(variable: string): string {
  return `t${variable.charAt(0).toUpperCase()}${variable.slice(1)}`;
}

export function simulationShaderHeader(dependencies: readonly string[]): string {
  return [...dependencies.map((d) => `uniform sampler2D ${samplerName(d)};`), 'uniform vec2 simResolution;', 'in vec2 vUv;', 'out vec4 FragColor;', ''].join('\n');
}

/** Float when the GPU can render to 32-bit float targets, half float otherwise. */
export function simulationTextureType(renderer: SimulationRenderer): THREE.TextureDataType {
  if (renderer.extensions.has('EXT_color_buffer_float')) return THREE.FloatType;
  if (renderer.extensions.has('EXT_color_buffer_half_float')) return THREE.HalfFloatType;
  throw new UnsupportedFeatureError('GPU simulation', 'float render targets are not available (EXT_color_buffer_float)');
}

export class GPUSimulation {
  readonly variables = new Map<string, SimulationVariable>();
  readonly type: THREE.TextureDataType;
  private readonly quad = new FullscreenQuad();
  private readonly copy = createFullscreenMaterial('SimulationUpload', 'uniform sampler2D tSource;\nin vec2 vUv;\nout vec4 FragColor;\nvoid main() { FragColor = texture(tSource, vUv); }', { tSource: { value: null } });
  private readonly pendingInit = new Map<string, Float32Array>();
  /** Index of the target holding the current state. */
  private current = 0;

  constructor(
    private readonly renderer: SimulationRenderer,
    readonly width: number,
    readonly height: number,
    options: GPUSimulationOptions = {},
  ) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw new RangeError(`Simulation size must be positive integers, got ${width}x${height}`);
    this.type = options.type ?? simulationTextureType(renderer);
  }

  addVariable(options: SimulationVariableOptions): SimulationVariable {
    if (this.variables.has(options.name)) throw new Error(`Simulation variable "${options.name}" already exists`);
    const expected = this.width * this.height * 4;
    if (options.initial.length !== expected) throw new RangeError(`Initial data of "${options.name}" has ${options.initial.length} values, expected ${expected}`);
    const dependencies = options.dependencies ?? [options.name];
    const uniforms: UniformMap = { simResolution: { value: new THREE.Vector2(this.width, this.height) }, ...options.uniforms };
    for (const d of dependencies) uniforms[samplerName(d)] = { value: null };
    const material = createFullscreenMaterial(`Simulation_${options.name}`, simulationShaderHeader(dependencies) + options.fragmentShader, uniforms);
    const make = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(this.width, this.height, {
        type: this.type,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
    const variable: SimulationVariable = { name: options.name, material, dependencies, targets: [make(), make()] };
    this.variables.set(options.name, variable);
    this.pendingInit.set(options.name, options.initial);
    return variable;
  }

  /** Validates dependencies and writes the initial data into both targets of every variable. */
  init(): void {
    for (const v of this.variables.values()) {
      for (const d of v.dependencies) if (!this.variables.has(d)) throw new Error(`Simulation variable "${v.name}" depends on unknown variable "${d}"`);
    }
    for (const [name, data] of this.pendingInit) this.write(this.require(name), data);
    this.pendingInit.clear();
  }

  /** Replaces a variable's state (both targets), e.g. to reset a simulation. */
  reset(name: string, data: Float32Array): void {
    const variable = this.require(name);
    if (data.length !== this.width * this.height * 4) throw new RangeError(`Reset data of "${name}" has ${data.length} values, expected ${this.width * this.height * 4}`);
    this.write(variable, data);
  }

  private write(variable: SimulationVariable, data: Float32Array): void {
    const source = new THREE.DataTexture(data, this.width, this.height, THREE.RGBAFormat, THREE.FloatType);
    source.minFilter = source.magFilter = THREE.NearestFilter;
    source.needsUpdate = true;
    (this.copy.uniforms.tSource as THREE.IUniform).value = source;
    for (const t of variable.targets) this.quad.render(this.renderer, this.copy, t);
    source.dispose();
  }

  private require(name: string): SimulationVariable {
    const v = this.variables.get(name);
    if (!v) throw new Error(`Unknown simulation variable "${name}"`);
    return v;
  }

  /** Current state texture of a variable. */
  texture(name: string): THREE.Texture {
    return (this.require(name).targets[this.current] as THREE.WebGLRenderTarget).texture;
  }

  /** Uniforms of a variable's shader. */
  uniforms(name: string): UniformMap {
    return this.require(name).material.uniforms;
  }

  step(): void {
    const read = this.current;
    const write = 1 - read;
    for (const v of this.variables.values()) {
      for (const d of v.dependencies) (v.material.uniforms[samplerName(d)] as THREE.IUniform).value = (this.require(d).targets[read] as THREE.WebGLRenderTarget).texture;
      this.quad.render(this.renderer, v.material, v.targets[write] as THREE.WebGLRenderTarget);
    }
    this.current = write;
  }

  dispose(): void {
    for (const v of this.variables.values()) {
      v.material.dispose();
      for (const t of v.targets) t.dispose();
    }
    this.variables.clear();
    this.copy.dispose();
    this.quad.dispose();
  }
}
