import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BeadPoints, bokehScale } from '../src/particles/beadPoints';

describe('bokehScale', () => {
  const focus = { distance: 10, range: 4, maxBlur: 3 };

  it('is 1 on the focus plane and grows linearly to 1 + maxBlur at the range', () => {
    expect(bokehScale(10, focus)).toBe(1);
    expect(bokehScale(12, focus)).toBeCloseTo(2.5);
    expect(bokehScale(8, focus)).toBeCloseTo(2.5);
    expect(bokehScale(14, focus)).toBeCloseTo(4);
  });

  it('clamps beyond the range and ignores a negative blur', () => {
    expect(bokehScale(40, focus)).toBeCloseTo(4);
    expect(bokehScale(40, { ...focus, maxBlur: -2 })).toBe(1);
  });

  it('rejects a non-positive range', () => {
    expect(() => bokehScale(1, { ...focus, range: 0 })).toThrow(RangeError);
  });
});

describe('BeadPoints', () => {
  const positions = new Float32Array([0, 0, 0, 1, 2, 3]);

  it('builds per-point attributes with defaults', () => {
    const beads = new BeadPoints({ positions, size: 0.1 });
    expect(beads.count).toBe(2);
    const sizes = beads.object.geometry.getAttribute('size') as THREE.BufferAttribute;
    const colors = beads.object.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(Array.from(sizes.array)).toEqual([0.1, 0.1].map((v) => Math.fround(v)));
    expect(Array.from(colors.array)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(beads.object.frustumCulled).toBe(false);
    beads.dispose();
  });

  it('rejects malformed buffers', () => {
    expect(() => new BeadPoints({ positions: new Float32Array([0, 1]) })).toThrow(/xyz triples/);
    expect(() => new BeadPoints({ positions, colors: new Float32Array(3) })).toThrow(/colors has 3 values, expected 6/);
    expect(() => new BeadPoints({ positions, sizes: new Float32Array(1) })).toThrow(/sizes has 1 values, expected 2/);
    expect(() => new BeadPoints({ positions, wrap: { axis: 'y', length: 0 } })).toThrow(/wrap length/);
    expect(() => new BeadPoints({ positions, depthFade: { start: 10, end: 5 } })).toThrow(/depthFade/);
  });

  it('updates focus, wrap offset and opacity through uniforms', () => {
    const beads = new BeadPoints({ positions, focus: { distance: 5, range: 2, maxBlur: 1 }, wrap: { axis: 'y', length: 30 } });
    const focus = beads.material.uniforms.focus!.value as THREE.Vector3;
    const wrap = beads.material.uniforms.wrap!.value as THREE.Vector4;
    expect(focus.toArray()).toEqual([5, 2, 1]);
    expect(wrap.toArray()).toEqual([1, 0, 0, 30]);
    expect((beads.material.uniforms.depthFade!.value as THREE.Vector2).toArray()).toEqual([0, 0]);

    beads.setFocus({ distance: 9 });
    expect(focus.toArray()).toEqual([9, 2, 1]);
    beads.offset = 4.5;
    expect(wrap.y).toBe(4.5);
    beads.opacity = 0;
    expect(beads.object.visible).toBe(false);
    beads.opacity = 0.5;
    expect(beads.object.visible).toBe(true);
    beads.dispose();
  });

  it('uses additive blending without depth writes when asked', () => {
    const beads = new BeadPoints({ positions, blending: 'additive', shading: 'disc' });
    expect(beads.material.blending).toBe(THREE.AdditiveBlending);
    expect(beads.material.depthWrite).toBe(false);
    expect(beads.material.uniforms.shading!.value).toBe(0);
    beads.dispose();
  });
});
