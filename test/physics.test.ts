import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../src/physics/rigid';
import { Spring, VectorSpring, springStep } from '../src/physics/spring';
import { ClothGeometry, VerletWorld, createCloth, createRope } from '../src/physics/verlet';

describe('springs', () => {
  it('settles on the target and is independent of the step size', () => {
    const coarse = new Spring(0, { frequency: 2, damping: 0.5 });
    const fine = new Spring(0, { frequency: 2, damping: 0.5 });
    coarse.target = fine.target = 1;
    coarse.update(100);
    for (let i = 0; i < 10; i++) fine.update(10);
    expect(coarse.value).toBeCloseTo(fine.value, 10);
    expect(coarse.velocity).toBeCloseTo(fine.velocity, 10);
    for (let i = 0; i < 400; i++) coarse.update(16);
    expect(coarse.settled()).toBe(true);
    expect(coarse.value).toBeCloseTo(1, 4);
  });

  it('overshoots when under-damped and never when critically or over-damped', () => {
    const peak = (damping: number): number => {
      let x = -1;
      let v = 0;
      let max = -Infinity;
      for (let i = 0; i < 300; i++) {
        [x, v] = springStep(x, v, 1 / 120, 3, damping);
        max = Math.max(max, x);
      }
      return max;
    };
    expect(peak(0.2)).toBeGreaterThan(0.3);
    expect(peak(1)).toBeLessThanOrEqual(1e-9);
    expect(peak(2)).toBeLessThanOrEqual(1e-9);
  });

  it('survives a huge step without exploding', () => {
    const [x, v] = springStep(1, 50, 10, 8, 0.3);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it('springs vectors per component in place', () => {
    const value = new THREE.Vector3(0, 0, 0);
    const spring = new VectorSpring(value, new THREE.Vector3(1, 2, 3), { frequency: 4 });
    for (let i = 0; i < 200; i++) spring.update(16);
    expect(value.x).toBeCloseTo(1, 4);
    expect(value.z).toBeCloseTo(3, 4);
    expect(spring.settled()).toBe(true);
  });
});

describe('Verlet world', () => {
  it('falls under gravity close to the analytic distance', () => {
    const world = new VerletWorld({ drag: 0, timestep: 1 / 240 });
    const i = world.addParticle(0, 0, 0);
    for (let f = 0; f < 60; f++) world.update(1000 / 60);
    // Position Verlet starting at rest lands within one step's travel of g t^2 / 2.
    expect(world.getPosition(i).y).toBeCloseTo(-0.5 * 9.81, 1);
  });

  it('keeps a rope at its rest length and its pinned end fixed', () => {
    const world = new VerletWorld({ iterations: 30 });
    const rope = createRope(world, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), { segments: 10 });
    for (let f = 0; f < 240; f++) world.update(16.67);
    const first = world.getPosition(rope[0] as number);
    const last = world.getPosition(rope[10] as number);
    expect(first.length()).toBe(0);
    expect(last.distanceTo(first)).toBeLessThanOrEqual(1.02);
    expect(last.y).toBeLessThan(-0.9);
  });

  it('stops particles at plane, sphere and bounds colliders', () => {
    const world = new VerletWorld({ particleRadius: 0.05 });
    world.colliders.push({ type: 'plane', normal: new THREE.Vector3(0, 1, 0), constant: 0 });
    world.colliders.push({ type: 'bounds', min: new THREE.Vector3(-1, -10, -1), max: new THREE.Vector3(1, 10, 1) });
    world.colliders.push({ type: 'sphere', center: new THREE.Vector3(0, 1, 0), radius: 0.5 });
    const a = world.addParticle(0.5, 3, 0);
    world.addVelocity(a, new THREE.Vector3(20, 0, 0));
    const b = world.addParticle(0, 3, 0);
    for (let f = 0; f < 300; f++) world.update(16.67);
    const pa = world.getPosition(a);
    expect(pa.y).toBeGreaterThanOrEqual(0.05 - 1e-6);
    expect(pa.x).toBeLessThanOrEqual(0.95 + 1e-6);
    expect(world.getPosition(b).distanceTo(new THREE.Vector3(0, 1, 0))).toBeGreaterThanOrEqual(0.55 - 1e-3);
  });

  it('builds a pinned cloth and mirrors it into geometry', () => {
    const world = new VerletWorld();
    const cloth = createCloth(world, { origin: [-1, 1, 0], width: 2, height: 2, segmentsX: 8, segmentsY: 6 });
    expect(cloth.indices).toHaveLength(9 * 7);
    expect(world.isPinned(cloth.indices[0] as number)).toBe(true);
    expect(world.isPinned(cloth.indices[9] as number)).toBe(false);
    const geometry = new ClothGeometry(world, cloth);
    expect(geometry.getIndex()?.count).toBe(8 * 6 * 6);
    world.update(500);
    geometry.update();
    const y = (geometry.getAttribute('position') as THREE.BufferAttribute).getY(9 * 6);
    expect(y).toBe(world.getPosition(cloth.indices[9 * 6] as number).y);
    expect(() => world.addConstraint(0, 999)).toThrow(RangeError);
  });
});

describe('Rapier physics world', () => {
  it('drops a box onto a fixed floor, reports the contact and raycasts it', async () => {
    const physics = await PhysicsWorld.create();
    const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 10));
    floor.position.y = -0.5;
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.position.y = 3;
    const parent = new THREE.Group();
    parent.position.x = 2;
    parent.add(box);
    physics.add(floor, { type: 'fixed' });
    physics.add(box, { restitution: 0 });
    const contacts: boolean[] = [];
    physics.onCollision((e) => contacts.push(e.started));
    for (let f = 0; f < 240; f++) physics.update(1000 / 60);
    // Settled on the floor top (y = 0) with half its height above; written back in the parent's local space.
    expect(box.position.y).toBeCloseTo(0.5, 1);
    expect(box.position.x).toBeCloseTo(0, 1);
    expect(contacts[0]).toBe(true);
    const hit = physics.raycast(new THREE.Vector3(2, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(hit?.body.object).toBe(box);
    expect(hit?.point.y).toBeCloseTo(1, 1);
    expect(hit?.normal.y).toBeCloseTo(1, 3);
    physics.remove(box);
    expect(physics.raycast(new THREE.Vector3(2, 10, 0), new THREE.Vector3(0, -1, 0))?.body.object).toBe(floor);
    physics.dispose();
  });

  it('interpolates between fixed steps', async () => {
    const physics = await PhysicsWorld.create({ gravity: [0, 0, 0], timestep: 1 / 10 });
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5));
    physics.add(ball, { shape: { type: 'sphere', radius: 0.5 }, linearVelocity: [1, 0, 0] });
    physics.update(150);
    // One step ran (x = 0.1); half a step is pending, so the object sits halfway between 0 and 0.1.
    expect(ball.position.x).toBeCloseTo(0.05, 3);
    physics.dispose();
  });
});
