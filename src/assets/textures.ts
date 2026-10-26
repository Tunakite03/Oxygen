import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { AssetLoadError } from '../core/errors';
import { fetchBuffer } from '../core/net';
import { cleanAssetPath } from '../core/paths';

/**
 * Texture cache: raw (non colour-managed) values, bitmaps flipped at decode, clamp or repeat wrapping, one texture per
 * path and alpha mode. Loads are tracked so a boot sequence can await them before GPU warm-up. A failed load is
 * evicted from the cache so the next request downloads again.
 */
// Bitmaps are decoded premultiplied unless a caller asks for `premultiplyAlpha: false` (RGBM env maps, PBR inputs).
let ktx2Loader: KTX2Loader | null = null;
const cache = new Map<string, THREE.Texture>();
const pending = new Set<Promise<unknown>>();

export interface TextureSetup {
  /** Directory holding three's `basis_transcoder.js` / `.wasm`, with a trailing slash. */
  ktx2TranscoderPath: string;
}

export function initTextures(renderer: THREE.WebGLRenderer, setup: TextureSetup): void {
  ktx2Loader?.dispose();
  ktx2Loader = new KTX2Loader().setTranscoderPath(setup.ktx2TranscoderPath).detectSupport(renderer);
}

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  void p.then(() => pending.delete(p), () => pending.delete(p));
  return p;
}

export function pendingTextureLoads(): Promise<unknown> {
  return Promise.allSettled([...pending]);
}

function configure(texture: THREE.Texture, repeat: boolean): void {
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
}

export interface TextureOptions {
  premultiplyAlpha?: boolean;
}

/** Downloads through the shared retry and timeout policy, then decodes off the main thread. */
async function decodeBitmap(url: string, premultiply: boolean): Promise<ImageBitmap> {
  const data = await fetchBuffer(url);
  try {
    return await createImageBitmap(new Blob([data]), { imageOrientation: 'flipY', premultiplyAlpha: premultiply ? 'premultiply' : 'none' });
  } catch (error) {
    throw new AssetLoadError(url, error instanceof Error ? error.message : 'image decode failed');
  }
}

/**
 * One texture per path (and alpha mode): `getRepeatTexture` switches the shared texture to REPEAT for every user of
 * that path.
 */
function load(path: string, repeat: boolean, options: TextureOptions): THREE.Texture {
  const src = cleanAssetPath(path);
  const premultiply = options.premultiplyAlpha ?? true;
  const key = `${premultiply ? 'p' : 's'}:${src}`;
  const cached = cache.get(key);
  if (cached) {
    if (repeat && cached.wrapS !== THREE.RepeatWrapping) configure(cached, true);
    return cached;
  }

  const texture = new THREE.Texture();
  texture.name = src;
  configure(texture, repeat);
  cache.set(key, texture);

  const promise = decodeBitmap(src, premultiply).then((bitmap) => {
    texture.image = bitmap;
    texture.flipY = false; // already flipped by ImageBitmap options
    configure(texture, texture.wrapS === THREE.RepeatWrapping);
  });
  void track(promise).catch((err: unknown) => {
    if (cache.get(key) === texture) cache.delete(key);
    texture.dispose();
    console.error('[textures] load failed; the next request will retry', { url: src, error: String(err) });
  });
  return texture;
}

export function getTexture(path: string, options: TextureOptions = {}): THREE.Texture {
  return load(path, false, options);
}

export function getRepeatTexture(path: string, options: TextureOptions = {}): THREE.Texture {
  return load(path, true, options);
}

/** KTX2 (Basis Universal) texture; a `.png` / `.jpg` reference is mapped to its `.ktx2` sibling. */
export async function getKTX2Texture(path: string): Promise<THREE.Texture> {
  if (!ktx2Loader) throw new Error('initTextures() must run before loading KTX2 textures');
  const url = cleanAssetPath(path).replace(/\.(png|jpe?g)$/i, '.ktx2');
  const texture = await track(ktx2Loader.loadAsync(url)).catch((err: unknown) => {
    throw new AssetLoadError(url, err instanceof Error ? err.message : String(err));
  });
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

export function getEmptyTexture(): THREE.Texture {
  const key = 'empty';
  const cached = cache.get(key);
  if (cached) return cached;
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}
