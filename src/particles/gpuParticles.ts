import { prefersReducedMotion } from '../accessibility/motion';
import * as THREE from 'three';
import { createRandom, randomRange } from '../core/random';
import type { RandomFn } from '../core/random';
import { GPUSimulation } from './gpuSimulation';
import type { SimulationRenderer } from './gpuSimulation';
import { NOISE_GLSL } from './noise.glsl';

/**
 * GPU particle system: positions and velocities live in float textures advanced by `GPUSimulation`, so hundreds of
 * thousands of particles cost two full-screen passes per frame. Forces: gravity, drag, curl noise and a spherical
 * attractor (point it at the pointer). Each particle has a lifetime; when it ends the particle respawns inside the
 * emitter, so the emitter can move every frame. Points are drawn as soft discs coloured from `colorStart` (birth) to
 * `colorEnd` (death).
 */
export type EmitterShape =
  | { type: 'point'; position: THREE.Vector3Tuple }
  | { type: 'sphere'; center: THREE.Vector3Tuple; radius: number }
  | { type: 'box'; center: THREE.Vector3Tuple; size: THREE.Vector3Tuple };

export interface CurlOptions {
  /** Acceleration from the curl field. Default 1. */
  strength: number;
  /** Spatial frequency of the field (1 / feature size in world units). Default 0.6. */
  scale: number;
  /** How fast the field evolves. Default 0.15. */
  speed: number;
}

export interface GPUParticlesOptions {
  /** Number of particles, 1 to 4 194 304. */
  count: number;
  emitter: EmitterShape;
  /** Lifetime range in seconds. Default [2, 5]. */
  lifetime?: [number, number];
  /** Speed at birth in a random direction, world units per second. Default 0.2. */
  speed?: number;
  gravity?: THREE.Vector3Tuple;
  /** Velocity damping per second (0 = none). Default 0.6. */
  drag?: number;
  curl?: Partial<CurlOptions>;
  /** Point diameter in world units. Default 0.02. */
  size?: number;
  colorStart?: THREE.ColorRepresentation;
  colorEnd?: THREE.ColorRepresentation;
  opacity?: number;
  blending?: 'additive' | 'normal';
  seed?: number;
}

export interface Attractor {
  position: THREE.Vector3;
  /** Acceleration toward `position` at its centre; negative repels. */
  strength: number;
  /** Distance beyond which the attractor has no effect. */
  radius: number;
}

const MAX_COUNT = 2048 * 2048;
const EMITTER_IDS: Record<EmitterShape['type'], number> = { point: 0, sphere: 1, box: 2 };

/** Smallest near-square texture that holds `count` texels. */
export function particleTextureSize(count: number): { width: number; height: number } {
  if (!(Number.isInteger(count) && count > 0 && count <= MAX_COUNT)) throw new RangeError(`Particle count must be an integer in 1..${MAX_COUNT}, got ${count}`);
  const width = Math.ceil(Math.sqrt(count));
  return { width, height: Math.ceil(count / width) };
}

/** A uniformly distributed point inside the emitter. */
export function sampleEmitter(shape: EmitterShape, random: RandomFn, out = new THREE.Vector3()): THREE.Vector3 {
  switch (shape.type) {
    case 'point':
      return out.fromArray(shape.position);
    case 'sphere': {
      randomDirection(random, out).multiplyScalar(shape.radius * Math.cbrt(random()));
      return out.add(new THREE.Vector3().fromArray(shape.center));
    }
    case 'box':
      return out.set(
        shape.center[0] + (random() - 0.5) * shape.size[0],
        shape.center[1] + (random() - 0.5) * shape.size[1],
        shape.center[2] + (random() - 0.5) * shape.size[2],
      );
  }
}

export function randomDirection(random: RandomFn, out = new THREE.Vector3()): THREE.Vector3 {
  const z = random() * 2 - 1;
  const phi = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(phi), r * Math.sin(phi), z);
}

/**
 * Initial simulation state. Position `w` is the remaining life and velocity `w` the full lifetime; remaining lives are
 * spread over the lifetime so the first generation does not die all at once. Texels past `count` stay zero.
 */
export function seedParticles(
  count: number,
  width: number,
  height: number,
  options: { emitter: EmitterShape; lifetime: [number, number]; speed: number },
  random: RandomFn,
): { position: Float32Array; velocity: Float32Array } {
  const position = new Float32Array(width * height * 4);
  const velocity = new Float32Array(width * height * 4);
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    sampleEmitter(options.emitter, random, p);
    randomDirection(random, v).multiplyScalar(options.speed);
    const lifetime = randomRange(random, options.lifetime[0], options.lifetime[1]);
    position.set([p.x, p.y, p.z, lifetime * (0.05 + 0.95 * random())], i * 4);
    velocity.set([v.x, v.y, v.z, lifetime], i * 4);
  }
  return { position, velocity };
}

const SPAWN_GLSL = `
uniform float time;
uniform int emitterType;
uniform vec3 emitterCenter;
uniform vec3 emitterSize;
uniform vec2 lifetime;
uniform float speed;
vec2 spawnSeed() { return vUv * 17.0 + vec2(fract(time * 0.731) * 113.0, fract(time * 1.379) * 71.0); }
vec3 spawnDirection(vec2 seed) {
  float z = oxHash12(seed + 1.7) * 2.0 - 1.0;
  float phi = oxHash12(seed + 5.3) * 6.28318530718;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(phi), r * sin(phi), z);
}
vec3 spawnPosition(vec2 seed) {
  if (emitterType == 1) return emitterCenter + spawnDirection(seed + 11.0) * emitterSize.x * pow(oxHash12(seed + 3.1), 1.0 / 3.0);
  if (emitterType == 2) return emitterCenter + (vec3(oxHash12(seed + 2.1), oxHash12(seed + 4.7), oxHash12(seed + 8.9)) - 0.5) * emitterSize;
  return emitterCenter;
}
float spawnLifetime(vec2 seed) { return mix(lifetime.x, lifetime.y, oxHash12(seed + 9.4)); }
`;

const POSITION_FS = `${NOISE_GLSL}${SPAWN_GLSL}
uniform float dt;
void main() {
  vec4 pos = texture(tPosition, vUv);
  vec4 vel = texture(tVelocity, vUv);
  if (pos.w <= 0.0) {
    vec2 seed = spawnSeed();
    FragColor = vec4(spawnPosition(seed), spawnLifetime(seed));
    return;
  }
  FragColor = vec4(pos.xyz + vel.xyz * dt, pos.w - dt);
}`;

const VELOCITY_FS = `${NOISE_GLSL}${SPAWN_GLSL}
uniform float dt;
uniform vec3 gravity;
uniform float drag;
uniform vec3 curl;
uniform vec3 attractorPosition;
uniform float attractorStrength;
uniform float attractorRadius;
void main() {
  vec4 pos = texture(tPosition, vUv);
  vec4 vel = texture(tVelocity, vUv);
  if (pos.w <= 0.0) {
    vec2 seed = spawnSeed();
    FragColor = vec4(spawnDirection(seed) * speed, spawnLifetime(seed));
    return;
  }
  vec3 force = gravity + oxCurlNoise(pos.xyz * curl.y + vec3(0.0, 0.0, time * curl.z)) * curl.x;
  vec3 toAttractor = attractorPosition - pos.xyz;
  float d = length(toAttractor) + 1e-4;
  force += toAttractor / d * attractorStrength * (1.0 - smoothstep(0.0, attractorRadius, d));
  vec3 v = (vel.xyz + force * dt) * exp(-drag * dt);
  FragColor = vec4(v, vel.w);
}`;

const POINTS_VS = `precision highp float;
in vec3 position;
in vec2 reference;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform float size;
uniform float viewportHeight;
out float vLife;
out float vFade;
void main() {
  vec4 p = texture(tPosition, reference);
  vec4 v = texture(tVelocity, reference);
  float life = clamp(p.w / max(v.w, 1e-4), 0.0, 1.0);
  vLife = life;
  vFade = smoothstep(0.0, 0.2, life) * smoothstep(1.0, 0.9, life);
  vec4 mv = modelViewMatrix * vec4(p.xyz + position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * projectionMatrix[1][1] * viewportHeight * 0.5 / max(-mv.z, 1e-3);
}`;

const POINTS_FS = `precision highp float;
uniform vec3 colorStart;
uniform vec3 colorEnd;
uniform float opacity;
in float vLife;
in float vFade;
out vec4 FragColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d) * vFade * opacity;
  if (a <= 0.001) discard;
  FragColor = vec4(mix(colorEnd, colorStart, vLife), a);
}`;

export class GPUParticles {
  readonly object: THREE.Points<THREE.BufferGeometry, THREE.RawShaderMaterial>;
  readonly simulation: GPUSimulation;
  readonly count: number;
  readonly attractor: Attractor = { position: new THREE.Vector3(), strength: 0, radius: 1 };
  /** Simulation speed multiplier; 0 freezes the particles. */
  timeScale = 1;
  private time = 0;
  private emitterShape: EmitterShape;
  private readonly viewport = new THREE.Vector4();

  constructor(renderer: SimulationRenderer, options: GPUParticlesOptions) {
    const lifetime = options.lifetime ?? [2, 5];
    if (!(lifetime[0] > 0 && lifetime[1] >= lifetime[0])) throw new RangeError(`Particle lifetime must satisfy 0 < min <= max, got [${lifetime.join(', ')}]`);
    const { width, height } = particleTextureSize(options.count);
    const speed = options.speed ?? 0.2;
    const curl: CurlOptions = { strength: 1, scale: 0.6, speed: 0.15, ...options.curl };
    this.count = options.count;
    this.emitterShape = options.emitter;
    const seeded = seedParticles(options.count, width, height, { emitter: options.emitter, lifetime, speed }, createRandom(options.seed ?? 1));

    const spawnUniforms = (): Record<string, THREE.IUniform> => ({
      time: { value: 0 },
      dt: { value: 0 },
      emitterType: { value: 0 },
      emitterCenter: { value: new THREE.Vector3() },
      emitterSize: { value: new THREE.Vector3() },
      lifetime: { value: new THREE.Vector2(lifetime[0], lifetime[1]) },
      speed: { value: speed },
    });
    this.simulation = new GPUSimulation(renderer, width, height);
    this.simulation.addVariable({ name: 'position', fragmentShader: POSITION_FS, initial: seeded.position, dependencies: ['position', 'velocity'], uniforms: spawnUniforms() });
    this.simulation.addVariable({
      name: 'velocity',
      fragmentShader: VELOCITY_FS,
      initial: seeded.velocity,
      dependencies: ['position', 'velocity'],
      uniforms: {
        ...spawnUniforms(),
        gravity: { value: new THREE.Vector3().fromArray(options.gravity ?? [0, 0, 0]) },
        drag: { value: options.drag ?? 0.6 },
        curl: { value: new THREE.Vector3(curl.strength, curl.scale, curl.speed) },
        attractorPosition: { value: new THREE.Vector3() },
        attractorStrength: { value: 0 },
        attractorRadius: { value: 1 },
      },
    });
    this.simulation.init();
    this.emitter = options.emitter;

    const geometry = new THREE.BufferGeometry();
    const reference = new Float32Array(options.count * 2);
    for (let i = 0; i < options.count; i++) {
      reference[i * 2] = ((i % width) + 0.5) / width;
      reference[i * 2 + 1] = (Math.floor(i / width) + 0.5) / height;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(options.count * 3), 3));
    geometry.setAttribute('reference', new THREE.BufferAttribute(reference, 2));
    const additive = (options.blending ?? 'additive') === 'additive';
    const material = new THREE.RawShaderMaterial({
      name: 'GPUParticles',
      glslVersion: THREE.GLSL3,
      vertexShader: POINTS_VS,
      fragmentShader: POINTS_FS,
      uniforms: {
        tPosition: { value: this.simulation.texture('position') },
        tVelocity: { value: this.simulation.texture('velocity') },
        size: { value: options.size ?? 0.02 },
        viewportHeight: { value: 1 },
        colorStart: { value: new THREE.Color(options.colorStart ?? 0xffffff) },
        colorEnd: { value: new THREE.Color(options.colorEnd ?? 0x3366ff) },
        opacity: { value: options.opacity ?? 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.object = new THREE.Points(geometry, material);
    this.object.frustumCulled = false;
    this.object.onBeforeRender = (r) => {
      r.getCurrentViewport(this.viewport);
      (material.uniforms.viewportHeight as THREE.IUniform).value = this.viewport.w;
    };
  }

  get emitter(): EmitterShape {
    return this.emitterShape;
  }

  /** Moves or reshapes the emitter; particles born from now on use it. */
  set emitter(shape: EmitterShape) {
    this.emitterShape = shape;
    for (const name of ['position', 'velocity']) {
      const u = this.simulation.uniforms(name);
      (u.emitterType as THREE.IUniform).value = EMITTER_IDS[shape.type];
      const center = u.emitterCenter?.value as THREE.Vector3;
      const size = u.emitterSize?.value as THREE.Vector3;
      if (shape.type === 'point') {
        center.fromArray(shape.position);
        size.set(0, 0, 0);
      } else if (shape.type === 'sphere') {
        center.fromArray(shape.center);
        size.set(shape.radius, shape.radius, shape.radius);
      } else {
        center.fromArray(shape.center);
        size.fromArray(shape.size);
      }
    }
  }

  get material(): THREE.RawShaderMaterial {
    return this.object.material;
  }

  /** Advances the simulation by `deltaMs` (clamped to 1/30 s so a background tab does not explode it). */
  update(deltaMs: number): void {
    if (prefersReducedMotion()) return;
    const dt = Math.min(Math.max(deltaMs, 0) / 1000, 1 / 30) * this.timeScale;
    if (dt === 0) return;
    this.time += dt;
    for (const name of ['position', 'velocity']) {
      const u = this.simulation.uniforms(name);
      (u.time as THREE.IUniform).value = this.time;
      (u.dt as THREE.IUniform).value = dt;
    }
    const v = this.simulation.uniforms('velocity');
    (v.attractorPosition?.value as THREE.Vector3).copy(this.attractor.position);
    (v.attractorStrength as THREE.IUniform).value = this.attractor.strength;
    (v.attractorRadius as THREE.IUniform).value = Math.max(this.attractor.radius, 1e-4);
    this.simulation.step();
    (this.material.uniforms.tPosition as THREE.IUniform).value = this.simulation.texture('position');
    (this.material.uniforms.tVelocity as THREE.IUniform).value = this.simulation.texture('velocity');
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.simulation.dispose();
  }
}
