import * as THREE from 'three';
import type { UniformMap } from './shaderLibrary';

/**
 * Full-screen triangle and GLSL ES 3.00 material helpers shared by post passes, GPU simulations and transitions. One
 * oversized triangle covers the viewport without the diagonal seam of a two-triangle quad.
 */
export const FULLSCREEN_VERTEX = [
  'in vec3 position;',
  'in vec2 uv;',
  'out vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = vec4(position.xy, 0.0, 1.0);',
  '}',
].join('\n');

export function createFullscreenGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return geometry;
}

/** A full-screen GLSL3 material. `fragmentShader` is a complete body: declare `in vec2 vUv` and `out vec4 FragColor`. */
export function createFullscreenMaterial(name: string, fragmentShader: string, uniforms: UniformMap): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    name,
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: `precision highp float;\nprecision highp int;\n${fragmentShader}`,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

/** The subset of `WebGLRenderer` the off-screen helpers draw with, so tests can pass a recording stub. */
export type QuadRenderer = Pick<THREE.WebGLRenderer, 'render' | 'setRenderTarget' | 'getRenderTarget'>;

export class FullscreenQuad {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(material: THREE.Material = new THREE.MeshBasicMaterial()) {
    this.mesh = new THREE.Mesh(createFullscreenGeometry(), material);
    this.mesh.frustumCulled = false;
  }

  /** Draws `material` into `target` (null = canvas) and restores the previous render target. */
  render(renderer: QuadRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    const previous = renderer.getRenderTarget();
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
    renderer.setRenderTarget(previous);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
