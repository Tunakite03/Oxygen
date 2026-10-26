import * as THREE from 'three';
import type * as RapierModule from '@dimforge/rapier3d-compat';
import { MissingDependencyError } from '../core/errors';

/**
 * Rigid-body physics on Rapier (`@dimforge/rapier3d-compat`, an optional peer dependency loaded on demand). Bodies
 * are bound to `Object3D`s: the world steps on a fixed timestep and writes interpolated transforms back to the
 * objects, so motion stays smooth at any refresh rate. Shapes can be given or derived from the object's geometry.
 *
 * Bound objects are positioned in world space. Their parents may be transformed; the world converts to local space
 * when it writes back. Object scale is baked into the collider when the body is added.
 */
export type Rapier = typeof RapierModule;

export type ColliderShape =
  | { type: 'box'; halfExtents: THREE.Vector3Tuple }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; halfHeight: number; radius: number }
  | { type: 'cylinder'; halfHeight: number; radius: number }
  /** Convex hull of the object's vertices (or of `points`). */
  | { type: 'convexHull'; points?: Float32Array }
  /** Exact triangle mesh of the object's geometry; use it for fixed bodies only. */
  | { type: 'trimesh' }
  /** Box fitted to the object's geometry bounds. */
  | { type: 'auto' };

export type BodyType = 'dynamic' | 'fixed' | 'kinematic';

export interface BodyOptions {
  type?: BodyType;
  shape?: ColliderShape;
  density?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  linearVelocity?: THREE.Vector3Tuple;
  angularVelocity?: THREE.Vector3Tuple;
  /** Continuous collision detection for fast, small bodies. */
  ccd?: boolean;
  /** Reports collisions without a physical response. */
  sensor?: boolean;
}

export interface PhysicsBody {
  readonly object: THREE.Object3D;
  readonly type: BodyType;
  readonly rigidBody: RapierModule.RigidBody;
  readonly collider: RapierModule.Collider;
}

export interface RaycastHit {
  body: PhysicsBody;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

export interface CollisionEvent {
  a: PhysicsBody;
  b: PhysicsBody;
  /** True when contact starts, false when it ends. */
  started: boolean;
}

export interface PhysicsWorldOptions {
  gravity?: THREE.Vector3Tuple;
  /** Fixed step in seconds. Default 1/60. */
  timestep?: number;
  /** Steps per `update` at most; extra time is dropped. Default 5. */
  maxSubsteps?: number;
  /** An already imported Rapier module; by default it is imported and initialised on `create`. */
  rapier?: Rapier;
}

interface BodyState {
  body: PhysicsBody;
  previous: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  current: { position: THREE.Vector3; quaternion: THREE.Quaternion };
}

async function loadRapier(): Promise<Rapier> {
  try {
    const mod = await import('@dimforge/rapier3d-compat');
    const rapier = (mod.default ?? mod) as Rapier;
    await rapier.init();
    return rapier;
  } catch (err) {
    throw new MissingDependencyError('@dimforge/rapier3d-compat', 'PhysicsWorld', err instanceof Error ? err.message : String(err));
  }
}

/** World-space vertex positions of a mesh's geometry with the object's world scale applied (no rotation/translation). */
function scaledVertices(object: THREE.Object3D, scale: THREE.Vector3): { vertices: Float32Array; indices: Uint32Array | null } {
  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  const position = geometry?.getAttribute('position');
  if (!geometry || !position) throw new Error(`Object "${object.name || object.uuid}" has no geometry to build a collider from`);
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    vertices[i * 3] = position.getX(i) * scale.x;
    vertices[i * 3 + 1] = position.getY(i) * scale.y;
    vertices[i * 3 + 2] = position.getZ(i) * scale.z;
  }
  const index = geometry.getIndex();
  return { vertices, indices: index ? new Uint32Array(index.array) : null };
}

export class PhysicsWorld {
  readonly world: RapierModule.World;
  readonly timestep: number;
  maxSubsteps: number;
  private readonly states = new Map<THREE.Object3D, BodyState>();
  private readonly byCollider = new Map<number, BodyState>();
  private readonly eventQueue: RapierModule.EventQueue;
  private readonly collisionListeners = new Set<(e: CollisionEvent) => void>();
  private accumulator = 0;

  private constructor(
    readonly rapier: Rapier,
    options: PhysicsWorldOptions,
  ) {
    const [gx, gy, gz] = options.gravity ?? [0, -9.81, 0];
    this.world = new rapier.World({ x: gx, y: gy, z: gz });
    this.timestep = options.timestep ?? 1 / 60;
    if (!(this.timestep > 0)) throw new RangeError(`Physics timestep must be positive, got ${this.timestep}`);
    this.world.timestep = this.timestep;
    this.maxSubsteps = options.maxSubsteps ?? 5;
    this.eventQueue = new rapier.EventQueue(true);
  }

  /** Loads Rapier (unless `options.rapier` is given) and creates a world. */
  static async create(options: PhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    return new PhysicsWorld(options.rapier ?? (await loadRapier()), options);
  }

  get bodies(): PhysicsBody[] {
    return [...this.states.values()].map((s) => s.body);
  }

  /** Binds `object` to a new rigid body at its current world transform. */
  add(object: THREE.Object3D, options: BodyOptions = {}): PhysicsBody {
    if (this.states.has(object)) throw new Error(`Object "${object.name || object.uuid}" already has a physics body`);
    const R = this.rapier;
    const type = options.type ?? 'dynamic';
    object.updateWorldMatrix(true, false);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    object.matrixWorld.decompose(position, quaternion, scale);

    const bodyDesc = type === 'fixed' ? R.RigidBodyDesc.fixed() : type === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic();
    bodyDesc.setTranslation(position.x, position.y, position.z).setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    if (options.linearDamping !== undefined) bodyDesc.setLinearDamping(options.linearDamping);
    if (options.angularDamping !== undefined) bodyDesc.setAngularDamping(options.angularDamping);
    if (options.linearVelocity) bodyDesc.setLinvel(...options.linearVelocity);
    if (options.angularVelocity) {
      const [x, y, z] = options.angularVelocity;
      bodyDesc.setAngvel({ x, y, z });
    }
    if (options.ccd) bodyDesc.setCcdEnabled(true);
    const rigidBody = this.world.createRigidBody(bodyDesc);

    const colliderDesc = this.colliderDesc(object, options.shape ?? { type: 'auto' }, scale);
    if (options.density !== undefined) colliderDesc.setDensity(options.density);
    if (options.friction !== undefined) colliderDesc.setFriction(options.friction);
    if (options.restitution !== undefined) colliderDesc.setRestitution(options.restitution);
    if (options.sensor) colliderDesc.setSensor(true);
    colliderDesc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(colliderDesc, rigidBody);

    const body: PhysicsBody = { object, type, rigidBody, collider };
    const state: BodyState = {
      body,
      previous: { position: position.clone(), quaternion: quaternion.clone() },
      current: { position: position.clone(), quaternion: quaternion.clone() },
    };
    this.states.set(object, state);
    this.byCollider.set(collider.handle, state);
    return body;
  }

  private colliderDesc(object: THREE.Object3D, shape: ColliderShape, scale: THREE.Vector3): RapierModule.ColliderDesc {
    const R = this.rapier;
    switch (shape.type) {
      case 'box':
        return R.ColliderDesc.cuboid(...shape.halfExtents);
      case 'sphere':
        return R.ColliderDesc.ball(shape.radius);
      case 'capsule':
        return R.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      case 'cylinder':
        return R.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      case 'convexHull': {
        const points = shape.points ?? scaledVertices(object, scale).vertices;
        const desc = R.ColliderDesc.convexHull(points);
        if (!desc) throw new Error(`Convex hull of "${object.name || object.uuid}" is degenerate`);
        return desc;
      }
      case 'trimesh': {
        const { vertices, indices } = scaledVertices(object, scale);
        return R.ColliderDesc.trimesh(vertices, indices ?? Uint32Array.from({ length: vertices.length / 3 }, (_, i) => i));
      }
      case 'auto': {
        const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!geometry) throw new Error(`Object "${object.name || object.uuid}" has no geometry; give an explicit shape`);
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const box = geometry.boundingBox as THREE.Box3;
        const size = box.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
        const center = box.getCenter(new THREE.Vector3()).multiply(scale);
        return R.ColliderDesc.cuboid(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4)).setTranslation(center.x, center.y, center.z);
      }
    }
  }

  get(object: THREE.Object3D): PhysicsBody | undefined {
    return this.states.get(object)?.body;
  }

  private require(object: THREE.Object3D): BodyState {
    const state = this.states.get(object);
    if (!state) throw new Error(`Object "${object.name || object.uuid}" has no physics body`);
    return state;
  }

  remove(object: THREE.Object3D): void {
    const state = this.states.get(object);
    if (!state) return;
    this.byCollider.delete(state.body.collider.handle);
    this.world.removeRigidBody(state.body.rigidBody);
    this.states.delete(object);
  }

  applyImpulse(object: THREE.Object3D, impulse: THREE.Vector3): void {
    this.require(object).body.rigidBody.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  setVelocity(object: THREE.Object3D, velocity: THREE.Vector3): void {
    this.require(object).body.rigidBody.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
  }

  /** Teleports a body (any type) and clears its interpolation history. */
  setTransform(object: THREE.Object3D, position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    const state = this.require(object);
    const rb = state.body.rigidBody;
    rb.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    if (quaternion) rb.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }, true);
    state.current.position.copy(position);
    if (quaternion) state.current.quaternion.copy(quaternion);
    state.previous.position.copy(state.current.position);
    state.previous.quaternion.copy(state.current.quaternion);
  }

  /** Moves a kinematic body to `position` by the next step, pushing dynamic bodies on the way. */
  setKinematicTarget(object: THREE.Object3D, position: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    const state = this.require(object);
    if (state.body.type !== 'kinematic') throw new Error(`setKinematicTarget needs a kinematic body, "${object.name || object.uuid}" is ${state.body.type}`);
    state.body.rigidBody.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    if (quaternion) state.body.rigidBody.setNextKinematicRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
  }

  onCollision(listener: (e: CollisionEvent) => void): () => void {
    this.collisionListeners.add(listener);
    return () => this.collisionListeners.delete(listener);
  }

  /** Nearest body hit by the ray, or null. `direction` need not be normalised. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 1000): RaycastHit | null {
    const dir = direction.clone().normalize();
    const ray = new this.rapier.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true);
    if (!hit) return null;
    const state = this.byCollider.get(hit.collider.handle);
    if (!state) return null;
    return {
      body: state.body,
      distance: hit.timeOfImpact,
      point: origin.clone().addScaledVector(dir, hit.timeOfImpact),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
    };
  }

  /** Advances by `deltaMs` in fixed steps and writes interpolated transforms to the objects. Returns the steps run. */
  update(deltaMs: number): number {
    this.accumulator += Math.max(0, deltaMs) / 1000;
    let steps = 0;
    while (this.accumulator >= this.timestep && steps < this.maxSubsteps) {
      this.step();
      this.accumulator -= this.timestep;
      steps++;
    }
    if (steps === this.maxSubsteps) this.accumulator = Math.min(this.accumulator, this.timestep);
    this.sync(this.accumulator / this.timestep);
    return steps;
  }

  /** One fixed step, without writing to the objects. */
  step(): void {
    for (const s of this.states.values()) {
      s.previous.position.copy(s.current.position);
      s.previous.quaternion.copy(s.current.quaternion);
    }
    this.world.step(this.eventQueue);
    for (const s of this.states.values()) {
      const t = s.body.rigidBody.translation();
      const r = s.body.rigidBody.rotation();
      s.current.position.set(t.x, t.y, t.z);
      s.current.quaternion.set(r.x, r.y, r.z, r.w);
    }
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const a = this.byCollider.get(h1);
      const b = this.byCollider.get(h2);
      if (!a || !b) return;
      const event: CollisionEvent = { a: a.body, b: b.body, started };
      for (const l of [...this.collisionListeners]) l(event);
    });
  }

  /** Writes body transforms to the objects, blending the last two steps by `alpha` (0..1). */
  sync(alpha = 1): void {
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const world = new THREE.Matrix4();
    const parentInverse = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (const s of this.states.values()) {
      if (s.body.type === 'fixed') continue;
      const object = s.body.object;
      position.lerpVectors(s.previous.position, s.current.position, alpha);
      quaternion.slerpQuaternions(s.previous.quaternion, s.current.quaternion, alpha);
      if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        world.compose(position, quaternion, scale.set(1, 1, 1));
        parentInverse.copy(object.parent.matrixWorld).invert();
        world.premultiply(parentInverse).decompose(position, quaternion, scale);
      }
      object.position.copy(position);
      object.quaternion.copy(quaternion);
    }
  }

  dispose(): void {
    this.states.clear();
    this.byCollider.clear();
    this.collisionListeners.clear();
    this.eventQueue.free();
    this.world.free();
  }
}
