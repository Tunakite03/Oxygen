import * as THREE from 'three';
import { createFullscreenMaterial } from '../gl/fullscreen';
import type { UniformMap } from '../gl/shaderLibrary';
import type { PostContext, PostPass } from './postStack';

/**
 * A post pass from one fragment shader. The shader declares `uniform sampler2D tDiffuse` (the previous pass),
 * `in vec2 vUv` and `out vec4 FragColor`; `resolution` (vec2, pixels) and `time` (float, seconds) are set every frame
 * when declared.
 */
export class ShaderPass implements PostPass {
  enabled = true;
  readonly material: THREE.RawShaderMaterial;

  constructor(
    readonly name: string,
    fragmentShader: string,
    uniforms: UniformMap = {},
  ) {
    this.material = createFullscreenMaterial(name, fragmentShader, {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 },
      ...uniforms,
    });
  }

  get uniforms(): UniformMap {
    return this.material.uniforms;
  }

  /** Typed uniform access; throws when the uniform does not exist. */
  uniform<T>(name: string): THREE.IUniform<T> {
    const u = this.material.uniforms[name];
    if (!u) throw new Error(`Post pass "${this.name}" has no uniform "${name}"`);
    return u as THREE.IUniform<T>;
  }

  setSize(width: number, height: number): void {
    this.uniform<THREE.Vector2>('resolution').value.set(width, height);
  }

  render(context: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    this.uniform<THREE.Texture | null>('tDiffuse').value = input;
    this.uniform<number>('time').value = context.time;
    context.quad.render(context.renderer, this.material, output);
  }

  dispose(): void {
    this.material.dispose();
  }
}
