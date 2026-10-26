import { setMotionPreference } from '../src/accessibility/motion';
import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '../src/core/loop';
import type { Pipeline } from '../src/gl/pipeline';
import { AudioTrack } from '../src/audio/audioManager';
import { configureGeometry, loadGeometry } from '../src/assets/geometry';
import { getKTX2Texture, getTexture, initTextures, pendingTextureLoads } from '../src/assets/textures';
import { Component } from '../src/core/component';
import { emit, getState, listen } from '../src/core/events';
import { stage } from '../src/core/stage';
import { clearTween, tween, updateTweens } from '../src/core/tween';
import { world } from '../src/core/world';
import { Skin } from '../src/gl/skin';
import { interaction3d } from '../src/input/interaction3d';
import { VirtualScroll } from '../src/scroll/virtualScroll';
import { ScrollStory } from '../src/story/scrollStory';
import { StoryScene } from '../src/story/storyScene';
import { layoutText } from '../src/text/msdf';
import type { Font, Glyph } from '../src/text/msdf';
import { dom } from '../src/ui/domTween';

const callbacks = vi.hoisted(() => new Map<(time: number, delta: number) => void, Phase>());
vi.mock('../src/core/loop', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/loop')>(),
  onFrame: (callback: (time: number, delta: number) => void, phase: Phase = 'loop'): (() => void) => {
    callbacks.set(callback, phase);
    return () => { callbacks.delete(callback); };
  },
}));

function frame(): void {
  for (const phase of ['loop', 'afterLoops', 'beforeRender', 'postRender'] as const) {
    for (const [callback, registered] of [...callbacks]) if (registered === phase) callback(16, 16);
  }
}

afterEach(() => {
  setMotionPreference('system');
  callbacks.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('immediate tween cancellation', () => {
  it('cancels a tween before its deferred start', async () => {
    const target = { x: 0 };
    const animation = tween(target, { x: 100 }, 100);
    clearTween(target);
    await Promise.resolve();
    updateTweens(100);
    expect(animation.stopped).toBe(true);
    expect(target.x).toBe(0);
  });

  it('lets an immediate DOM set supersede a pending tween', async () => {
    const element = document.createElement('div');
    void dom(element).tween({ x: 100 }, 100, 'linear');
    dom(element).set({ x: 25 });
    await Promise.resolve();
    updateTweens(100);
    expect(element.style.transform).toBe('translate3d(25px, 0px, 0px)');
  });

  it('keeps only the last replacement created in one turn', async () => {
    const target = { x: 0 };
    const first = tween(target, { x: 100 }, 100);
    tween(target, { x: 25 }, 100);
    await Promise.resolve();
    updateTweens(100);
    expect(first.stopped).toBe(true);
    expect(target.x).toBe(25);
  });
});

describe('geometry attribute round trips', () => {
  it('preserves serialized array types, normalized values and indices', async () => {
    const original = new THREE.BufferGeometry();
    original.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    original.setAttribute('color', new THREE.Uint8BufferAttribute([255, 128, 0, 255, 128, 0, 255, 128, 0], 3, true));
    original.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 2, 3], 1));
    original.setIndex([0, 1, 2]);
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(JSON.stringify(original.toJSON()))));
    configureGeometry({ geometryPath: '/geometry/', dracoDecoderPath: '/draco/' });
    const loaded = await loadGeometry('normalized-regression.json');
    expect(loaded.getAttribute('color').array).toBeInstanceOf(Uint8Array);
    expect(loaded.getAttribute('color').normalized).toBe(true);
    expect(loaded.getAttribute('color').getX(0)).toBe(1);
    expect(loaded.getAttribute('color').getY(0)).toBeCloseTo(128 / 255);
    expect(loaded.getAttribute('skinIndex').array).toBeInstanceOf(Uint16Array);
    expect([...loaded.getIndex()!.array]).toEqual([0, 1, 2]);
  });

  it('rejects unsupported attribute array types with asset context', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      metadata: { type: 'BufferGeometry' },
      data: { attributes: { position: { type: 'InvalidArray', itemSize: 3, array: [0, 0, 0] } } },
    }))));
    configureGeometry({ geometryPath: '/geometry/', dracoDecoderPath: '/draco/' });
    await expect(loadGeometry('invalid-type-regression.json')).rejects.toThrow(/invalid-type-regression.*position.*InvalidArray/);
  });
});

describe('texture rejection cleanup', () => {
  it('settles failed bitmap loads without an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(null, { status: 404 })));
    getTexture('/failed-regression.png');
    await expect(pendingTextureLoads()).resolves.toMatchObject([{ status: 'rejected' }]);
    // Give the runtime an event-loop turn to report any orphaned rejection to Vitest.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(pendingTextureLoads()).resolves.toEqual([]);
  });

  it('evicts a failed texture so the next request downloads it again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bitmap = { width: 1, height: 1, close: (): void => {} } as unknown as ImageBitmap;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(new ArrayBuffer(4)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn(async (): Promise<ImageBitmap> => bitmap));
    const failed = getTexture('/retry-regression.png');
    await pendingTextureLoads();
    const retried = getTexture('/retry-regression.png');
    expect(retried).not.toBe(failed);
    await pendingTextureLoads();
    expect(retried.image).toBe(bitmap);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the KTX2 rejection for callers without an orphaned rejection', async () => {
    vi.spyOn(KTX2Loader.prototype, 'detectSupport').mockReturnThis();
    vi.spyOn(KTX2Loader.prototype, 'loadAsync').mockRejectedValue(new Error('decoder failed'));
    initTextures({} as THREE.WebGLRenderer, { ktx2TranscoderPath: '/basis/' });
    await expect(getKTX2Texture('/failed-regression.ktx2')).rejects.toThrow(/failed-regression.ktx2.*decoder failed/);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(pendingTextureLoads()).resolves.toEqual([]);
  });
});

function audioFixture(): { clock: { value: number }; track: AudioTrack } {
  const clock = { value: 0 };
  function connect(destination: AudioNode): AudioNode;
  function connect(destination: AudioParam): void;
  function connect(destination: AudioNode | AudioParam): AudioNode | void {
    if ('connect' in destination) return destination;
  }
  // Only the Web Audio boundary is stubbed; AudioTrack and its frame callbacks run unchanged.
  const context: Partial<AudioContext> = {
    get currentTime(): number { return clock.value; },
    createGain: (): GainNode => {
      const gain: Partial<GainNode> = { gain: { value: 1 } as AudioParam, connect };
      return gain as GainNode;
    },
    createBufferSource: (): AudioBufferSourceNode => {
      const source: Partial<AudioBufferSourceNode> = {
        start: vi.fn<AudioBufferSourceNode['start']>(), stop: vi.fn<AudioBufferSourceNode['stop']>(),
        connect, disconnect: (): void => {},
      };
      return source as AudioBufferSourceNode;
    },
    decodeAudioData: async (): Promise<AudioBuffer> => ({ duration: 1 } as AudioBuffer),
  };
  vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(new ArrayBuffer(0))));
  return { clock, track: new AudioTrack('regression', context as AudioContext, '/audio.ogg', { baseGain: 0.25 }) };
}

describe('audio playback', () => {
  it.each([0, 0.4])('respects volume %s when playing without a fade', async (volume) => {
    const { track } = audioFixture();
    await track.play({ duration: 0, volume });
    expect(track.gain.gain.value).toBe(volume);
    await track.stop();
  });

  it('uses baseGain when immediate playback omits volume', async () => {
    const { track } = audioFixture();
    await track.play({ duration: 0 });
    expect(track.gain.gain.value).toBe(0.25);
    await track.stop();
  });

  it('notifies once per loop boundary and once for a one-shot', async () => {
    const { clock, track } = audioFixture();
    const complete = vi.fn();
    track.onComplete(complete);
    await track.play({ duration: 0, loop: true });
    for (const time of [0.99, 1.01, 1.02, 1.03, 2.01, 2.02]) {
      clock.value = time;
      frame();
    }
    expect(complete).toHaveBeenCalledTimes(2);
    await track.stop();
    complete.mockClear();
    await track.play({ duration: 0, loop: false });
    clock.value += 1.01;
    frame();
    frame();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(track.playing).toBe(false);
  });

  it('keeps loop notifications aligned when playback starts at an offset', async () => {
    const { clock, track } = audioFixture();
    const complete = vi.fn();
    track.onComplete(complete);
    await track.play({ duration: 0, startFrom: 0.5, loop: true });
    for (const time of [0.49, 0.51, 0.52]) {
      clock.value = time;
      frame();
    }
    expect(complete).toHaveBeenCalledTimes(1);
    clock.value = 1.51;
    frame();
    frame();
    expect(complete).toHaveBeenCalledTimes(2);
    await track.stop();
  });

  it('honors an explicit completion boundary without repeating every frame', async () => {
    const { clock, track } = audioFixture();
    const complete = vi.fn();
    track.onComplete(complete);
    await track.play({ duration: 0, stopTo: 0.5, loop: true });
    for (const time of [0.49, 0.51, 0.52, 1.51, 1.52]) {
      clock.value = time;
      frame();
    }
    expect(complete).toHaveBeenCalledTimes(2);
    await track.stop();
  });
});

describe('weighted skeletal animation', () => {
  it.each([{ positions: [0, 10, 20] }, { positions: [20, 10, 0] }])('blends equal-weight poses $positions independently of order', ({ positions }) => {
    const skin = new Skin(new THREE.BufferGeometry(), new THREE.RawShaderMaterial(), [{ name: 'root', parent: -1, pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }]);
    for (const x of positions) skin.addAnimation({ duration: 0, frameCount: 1, skeleton: [{ keys: [{ time: 0, pos: [x, 0, 0], rot: [0, 0, 0, 1], scl: [1 + x, 1, 1] }] }] });
    skin.update();
    expect(skin.bones[0]!.position.x).toBeCloseTo(10);
    expect(skin.bones[0]!.scale.x).toBeCloseTo(11);
  });

  it('ignores zero-weight poses and respects unequal weights', () => {
    const skin = new Skin(new THREE.BufferGeometry(), new THREE.RawShaderMaterial(), [{ name: 'root', parent: -1, pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }]);
    for (const [x, weight] of [[100, 0], [0, 1], [10, 2], [20, 3]] as const) {
      skin.addAnimation({ duration: 0, frameCount: 1, skeleton: [{ keys: [{ time: 0, pos: [x, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] }] }] }).weight = weight;
    }
    skin.update();
    expect(skin.bones[0]!.position.x).toBeCloseTo(80 / 6);
  });
});

describe('directional font kerning', () => {
  it('applies the pair in reading order, including when kerning entries are unsorted', () => {
    const glyphs: Glyph[] = [...'AV'].map((char) => ({ char, id: char.charCodeAt(0), width: 10, height: 10, xoffset: 0, yoffset: 0, xadvance: 10, x: 0, y: 0 }));
    const font: Font = {
      json: { chars: glyphs, info: { size: 10 }, common: { scaleW: 256, scaleH: 256 }, kernings: [{ first: 90, second: 90, amount: -1 }, { first: 65, second: 86, amount: -2 }] },
      glyphs: new Map(glyphs.map((glyph) => [glyph.char, glyph])), firstGlyph: glyphs[0]!, texture: new THREE.Texture(),
    };
    const options = { width: 100, align: 'left', size: 10, letterSpacing: 0, wordSpacing: 0, lineHeight: 1, paragraphSpacing: 1, indent: 0, wordBreak: false } as const;
    expect(layoutText(font, { ...options, text: 'AV' }).position[12]).toBe(8);
    expect(layoutText(font, { ...options, text: 'VA' }).position[12]).toBe(10);
  });
});

describe('keyboard scroll ownership', () => {
  it('ignores editable, opted-out and handled events but consumes page navigation', async () => {
    const scroll = new VirtualScroll({ drag: false, mouseWheel: true, limit: true, keyboard: true, scale: 1, touchScale: 1 });
    scroll.max.y = 5000;
    try {
      for (const tag of ['textarea', 'input', 'select', 'div']) {
        const element = document.createElement(tag);
        if (tag === 'div') element.setAttribute('contenteditable', 'true');
        document.body.appendChild(element);
        element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      }
      const container = document.createElement('div');
      container.className = 'prevent_interactionScroll';
      const child = document.createElement('span');
      container.appendChild(child);
      document.body.appendChild(container);
      child.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const handled = new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true });
      handled.preventDefault();
      window.dispatchEvent(handled);
      await Promise.resolve();
      updateTweens(400);
      expect(scroll.targetY).toBe(0);
      const navigation = new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true });
      window.dispatchEvent(navigation);
      await Promise.resolve();
      updateTweens(400);
      expect(scroll.targetY).toBe(stage.height);
      expect(navigation.defaultPrevented).toBe(true);
    } finally {
      scroll.destroy();
    }
  });
});

class LifecycleScene extends StoryScene {
  constructor() { super('LifecycleScene', 0); }
}

function storyFixture(): { story: ScrollStory; scene: LifecycleScene; pipeline: Pipeline; root: HTMLDivElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  Object.defineProperty(root, 'clientHeight', { value: 2000 });
  const pipeline: Pipeline = {
    size: { width: 800, height: 600 }, status: 'ready', onContextChange: () => () => {}, dispose: () => {},
    renderer: {} as THREE.WebGLRenderer,
    scene: new THREE.Scene(), uiScene: new THREE.Scene(), beforePassesScene: new THREE.Scene(),
    uiCamera: new THREE.OrthographicCamera(), sceneRT: new THREE.WebGLRenderTarget(),
    composite: null, post: null, dpr: 1,
    setComposite: vi.fn(), setPost: vi.fn(), setPixelRatio: vi.fn(), render: vi.fn(),
    addPreRender: (): (() => void) => () => {}, warmUp: async (): Promise<void> => {},
  };
  return { story: new ScrollStory(pipeline, root), scene: new LifecycleScene(), pipeline, root };
}

describe('story lifecycle', () => {
  it('releases frames, events, observers, timers, child components and DOM on destroy', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { queueMicrotask(() => callback(16)); return 1; });
    const disconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect');
    const fixture = storyFixture();
    const child = fixture.scene.addChild(new Component());
    const childFrame = vi.fn();
    child.startRender(childFrame);
    await fixture.story.load([{ scene: fixture.scene, height: 2 }], () => {});
    await fixture.story.start();
    emit('Global/loaderFinished');
    const updates = vi.fn();
    const wheel = vi.fn();
    const offUpdate = listen('Story/update', updates);
    const offWheel = listen('Global/wheel', wheel);
    frame();
    expect(updates).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('resize'));
    const resize = vi.spyOn(fixture.scene, 'handleViewResize');
    const target = fixture.story.scroll.targetY;
    fixture.story.destroy();
    fixture.story.destroy();
    updates.mockClear();
    childFrame.mockClear();
    frame();
    emit('Global/loaderFinished');
    window.dispatchEvent(new WheelEvent('wheel'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    await vi.advanceTimersByTimeAsync(2000);
    updateTweens(400);
    expect(updates).not.toHaveBeenCalled();
    expect(childFrame).not.toHaveBeenCalled();
    expect(wheel).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
    expect(fixture.story.scroll.enabled).toBe(false);
    expect(fixture.story.scroll.targetY).toBe(target);
    expect(fixture.pipeline.scene.children).toHaveLength(0);
    expect(fixture.root.children).toHaveLength(0);
    expect(() => interaction3d()).toThrow();
    expect(() => world()).toThrow();
    offUpdate();
    offWheel();
    fixture.pipeline.sceneRT.dispose();
  });

  it('does not register callbacks after destruction during asynchronous startup', async () => {
    let resume: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { resume = () => callback(16); return 1; });
    const { story, scene, pipeline } = storyFixture();
    await story.load([{ scene, height: 2 }], () => {});
    const starting = story.start();
    await vi.waitFor(() => expect(resume).toBeDefined());
    story.destroy();
    resume!();
    await starting;
    emit('Global/loaderFinished');
    expect(callbacks.size).toBe(0);
    expect(pipeline.scene.children).toHaveLength(0);
    pipeline.sceneRT.dispose();
  });

  it('preserves a replacement story when the previous instance is destroyed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => { queueMicrotask(() => callback(16)); return 1; });
    const previous = storyFixture();
    await previous.story.load([{ scene: previous.scene, height: 2 }], () => {});
    await previous.story.start();
    emit('Global/loaderFinished');
    const replacement = storyFixture();
    const replacementInteraction = interaction3d();
    await replacement.story.load([{ scene: replacement.scene, height: 2 }], () => {});
    await replacement.story.start();
    previous.story.destroy();
    expect(world().camera).toBe(replacement.story.camera);
    expect(interaction3d()).toBe(replacementInteraction);
    expect(getState('Story/scroll')).toBe(replacement.story.scroll);
    const update = vi.fn();
    const off = listen('Story/update', update);
    emit('Global/loaderFinished');
    emit('Global/loaderFinished');
    frame();
    expect(update).toHaveBeenCalledExactlyOnceWith(replacement.story.camera.camera);
    replacement.story.destroy();
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    off();
    previous.pipeline.sceneRT.dispose();
    replacement.pipeline.sceneRT.dispose();
  });

  it('does not destroy children reparented to another component', () => {
    const previous = new Component();
    const replacement = new Component();
    const child = previous.addChild(new Component());
    const render = vi.fn();
    child.startRender(render);
    replacement.addChild(child);
    previous.destroy();
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(child.parent).toBe(replacement);
    replacement.destroy();
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
  });
});

it('snaps virtual scroll to the keyboard target under reduced motion', async () => {
  setMotionPreference('reduce');
  const scroll = new VirtualScroll({ drag: false, mouseWheel: true, keyboard: true, limit: true, scale: 1, touchScale: 1 });
  scroll.max.y = 1000;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
  await Promise.resolve();
  updateTweens(16);
  frame();
  expect(scroll.y).toBe(150);
  scroll.destroy();
});
