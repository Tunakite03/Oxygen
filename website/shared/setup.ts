import * as THREE from 'three';
import {
  BloomPass, ColorGradePass, DebugGUI, FXAAPass, LensPass, PerfMonitor, PostStack, QualityManager, createPipeline,
  detectGPU, onFrame, onResize, setRenderFunction, stage, startLoop,
} from '@tunakite03/oxygen';
import type { Pipeline, QualityLevel } from '@tunakite03/oxygen';

/**
 * Shared example bootstrap: HDR pipeline, a perspective camera kept at the viewport aspect, the standard post stack
 * (bloom → colour grade with sRGB output → lens → FXAA), quality levels from the GPU tier with adaptive switching, a
 * debug panel and frame statistics.
 */
export interface ExampleLevel extends QualityLevel {
  bloomLevels: number;
  fxaa: boolean;
  particles: number;
}

export const LEVELS: readonly ExampleLevel[] = [
  { name: 'low', dpr: 1, bloomLevels: 4, fxaa: false, particles: 32_768 },
  { name: 'medium', dpr: 1.5, bloomLevels: 5, fxaa: true, particles: 131_072 },
  { name: 'high', dpr: 2, bloomLevels: 6, fxaa: true, particles: 262_144 },
];

export interface Example {
  pipeline: Pipeline;
  camera: THREE.PerspectiveCamera;
  post: PostStack;
  bloom: BloomPass;
  grade: ColorGradePass;
  lens: LensPass;
  fxaa: FXAAPass;
  quality: QualityManager<ExampleLevel>;
  gui: DebugGUI;
}

export function createExample(title: string, options: { clearColor?: THREE.ColorRepresentation; fov?: number } = {}): Example {
  const container = document.querySelector<HTMLElement>('.stage');
  if (!container) throw new Error('Example page needs a .stage element');
  startLoop();
  const pipeline = createPipeline(container, { clearColor: options.clearColor ?? '#07080a', hdr: true, samples: 4 });
  const camera = new THREE.PerspectiveCamera(options.fov ?? 45, stage.width / stage.height, 0.1, 200);
  onResize(() => {
    camera.aspect = stage.width / stage.height;
    camera.updateProjectionMatrix();
  });

  const post = new PostStack(pipeline.renderer);
  const gpu = detectGPU(pipeline.renderer.getContext());
  const quality = new QualityManager({ levels: LEVELS, initial: { tier: gpu.tier } });
  const bloom = post.add(new BloomPass({ threshold: 0.9, knee: 0.4, intensity: 0.9, radius: 0.8, levels: quality.level.bloomLevels }));
  const grade = post.add(new ColorGradePass({ toneMapping: 'aces', outputSRGB: true, exposure: 0 }));
  const lens = post.add(new LensPass({ chromaticAberration: 0.0015, vignette: 0.3, grain: 0.03 }));
  const fxaa = post.add(new FXAAPass());
  pipeline.setPost(post);
  quality.bindPipeline(pipeline);
  quality.onChange((level) => (fxaa.enabled = level.fxaa));
  quality.start();

  const gui = new DebugGUI({ title, storageKey: `oxygen-example-${title}` });
  const perf = new PerfMonitor(pipeline.renderer);
  const perfFolder = gui.addFolder('Performance', { open: false });
  perfFolder.addMonitor('GPU', () => `${gpu.reason} (tier ${gpu.tier})`);
  perfFolder.addMonitor('quality', () => quality.level.name);
  perf.attach(perfFolder);
  const postFolder = gui.addFolder('Post', { open: false });
  postFolder.addBoolean(bloom, 'enabled', { label: 'bloom' });
  postFolder.addNumber(bloom, 'threshold', { min: 0, max: 4, step: 0.01 });
  postFolder.addNumber(bloom, 'intensity', { min: 0, max: 4, step: 0.01 });
  postFolder.addNumber(bloom, 'radius', { min: 0, max: 1, step: 0.01 });
  postFolder.addNumber(grade, 'exposure', { min: -3, max: 3, step: 0.01 });
  postFolder.addNumber(grade, 'contrast', { min: 0.5, max: 1.5, step: 0.01 });
  postFolder.addNumber(grade, 'saturation', { min: 0, max: 2, step: 0.01 });
  postFolder.addSelect(grade, 'toneMapping', ['none', 'reinhard', 'aces']);
  postFolder.addNumber(lens, 'chromaticAberration', { label: 'aberration', min: 0, max: 0.01, step: 0.0001 });
  postFolder.addNumber(lens, 'vignette', { min: 0, max: 1, step: 0.01 });
  postFolder.addNumber(lens, 'grain', { min: 0, max: 0.2, step: 0.001 });
  postFolder.addBoolean(fxaa, 'enabled', { label: 'fxaa' });

  setRenderFunction(() => pipeline.render(camera));
  return { pipeline, camera, post, bloom, grade, lens, fxaa, quality, gui };
}

/** Runs `fn` every frame with the delta in ms. */
export function everyFrame(fn: (deltaMs: number, timeMs: number) => void): () => void {
  return onFrame((time, delta) => fn(delta, time));
}
