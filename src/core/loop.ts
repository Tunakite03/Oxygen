import { setFrameDelta } from './math';
import { updateTweens } from './tween';
import { initializeStage } from './stage';

/**
 * Single requestAnimationFrame loop with ordered phases: tweens, `loop`, `afterLoops`, `beforeRender`, the render
 * function, `postRender`. `frame.delta` is the frame delta in ms (capped at 200) and `frame.time` the rAF timestamp.
 */
export type Phase = 'loop' | 'afterLoops' | 'beforeRender' | 'postRender';
type FrameCallback = (time: number, delta: number) => void;

export const frame = { time: 0, delta: 16.6667, count: 0, hzMultiplier: 1 };

/** 60 / display refresh rate, sampled as the median frame delta snapped to common rates. */
const REFRESH_TABLE = [30, 60, 72, 90, 100, 120, 144, 240];
const refreshSamples: number[] = [];

function sampleRefreshRate(dt: number): void {
  refreshSamples.push(1000 / dt);
  if (refreshSamples.length < 30) return;
  refreshSamples.sort((a, b) => a - b);
  const median = refreshSamples[Math.round(refreshSamples.length / 2)] ?? 60;
  const rate = REFRESH_TABLE.reduce((prev, curr) => (Math.abs(curr - median) < Math.abs(prev - median) ? curr : prev));
  frame.hzMultiplier = 60 / rate;
  refreshSamples.length = 0;
}

const phases: Record<Phase, Set<FrameCallback>> = {
  loop: new Set(),
  afterLoops: new Set(),
  beforeRender: new Set(),
  postRender: new Set(),
};

let renderFn: (() => void) | null = null;
let last = 0;
let running = false;
let animationFrame: number | null = null;

export function onFrame(cb: FrameCallback, phase: Phase = 'loop'): () => void {
  phases[phase].add(cb);
  return () => phases[phase].delete(cb);
}

export function setRenderFunction(fn: () => void): () => void {
  renderFn = fn;
  return () => { if (renderFn === fn) renderFn = null; };
}

function run(phase: Phase): void {
  for (const cb of [...phases[phase]]) cb(frame.time, frame.delta);
}

function tick(tsl: number): void {
  if (!running) return;
  animationFrame = requestAnimationFrame(tick);
  if (document.hidden) { last = 0; return; }
  if (tsl <= last) return;
  const dt = last === 0 ? 16.6667 : tsl - last;
  last = tsl;
  frame.time = tsl;
  frame.delta = Math.min(200, dt);
  frame.count++;
  setFrameDelta(frame.delta);
  sampleRefreshRate(dt);
  updateTweens(frame.delta);
  run('loop');
  run('afterLoops');
  run('beforeRender');
  renderFn?.();
  run('postRender');
}

export function startLoop(): void {
  if (running) return;
  initializeStage();
  running = true;
  last = 0;
  animationFrame = requestAnimationFrame(tick);
}

/** Stops scheduling frames. Subscriptions remain registered so startLoop() can resume them. */
export function stopLoop(): void {
  running = false;
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  last = 0;
  refreshSamples.length = 0;
}
