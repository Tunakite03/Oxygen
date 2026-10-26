import * as THREE from 'three';
import { ShaderNotFoundError } from '../core/errors';
import { fetchText } from '../core/net';

/**
 * Named GLSL library and material factory.
 *
 * Bundle format: `{@}<file name>{@}<source>` repeated. A file whose source has `#!UNIFORMS` / `#!VARYINGS` /
 * `#!ATTRIBUTES` sections and `#!SHADER: <name>.vs|.fs` blocks yields one vertex and one fragment entry with the
 * shared declarations prepended; any other file is a chunk. Sources compose with `#require(<name>)` and branch with
 * `#test <condition>` ... `#endtest`, where conditions are resolved by evaluators registered with `addShaderTests`.
 *
 * Materials are GLSL ES 3.00 `RawShaderMaterial`s: GLSL 1 sources are converted (attribute/varying/texture2D/
 * gl_FragColor), duplicate declarations are dropped, and a preamble adds the shared `time`, `timeScale`,
 * `resolution` and `cameraQuaternion` uniforms plus `normalMatrixWorld`.
 */
const library = new Map<string, string>();

export interface ShaderTestContext {
  isMobile: boolean;
}

/** Returns the condition's value, or `undefined` when this evaluator does not know the condition. */
export type ShaderTestEvaluator = (condition: string, context: ShaderTestContext) => boolean | undefined;

const testEvaluators: ShaderTestEvaluator[] = [];

export function addShaderTests(evaluator: ShaderTestEvaluator): void {
  testEvaluators.push(evaluator);
}

function parseSingleShader(code: string, fileName: string): void {
  const section = (tag: string): string => code.split(tag)[1]?.split('#!')[0] ?? '';
  const uniforms = section('#!UNIFORMS');
  const varyings = section('#!VARYINGS');
  const attributes = section('#!ATTRIBUTES');
  let rest = code;
  while (rest.includes('#!SHADER')) {
    rest = rest.slice(rest.indexOf('#!SHADER'));
    const split = rest.split('#!SHADER')[1] ?? '';
    const br = split.indexOf('\n');
    const label = split.slice(0, br);
    const glsl = split.slice(br);
    const base = fileName.split('.')[0] ?? fileName;
    let name = label.split(': ')[1] ?? '';
    if (name.slice(0, 6).includes('Vertex')) name = `${base}.vs`;
    else if (name.slice(0, 8).includes('Fragment')) name = `${base}.fs`;
    else {
      const parts = name.split('.');
      name = `${parts[0] ?? name}${(parts[1] ?? '').includes('vs') ? '.vs' : '.fs'}`;
    }
    library.set(name.trim(), name.includes('.vs') ? attributes + uniforms + varyings + glsl : uniforms + varyings + glsl);
    rest = rest.replace('#!SHADER', '$');
  }
}

function resolveRequires(code: string): string {
  let out = code.replace(/# require/g, '#require');
  let guard = 0;
  while (out.includes('#require(')) {
    const name = (out.split('#require(')[1]?.split(')')[0] ?? '').replace(/ /g, '');
    const dep = library.get(name);
    if (dep === undefined) throw new ShaderNotFoundError(name);
    out = out.replace(`#require(${name})`, dep);
    if (++guard > 500) throw new Error(`Shader require recursion while resolving ${name}`);
  }
  return out;
}

function applyTests(code: string, context: ShaderTestContext): string {
  const evaluate = (cond: string): boolean => {
    const c = cond.trim();
    for (const evaluator of testEvaluators) {
      const result = evaluator(c, context);
      if (result !== undefined) return result;
    }
    throw new Error(`Unsupported shader #test condition: ${c}`);
  };
  let out = code;
  while (out.includes('#test ')) {
    const name = out.split('#test ')[1]?.split('\n')[0] ?? '';
    const glsl = out.split(`#test ${name}\n`)[1]?.split('#endtest')[0] ?? '';
    if (!evaluate(name)) out = out.replace(glsl, '');
    out = out.replace(`#test ${name}\n`, '').replace('#endtest', '');
  }
  return out;
}

/** Parses a shader bundle into the library and resolves every `#require`. */
export function registerShaderBundle(text: string): void {
  const split = text.split('{@}');
  split.shift();
  for (let i = 0; i < split.length; i += 2) {
    const name = split[i] ?? '';
    const body = split[i + 1] ?? '';
    if (body.includes('#!UNIFORMS')) parseSingleShader(body, name);
    else library.set(name, body);
  }
  for (const [key, value] of library) library.set(key, resolveRequires(value));
}

/** Registers one source (a chunk, `<name>.vs` or `<name>.fs`); `#require`s resolve against the current library. */
export function registerShaderSource(name: string, code: string): void {
  library.set(name, resolveRequires(code));
}

export async function loadShaderLibrary(url: string): Promise<void> {
  registerShaderBundle(await fetchText(url));
}

export function hasShader(name: string): boolean {
  return library.has(`${name}.vs`) && library.has(`${name}.fs`);
}

export function getShaderSource(name: string): string {
  const code = library.get(name);
  if (code === undefined) throw new ShaderNotFoundError(name);
  return code;
}

/** Uniforms shared by every material (the render pipeline updates them each frame). */
export const globalUniforms = {
  time: { value: 0 },
  timeScale: { value: 1 },
  resolution: { value: new THREE.Vector2(1, 1) },
  cameraQuaternion: { value: new THREE.Vector4(0, 0, 0, 1) },
};

const VS_HEADER = [
  'precision highp float;',
  'precision highp int;',
  'precision highp sampler3D;',
  'precision highp sampler2DArray;',
  'in vec2 uv;',
  'in vec3 position;',
  'in vec3 normal;',
  'uniform mat3 normalMatrix;',
  'uniform mat3 normalMatrixWorld;',
  'uniform mat4 modelMatrix;',
  'uniform mat4 modelViewMatrix;',
  'uniform mat4 projectionMatrix;',
  'uniform mat4 viewMatrix;',
  'uniform vec3 cameraPosition;',
  'uniform vec4 cameraQuaternion;',
  'uniform vec2 resolution;',
  'uniform float time;',
  'uniform float timeScale;',
].join('\n');

const FS_HEADER = [
  'precision highp float;',
  'precision highp int;',
  'precision highp sampler3D;',
  'precision highp sampler2DArray;',
  'uniform mat3 normalMatrix;',
  'uniform mat3 normalMatrixWorld;',
  'uniform mat4 modelMatrix;',
  'uniform mat4 modelViewMatrix;',
  'uniform mat4 projectionMatrix;',
  'uniform mat4 viewMatrix;',
  'uniform vec3 cameraPosition;',
  'uniform vec4 cameraQuaternion;',
  'uniform vec2 resolution;',
  'uniform float time;',
  'uniform float timeScale;',
  'out vec4 FragColor;',
].join('\n');

const BUILTIN_DECLARATIONS = new Set([
  'normalMatrix',
  'normalMatrixWorld',
  'modelMatrix',
  'modelViewMatrix',
  'projectionMatrix',
  'viewMatrix',
  'cameraPosition',
  'cameraQuaternion',
  'resolution',
  'time',
  'timeScale',
  'uv',
  'position',
  'normal',
]);

/** Removes repeated uniform/varying/attribute declarations (includes often redeclare) and built-ins. */
function dedupeDeclarations(code: string): string {
  const seen = new Set<string>();
  return code
    .split('\n')
    .map((line) => {
      const m = /^\s*(uniform|varying|attribute|in|out)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*;/.exec(line);
      if (!m) return line;
      const [, qualifier, , name] = m;
      if (!name || name === 'FragColor') return line;
      if (qualifier !== 'varying' && BUILTIN_DECLARATIONS.has(name)) return '';
      const key = `${qualifier}:${name}`;
      if (seen.has(key)) return '';
      seen.add(key);
      return line;
    })
    .join('\n');
}

function closeBraces(code: string): string {
  const trimmed = code.trim();
  return trimmed.endsWith('}') ? trimmed : `${trimmed}\n}`;
}

function convert(code: string, type: 'vs' | 'fs', drawBuffers: readonly string[] = []): string {
  let out = dedupeDeclarations(closeBraces(code));
  // MRT: `#drawbuffer Name gl_FragColor = x;` writes the named attachment; without MRT only Color survives.
  for (const name of drawBuffers) out = out.replace(new RegExp(`#drawbuffer ${name}\\s+gl_FragColor`, 'g'), name);
  out = out.replace(/#drawbuffer Color/g, '').replace(/^.*#drawbuffer.*$/gm, '');
  if (type === 'vs') out = out.replace(/\battribute\b/g, 'in').replace(/\bvarying\b/g, 'out');
  else out = out.replace(/\bvarying\b/g, 'in').replace(/gl_FragColor/g, 'FragColor');
  out = out.replace(/texture(2D|Cube)?(Lod|Proj|ProjLod|Grad)?(EXT)?\s*\(/g, (_m, _s: string | undefined, suffix: string | undefined) => `texture${suffix ?? ''}(`);
  return out;
}

export interface MaterialOptions {
  defines?: Record<string, string | number | boolean>;
  isMobile?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  depthTest?: boolean;
  depthWrite?: boolean;
  blending?: THREE.Blending;
  /** Use a different vertex shader than `${name}.vs`. */
  vsName?: string;
  /** Extra MRT outputs (locations 1..n) written by `#drawbuffer <name>` lines. */
  drawBuffers?: readonly string[];
  /** Declarations inserted before the fragment body (e.g. GPU-compute dependency samplers). */
  fsPrefix?: string;
  /** Rewrites the raw library fragment source before `#test` evaluation. */
  fsTransform?: (code: string) => string;
}

export type UniformMap = Record<string, THREE.IUniform>;

function definesBlock(defines: Record<string, string | number | boolean> | undefined): string {
  if (!defines) return '';
  return Object.entries(defines)
    .map(([k, v]) => `#define ${k.toUpperCase()}${v === true ? '' : ` ${String(v)}`}`)
    .join('\n');
}

/** Collects sampler uniforms declared in the code so they default to an empty texture instead of erroring. */
function autoSamplers(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/uniform\s+sampler2D\s+(\w+)\s*;/g)) if (m[1]) names.push(m[1]);
  return names;
}

/** Material from the library's `<name>.vs` / `<name>.fs` (or `options.vsName`), with the shared uniforms merged in. */
export function createShaderMaterial(name: string, uniforms: UniformMap, options: MaterialOptions = {}): THREE.RawShaderMaterial {
  const context: ShaderTestContext = { isMobile: options.isMobile ?? false };
  const vsRaw = applyTests(getShaderSource(`${options.vsName ?? name}.vs`), context);
  const fsSource = getShaderSource(`${name}.fs`);
  const fsRaw = applyTests(options.fsTransform ? resolveRequires(options.fsTransform(fsSource)) : fsSource, context);
  const defs = definesBlock(options.defines);
  const vertexShader = `${defs}\n${VS_HEADER}\n${convert(vsRaw, 'vs')}`;
  const drawBuffers = options.drawBuffers ?? [];
  const fsHeader = drawBuffers.length
    ? FS_HEADER.replace('out vec4 FragColor;', ['layout(location = 0) out vec4 FragColor;', ...drawBuffers.map((n, i) => `layout(location = ${i + 1}) out vec4 ${n};`)].join('\n'))
    : FS_HEADER;
  const fragmentShader = `${defs}\n${fsHeader}\n${options.fsPrefix ?? ''}\n${convert(fsRaw, 'fs', drawBuffers)}`;

  const allUniforms: UniformMap = {
    time: globalUniforms.time,
    timeScale: globalUniforms.timeScale,
    resolution: globalUniforms.resolution,
    cameraQuaternion: globalUniforms.cameraQuaternion,
    normalMatrixWorld: { value: new THREE.Matrix3() },
  };
  for (const s of [...autoSamplers(vsRaw), ...autoSamplers(fsRaw)]) allUniforms[s] = { value: null };
  Object.assign(allUniforms, uniforms);

  const material = new THREE.RawShaderMaterial({
    name,
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: allUniforms,
    side: options.side ?? THREE.FrontSide,
    transparent: options.transparent ?? false,
    depthTest: options.depthTest ?? true,
    depthWrite: options.depthWrite ?? true,
    blending: options.blending ?? THREE.NormalBlending,
  });
  // WebGL's default for a missing attribute is (0, 0, 0, 1); three would otherwise feed white for `color`.
  material.defaultAttributeValues = { color: [0, 0, 0], uv: [0, 0], uv1: [0, 0] };
  if (!material.transparent) {
    material.blending = THREE.NoBlending;
  } else if (material.blending === THREE.NormalBlending) {
    // Straight-alpha blending for colour and alpha: SRC_ALPHA, ONE_MINUS_SRC_ALPHA.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.SrcAlphaFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  }
  return material;
}

const _m3 = new THREE.Matrix3();
/** Keeps `normalMatrixWorld` in sync for a mesh drawn with a library material. */
export function attachWorldNormalMatrix(mesh: THREE.Object3D): void {
  mesh.onBeforeRender = (_r, _s, _c, _g, material) => {
    const m = material as THREE.ShaderMaterial;
    const u = m.uniforms?.normalMatrixWorld;
    if (u) (u.value as THREE.Matrix3).copy(_m3.getNormalMatrix(mesh.matrixWorld));
  };
}
