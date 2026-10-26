import * as THREE from 'three';
import { frame } from '../core/loop';
import { FullscreenQuad } from '../gl/fullscreen';
import type { QuadRenderer } from '../gl/fullscreen';
import { globalUniforms } from '../gl/shaderLibrary';
import { ShaderPass } from './shaderPass';

/**
 * Ordered post-processing stack. Each enabled pass reads the previous pass's result and writes the next; two
 * ping-pong targets carry the intermediate frames and the last enabled pass writes straight to the output (the canvas
 * when null), so a stack of N passes costs N full-screen draws. With every pass disabled the input is copied.
 */
export interface PostContext {
  renderer: QuadRenderer;
  quad: FullscreenQuad;
  /** Drawing-buffer size in pixels. */
  width: number;
  height: number;
  /** Shared shader time in seconds (`globalUniforms.time`). */
  time: number;
  /** Frame delta in ms. */
  delta: number;
}

export interface PostPass {
  readonly name: string;
  enabled: boolean;
  /** Called with the drawing-buffer size in pixels when the stack is resized. */
  setSize(width: number, height: number): void;
  /** Reads `input` and draws the result into `output` (null = canvas). It must not draw into `input`. */
  render(context: PostContext, input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void;
  dispose(): void;
}

export interface PostStackOptions {
  /** Texel type of the intermediate targets. HalfFloat keeps HDR values between passes. Default HalfFloatType. */
  type?: THREE.TextureDataType;
}

const COPY_FS = `uniform sampler2D tDiffuse;
in vec2 vUv;
out vec4 FragColor;
void main() {
  FragColor = texture(tDiffuse, vUv);
}`;

export class PostStack {
  readonly passes: PostPass[] = [];
  private readonly quad = new FullscreenQuad();
  private readonly targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly copy = new ShaderPass('PostCopy', COPY_FS);
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: QuadRenderer,
    options: PostStackOptions = {},
  ) {
    const make = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(1, 1, { type: options.type ?? THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
    this.targets = [make(), make()];
  }

  /** Adds `pass` at `index` (default: the end) and sizes it to the stack. */
  add<T extends PostPass>(pass: T, index = this.passes.length): T {
    if (this.passes.some((p) => p.name === pass.name)) throw new Error(`Post pass "${pass.name}" is already in the stack`);
    this.passes.splice(index, 0, pass);
    pass.setSize(this.width, this.height);
    return pass;
  }

  remove(pass: PostPass): void {
    const i = this.passes.indexOf(pass);
    if (i >= 0) this.passes.splice(i, 1);
  }

  get(name: string): PostPass | undefined {
    return this.passes.find((p) => p.name === name);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    for (const t of this.targets) t.setSize(this.width, this.height);
    this.copy.setSize(this.width, this.height);
    for (const p of this.passes) p.setSize(this.width, this.height);
  }

  render(input: THREE.Texture, output: THREE.WebGLRenderTarget | null): void {
    const context: PostContext = { renderer: this.renderer, quad: this.quad, width: this.width, height: this.height, time: globalUniforms.time.value, delta: frame.delta };
    const enabled = this.passes.filter((p) => p.enabled);
    if (enabled.length === 0) {
      this.copy.render(context, input, output);
      return;
    }
    let read = input;
    enabled.forEach((pass, i) => {
      const write = i === enabled.length - 1 ? output : this.targets[i % 2] as THREE.WebGLRenderTarget;
      pass.render(context, read, write);
      if (write) read = write.texture;
    });
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    for (const p of this.passes) p.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
