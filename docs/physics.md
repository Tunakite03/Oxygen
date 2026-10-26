# Physics

Three solvers for three jobs:

| Need | Use |
| --- | --- |
| UI motion, hover, magnetic cursors, camera follow | `Spring`, `VectorSpring` |
| Ropes, cloth, flags, soft hanging things | `VerletWorld` with `createRope`, `createCloth`, `ClothGeometry` |
| Stacks, throws, collisions between solid objects | `PhysicsWorld` (Rapier) |

## Springs

Damped springs solved in closed form, so a step of any length lands where the continuous spring would be: motion is
identical at 30, 60 or 144 Hz and a long frame cannot make it explode.

```ts
import { Spring, VectorSpring } from '@tunn/oxygen';

const scale = new Spring(1, { frequency: 3.5, damping: 0.35 }); // Hz, damping ratio
scale.target = 1.4;
onFrame((_t, delta) => (mesh.scale.setScalar(scale.update(delta))));

const follow = new VectorSpring(mesh.position, target, { frequency: 2, damping: 1 }); // updates mesh.position in place
```

`damping` below 1 overshoots and bounces, 1 settles fastest without overshoot, above 1 is sluggish. `impulse(v)` kicks
the velocity, `snap(v)` jumps to rest, `settled()` tells when to stop updating. `springStep` is the raw solver.

## Verlet: ropes and cloth

Position-based dynamics on a fixed timestep (default 1/120 s, at most 8 steps per update). Constraints are relaxed
`iterations` times per step; more iterations make stiffer material.

```ts
import { ClothGeometry, VerletWorld, createCloth } from '@tunn/oxygen';

const world = new VerletWorld({ gravity: [0, -9.81, 0], iterations: 12, drag: 0.6, particleRadius: 0.03 });
const cloth = createCloth(world, { origin: [-1, 2, 0], width: 2, height: 1.6, segmentsX: 30, segmentsY: 24, pin: 'top' });
const mesh = new THREE.Mesh(new ClothGeometry(world, cloth), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));

const brush = { type: 'sphere' as const, center: new THREE.Vector3(), radius: 0.4 };
world.colliders.push(brush, { type: 'plane', normal: new THREE.Vector3(0, 1, 0), constant: 0 });

onFrame((_t, delta) => {
  brush.center.copy(pointerWorld); // move colliders freely
  world.update(delta);
  (mesh.geometry as ClothGeometry).update(); // copies positions, recomputes normals
});
```

- Particles: `addParticle(x, y, z, mass)` (mass 0 pins), `pin`, `unpin`, `setPosition` (teleport), `moveTo` (keeps the
  motion as velocity, for dragging a pinned corner), `addVelocity`, `getPosition`, `getVelocity`.
- Constraints: `addConstraint(a, b, { length, stiffness })`. `createCloth` adds structural links plus shear and bend
  links unless `shear: false`.
- Colliders: `plane` (the `THREE.Plane` convention, `normal · p + constant >= 0`), `sphere` (pushes out), `bounds`
  (keeps inside a box). Contacts cancel velocity into the surface and remove `friction` of the sliding velocity.

## Rapier rigid bodies

`PhysicsWorld` binds `Object3D`s to [Rapier](https://rapier.rs) bodies. Rapier is an optional peer dependency:

```sh
npm install @dimforge/rapier3d-compat
```

```ts
import { PhysicsWorld } from '@tunn/oxygen';

const physics = await PhysicsWorld.create({ gravity: [0, -9.81, 0] }); // imports and initialises Rapier
physics.add(floor, { type: 'fixed', friction: 0.8 });
physics.add(box, { restitution: 0.2 });                                // box collider fitted to the geometry
physics.add(ball, { shape: { type: 'sphere', radius: 0.2 }, linearVelocity: [0, 5, -10], ccd: true });

physics.onCollision(({ a, b, started }) => started && playSound(a.object, b.object));
onFrame((_t, delta) => physics.update(delta)); // fixed 1/60 s steps, interpolated transforms written back
```

- Shapes: `box`, `sphere`, `capsule`, `cylinder`, `convexHull` (from the geometry or given points), `trimesh` (exact,
  for fixed bodies), `auto` (box fitted to the geometry bounds, the default). The object's world scale is baked in
  when the body is added.
- Body types: `dynamic`, `fixed`, `kinematic` (drive it with `setKinematicTarget`, it pushes dynamic bodies).
- Control: `applyImpulse`, `setVelocity`, `setTransform` (teleport, clears interpolation), `remove`, `raycast(origin,
  direction, maxDistance)` → `{ body, point, normal, distance }`.
- Objects may have transformed parents; transforms are converted to local space when written back.
- `physics.world` and `physics.rapier` expose Rapier directly for joints, character controllers and other features.

If Rapier is not installed or fails to initialise, `create` throws `MissingDependencyError`. Pass `{ rapier }` to reuse
a module you imported yourself.
