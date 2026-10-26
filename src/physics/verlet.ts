import * as THREE from 'three';

/**
 * Position-based Verlet solver for ropes, cloth and soft bodies: particles with inverse masses, distance constraints
 * relaxed over several iterations, pins, and plane / sphere / bounds colliders. It runs on a fixed timestep with an
 * accumulator, so behaviour does not depend on the frame rate. Positions are stored in flat `Float32Array`s that
 * `ClothGeometry` copies straight into a vertex buffer.
 */
export type VerletCollider =
  /** Keeps particles on the positive side of `normal · p + constant = 0` (the `THREE.Plane` convention). */
  | { type: 'plane'; normal: THREE.Vector3; constant: number }
  /** Pushes particles out of a sphere; move `center` every frame for a pointer-driven collider. */
  | { type: 'sphere'; center: THREE.Vector3; radius: number }
  /** Keeps particles inside an axis-aligned box. */
  | { type: 'bounds'; min: THREE.Vector3; max: THREE.Vector3 };

export interface VerletOptions {
  gravity?: THREE.Vector3Tuple;
  /** Velocity loss per second (0 = none). Default 0.5. */
  drag?: number;
  /** Constraint relaxation passes per step. More is stiffer. Default 8. */
  iterations?: number;
  /** Fixed step in seconds. Default 1/120. */
  timestep?: number;
  /** Steps run per `update` at most; extra time is dropped so a long frame cannot spiral. Default 8. */
  maxSubsteps?: number;
  /** Tangential velocity removed on contact (0..1). Default 0.3. */
  friction?: number;
  /** Collision radius of every particle. Default 0.01. */
  particleRadius?: number;
}

export interface ConstraintOptions {
  /** Rest length. Default: the current distance. */
  length?: number;
  /** Fraction of the error corrected per iteration (0..1). Default 1. */
  stiffness?: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export class VerletWorld {
  readonly gravity: THREE.Vector3;
  drag: number;
  iterations: number;
  readonly timestep: number;
  maxSubsteps: number;
  friction: number;
  particleRadius: number;
  readonly colliders: VerletCollider[] = [];
  /** Current positions, xyz per particle. Grows as particles are added; read up to `count * 3`. */
  positions = new Float32Array(64 * 3);
  private previous = new Float32Array(64 * 3);
  private invMass = new Float32Array(64);
  private constraintA: number[] = [];
  private constraintB: number[] = [];
  private constraintLength: number[] = [];
  private constraintStiffness: number[] = [];
  private accumulator = 0;
  count = 0;

  constructor(options: VerletOptions = {}) {
    this.gravity = new THREE.Vector3().fromArray(options.gravity ?? [0, -9.81, 0]);
    this.drag = options.drag ?? 0.5;
    this.iterations = options.iterations ?? 8;
    this.timestep = options.timestep ?? 1 / 120;
    this.maxSubsteps = options.maxSubsteps ?? 8;
    this.friction = options.friction ?? 0.3;
    this.particleRadius = options.particleRadius ?? 0.01;
    if (!(this.timestep > 0)) throw new RangeError(`Verlet timestep must be positive, got ${this.timestep}`);
  }

  get constraintCount(): number {
    return this.constraintA.length;
  }

  private grow(): void {
    const capacity = this.invMass.length * 2;
    const grow = (src: Float32Array, size: number): Float32Array<ArrayBuffer> => {
      const next = new Float32Array(size);
      next.set(src);
      return next;
    };
    this.positions = grow(this.positions, capacity * 3);
    this.previous = grow(this.previous, capacity * 3);
    this.invMass = grow(this.invMass, capacity);
  }

  /** Adds a particle at rest; `mass` 0 pins it. Returns its index. */
  addParticle(x: number, y: number, z: number, mass = 1): number {
    if (this.count === this.invMass.length) this.grow();
    const i = this.count++;
    this.positions.set([x, y, z], i * 3);
    this.previous.set([x, y, z], i * 3);
    this.invMass[i] = mass > 0 ? 1 / mass : 0;
    return i;
  }

  private check(i: number): void {
    if (!(Number.isInteger(i) && i >= 0 && i < this.count)) throw new RangeError(`Particle index ${i} is out of range 0..${this.count - 1}`);
  }

  /** Links two particles; returns the constraint index. */
  addConstraint(a: number, b: number, options: ConstraintOptions = {}): number {
    this.check(a);
    this.check(b);
    const length = options.length ?? this.getPosition(a, _a).distanceTo(this.getPosition(b, _b));
    this.constraintA.push(a);
    this.constraintB.push(b);
    this.constraintLength.push(length);
    this.constraintStiffness.push(THREE.MathUtils.clamp(options.stiffness ?? 1, 0, 1));
    return this.constraintA.length - 1;
  }

  /** Fixes a particle in place (or at `position`). Pinned particles follow `setPosition` only. */
  pin(i: number, position?: THREE.Vector3): void {
    this.check(i);
    this.invMass[i] = 0;
    if (position) this.setPosition(i, position);
  }

  unpin(i: number, mass = 1): void {
    this.check(i);
    this.invMass[i] = 1 / mass;
  }

  isPinned(i: number): boolean {
    this.check(i);
    return this.invMass[i] === 0;
  }

  getPosition(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.check(i);
    return out.fromArray(this.positions, i * 3);
  }

  /** Teleports a particle without giving it velocity. */
  setPosition(i: number, p: THREE.Vector3): void {
    this.check(i);
    p.toArray(this.positions, i * 3);
    p.toArray(this.previous, i * 3);
  }

  /** Moves a particle, keeping the motion as velocity (drag a pinned point to swing the cloth). */
  moveTo(i: number, p: THREE.Vector3): void {
    this.check(i);
    p.toArray(this.positions, i * 3);
  }

  /** Per-step velocity (world units per step) of a particle. */
  getVelocity(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.check(i);
    return out.fromArray(this.positions, i * 3).sub(_a.fromArray(this.previous, i * 3)).divideScalar(this.timestep);
  }

  /** Adds velocity (world units per second) to a particle. */
  addVelocity(i: number, v: THREE.Vector3): void {
    this.check(i);
    if (this.invMass[i] === 0) return;
    _a.fromArray(this.previous, i * 3).addScaledVector(v, -this.timestep).toArray(this.previous, i * 3);
  }

  /** Advances by `deltaMs` in fixed steps; returns the number of steps run. */
  update(deltaMs: number): number {
    this.accumulator += Math.max(0, deltaMs) / 1000;
    let steps = 0;
    while (this.accumulator >= this.timestep && steps < this.maxSubsteps) {
      this.step();
      this.accumulator -= this.timestep;
      steps++;
    }
    if (steps === this.maxSubsteps) this.accumulator = Math.min(this.accumulator, this.timestep);
    return steps;
  }

  /** One fixed step: integrate, then relax constraints and resolve collisions `iterations` times. */
  step(): void {
    const dt = this.timestep;
    const keep = Math.exp(-this.drag * dt);
    const p = this.positions;
    const q = this.previous;
    const gx = this.gravity.x * dt * dt;
    const gy = this.gravity.y * dt * dt;
    const gz = this.gravity.z * dt * dt;
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const o = i * 3;
      for (let k = 0; k < 3; k++) {
        const x = p[o + k] as number;
        const v = (x - (q[o + k] as number)) * keep;
        q[o + k] = x;
        p[o + k] = x + v + (k === 0 ? gx : k === 1 ? gy : gz);
      }
    }
    for (let n = 0; n < this.iterations; n++) {
      this.solveConstraints();
      this.collide();
    }
  }

  private solveConstraints(): void {
    const p = this.positions;
    const w = this.invMass;
    for (let c = 0; c < this.constraintA.length; c++) {
      const a = this.constraintA[c] as number;
      const b = this.constraintB[c] as number;
      const wa = w[a] as number;
      const wb = w[b] as number;
      const sum = wa + wb;
      if (sum === 0) continue;
      const oa = a * 3;
      const ob = b * 3;
      const dx = (p[ob] as number) - (p[oa] as number);
      const dy = (p[ob + 1] as number) - (p[oa + 1] as number);
      const dz = (p[ob + 2] as number) - (p[oa + 2] as number);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-9) continue;
      const k = (((dist - (this.constraintLength[c] as number)) / dist) * (this.constraintStiffness[c] as number)) / sum;
      p[oa] = (p[oa] as number) + dx * k * wa;
      p[oa + 1] = (p[oa + 1] as number) + dy * k * wa;
      p[oa + 2] = (p[oa + 2] as number) + dz * k * wa;
      p[ob] = (p[ob] as number) - dx * k * wb;
      p[ob + 1] = (p[ob + 1] as number) - dy * k * wb;
      p[ob + 2] = (p[ob + 2] as number) - dz * k * wb;
    }
  }

  private collide(): void {
    if (this.colliders.length === 0) return;
    const r = this.particleRadius;
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const pos = _a.fromArray(this.positions, i * 3);
      for (const c of this.colliders) {
        if (c.type === 'plane') {
          const d = c.normal.dot(pos) + c.constant - r;
          if (d < 0) this.contact(i, pos.addScaledVector(c.normal, -d), c.normal);
        } else if (c.type === 'sphere') {
          const offset = _b.subVectors(pos, c.center);
          const dist = offset.length();
          const min = c.radius + r;
          if (dist < min) {
            const normal = dist > 1e-9 ? offset.divideScalar(dist) : offset.set(0, 1, 0);
            this.contact(i, pos.copy(c.center).addScaledVector(normal, min), normal);
          }
        } else {
          for (const axis of ['x', 'y', 'z'] as const) {
            const lo = c.min[axis] + r;
            const hi = c.max[axis] - r;
            if (pos[axis] < lo || pos[axis] > hi) {
              const normal = _b.set(0, 0, 0);
              normal[axis] = pos[axis] < lo ? 1 : -1;
              pos[axis] = THREE.MathUtils.clamp(pos[axis], lo, hi);
              this.contact(i, pos, normal);
            }
          }
        }
      }
    }
  }

  /** Writes the corrected position, cancels velocity into the surface and removes `friction` of the sliding velocity. */
  private contact(i: number, corrected: THREE.Vector3, normal: THREE.Vector3): void {
    corrected.toArray(this.positions, i * 3);
    const velocity = _c.fromArray(this.previous, i * 3).negate().add(corrected);
    const normalSpeed = velocity.dot(normal);
    const tangential = _d.copy(velocity).addScaledVector(normal, -normalSpeed).multiplyScalar(1 - this.friction);
    tangential.addScaledVector(normal, Math.max(0, normalSpeed));
    _c.copy(corrected).sub(tangential).toArray(this.previous, i * 3);
  }
}

export interface RopeOptions {
  segments: number;
  mass?: number;
  pinStart?: boolean;
  pinEnd?: boolean;
  stiffness?: number;
}

/** A chain of `segments + 1` particles from `from` to `to`. Returns the particle indices in order. */
export function createRope(world: VerletWorld, from: THREE.Vector3, to: THREE.Vector3, options: RopeOptions): number[] {
  if (!(Number.isInteger(options.segments) && options.segments > 0)) throw new RangeError(`Rope segments must be a positive integer, got ${options.segments}`);
  const indices: number[] = [];
  const p = new THREE.Vector3();
  for (let s = 0; s <= options.segments; s++) {
    p.lerpVectors(from, to, s / options.segments);
    indices.push(world.addParticle(p.x, p.y, p.z, options.mass ?? 1));
  }
  for (let s = 0; s < options.segments; s++) world.addConstraint(indices[s] as number, indices[s + 1] as number, { stiffness: options.stiffness });
  if (options.pinStart ?? true) world.pin(indices[0] as number);
  if (options.pinEnd) world.pin(indices[indices.length - 1] as number);
  return indices;
}

export interface ClothOptions {
  /** Top-left corner. */
  origin: THREE.Vector3Tuple;
  width: number;
  height: number;
  segmentsX: number;
  segmentsY: number;
  /** Which particles start pinned. Default 'top'. */
  pin?: 'top' | 'corners' | 'none';
  mass?: number;
  stiffness?: number;
  /** Adds diagonal shear and skip-one bend constraints for a stiffer, less stretchy sheet. Default true. */
  shear?: boolean;
}

export interface Cloth {
  /** Row-major particle indices, `(segmentsX + 1) * (segmentsY + 1)`, starting at the top-left. */
  indices: number[];
  columns: number;
  rows: number;
}

/** A sheet in the XY plane hanging down from `origin`. */
export function createCloth(world: VerletWorld, options: ClothOptions): Cloth {
  const { segmentsX, segmentsY } = options;
  if (!(Number.isInteger(segmentsX) && Number.isInteger(segmentsY) && segmentsX > 0 && segmentsY > 0)) throw new RangeError(`Cloth segments must be positive integers, got ${segmentsX}x${segmentsY}`);
  const columns = segmentsX + 1;
  const rows = segmentsY + 1;
  const [ox, oy, oz] = options.origin;
  const indices: number[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) indices.push(world.addParticle(ox + (x / segmentsX) * options.width, oy - (y / segmentsY) * options.height, oz, options.mass ?? 1));
  }
  const at = (x: number, y: number): number => indices[y * columns + x] as number;
  const stiffness = options.stiffness;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (x < segmentsX) world.addConstraint(at(x, y), at(x + 1, y), { stiffness });
      if (y < segmentsY) world.addConstraint(at(x, y), at(x, y + 1), { stiffness });
      if (options.shear ?? true) {
        if (x < segmentsX && y < segmentsY) {
          world.addConstraint(at(x, y), at(x + 1, y + 1), { stiffness: (stiffness ?? 1) * 0.5 });
          world.addConstraint(at(x + 1, y), at(x, y + 1), { stiffness: (stiffness ?? 1) * 0.5 });
        }
        if (x + 2 < columns) world.addConstraint(at(x, y), at(x + 2, y), { stiffness: (stiffness ?? 1) * 0.3 });
        if (y + 2 < rows) world.addConstraint(at(x, y), at(x, y + 2), { stiffness: (stiffness ?? 1) * 0.3 });
      }
    }
  }
  const pin = options.pin ?? 'top';
  if (pin === 'top') for (let x = 0; x < columns; x++) world.pin(at(x, 0));
  else if (pin === 'corners') {
    world.pin(at(0, 0));
    world.pin(at(segmentsX, 0));
  }
  return { indices, columns, rows };
}

/** Indexed grid geometry that mirrors a cloth; call `update` after the world steps. */
export class ClothGeometry extends THREE.BufferGeometry {
  constructor(
    private readonly world: VerletWorld,
    private readonly cloth: Cloth,
  ) {
    super();
    const { columns, rows } = cloth;
    const position = new Float32Array(columns * rows * 3);
    const uv = new Float32Array(columns * rows * 2);
    const index: number[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const i = y * columns + x;
        uv[i * 2] = x / (columns - 1);
        uv[i * 2 + 1] = 1 - y / (rows - 1);
        if (x < columns - 1 && y < rows - 1) index.push(i, i + columns, i + 1, i + 1, i + columns, i + columns + 1);
      }
    }
    this.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.setIndex(index);
    this.update();
  }

  update(): void {
    const attr = this.getAttribute('position') as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    const src = this.world.positions;
    this.cloth.indices.forEach((p, i) => {
      array[i * 3] = src[p * 3] as number;
      array[i * 3 + 1] = src[p * 3 + 1] as number;
      array[i * 3 + 2] = src[p * 3 + 2] as number;
    });
    attr.needsUpdate = true;
    this.computeVertexNormals();
    this.computeBoundingSphere();
  }
}
