import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { AssetLoadError, DisposedError } from '../core/errors';
import { fetchBuffer, type FetchOptions } from '../core/net';

export interface GLTFAssetOptions {
  /** Decoder directories must end in '/'. Serve the files shipped with the installed Three version. */
  dracoDecoderPath?: string;
  ktx2TranscoderPath?: string;
  /** Required when loading KTX2 textures. */
  renderer?: THREE.WebGLRenderer;
}

export interface GLTFAsset {
  readonly gltf: GLTF;
  /** Removes all scenes from parents and releases their geometry, materials and textures exactly once. */
  dispose(): void;
}

function release(gltf: GLTF): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  for (const scene of gltf.scenes) {
    scene.removeFromParent();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    });
  }
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

/** An explicit ownership scope for GLB/glTF requests, decoder workers and loaded scenes. */
export class GLTFAssets {
  private disposed = false;
  private readonly requests = new Set<AbortController>();
  private readonly assets = new Set<GLTFAsset>();
  private readonly options: GLTFAssetOptions;

  constructor(options: GLTFAssetOptions = {}) {
    for (const path of [options.dracoDecoderPath, options.ktx2TranscoderPath]) {
      if (path !== undefined && (!path.trim() || !path.endsWith('/'))) throw new RangeError('Decoder path must be a nonempty directory ending in /');
    }
    if (options.ktx2TranscoderPath && !options.renderer) throw new Error('GLTFAssets requires a renderer to detect KTX2 support');
    this.options = { ...options };
  }

  async load(url: string, options: FetchOptions = {}): Promise<GLTFAsset> {
    if (this.disposed) throw new DisposedError('GLTFAssets');
    if (!url.trim()) throw new AssetLoadError(url, 'URL must not be empty');
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Asset timeout must be a positive integer');
    const controller = new AbortController();
    this.requests.add(controller);
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const manager = new THREE.LoadingManager();
    const loader = new GLTFLoader(manager);
    const draco = this.options.dracoDecoderPath ? new DRACOLoader(manager).setDecoderPath(this.options.dracoDecoderPath) : null;
    const ktx2 = this.options.ktx2TranscoderPath && this.options.renderer
      ? new KTX2Loader(manager).setTranscoderPath(this.options.ktx2TranscoderPath).detectSupport(this.options.renderer) : null;
    if (draco) loader.setDRACOLoader(draco);
    if (ktx2) loader.setKTX2Loader(ktx2);
    let rejectAbort: (error: AssetLoadError) => void = () => {};
    const abortError = (): AssetLoadError => new AssetLoadError(url, signal.reason instanceof Error ? signal.reason.message : 'request aborted');
    const abort = (): void => { manager.abort(); rejectAbort(abortError()); };
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    signal.addEventListener('abort', abort, { once: true });
    // Register rejection handling before starting any request, including an already-aborted signal.
    const loading = (async (): Promise<GLTF> => {
      signal.throwIfAborted();
      const data = await fetchBuffer(url, { signal, timeoutMs });
      signal.throwIfAborted();
      const absolute = new URL(url, typeof document === 'undefined' ? undefined : document.baseURI);
      const gltf = await loader.parseAsync(data, new URL('.', absolute).href);
      if (signal.aborted) { release(gltf); throw abortError(); }
      return gltf;
    })();
    try {
      const gltf = await Promise.race([loading, aborted]);
      if (signal.aborted) { release(gltf); throw abortError(); }
      let released = false;
      const asset: GLTFAsset = {
        gltf,
        dispose: (): void => {
          if (released) return;
          released = true;
          release(gltf);
          this.assets.delete(asset);
        },
      };
      this.assets.add(asset);
      return asset;
    } catch (error) {
      if (error instanceof AssetLoadError) throw error;
      throw new AssetLoadError(url, error instanceof Error ? error.message : String(error));
    } finally {
      signal.removeEventListener('abort', abort);
      this.requests.delete(controller);
      draco?.dispose();
      ktx2?.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests) request.abort(new DisposedError('GLTFAssets'));
    this.requests.clear();
    for (const asset of this.assets) asset.dispose();
  }
}
