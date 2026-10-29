import * as THREE from 'three';

/**
 * Bead points: a static point cloud drawn as tiny lit spheres ("beads") with per-point size and colour and a
 * depth-of-field blur, the look of scanned foliage, coral and dust in award-style sites. Points far from the focus
 * plane grow into soft, dim bokeh discs; points in focus keep a crisp shaded sphere. An optional wrap repeats the cloud
 * along one axis so a scrolling column never runs out.
 */
export interface BeadFocus {
  /** View-space distance that is perfectly sharp. */
  distance: number;
  /** Distance from the focus plane at which the blur is fully applied. */
  range: number;
  /** How many times larger a fully blurred bead is drawn (0 disables depth of field). */
  maxBlur: number;
}

export interface BeadWrap {
  axis: 'x' | 'y' | 'z';
  /** Length of one repeat in local units; positions are wrapped into [-length / 2, length / 2) after `offset`. */
  length: number;
}

export interface BeadPointsOptions {
  /** xyz per point, local space. */
  positions: Float32Array;
  /** Linear rgb per point. Default white. */
  colors?: Float32Array;
  /** World-space diameter per point. Overrides `size`. */
  sizes?: Float32Array;
  /** World-space diameter when `sizes` is absent. Default 0.03. */
  size?: number;
  focus?: Partial<BeadFocus>;
  wrap?: BeadWrap;
  /** Beads fade out between these view distances, like fog. Default none. */
  depthFade?: { start: number; end: number };
  /** `bead` shades each point as a sphere; `disc` draws a flat soft dot. Default bead. */
  shading?: 'bead' | 'disc';
  blending?: 'normal' | 'additive';
  opacity?: number;
}

const DEFAULT_FOCUS: BeadFocus = { distance: 8, range: 6, maxBlur: 0 };
const WRAP_AXES = { x: 0, y: 1, z: 2 } as const;

/**
 * Blur growth for a bead at view depth `depth`: 1 in focus, rising linearly to `1 + maxBlur` at `range` from the focus
 * plane. The shader uses the same curve; exported so layouts can predict on-screen bead sizes.
 */
export function bokehScale(depth: number, focus: BeadFocus): number {
  if (!(focus.range > 0)) throw new RangeError(`Bead focus range must be positive, got ${focus.range}`);
  const coc = Math.min(Math.abs(depth - focus.distance) / focus.range, 1);
  return 1 + coc * Math.max(focus.maxBlur, 0);
}

function requireLength(name: string, array: Float32Array, expected: number): void {
  if (array.length !== expected) {
    throw new RangeError(`BeadPoints ${name} has ${array.length} values, expected ${expected}`);
  }
}

const VS = `precision highp float;
in vec3 position;
in vec3 color;
in float size;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float viewportHeight;
uniform vec3 focus;
uniform vec4 wrap;
uniform vec2 depthFade;
out vec3 vColor;
out float vBlur;
out float vAlpha;
void main() {
  vec3 p = position;
  if (wrap.w > 0.0) {
    int axis = int(wrap.x);
    float v = p[axis] + wrap.y;
    p[axis] = mod(v + wrap.w * 0.5, wrap.w) - wrap.w * 0.5;
    // Fade beads at the wrap seam so the jump is invisible.
    vAlpha = smoothstep(wrap.w * 0.5, wrap.w * 0.38, abs(p[axis]));
  } else {
    vAlpha = 1.0;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = max(-mv.z, 1e-3);
  float coc = focus.y > 0.0 ? min(abs(depth - focus.x) / focus.y, 1.0) : 0.0;
  float grow = 1.0 + coc * focus.z;
  vBlur = coc * step(0.001, focus.z);
  // Energy is spread over the larger disc, so blurred beads also get dimmer.
  vAlpha *= 1.0 / (grow * grow) * (1.0 + coc * 0.6) * smoothstep(0.05, 0.6, depth);
  if (depthFade.y > depthFade.x) vAlpha *= 1.0 - smoothstep(depthFade.x, depthFade.y, depth);
  vColor = color;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * grow * projectionMatrix[1][1] * viewportHeight * 0.5 / depth;
}`;

const FS = `precision highp float;
uniform float opacity;
uniform float shading;
uniform vec3 lightDirection;
in vec3 vColor;
in float vBlur;
in float vAlpha;
out vec4 FragColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float edge = smoothstep(1.0, mix(0.82, 0.05, vBlur), r2);
  vec3 c = vColor;
  if (shading > 0.5) {
    vec3 n = vec3(q, sqrt(1.0 - r2));
    float diffuse = max(dot(n, lightDirection), 0.0);
    float spec = pow(max(dot(reflect(-lightDirection, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
    float rim = pow(1.0 - n.z, 2.0);
    vec3 lit = vColor * (0.32 + 0.85 * diffuse) + vec3(spec * 0.55) + vColor * rim * 0.35;
    // Out-of-focus beads lose their shading and read as flat bokeh.
    c = mix(lit, vColor * 0.9, vBlur);
  }
  float a = edge * vAlpha * opacity;
  if (a < 0.004) discard;
  FragColor = vec4(c, a);
}`;

export class BeadPoints {
  readonly object: THREE.Points<THREE.BufferGeometry, THREE.RawShaderMaterial>;
  readonly count: number;
  private readonly viewport = new THREE.Vector4();

  constructor(options: BeadPointsOptions) {
    const { positions } = options;
    if (positions.length === 0 || positions.length % 3 !== 0) {
      throw new RangeError(`BeadPoints positions must hold xyz triples, got ${positions.length} values`);
    }
    this.count = positions.length / 3;
    const colors = options.colors ?? new Float32Array(this.count * 3).fill(1);
    requireLength('colors', colors, this.count * 3);
    const sizes = options.sizes ?? new Float32Array(this.count).fill(options.size ?? 0.03);
    requireLength('sizes', sizes, this.count);
    if (options.wrap && !(options.wrap.length > 0)) throw new RangeError(`Bead wrap length must be positive, got ${options.wrap.length}`);
    if (options.depthFade && !(options.depthFade.end > options.depthFade.start)) {
      throw new RangeError(`Bead depthFade end must exceed start, got ${options.depthFade.start}..${options.depthFade.end}`);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const focus = { ...DEFAULT_FOCUS, ...options.focus };
    const wrap = options.wrap;
    const additive = options.blending === 'additive';
    const material = new THREE.RawShaderMaterial({
      name: 'BeadPoints',
      glslVersion: THREE.GLSL3,
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        viewportHeight: { value: 1 },
        focus: { value: new THREE.Vector3(focus.distance, focus.range, focus.maxBlur) },
        wrap: { value: new THREE.Vector4(wrap ? WRAP_AXES[wrap.axis] : 0, 0, 0, wrap?.length ?? 0) },
        depthFade: { value: new THREE.Vector2(options.depthFade?.start ?? 0, options.depthFade?.end ?? 0) },
        opacity: { value: options.opacity ?? 1 },
        shading: { value: options.shading === 'disc' ? 0 : 1 },
        lightDirection: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() },
      },
      transparent: true,
      depthWrite: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.object = new THREE.Points(geometry, material);
    // Wrapped and blurred beads leave the static bounds, so culling would pop them.
    this.object.frustumCulled = false;
    this.object.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(this.viewport);
      (material.uniforms.viewportHeight as THREE.IUniform<number>).value = this.viewport.w;
    };
  }

  get material(): THREE.RawShaderMaterial {
    return this.object.material;
  }

  get opacity(): number {
    return (this.material.uniforms.opacity as THREE.IUniform<number>).value;
  }

  set opacity(value: number) {
    (this.material.uniforms.opacity as THREE.IUniform<number>).value = value;
    this.object.visible = value > 0.001;
  }

  /** Moves the focus plane; `range` and `maxBlur` keep their values when omitted. */
  setFocus(focus: Partial<BeadFocus>): void {
    const uniform = (this.material.uniforms.focus as THREE.IUniform<THREE.Vector3>).value;
    uniform.set(focus.distance ?? uniform.x, focus.range ?? uniform.y, focus.maxBlur ?? uniform.z);
  }

  /** Shifts the cloud along its wrap axis (no effect without `wrap`). */
  set offset(value: number) {
    (this.material.uniforms.wrap as THREE.IUniform<THREE.Vector4>).value.y = value;
  }

  get offset(): number {
    return (this.material.uniforms.wrap as THREE.IUniform<THREE.Vector4>).value.y;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
