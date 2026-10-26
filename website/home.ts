import * as THREE from 'three';
import { ColorGradePass, PostStack, createAccessiblePipeline, disposeStage, onFrame, onMotionChange, prefersReducedMotion, setRenderFunction, startLoop, stopLoop } from '@tunn/oxygen';
import { getLanguage, onLanguageChange, requireElement } from './shared/site';

const host = requireElement('hero-scene');
const fallback = requireElement('hero-fallback');
const control = requireElement('hero-motion');
if (!(control instanceof HTMLButtonElement)) throw new TypeError('Oxygen homepage motion control must be a button');
const toggle: HTMLButtonElement = control;

const mounted = createAccessiblePipeline(host, fallback, { sizeMode: 'container', clearColor: '#0c0e12', samples: 4 });
const pipeline = mounted.pipeline;
if (!pipeline) {
  host.dataset.state = 'fallback';
  toggle.disabled = true;
} else {
  host.dataset.state = 'ready';
  pipeline.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  const post = new PostStack(pipeline.renderer);
  post.add(new ColorGradePass({ toneMapping: 'none', outputSRGB: true }));
  pipeline.setPost(post);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.z = 6.2;
  const geometry = new THREE.TorusKnotGeometry(1.02, 0.34, 240, 22, 2, 3);
  const wireMaterial = new THREE.MeshBasicMaterial({ color: '#94e3c0', wireframe: true, transparent: true, opacity: 0.13, depthWrite: false });
  const pointMaterial = new THREE.PointsMaterial({ color: '#b6f0d3', size: 0.013, transparent: true, opacity: 0.85, depthWrite: false });
  const sculpture = new THREE.Group();
  sculpture.add(new THREE.Mesh(geometry, wireMaterial), new THREE.Points(geometry, pointMaterial));
  sculpture.rotation.set(0.5, 0.3, -0.42);
  pipeline.scene.add(sculpture);

  const pointer = new THREE.Vector2();
  let paused = false;
  let visible = true;
  let disposed = false;

  function render(): void {
    if (disposed || !pipeline) return;
    camera.aspect = pipeline.size.width / pipeline.size.height;
    camera.updateProjectionMatrix();
    pipeline.render(camera);
  }

  function syncPlayback(): void {
    if (disposed) return;
    const reduced = prefersReducedMotion();
    const stopped = paused || reduced;
    toggle.setAttribute('aria-pressed', String(stopped));
    toggle.disabled = reduced;
    const vi = getLanguage() === 'vi';
    toggle.textContent = reduced ? (vi ? 'Đã giảm chuyển động' : 'Reduced motion')
      : paused ? (vi ? 'Tiếp tục chuyển động ▷' : 'Resume motion ▷') : (vi ? 'Dừng chuyển động Ⅱ' : 'Pause motion Ⅱ');
    host.dataset.animated = String(!stopped && visible && !document.hidden);
    if (stopped || !visible || document.hidden) {
      stopLoop();
      render();
    } else startLoop();
  }

  const offFrame = onFrame((_time, delta) => {
    sculpture.rotation.y += delta * 0.00012;
    sculpture.rotation.x += (0.5 + pointer.y * 0.15 - sculpture.rotation.x) * Math.min(delta * 0.004, 1);
    sculpture.rotation.z += (-0.42 + pointer.x * 0.12 - sculpture.rotation.z) * Math.min(delta * 0.004, 1);
  });
  const offRender = setRenderFunction(render);
  const offMotion = onMotionChange(syncPlayback);
  const offLanguage = onLanguageChange(syncPlayback);
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    syncPlayback();
  });
  observer.observe(host);
  const sizeObserver = new ResizeObserver(render);
  sizeObserver.observe(host);
  host.addEventListener('pointermove', (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1);
  });
  host.addEventListener('pointerleave', () => pointer.set(0, 0));
  toggle.addEventListener('click', () => { paused = !paused; syncPlayback(); });
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('pageshow', syncPlayback);
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    if (event.persisted) { stopLoop(); return; }
    disposed = true;
    observer.disconnect();
    sizeObserver.disconnect();
    offFrame();
    offRender();
    offMotion();
    offLanguage();
    document.removeEventListener('visibilitychange', syncPlayback);
    window.removeEventListener('pageshow', syncPlayback);
    geometry.dispose();
    wireMaterial.dispose();
    pointMaterial.dispose();
    pipeline.setPost(null);
    post.dispose();
    mounted.dispose();
    stopLoop();
    disposeStage();
  });
  render();
}
