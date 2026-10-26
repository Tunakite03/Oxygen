import * as THREE from 'three';
import {
  PointerTracker, bindState, createPipeline, dom, emit, listen, onFrame, setMotionPreference, setRenderFunction, setState,
  startLoop, tween,
} from '@tunn/oxygen';

/** Returns the element with `id`, or throws so a missing demo node fails loudly. */
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing demo element: ${id}`);
  return found as T;
}

startLoop();

// Tweens and DOM tweens: the card moves with the DOM helper, the bar with a numeric tween on a plain object.
const card = element<HTMLDivElement>('tween-card');
const bar = element<HTMLDivElement>('tween-bar');
const meter = { value: 0 };
let open = false;
const motion = element<HTMLSelectElement>('motion');
motion.addEventListener('change', () => {
  if (motion.value === 'system' || motion.value === 'reduce' || motion.value === 'full') setMotionPreference(motion.value);
});
element<HTMLButtonElement>('tween-toggle').addEventListener('click', () => {
  open = !open;
  void dom(card).tween({ x: open ? 160 : 0, opacity: open ? 0.6 : 1 }, 600, 'easeOutBack');
  tween(meter, { value: open ? 1 : 0 }, 900, 'easeInOutCubic').onUpdate(() => {
    bar.style.transform = `scaleX(${meter.value})`;
  });
});

// Events and state: a bus counter and a bound slider value.
let pings = 0;
const pingCount = element('ping-count');
listen<number>('Demo/ping', (count) => {
  pingCount.textContent = String(count);
});
element<HTMLButtonElement>('ping').addEventListener('click', () => {
  pings += 1;
  emit('Demo/ping', pings);
});

const gain = element<HTMLInputElement>('gain');
const gainValue = element('gain-value');
setState('demo.gain', Number(gain.value));
bindState<number>('demo.gain', (value) => {
  gainValue.textContent = value.toFixed(2);
});
gain.addEventListener('input', () => setState('demo.gain', Number(gain.value)));

// Pointer input: the tracker follows the pad; the dot eases toward the smoothed position each frame.
const pad = element<HTMLDivElement>('pointer-pad');
const dot = element<HTMLDivElement>('pointer-dot');
const readout = element('pointer-readout');
const tracker = new PointerTracker(pad);
let taps = 0;
tracker.on('tap', () => {
  taps += 1;
});
onFrame((_time, delta) => {
  tracker.update(delta);
  dot.style.transform = `translate(${tracker.smoothed.x}px, ${tracker.smoothed.y}px)`;
  readout.textContent =
    `ndc ${tracker.ndc.x.toFixed(2)}, ${tracker.ndc.y.toFixed(2)} · speed ${tracker.speed.toFixed(0)} px/s · ` +
    `taps ${taps} · dragging ${tracker.drag.active}`;
});

// Render pipeline: mount an embedded pipeline on demand and release every resource on unmount.
const host = element<HTMLDivElement>('scene-host');
const sceneStatus = element('scene-status');
let teardown: (() => void) | null = null;

function unmount(): void {
  teardown?.();
  teardown = null;
  sceneStatus.textContent = 'Not mounted.';
}

function mount(): void {
  unmount();
  const pipeline = createPipeline(host, { sizeMode: 'container', clearColor: '#14161c' });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 4;
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.25, 160, 20), new THREE.MeshNormalMaterial());
  pipeline.scene.add(knot);
  void pipeline.warmUp(camera);

  const offFrame = onFrame((_time, delta) => {
    knot.rotation.y += delta * 0.001;
  });
  const offRender = setRenderFunction(() => {
    camera.aspect = pipeline.size.width / pipeline.size.height;
    camera.updateProjectionMatrix();
    pipeline.render(camera);
  });
  teardown = () => {
    offFrame();
    offRender();
    pipeline.dispose();
    knot.geometry.dispose();
    (knot.material as THREE.Material).dispose();
  };
  sceneStatus.textContent = `Mounted (${pipeline.status}).`;
}

element<HTMLButtonElement>('mount').addEventListener('click', mount);
element<HTMLButtonElement>('unmount').addEventListener('click', unmount);
window.addEventListener('pagehide', unmount, { once: true });
unmount();
