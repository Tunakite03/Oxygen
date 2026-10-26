import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ShaderNotFoundError } from '../src/core/errors';
import { addShaderTests, createShaderMaterial, getShaderSource, hasShader, registerShaderBundle, registerShaderSource } from '../src/gl/shaderLibrary';

const bundle = [
  '{@}common.glsl{@}float double(float v) { return v * 2.0; }',
  [
    '{@}Tint.glsl{@}#!ATTRIBUTES',
    'attribute vec3 offset;',
    '#!UNIFORMS',
    'uniform vec3 uColor;',
    'uniform sampler2D tMap;',
    '#!VARYINGS',
    'varying vec2 vUv;',
    '#!SHADER: Tint.vs',
    '#require(common.glsl)',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + offset, 1.0);',
    '}',
    '#!SHADER: Tint.fs',
    'void main() {',
    '#test quality.high',
    '  gl_FragColor = texture2D(tMap, vUv) * vec4(uColor, 1.0);',
    '#endtest',
    '#test !quality.high',
    '  gl_FragColor = vec4(uColor, 1.0);',
    '#endtest',
    '}',
  ].join('\n'),
].join('');

addShaderTests((condition, { isMobile }) => {
  if (condition === 'quality.high') return !isMobile;
  if (condition === '!quality.high') return isMobile;
  return undefined;
});
registerShaderBundle(bundle);

describe('shader library', () => {
  it('splits shader files into vertex and fragment entries with shared declarations', () => {
    expect(hasShader('Tint')).toBe(true);
    const vs = getShaderSource('Tint.vs');
    expect(vs).toContain('attribute vec3 offset;');
    expect(vs).toContain('float double(float v)');
    expect(getShaderSource('Tint.fs')).not.toContain('attribute vec3 offset;');
  });

  it('builds GLSL 3 materials with the shared uniforms and evaluates #test blocks', () => {
    const desktop = createShaderMaterial('Tint', { uColor: { value: new THREE.Color(1, 0, 0) } });
    expect(desktop.glslVersion).toBe(THREE.GLSL3);
    expect(desktop.vertexShader).toMatch(/\bin vec3 offset;/);
    expect(desktop.vertexShader).toMatch(/\bout vec2 vUv;/);
    expect(desktop.fragmentShader).toMatch(/\bin vec2 vUv;/);
    expect(desktop.fragmentShader).toContain('FragColor = texture(tMap, vUv)');
    expect(desktop.fragmentShader).not.toContain('gl_FragColor');
    expect(desktop.uniforms).toHaveProperty('time');
    expect(desktop.uniforms).toHaveProperty('resolution');
    expect(desktop.uniforms.tMap).toEqual({ value: null });

    const mobile = createShaderMaterial('Tint', { uColor: { value: new THREE.Color() } }, { isMobile: true });
    expect(mobile.fragmentShader).not.toContain('texture(tMap');
  });

  it('declares transparent materials with straight-alpha blending and opaque ones without blending', () => {
    expect(createShaderMaterial('Tint', {}, { transparent: true }).blending).toBe(THREE.CustomBlending);
    expect(createShaderMaterial('Tint', {}).blending).toBe(THREE.NoBlending);
  });

  it('fails loudly on missing shaders, missing requires and unknown conditions', () => {
    expect(() => getShaderSource('Missing.fs')).toThrow(ShaderNotFoundError);
    expect(() => registerShaderSource('Broken.vs', '#require(nope.glsl)')).toThrow(ShaderNotFoundError);
    registerShaderSource('Odd.vs', 'void main() { gl_Position = vec4(0.0); }');
    registerShaderSource('Odd.fs', 'void main() {\n#test unknown.flag\ngl_FragColor = vec4(1.0);\n#endtest\n}');
    expect(() => createShaderMaterial('Odd', {})).toThrow(/Unsupported shader #test condition: unknown.flag/);
  });
});
