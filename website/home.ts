import * as THREE from 'three';
import {
  BloomPass,
  ColorGradePass,
  FXAAPass,
  GPUParticles,
  LensPass,
  PointerTracker,
  PostStack,
  Spring,
  VectorSpring,
  createAccessiblePipeline,
  detectGPU,
  disposeStage,
  onFrame,
  onMotionChange,
  pointerToPlane,
  prefersReducedMotion,
  setRenderFunction,
  startLoop,
  stopLoop,
} from '@tunakite03/oxygen';
import { getLanguage, onLanguageChange, requireElement } from './shared/site';

// DOM Element Bindings
const host = requireElement('hero-scene');
const fallback = requireElement('hero-fallback');
const motionControl = requireElement('hero-motion');
const bloomToggle = requireElement('hero-bloom-toggle');
const audioToggle = requireElement('hero-audio-toggle');
const fpsDisplay = document.getElementById('hero-fps');
const tierDisplay = document.getElementById('hero-tier');
const heroHint = document.getElementById('hero-hint');

if (!(motionControl instanceof HTMLButtonElement)) throw new TypeError('Hero motion control must be a button');
if (!(bloomToggle instanceof HTMLButtonElement)) throw new TypeError('Hero bloom toggle must be a button');
if (!(audioToggle instanceof HTMLButtonElement)) throw new TypeError('Hero audio toggle must be a button');
const motionBtn: HTMLButtonElement = motionControl;
const bloomBtn: HTMLButtonElement = bloomToggle;
const audioBtn: HTMLButtonElement = audioToggle;

// Palettes Definition
interface Palette {
  name: string;
  accent: number;
  secondary: number;
  glow: string;
}

const PALETTES: Record<'mint' | 'solar' | 'violet' | 'ice', Palette> = {
  mint: { name: 'mint', accent: 0x00f5a0, secondary: 0x00d2ff, glow: '#00f5a0' },
  solar: { name: 'solar', accent: 0xff9e2c, secondary: 0xff4b4b, glow: '#ff9e2c' },
  violet: { name: 'violet', accent: 0xc084fc, secondary: 0x38bdf8, glow: '#c084fc' },
  ice: { name: 'ice', accent: 0x38bdf8, secondary: 0x818cf8, glow: '#38bdf8' },
};

let currentPalette: Palette = PALETTES.mint;

// Web Audio synthesizer for tactile sound feedback
let audioEnabled = false;
let audioContext: AudioContext | null = null;

function playTone(freq = 520, type: OscillatorType = 'sine', duration = 0.35, gainVal = 0.08): void {
  if (!audioEnabled) return;
  try {
    audioContext ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audioContext.state === 'suspended') void audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioContext.currentTime);
    gain.gain.setValueAtTime(gainVal, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + duration);
  } catch {
    // Audio context unavailable or blocked
  }
}

function playShockwaveSound(): void {
  if (!audioEnabled) return;
  try {
    audioContext ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audioContext.state === 'suspended') void audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(35, audioContext.currentTime + 0.6);
    gain.gain.setValueAtTime(0.12, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.6);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + 0.6);
  } catch {
    // Ignore audio errors
  }
}

// Pipeline Initialization
const mounted = createAccessiblePipeline(host, fallback, {
  sizeMode: 'container',
  clearColor: '#07090f',
  hdr: true,
  samples: 4,
});

const pipeline = mounted.pipeline;

if (!pipeline) {
  host.dataset.state = 'fallback';
  motionBtn.disabled = true;
  bloomBtn.disabled = true;
} else {
  host.dataset.state = 'ready';
  pipeline.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Detect GPU Tier
  const gpuInfo = detectGPU(pipeline.renderer.getContext());
  if (tierDisplay) {
    tierDisplay.textContent = gpuInfo.webgl2 ? `TIER ${gpuInfo.tier || 3}` : 'TIER 1 (WGL1)';
  }

  // Cinematic Post-Processing Stack
  const post = new PostStack(pipeline.renderer);
  const bloomPass = post.add(new BloomPass({ threshold: 0.72, knee: 0.35, intensity: 1.3, radius: 0.85, levels: 5 }));
  const lensPass = post.add(new LensPass({ chromaticAberration: 0.0016, vignette: 0.36, grain: 0.015 }));
  const gradePass = post.add(new ColorGradePass({ toneMapping: 'aces', contrast: 1.08, saturation: 1.15, outputSRGB: true }));
  const fxaaPass = post.add(new FXAAPass());
  pipeline.setPost(post);

  // Perspective Camera
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.set(0, 0, 6.2);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x0a101d, 1.5);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
  keyLight.position.set(4, 6, 5);
  const fillLight = new THREE.PointLight(currentPalette.accent, 3.5, 12);
  fillLight.position.set(-3, -2, 3);
  pipeline.scene.add(ambientLight, keyLight, fillLight);

  // =========================================================================
  // MODE 0: QUANTUM CORE
  // =========================================================================
  const coreGroup = new THREE.Group();

  // Inner Polyhedral Core
  const coreGeo = new THREE.IcosahedronGeometry(0.85, 2);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x070c14,
    roughness: 0.15,
    metalness: 0.85,
    emissive: new THREE.Color(currentPalette.accent),
    emissiveIntensity: 1.8,
  });
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreGroup.add(coreMesh);

  // Outer Orbiting Wireframe Cage
  const cageGeo = new THREE.TorusKnotGeometry(1.06, 0.28, 160, 22, 2, 3);
  const cageMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(currentPalette.secondary),
    wireframe: true,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const cageMesh = new THREE.Mesh(cageGeo, cageMat);
  coreGroup.add(cageMesh);

  // Celestial Orbital Ring
  const ringGeo = new THREE.TorusGeometry(1.72, 0.014, 16, 120);
  const ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(currentPalette.accent),
    transparent: true,
    opacity: 0.7,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.rotation.x = Math.PI / 2.3;
  coreGroup.add(ringMesh);

  // Ambient Star Dust Constellation
  const dustCount = 1200;
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const radius = 2.2 + Math.random() * 2.8;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    dustPos[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    dustPos[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    dustPos[i * 3 + 2] = radius * Math.cos(phi);
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({
    color: new THREE.Color(currentPalette.accent),
    size: 0.016,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  coreGroup.add(dustPoints);

  pipeline.scene.add(coreGroup);

  // =========================================================================
  // MODE 1: GPGPU PARTICLE TEMPEST
  // =========================================================================
  const particles = new GPUParticles(pipeline.renderer, {
    count: Math.min(gpuInfo.tier >= 3 ? 45_000 : 25_000, 50_000),
    emitter: { type: 'sphere', center: [0, 0, 0], radius: 1.35 },
    lifetime: [2.5, 6],
    speed: 0.12,
    drag: 0.85,
    curl: { strength: 1.6, scale: 0.55, speed: 0.16 },
    size: 0.02,
    colorStart: currentPalette.accent,
    colorEnd: currentPalette.secondary,
    opacity: 0.75,
    blending: 'additive',
  });
  particles.object.visible = false;
  pipeline.scene.add(particles.object);

  // =========================================================================
  // MODE 2: KINETIC SPRING MATRIX
  // =========================================================================
  const springsGroup = new THREE.Group();
  const gridRows = 7;
  const gridCols = 7;
  const nodeGeo = new THREE.BoxGeometry(0.18, 0.5, 0.18);
  const nodeMaterialBase = new THREE.MeshStandardMaterial({
    color: 0x0d1420,
    metalness: 0.8,
    roughness: 0.2,
    emissive: new THREE.Color(currentPalette.accent),
    emissiveIntensity: 0.4,
  });

  interface SpringNode {
    mesh: THREE.Mesh;
    baseY: number;
    springY: Spring;
    springScale: Spring;
    mat: THREE.MeshStandardMaterial;
  }

  const springNodes: SpringNode[] = [];
  const spacing = 0.48;
  const offsetX = ((gridCols - 1) * spacing) / 2;
  const offsetZ = ((gridRows - 1) * spacing) / 2;

  for (let r = 0; r < gridRows; r++) {
    for (let c = 0; c < gridCols; c++) {
      const mat = nodeMaterialBase.clone();
      const mesh = new THREE.Mesh(nodeGeo, mat);
      const x = c * spacing - offsetX;
      const z = r * spacing - offsetZ;
      mesh.position.set(x, 0, z);
      springsGroup.add(mesh);
      springNodes.push({
        mesh,
        baseY: 0,
        springY: new Spring(0, { frequency: 3.5, damping: 0.65 }),
        springScale: new Spring(1, { frequency: 4, damping: 0.6 }),
        mat,
      });
    }
  }
  springsGroup.rotation.x = 0.55;
  springsGroup.visible = false;
  pipeline.scene.add(springsGroup);

  // =========================================================================
  // INTERACTIVE CONTROLS & STATE
  // =========================================================================
  type HeroMode = 'core' | 'particles' | 'springs';
  let activeMode: HeroMode = 'core';
  let paused = false;
  let visible = true;
  let disposed = false;
  let simSpeedMultiplier = 1.0;

  // Pointer & Camera Interaction
  const pointer = new PointerTracker(host);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const planeTarget = new THREE.Vector3();

  // Closed-form VectorSpring for Core Rotation
  const coreRotationTarget = new THREE.Vector3(0.35, 0, -0.2);
  const coreRotationSpring = new VectorSpring(
    new THREE.Vector3(coreGroup.rotation.x, coreGroup.rotation.y, coreGroup.rotation.z),
    coreRotationTarget,
    {
      frequency: 3.2,
      damping: 0.7,
    },
  );

  // Switch Mode Function
  function setHeroMode(mode: HeroMode): void {
    activeMode = mode;
    coreGroup.visible = mode === 'core';
    particles.object.visible = mode === 'particles';
    springsGroup.visible = mode === 'springs';

    document.querySelectorAll<HTMLButtonElement>('[data-hero-mode]').forEach((btn) => {
      const isCurrent = btn.dataset.heroMode === mode;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-selected', String(isCurrent));
    });

    const isVi = getLanguage() === 'vi';
    if (heroHint) {
      if (mode === 'core') {
        heroHint.innerHTML = isVi
          ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><path d="M8 2v12M2 8h12"/></svg><span>DI CHUYỂN CHUỘT ĐỂ NGHIÊNG · NHẤP ĐỂ TẠO XUNG LỰC</span>'
          : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><path d="M8 2v12M2 8h12"/></svg><span>DRAG TO ORBIT · CLICK FOR IMPULSE</span>';
      } else if (mode === 'particles') {
        heroHint.innerHTML = isVi
          ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg><span>DI CHUỘT ĐỂ HÚT HẠT · NHẤP/GIỮ ĐỂ ĐẨY NỔ</span>'
          : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg><span>HOVER TO ATTRACT · HOLD/CLICK TO EXPLODE</span>';
      } else {
        heroHint.innerHTML = isVi
          ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2"/></svg><span>RÊ CHUỘT QUA LÒ XO · NHẤP ĐỂ TẠO SÓNG CHẤN</span>'
          : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2"/></svg><span>GLIDE OVER SPRINGS · CLICK TO RIPPLE</span>';
      }
    }

    playTone(mode === 'core' ? 480 : mode === 'particles' ? 620 : 740, 'sine', 0.25);
  }

  // Bind Mode Switch Buttons
  document.querySelectorAll<HTMLButtonElement>('[data-hero-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.heroMode as HeroMode;
      if (m && m !== activeMode) setHeroMode(m);
    });
  });

  // Shockwave Impulse Action (Canvas click)
  function triggerShockwave(): void {
    playShockwaveSound();

    if (activeMode === 'core') {
      coreRotationSpring.velocity.x += (Math.random() - 0.5) * 8;
      coreRotationSpring.velocity.y += 12;
      coreRotationSpring.velocity.z += (Math.random() - 0.5) * 6;
      bloomPass.intensity = 2.4;
      setTimeout(() => {
        if (!disposed) bloomPass.intensity = 1.3;
      }, 350);
    } else if (activeMode === 'particles') {
      particles.attractor.strength = -40;
      bloomPass.intensity = 2.6;
      setTimeout(() => {
        if (!disposed) {
          particles.attractor.strength = 8;
          bloomPass.intensity = 1.3;
        }
      }, 400);
    } else if (activeMode === 'springs') {
      springNodes.forEach((node) => {
        const dist = Math.hypot(node.mesh.position.x, node.mesh.position.z);
        setTimeout(() => {
          if (!disposed) {
            node.springY.impulse(4.5 * Math.max(0.2, 1 - dist * 0.4));
            node.springScale.impulse(3.0 * Math.max(0.2, 1 - dist * 0.4));
          }
        }, dist * 80);
      });
    }
  }

  // Click on Canvas Host triggers impulse
  host.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName.toLowerCase() === 'canvas') {
      triggerShockwave();
    }
  });

  // Bloom Toggle Button
  bloomBtn.addEventListener('click', () => {
    bloomPass.enabled = !bloomPass.enabled;
    bloomBtn.classList.toggle('active', bloomPass.enabled);
    bloomBtn.setAttribute('aria-pressed', String(bloomPass.enabled));
    playTone(bloomPass.enabled ? 600 : 380, 'sine', 0.18);
  });

  // Audio Toggle Button
  const audioBtnLabel = document.getElementById('audio-btn-label');
  audioBtn.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    audioBtn.classList.toggle('active', audioEnabled);
    audioBtn.setAttribute('aria-pressed', String(audioEnabled));
    if (audioBtnLabel) {
      audioBtnLabel.textContent = audioEnabled ? 'AUDIO: ON' : 'AUDIO: OFF';
    }
    if (audioEnabled) {
      playTone(660, 'sine', 0.3);
    }
  });

  // Code Tab Switching
  const CODE_SNIPPETS: Record<string, { filename: string; code: string }> = {
    pipeline: {
      filename: 'first-scene.ts',
      code: `<span class="code-keyword">import</span> * <span class="code-keyword">as</span> THREE <span class="code-keyword">from</span> <span class="code-string">'three'</span>;
<span class="code-keyword">import</span> {
  createPipeline, PostStack, BloomPass,
  ColorGradePass, onFrame, startLoop,
} <span class="code-keyword">from</span> <span class="code-string">'@tunakite03/oxygen'</span>;

<span class="code-comment">// 1. Initialize deterministic engine loop</span>
startLoop();

<span class="code-comment">// 2. Create HDR WebGL 2 pipeline with container sizing</span>
<span class="code-keyword">const</span> host = document.getElementById(<span class="code-string">'scene'</span>)!;
<span class="code-keyword">const</span> pipeline = createPipeline(host, { hdr: <span class="code-keyword">true</span>, samples: <span class="code-number">4</span> });

<span class="code-comment">// 3. Attach cinematic post-processing stack</span>
<span class="code-keyword">const</span> post = <span class="code-keyword">new</span> PostStack(pipeline.renderer);
post.add(<span class="code-keyword">new</span> BloomPass({ threshold: <span class="code-number">0.8</span>, intensity: <span class="code-number">1.2</span>, radius: <span class="code-number">0.75</span> }));
post.add(<span class="code-keyword">new</span> ColorGradePass({ toneMapping: <span class="code-string">'aces'</span>, outputSRGB: <span class="code-keyword">true</span> }));
pipeline.setPost(post);

<span class="code-comment">// 4. Add your three.js objects & frame callback</span>
<span class="code-keyword">const</span> camera = <span class="code-keyword">new</span> THREE.PerspectiveCamera(<span class="code-number">45</span>, <span class="code-number">1</span>, <span class="code-number">0.1</span>, <span class="code-number">100</span>);
camera.position.z = <span class="code-number">5</span>;

<span class="code-keyword">const</span> mesh = <span class="code-keyword">new</span> THREE.Mesh(
  <span class="code-keyword">new</span> THREE.TorusKnotGeometry(<span class="code-number">1</span>, <span class="code-number">0.3</span>, <span class="code-number">180</span>, <span class="code-number">24</span>),
  <span class="code-keyword">new</span> THREE.MeshStandardMaterial({ color: <span class="code-string">'#00f5a0'</span>, roughness: <span class="code-number">0.2</span> })
);
pipeline.scene.add(mesh);

onFrame((_time, delta) =&gt; {
  mesh.rotation.y += delta * <span class="code-number">0.0008</span>;
  pipeline.render(camera);
});`,
    },
    particles: {
      filename: 'gpu-particles.ts',
      code: `<span class="code-keyword">import</span> * <span class="code-keyword">as</span> THREE <span class="code-keyword">from</span> <span class="code-string">'three'</span>;
<span class="code-keyword">import</span> {
  createPipeline, GPUParticles, PointerTracker,
  pointerToPlane, onFrame,
} <span class="code-keyword">from</span> <span class="code-string">'@tunakite03/oxygen'</span>;

<span class="code-keyword">const</span> pipeline = createPipeline(host, { hdr: <span class="code-keyword">true</span> });
<span class="code-keyword">const</span> camera = <span class="code-keyword">new</span> THREE.PerspectiveCamera(<span class="code-number">50</span>, <span class="code-number">1</span>, <span class="code-number">0.1</span>, <span class="code-number">100</span>);
camera.position.z = <span class="code-number">6</span>;

<span class="code-comment">// Spawn 50,000 GPU curl noise particles</span>
<span class="code-keyword">const</span> particles = <span class="code-keyword">new</span> GPUParticles(pipeline.renderer, {
  count: <span class="code-number">50_000</span>,
  emitter: { type: <span class="code-string">'sphere'</span>, center: [<span class="code-number">0</span>, <span class="code-number">0</span>, <span class="code-number">0</span>], radius: <span class="code-number">1.5</span> },
  lifetime: [<span class="code-number">3</span>, <span class="code-number">7</span>],
  speed: <span class="code-number">0.12</span>,
  drag: <span class="code-number">0.85</span>,
  curl: { strength: <span class="code-number">1.5</span>, scale: <span class="code-number">0.6</span>, speed: <span class="code-number">0.15</span> },
  colorStart: <span class="code-number">0x00f5a0</span>,
  colorEnd: <span class="code-number">0x00d2ff</span>,
  size: <span class="code-number">0.02</span>,
});
pipeline.scene.add(particles.object);

<span class="code-keyword">const</span> pointer = <span class="code-keyword">new</span> PointerTracker(pipeline.renderer.domElement);
<span class="code-keyword">const</span> plane = <span class="code-keyword">new</span> THREE.Plane(<span class="code-keyword">new</span> THREE.Vector3(<span class="code-number">0</span>, <span class="code-number">0</span>, <span class="code-number">1</span>), <span class="code-number">0</span>);
<span class="code-keyword">const</span> target = <span class="code-keyword">new</span> THREE.Vector3();

onFrame((_time, delta) =&gt; {
  pointer.update(delta);
  <span class="code-keyword">if</span> (pointer.inside &amp;&amp; pointerToPlane(pointer.ndc, camera, plane, target)) {
    particles.attractor.position.copy(target);
    particles.attractor.strength = pointer.down ? -<span class="code-number">25</span> : <span class="code-number">8</span>;
  }
  particles.update(delta);
  pipeline.render(camera);
});`,
    },
    springs: {
      filename: 'elastic-springs.ts',
      code: `<span class="code-keyword">import</span> * <span class="code-keyword">as</span> THREE <span class="code-keyword">from</span> <span class="code-string">'three'</span>;
<span class="code-keyword">import</span> { VectorSpring, Spring, onFrame } <span class="code-keyword">from</span> <span class="code-string">'@tunakite03/oxygen'</span>;

<span class="code-comment">// Closed-form analytical spring for rotation</span>
<span class="code-keyword">const</span> targetRotation = <span class="code-keyword">new</span> THREE.Vector3();
<span class="code-keyword">const</span> rotationSpring = <span class="code-keyword">new</span> VectorSpring(
  mesh.rotation.toVector3(),
  targetRotation,
  { frequency: <span class="code-number">3.5</span>, damping: <span class="code-number">0.6</span> }
);

<span class="code-comment">// Elastic scale punch spring</span>
<span class="code-keyword">const</span> scaleSpring = <span class="code-keyword">new</span> Spring(<span class="code-number">1</span>, { frequency: <span class="code-number">6</span>, damping: <span class="code-number">0.4</span> });

window.addEventListener(<span class="code-string">'pointermove'</span>, (e) =&gt; {
  <span class="code-keyword">const</span> x = (e.clientX / window.innerWidth) * <span class="code-number">2</span> - <span class="code-number">1</span>;
  <span class="code-keyword">const</span> y = (e.clientY / window.innerHeight) * <span class="code-number">2</span> - <span class="code-number">1</span>;
  targetRotation.set(y * <span class="code-number">0.4</span>, x * <span class="code-number">0.6</span>, <span class="code-number">0</span>);
});

window.addEventListener(<span class="code-string">'click'</span>, () =&gt; {
  <span class="code-comment">// Instant velocity kick that naturally settles</span>
  scaleSpring.impulse(<span class="code-number">4.5</span>);
});

onFrame((_time, delta) =&gt; {
  rotationSpring.update(delta);
  <span class="code-keyword">const</span> s = scaleSpring.update(delta);
  mesh.scale.setScalar(s);
});`,
    },
    story: {
      filename: 'scroll-story.ts',
      code: `<span class="code-keyword">import</span> { ScrollStory, StoryScene, onFrame } <span class="code-keyword">from</span> <span class="code-string">'@tunakite03/oxygen'</span>;

<span class="code-comment">// Compose multi-chapter scroll-driven 3D story</span>
<span class="code-keyword">const</span> story = <span class="code-keyword">new</span> ScrollStory({
  scrollElement: window,
  smoothDamping: <span class="code-number">0.08</span>,
});

<span class="code-keyword">const</span> heroChapter = <span class="code-keyword">new</span> StoryScene({
  enter: (progress) =&gt; {
    camera.position.z = <span class="code-number">6</span> - progress * <span class="code-number">2</span>;
    bloom.intensity = <span class="code-number">1</span> + progress * <span class="code-number">0.5</span>;
  },
  leave: () =&gt; console.log(<span class="code-string">'Chapter completed'</span>),
});

story.addChapter(heroChapter);
onFrame((_time, delta) =&gt; {
  story.update(delta);
});`,
    },
  };

  const codeContainer = document.getElementById('home-code');
  const codeFilename = document.getElementById('code-snippet-filename');

  document.querySelectorAll<HTMLButtonElement>('[data-code-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.codeTab;
      if (!key || !CODE_SNIPPETS[key]) return;
      document.querySelectorAll('[data-code-tab]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const snippet = CODE_SNIPPETS[key];
      if (codeFilename) codeFilename.textContent = snippet.filename;
      if (codeContainer) codeContainer.innerHTML = snippet.code;
      playTone(500, 'sine', 0.12);
    });
  });

  // Render & Playback Synchronization
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
    motionBtn.setAttribute('aria-pressed', String(stopped));
    motionBtn.disabled = reduced;
    const vi = getLanguage() === 'vi';
    const btnText = document.getElementById('motion-btn-text');
    const btnIcon = document.getElementById('motion-btn-icon');
    if (btnText && btnIcon) {
      if (reduced) {
        btnIcon.textContent = '—';
        btnText.textContent = vi ? 'Đã giảm chuyển động' : 'Reduced motion';
      } else if (paused) {
        btnIcon.textContent = '▷';
        btnText.textContent = vi ? 'Tiếp tục' : 'Resume';
      } else {
        btnIcon.textContent = 'Ⅱ';
        btnText.textContent = vi ? 'Dừng' : 'Pause';
      }
    }
    host.dataset.animated = String(!stopped && visible && !document.hidden);
    if (stopped || !visible || document.hidden) {
      stopLoop();
      render();
    } else {
      startLoop();
    }
  }

  // Rolling FPS Calculator
  let frameCount = 0;
  let lastFpsUpdate = performance.now();

  // Frame Callback Loop
  const offFrame = onFrame((_time, delta) => {
    const dt = delta * simSpeedMultiplier;

    // FPS Meter
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
      if (fpsDisplay) fpsDisplay.textContent = `${fps} FPS`;
      frameCount = 0;
      lastFpsUpdate = now;
    }

    pointer.update(delta);

    // Update Mode 0: Quantum Core
    if (activeMode === 'core') {
      coreRotationTarget.set(
        0.35 + pointer.ndc.y * 0.45,
        coreGroup.rotation.y + dt * 0.0003 + pointer.ndc.x * 0.1,
        -0.2 - pointer.ndc.x * 0.35,
      );
      coreRotationSpring.update(dt);
      coreGroup.rotation.set(coreRotationSpring.value.x, coreRotationSpring.value.y, coreRotationSpring.value.z);
      coreMesh.rotation.y -= dt * 0.0006;
      coreMesh.rotation.x += dt * 0.0004;
      cageMesh.rotation.y += dt * 0.0005;
      ringMesh.rotation.z += dt * 0.0008;
      dustPoints.rotation.y += dt * 0.00015;
    }

    // Update Mode 1: Particle Tempest
    else if (activeMode === 'particles') {
      if (pointer.inside && pointerToPlane(pointer.ndc, camera, plane, planeTarget)) {
        particles.attractor.position.copy(planeTarget);
        particles.attractor.strength = pointer.down ? -28 : 8.5;
        particles.attractor.radius = 2.8;
      } else {
        particles.attractor.strength = 1.2;
        particles.attractor.position.set(0, 0, 0);
      }
      particles.update(dt);
    }

    // Update Mode 2: Kinetic Spring Matrix
    else if (activeMode === 'springs') {
      let pointerWorldX = 0;
      let pointerWorldZ = 0;
      let hasPointer = false;
      if (pointer.inside && pointerToPlane(pointer.ndc, camera, plane, planeTarget)) {
        pointerWorldX = planeTarget.x;
        pointerWorldZ = planeTarget.y; // on rotated ground
        hasPointer = true;
      }

      springNodes.forEach((node) => {
        let targetY = node.baseY;
        let targetScale = 1.0;

        if (hasPointer) {
          const dx = node.mesh.position.x - pointerWorldX;
          const dz = node.mesh.position.z - pointerWorldZ;
          const dist = Math.hypot(dx, dz);
          if (dist < 1.1) {
            const influence = Math.cos((dist / 1.1) * (Math.PI / 2));
            targetY = influence * 0.85;
            targetScale = 1.0 + influence * 0.75;
            node.mat.emissiveIntensity = 0.4 + influence * 2.0;
          } else {
            node.mat.emissiveIntensity = 0.4;
          }
        } else {
          node.mat.emissiveIntensity = 0.4;
        }

        node.springY.target = targetY;
        node.springScale.target = targetScale;
        const curY = node.springY.update(dt);
        const curScale = node.springScale.update(dt);
        node.mesh.position.y = curY;
        node.mesh.scale.set(curScale, curScale, curScale);
        node.mesh.rotation.y += dt * 0.0004;
      });
    }
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

  motionBtn.addEventListener('click', () => {
    paused = !paused;
    syncPlayback();
    playTone(paused ? 360 : 540, 'sine', 0.15);
  });

  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('pageshow', syncPlayback);

  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    if (event.persisted) {
      stopLoop();
      return;
    }
    disposed = true;
    observer.disconnect();
    sizeObserver.disconnect();
    pointer.destroy();
    offFrame();
    offRender();
    offMotion();
    offLanguage();
    document.removeEventListener('visibilitychange', syncPlayback);
    window.removeEventListener('pageshow', syncPlayback);

    // Dispose Three.js GPU objects
    coreGeo.dispose();
    coreMat.dispose();
    cageGeo.dispose();
    cageMat.dispose();
    ringGeo.dispose();
    ringMat.dispose();
    dustGeo.dispose();
    dustMat.dispose();
    nodeGeo.dispose();
    nodeMaterialBase.dispose();
    springNodes.forEach((n) => n.mat.dispose());
    particles.dispose();

    pipeline.setPost(null);
    post.dispose();
    bloomPass.dispose();
    lensPass.dispose();
    gradePass.dispose();
    fxaaPass.dispose();
    mounted.dispose();
    stopLoop();
    disposeStage();
  });

  render();
}
