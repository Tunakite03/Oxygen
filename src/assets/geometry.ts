import * as THREE from 'three';
import { z } from 'zod';
import { AssetLoadError, GeometryFormatError } from '../core/errors';
import { fetchBuffer, fetchJson } from '../core/net';
import { cleanAssetPath } from '../core/paths';

/**
 * Geometry loaders:
 * - `.bin`: 10-byte ASCII header length + JSON header ({name,type,attributes:[[name,typeIndex]]}) + Draco payload,
 *   decoded with Google's Draco wasm decoder. Attribute unique id = header index. type 0 = mesh, type 2 = skeletal
 *   animation (offset_i/orientation_i/scale_i per frame). Bones travel as Draco metadata (`json` entry).
 * - `.json`: BufferGeometry JSON ({metadata:{type:"BufferGeometry"},data:{attributes,index}}).
 */
const TYPED_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array] as const;
type TypedArrayCtor = (typeof TYPED_ARRAYS)[number];

const binHeaderSchema = z.object({
  name: z.string(),
  type: z.number(),
  attributes: z.array(z.tuple([z.string(), z.number().int().min(0).max(8)])),
  duration: z.number().optional(),
  frameCount: z.number().int().optional(),
  frameTimes: z.array(z.number()).optional(),
});

const jsonGeometrySchema = z.object({
  metadata: z.object({ type: z.string() }).loose(),
  data: z.object({
    attributes: z.record(z.string(), z.object({ type: z.string(), itemSize: z.number().int(), array: z.array(z.number()) }).loose()),
    index: z.object({ type: z.string(), array: z.array(z.number()) }).loose().optional(),
  }),
  userData: z.record(z.string(), z.unknown()).optional(),
});

export interface BoneDef {
  name: string;
  parent: number;
  pos: number[];
  rot: number[];
  scl: number[];
}

export interface SkinAnimationKey {
  time: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scl: [number, number, number];
}

export interface SkinAnimationData {
  duration: number;
  frameCount: number;
  skeleton: { keys: SkinAnimationKey[] }[];
}

interface DracoModule {
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoGeometry;
  PointCloud: new () => DracoGeometry;
  MetadataQuerier: new () => { GetStringEntry(metadata: unknown, key: string): string };
  TRIANGULAR_MESH: number;
  POINT_CLOUD: number;
  DT_FLOAT32: number;
  DT_INT8: number;
  DT_INT16: number;
  DT_INT32: number;
  DT_UINT8: number;
  DT_UINT16: number;
  DT_UINT32: number;
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  destroy(obj: unknown): void;
}
interface DracoGeometry {
  ptr: number;
  num_points(): number;
  num_faces(): number;
}
interface DracoAttribute {
  num_components(): number;
}
interface DracoDecoder {
  GetEncodedGeometryType(bytes: Int8Array): number;
  DecodeArrayToMesh(bytes: Int8Array, len: number, out: DracoGeometry): { ok(): boolean; error_msg(): string };
  DecodeArrayToPointCloud(bytes: Int8Array, len: number, out: DracoGeometry): { ok(): boolean; error_msg(): string };
  GetAttributeByUniqueId(geom: DracoGeometry, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(geom: DracoGeometry, attr: DracoAttribute, type: number, byteLength: number, ptr: number): boolean;
  GetTrianglesUInt32Array(geom: DracoGeometry, byteLength: number, ptr: number): boolean;
  GetMetadata(geom: DracoGeometry): { ptr: number };
}

declare global {
  interface Window {
    DracoDecoderModule?: (config: { wasmBinary: ArrayBuffer; onModuleLoaded?: (m: DracoModule) => void }) => void;
  }
}

export interface GeometrySetup {
  /** Directory holding `draco_wasm_wrapper.js` and `draco_decoder.wasm`, with a trailing slash. */
  dracoDecoderPath: string;
  /** Directory that bare geometry names resolve against, with a trailing slash. */
  geometryPath: string;
}

let setup: GeometrySetup | null = null;
let dracoPromise: Promise<DracoModule> | null = null;

export function configureGeometry(next: GeometrySetup): void {
  setup = next;
}

function geometrySetup(): GeometrySetup {
  if (!setup) throw new Error('configureGeometry() must run before loading geometry');
  return setup;
}

function loadDraco(): Promise<DracoModule> {
  dracoPromise ??= (async () => {
    const dracoPath = geometrySetup().dracoDecoderPath;
    const [wasmBinary] = await Promise.all([
      fetchBuffer(`${dracoPath}draco_decoder.wasm`),
      new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${dracoPath}draco_wasm_wrapper.js`;
        script.onload = () => resolve();
        script.onerror = () => reject(new AssetLoadError(script.src, 'script failed to load'));
        document.head.appendChild(script);
      }),
    ]);
    const factory = window.DracoDecoderModule;
    if (!factory) throw new AssetLoadError(`${dracoPath}draco_wasm_wrapper.js`, 'DracoDecoderModule global missing');
    return new Promise<DracoModule>((resolve) => factory({ wasmBinary, onModuleLoaded: resolve }));
  })();
  return dracoPromise;
}

function dracoDataType(draco: DracoModule, ctor: TypedArrayCtor): number {
  switch (ctor) {
    case Float32Array:
      return draco.DT_FLOAT32;
    case Int8Array:
      return draco.DT_INT8;
    case Int16Array:
      return draco.DT_INT16;
    case Int32Array:
      return draco.DT_INT32;
    case Uint8Array:
      return draco.DT_UINT8;
    case Uint16Array:
      return draco.DT_UINT16;
    case Uint32Array:
      return draco.DT_UINT32;
    default:
      throw new Error(`Unsupported Draco attribute array type ${ctor.name}`);
  }
}

type AttributeArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

interface DecodedDraco {
  header: z.infer<typeof binHeaderSchema>;
  attributes: Map<string, { array: AttributeArray; itemSize: number }>;
  index: Uint32Array | null;
  bones: BoneDef[] | null;
}

async function decodeBin(url: string): Promise<DecodedDraco> {
  const [draco, buffer] = await Promise.all([loadDraco(), fetchBuffer(url)]);
  const textDecoder = new TextDecoder();
  const headerLength = Number.parseInt(textDecoder.decode(buffer.slice(0, 10)), 10);
  if (!Number.isFinite(headerLength)) throw new GeometryFormatError(url, 'missing JSON header length');
  const header = binHeaderSchema.parse(JSON.parse(textDecoder.decode(buffer.slice(10, 10 + headerLength))) as unknown);
  const bytes = new Int8Array(buffer.slice(10 + headerLength));

  const decoder = new draco.Decoder();
  const geometryType = decoder.GetEncodedGeometryType(bytes);
  let geom: DracoGeometry;
  let status: { ok(): boolean; error_msg(): string };
  if (geometryType === draco.TRIANGULAR_MESH) {
    geom = new draco.Mesh();
    status = decoder.DecodeArrayToMesh(bytes, bytes.byteLength, geom);
  } else if (geometryType === draco.POINT_CLOUD) {
    geom = new draco.PointCloud();
    status = decoder.DecodeArrayToPointCloud(bytes, bytes.byteLength, geom);
  } else {
    draco.destroy(decoder);
    throw new GeometryFormatError(url, `unexpected Draco geometry type ${geometryType}`);
  }
  try {
    if (!status.ok() || geom.ptr === 0) throw new GeometryFormatError(url, `Draco decode failed: ${status.error_msg()}`);
    const attributes: DecodedDraco['attributes'] = new Map();
    header.attributes.forEach(([name, typeIndex], uniqueId) => {
      const ctor = TYPED_ARRAYS[typeIndex];
      if (!ctor) throw new GeometryFormatError(url, `attribute ${name} has unknown type index ${typeIndex}`);
      const attribute = decoder.GetAttributeByUniqueId(geom, uniqueId);
      const itemSize = attribute.num_components();
      const numValues = geom.num_points() * itemSize;
      const byteLength = numValues * ctor.BYTES_PER_ELEMENT;
      const ptr = draco._malloc(byteLength);
      decoder.GetAttributeDataArrayForAllPoints(geom, attribute, dracoDataType(draco, ctor), byteLength, ptr);
      const array: AttributeArray = new ctor(draco.HEAPF32.buffer as ArrayBuffer, ptr, numValues).slice();
      draco._free(ptr);
      if (name === 'skinIndex') array.forEach((v, i) => (array[i] = Math.round(v)));
      attributes.set(name, { array, itemSize });
    });
    let index: Uint32Array | null = null;
    if (geometryType === draco.TRIANGULAR_MESH) {
      const numIndices = geom.num_faces() * 3;
      const byteLength = numIndices * 4;
      const ptr = draco._malloc(byteLength);
      decoder.GetTrianglesUInt32Array(geom, byteLength, ptr);
      index = new Uint32Array(draco.HEAPF32.buffer as ArrayBuffer, ptr, numIndices).slice();
      draco._free(ptr);
    }
    let bones: BoneDef[] | null = null;
    const metadata = decoder.GetMetadata(geom);
    if (metadata.ptr) {
      const querier = new draco.MetadataQuerier();
      const json = querier.GetStringEntry(metadata, 'json');
      if (json) {
        const parsed = JSON.parse(json) as { rig?: { bones?: BoneDef[] }; bones?: BoneDef[] };
        bones = parsed.rig?.bones ?? parsed.bones ?? null;
      }
      draco.destroy(querier);
    }
    return { header, attributes, index, bones };
  } finally {
    draco.destroy(geom);
    draco.destroy(decoder);
  }
}

const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>();

async function buildBinGeometry(url: string): Promise<THREE.BufferGeometry> {
  const decoded = await decodeBin(url);
  if (decoded.header.type !== 0) throw new GeometryFormatError(url, `expected mesh (type 0), got type ${decoded.header.type}`);
  const geometry = new THREE.BufferGeometry();
  geometry.name = decoded.header.name;
  for (const [name, { array, itemSize }] of decoded.attributes) geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  if (decoded.index) geometry.setIndex(new THREE.BufferAttribute(decoded.index, 1));
  if (decoded.bones) geometry.userData.bones = decoded.bones;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

async function buildJsonGeometry(url: string): Promise<THREE.BufferGeometry> {
  const parsed = jsonGeometrySchema.parse(await fetchJson(url));
  const geometry = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(parsed.data.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(attr.array), attr.itemSize));
  }
  if (parsed.data.index) {
    const max = parsed.data.index.array.reduce((m, v) => Math.max(m, v), 0);
    geometry.setIndex(new THREE.BufferAttribute(max > 65535 ? new Uint32Array(parsed.data.index.array) : new Uint16Array(parsed.data.index.array), 1));
  }
  if (parsed.userData) geometry.userData = { ...parsed.userData };
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Bare names resolve under `geometryPath`; a name without `.bin` / `.json` gets `.json`. */
export function resolveGeometryPath(path: string): string {
  const base = geometrySetup().geometryPath;
  let p = cleanAssetPath(path);
  if (!p.includes(base)) p = `${base}${p}`;
  if (!p.includes('.json') && !p.includes('.bin')) p += '.json';
  return p;
}

export function loadGeometry(path: string): Promise<THREE.BufferGeometry> {
  const url = resolveGeometryPath(path);
  let cached = geometryCache.get(url);
  if (!cached) {
    cached = url.endsWith('.bin') ? buildBinGeometry(url) : buildJsonGeometry(url);
    geometryCache.set(url, cached);
  }
  return cached;
}

const animationCache = new Map<string, Promise<SkinAnimationData>>();

/** Skeletal animation (.bin type 2): per frame, per bone pos/rot/scl. Rotations are normalised. */
export function loadSkinAnimation(path: string): Promise<SkinAnimationData> {
  const url = resolveGeometryPath(path);
  let cached = animationCache.get(url);
  if (!cached) {
    cached = (async () => {
      const decoded = await decodeBin(url);
      const { header } = decoded;
      if (header.type !== 2 || header.frameCount === undefined || header.duration === undefined) {
        throw new GeometryFormatError(url, 'expected skin animation (type 2) with frameCount and duration');
      }
      const first = decoded.attributes.get('offset_0');
      if (!first) throw new GeometryFormatError(url, 'missing offset_0 attribute');
      const boneCount = first.array.length / 3;
      const skeleton: SkinAnimationData['skeleton'] = [];
      for (let b = 0; b < boneCount; b++) {
        const keys: SkinAnimationKey[] = [];
        for (let i = 0; i < header.frameCount; i++) {
          const off = decoded.attributes.get(`offset_${i}`)?.array;
          const ori = decoded.attributes.get(`orientation_${i}`)?.array;
          const scl = decoded.attributes.get(`scale_${i}`)?.array;
          if (!off || !ori || !scl) throw new GeometryFormatError(url, `frame ${i} is missing transform attributes`);
          const r = [ori[4 * b] ?? 0, ori[4 * b + 1] ?? 0, ori[4 * b + 2] ?? 0, ori[4 * b + 3] ?? 1];
          const l = Math.hypot(r[0]!, r[1]!, r[2]!, r[3]!) || 1;
          keys.push({
            time: header.frameTimes?.[i] ?? i,
            pos: [off[3 * b] ?? 0, off[3 * b + 1] ?? 0, off[3 * b + 2] ?? 0],
            rot: [r[0]! / l, r[1]! / l, r[2]! / l, r[3]! / l],
            scl: [scl[3 * b] ?? 1, scl[3 * b + 1] ?? 1, scl[3 * b + 2] ?? 1],
          });
        }
        skeleton.push({ keys });
      }
      return { duration: header.duration, frameCount: header.frameCount, skeleton };
    })();
    animationCache.set(url, cached);
  }
  return cached;
}
