import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PointerTracker, pointerToPlane } from '../src/input/pointer';

describe('PointerTracker', () => {
  it('maps positions to NDC and UV and smooths velocity', () => {
    const p = new PointerTracker(document.createElement('div'));
    p.feed('move', 0, 0, 0, 200, 100);
    for (let t = 1; t <= 20; t++) p.feed('move', t * 10, 50, t * 10);
    expect(p.ndc.x).toBeCloseTo(1, 6);
    expect(p.ndc.y).toBeCloseTo(0, 6);
    expect(p.uv.y).toBeCloseTo(0.5, 6);
    // 10 px every 10 ms = 1000 px/s.
    expect(p.velocity.x).toBeGreaterThan(950);
    expect(p.velocity.x).toBeLessThanOrEqual(1000);
    p.update(1000);
    expect(p.speed).toBeLessThan(10);
    p.destroy();
  });

  it('distinguishes taps from drags', () => {
    const p = new PointerTracker(document.createElement('div'), { dragThreshold: 5 });
    const events: string[] = [];
    p.on('tap', () => events.push('tap'));
    p.on('dragStart', () => events.push('start'));
    p.on('drag', (d) => events.push(`drag ${d.delta.x}`));
    p.on('dragEnd', () => events.push('end'));
    p.feed('down', 10, 10, 0, 100, 100);
    p.feed('move', 12, 10, 16);
    p.feed('up', 12, 10, 100);
    p.feed('down', 10, 10, 1000);
    p.feed('move', 20, 10, 1016);
    p.feed('move', 30, 10, 1032);
    p.feed('up', 30, 10, 1048);
    // A slow press without movement is not a tap.
    p.feed('down', 10, 10, 2000);
    p.feed('up', 10, 10, 2500);
    expect(events).toEqual(['tap', 'start', 'drag 10', 'drag 20', 'end']);
    p.destroy();
  });

  it('eases the follower toward the pointer', () => {
    const p = new PointerTracker(document.createElement('div'), { follow: 0.5 });
    p.feed('move', 0, 0, 0, 100, 100);
    p.feed('move', 100, 0, 16);
    p.update(1000 / 60);
    expect(p.smoothed.x).toBeCloseTo(50, 3);
    p.destroy();
  });
});

describe('pointerToPlane', () => {
  it('projects the screen centre onto the ground plane', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 5, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const hit = pointerToPlane(new THREE.Vector2(0, 0), camera, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
    expect(hit?.length()).toBeCloseTo(0, 5);
    expect(pointerToPlane(new THREE.Vector2(0, 0), camera, new THREE.Plane(new THREE.Vector3(0, 1, 0), -10))).toBeNull();
  });
});
