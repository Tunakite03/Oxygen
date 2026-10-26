import * as THREE from 'three';
import { createAccessiblePipeline, disposeStage, GLTFAssets, onFrame, onMotionChange, prefersReducedMotion, setMotionPreference, setRenderFunction, startLoop, stopLoop, type AccessiblePipeline, type GLTFAsset } from '@tunn/oxygen';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing demo element: ${id}`);
  return result as T;
}
const host = element('scene');
const fallback = element('fallback');
const status = element('status');
const motion = element<HTMLSelectElement>('motion');
let mounted: AccessiblePipeline | null = null;
let assets: GLTFAssets | null = null;
let loaded: GLTFAsset | null = null;
let cancelLoad: AbortController | null = null;
let cleanup: () => void = () => {};
let generation = 0;

function unmount(): void {
  generation++;
  cancelLoad?.abort();
  cancelLoad = null;
  cleanup();
  cleanup = () => {};
  assets?.dispose();
  assets = null;
  loaded = null;
  mounted?.dispose();
  mounted = null;
  stopLoop();
  disposeStage();
  host.dataset.state = 'unmounted';
  status.textContent = 'Scene unmounted.';
}

function mount(): void {
  unmount();
  mounted = createAccessiblePipeline(host, fallback, { sizeMode: 'container', clearColor: '#20272d' });
  const pipeline = mounted.pipeline;
  if (!pipeline) { host.dataset.state = 'fallback'; status.textContent = mounted.reason?.message ?? ''; return; }
  assets = new GLTFAssets({ renderer: pipeline.renderer });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 4;
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial({ color: '#7dc7ae', wireframe: true });
  const cube = new THREE.Mesh(geometry, material);
  pipeline.scene.add(cube);
  const offMotion = onMotionChange(reduced => { host.dataset.reduced = String(reduced); });
  const offContext = pipeline.onContextChange(state => { host.dataset.state = state; });
  const offFrame = onFrame((_time, delta) => {
    if (!prefersReducedMotion()) cube.rotation.y += delta * 0.0005;
    host.dataset.rotation = String(cube.rotation.y);
  });
  const offRender = setRenderFunction(() => {
    camera.aspect = pipeline.size.width / pipeline.size.height;
    camera.updateProjectionMatrix();
    pipeline.render(camera);
    host.dataset.draws = String(pipeline.renderer.info.render.calls);
  });
  cleanup = () => { offFrame(); offRender(); offMotion(); offContext(); geometry.dispose(); material.dispose(); };
  host.dataset.state = 'ready';
  status.textContent = 'Scene ready.';
  startLoop();
}

motion.addEventListener('change', () => {
  if (motion.value === 'system' || motion.value === 'reduce' || motion.value === 'full') setMotionPreference(motion.value);
});
element('mount').addEventListener('click', mount);
element('unmount').addEventListener('click', unmount);
element('cancel').addEventListener('click', () => cancelLoad?.abort());
element<HTMLFormElement>('asset-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadAsset();
});
async function loadAsset(): Promise<void> {
  const scope = assets;
  const pipeline = mounted?.pipeline;
  if (!scope || !pipeline) { status.textContent = 'Mount a WebGL scene before loading assets.'; return; }
  cancelLoad?.abort();
  const controller = cancelLoad = new AbortController();
  const current = generation;
  status.textContent = 'Loading asset…';
  try {
    const asset = await scope.load(element<HTMLInputElement>('asset-url').value, { signal: controller.signal, timeoutMs: 10000 });
    if (current !== generation || controller.signal.aborted) { asset.dispose(); return; }
    loaded?.dispose();
    loaded = asset;
    pipeline.scene.add(asset.gltf.scene);
    status.textContent = 'Asset loaded.';
    host.dataset.asset = 'loaded';
  } catch (error) {
    if (current !== generation || cancelLoad !== controller) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    host.dataset.asset = 'error';
  }
}
window.addEventListener('pagehide', unmount, { once: true });
mount();
