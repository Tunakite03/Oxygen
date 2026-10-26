import { TransitionPass } from '../src/post/transitionPass';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { GLTFAssets } from '../src/assets/gltf';
import { AudioManager, AudioTrack } from '../src/audio/audioManager';
import { onMotionChange, prefersReducedMotion, setMotionPreference } from '../src/accessibility/motion';
import { createAccessiblePipeline } from '../src/accessibility/fallback';
import { GazeCamera } from '../src/camera/gazeCamera';
import { disposeStage } from '../src/core/stage';
import { frame, onFrame, setRenderFunction, startLoop, stopLoop } from '../src/core/loop';
import { tween, updateTweens } from '../src/core/tween';
import { fetchBuffer } from '../src/core/net';

const subscriptions: (() => void)[] = [];
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  stopLoop();
  disposeStage();
  setMotionPreference('system');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('stops scheduling frames and restarts with a fresh delta and one render callback', () => {
  let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { callbacks.set(++next, callback); return next; });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => { callbacks.delete(id); });
  const advance = (time: number): void => { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(time); };
  const render = vi.fn();
  const listener = vi.fn();
  subscriptions.push(setRenderFunction(render), onFrame(listener));
  startLoop(); startLoop();
  expect(callbacks.size).toBe(1);
  advance(100);
  expect(render).toHaveBeenCalledTimes(1);
  stopLoop();
  expect(callbacks.size).toBe(0);
  startLoop(); advance(100000);
  expect(frame.delta).toBeCloseTo(16.6667);
  expect(listener).toHaveBeenCalledTimes(2);
});

it('settles cancelled tweens and applies reduced motion only to decorative motion', async () => {
  setMotionPreference('reduce');
  const target = { x: 0 };
  const sound = { gain: 0 };
  const visual = tween(target, { x: 10 }, 1000, 'linear', 1000);
  const audio = tween(sound, { gain: 1 }, 1000, 'linear', 0, 'essential');
  await Promise.resolve();
  updateTweens(100);
  expect(target.x).toBe(10);
  expect(sound.gain).toBeCloseTo(0.1);
  await visual.promise();
  const settled = audio.promise();
  audio.stop();
  await settled;
  expect(sound.gain).toBeCloseTo(0.1);
});

it('notifies motion overrides and leaves the camera at its authored position', () => {
  const listener = vi.fn();
  subscriptions.push(onMotionChange(listener));
  setMotionPreference('reduce');
  expect(prefersReducedMotion()).toBe(true);
  expect(listener).toHaveBeenLastCalledWith(true);
  const camera = new GazeCamera();
  camera.setPosition(0, 0, 5);
  camera.wobbleStrength = 10;
  camera.update(100);
  expect(camera.camera.position.toArray()).toEqual([0, 0, 5]);
  expect(camera.inner.position.length()).toBe(0);
  setMotionPreference('full');
  expect(listener).toHaveBeenLastCalledWith(false);
});

it('provides fallback without a canvas and restores caller-owned visibility on dispose', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const host = document.createElement('div');
  const fallback = document.createElement('section');
  fallback.hidden = true;
  const mounted = createAccessiblePipeline(host, fallback);
  expect(mounted.pipeline).toBeNull();
  expect(mounted.reason?.feature).toBe('WebGL 2');
  expect(fallback.hidden).toBe(false);
  expect(host.children.length).toBe(0);
  mounted.dispose();
  expect(fallback.hidden).toBe(true);
});

it('loads a real GLB and releases its geometry and material only once', async () => {
  const bytes = readFileSync('examples/public/models/triangle.glb');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
  const scope = new GLTFAssets();
  const asset = await scope.load('https://example.test/triangle.glb');
  const mesh = asset.gltf.scene.children[0];
  expect(mesh).toBeInstanceOf(THREE.Mesh);
  if (!(mesh instanceof THREE.Mesh)) throw new Error('Expected fixture mesh');
  expect(mesh.geometry.getAttribute('position').count).toBe(3);
  const geometryDisposed = vi.fn();
  mesh.geometry.addEventListener('dispose', geometryDisposed);
  const materialDisposed = vi.fn();
  (mesh.material as THREE.Material).addEventListener('dispose', materialDisposed);
  const parent = new THREE.Scene();
  parent.add(asset.gltf.scene);
  scope.dispose(); asset.dispose(); scope.dispose();
  expect(parent.children.length).toBe(0);
  expect(geometryDisposed).toHaveBeenCalledTimes(1);
  expect(materialDisposed).toHaveBeenCalledTimes(1);
  await expect(scope.load('https://example.test/triangle.glb')).rejects.toThrow('disposed');
});

it('rejects malformed GLB with URL context and does not retry a 404', async () => {
  const fetch = vi.fn(async () => new Response('invalid'));
  vi.stubGlobal('fetch', fetch);
  const scope = new GLTFAssets();
  await expect(scope.load('https://example.test/broken.glb')).rejects.toThrow(/broken.glb/);
  fetch.mockResolvedValue(new Response('', { status: 404 }));
  await expect(scope.load('https://example.test/missing.glb')).rejects.toThrow(/missing.glb.*404/);
  expect(fetch).toHaveBeenCalledTimes(2);
  scope.dispose();
});

it('aborts asset scopes and preserves request timeout failures', async () => {
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    if (init.signal?.aborted) reject(init.signal.reason);
  })));
  const scope = new GLTFAssets();
  const result = scope.load('https://example.test/pending.glb');
  const rejected = expect(result).rejects.toThrow(/pending.glb.*disposed/);
  scope.dispose();
  await rejected;
  await expect(fetchBuffer('https://example.test/timeout.bin', { timeoutMs: 5 })).rejects.toThrow(/timeout.bin/);
});

it('rejects an already-cancelled GLTF request without starting fetch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); controller.abort();
  const scope = new GLTFAssets();
  await expect(scope.load('https://example.test/cancelled.glb', { signal: controller.signal })).rejects.toThrow('cancelled.glb');
  expect(fetch).not.toHaveBeenCalled();
  scope.dispose();
});

it('closes audio ownership, rejects pending resume waits, and removes gesture listeners', async () => {
  const disconnect = vi.fn();
  const resume = vi.fn();
  const close = vi.fn(async (): Promise<void> => {});
  class Context extends EventTarget {
    state = 'suspended'; currentTime = 0; destination = {};
    resume = resume;
    close = close;
    createGain(): object { return { connect: vi.fn(), disconnect, gain: { value: 1, cancelScheduledValues: vi.fn() } }; }
  }
  vi.stubGlobal('AudioContext', Context);
  const manager = new AudioManager();
  const wait = manager.waitRunning();
  const rejected = expect(wait).rejects.toThrow('disposed');
  await manager.dispose(); await manager.dispose();
  await rejected;
  document.dispatchEvent(new Event('click'));
  expect(close).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(resume).not.toHaveBeenCalled();
  expect(() => manager.registerAudio('late', '/late.wav')).toThrow('disposed');
});

it('does not resurrect an audio buffer when decoding finishes after disposal', async () => {
  let resolveDecode: (buffer: AudioBuffer) => void = () => {};
  const decoded = new Promise<AudioBuffer>(resolve => { resolveDecode = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(4))));
  const gain: Partial<GainNode> = { disconnect: vi.fn() };
  const context: Partial<AudioContext> = {
    createGain: () => gain as GainNode,
    decodeAudioData: vi.fn(() => decoded),
  };
  const track = new AudioTrack('pending', context as AudioContext, '/pending.wav', {});
  await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalled());
  const rejection = expect(track.ready).rejects.toThrow('disposed');
  track.dispose();
  resolveDecode({ duration: 1 } as AudioBuffer);
  await rejection;
  expect(track.buffer).toBeNull();
  expect(track.loaded).toBe(false);
});

it('settles pending captures and transitions when the pass is disposed', async () => {
  const pass = new TransitionPass();
  const capture = pass.capture();
  const playing = pass.play(1000);
  pass.dispose();
  await Promise.all([capture, playing]);
  expect(pass.enabled).toBe(false);
  expect(() => pass.capture()).toThrow('disposed');
  await expect(pass.play(1000)).rejects.toThrow('disposed');
  pass.dispose();
});
