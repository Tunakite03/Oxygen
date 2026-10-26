# @tunn/engine

A scroll-story WebGL engine on three.js. It covers what an award-style "scroll through a 3D story" site needs: a frame
loop with ordered phases, tweens, asset loading with GPU warm-up, a named GLSL library, a render pipeline with a
composite pass and pixel-space overlays, a virtual scroll, stacked story scenes with DOM sections, pointer interaction
and Web Audio.

It is a clean-room implementation written for this repository. It contains no code, shaders or assets from any
third-party framework; the Santioni site in `src/` supplies its own shaders, scene data and assets on top of it.

## Install

Inside this repository the site imports the engine from source (see `vite.config.ts` and `tsconfig.json`). For another
project, build the package and depend on it:

```sh
npm run build -w @tunn/engine   # dist/index.js + dist/*.d.ts
```

Peer dependencies: `three` (>= 0.180) and `zod` (4.x). three's `basis_transcoder` files are needed for KTX2 and
Google's Draco decoder (`draco_wasm_wrapper.js`, `draco_decoder.wasm`) for `.bin` geometry.

## Quick start

```ts
import * as THREE from 'three';
import {
  ScrollStory, StoryScene, createLoadProgress, createPipeline, createShaderMaterial, emit, initTextures,
  loadShaderLibrary, pendingTextureLoads, setRenderFunction, startLoop,
} from '@tunn/engine';

class IntroScene extends StoryScene {
  constructor() {
    super('IntroScene', 0); // DOM section class "IntroUI", CSS order 0
  }

  protected override async create(): Promise<void> {
    const material = createShaderMaterial('Gradient', { uAlpha: { value: 0 } }, { transparent: true });
    this.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  }

  override animateIn(): void {
    // Runs when the section scrolls into view.
  }
}

async function boot(): Promise<void> {
  const container = document.querySelector<HTMLElement>('.Container')!;
  const root = document.querySelector<HTMLDivElement>('.Story')!;
  startLoop();

  const progress = createLoadProgress({ shaders: 0.2, scenes: 0.8 }, (v) => console.log('loading', v));
  await loadShaderLibrary('shaders/library.glsl');
  progress.report('shaders', 1, 1);

  const pipeline = createPipeline(container, { clearColor: '#111111' });
  initTextures(pipeline.renderer, { ktx2TranscoderPath: 'lib/basis/' });

  const story = new ScrollStory(pipeline, root);
  await story.load([{ scene: new IntroScene(), height: 2, mobileHeight: 1.5 }], (n, total) => progress.report('scenes', n, total));
  await story.start();
  await pendingTextureLoads();
  await pipeline.warmUp(story.camera.camera); // compile every program and upload every texture before first scroll
  setRenderFunction(() => pipeline.render(story.camera.camera));
  emit('Global/loaderFinished'); // unlocks scrolling 1.5 s later
}

void boot();
```

The page needs a positioned container for the canvas and a story root whose children are the scenes' DOM sections:

```html
<div class="Container"><div class="Story"></div></div>
```

## Modules

| Area | Exports | Notes |
| --- | --- | --- |
| Frame loop | `startLoop`, `onFrame(cb, phase)`, `setRenderFunction`, `frame` | Phases run in order: tweens, `loop`, `afterLoops`, `beforeRender`, render, `postRender`. `frame.delta` is capped at 200 ms. |
| Events, state | `emit`, `listen`, `setState`, `getState`, `requireState`, `bindState`, `whenState` | One process-wide bus. `bindState` fires now and on change. |
| Math | `clamp`, `range`, `mix`, `lerp`, `lerpVec`, `smoothstep`, `radians` | `lerp(target, value, alpha)` is normalised to 60 Hz frames. |
| Tweens | `tween`, `tweenUniform`, `clearTween`, `addCustomEase`, `getEase`, `delay`, `defer` | Penner eases by name plus named `cubic-bezier(...)` eases. A new tween replaces earlier ones on the same object unless it sets `multiTween`. |
| Components | `Component` | A `THREE.Group` with `startRender` loops that only run while the component and its ancestors are visible. |
| Viewport | `stage`, `pointer`, `device`, `getDPR`, `onResize` | |
| Assets | `getTexture`, `getRepeatTexture`, `getKTX2Texture`, `pendingTextureLoads`, `initTextures` | One cached texture per path and alpha mode. |
| Geometry | `configureGeometry`, `loadGeometry`, `loadSkinAnimation` | `.bin` (JSON header + Draco payload, optional bone metadata) and BufferGeometry `.json`. |
| Scene config | `ConfigStore` | Typed reads of a flat key/value document; wrong types throw `ConfigValueError`. |
| Load progress | `createLoadProgress` | Weighted stages; the value never decreases. |
| Shader library | `loadShaderLibrary`, `registerShaderBundle`, `registerShaderSource`, `addShaderTests`, `createShaderMaterial`, `globalUniforms` | See below. |
| Pipeline | `createPipeline`, `registerOffscreenPass` | MSAA scene buffer, composite material, pixel-space overlays, `warmUp`. |
| Skinning | `Skin`, `SkinAnimation` | Bone matrices in a float texture (`boneTexture`, `boneTextureSize`); override `isBoneAnimated` to drive bones in code. |
| Overlay UI | `GLUIElement`, `gluiQuad`, `setQuadSize`, `HitLink`, `bindTap` | Elements in CSS pixels with y down; `HitLink` gives a GL element an accessible link. |
| Camera | `GazeCamera`, `world`, `units`, `getHeightFromCamera` | Pointer-gaze camera with optional wobble. |
| Input | `Interaction3D`, `interaction3d` | Hover / click / move on meshes. DOM elements with class `hit` or `prevent_interaction3d` block it. |
| Scroll | `VirtualScroll`, `scrollState`, `SceneUI` | Wheel, touch drag and keyboard with per-platform wheel tuning. Elements with class `prevent_interactionScroll` opt out. |
| Story | `ScrollStory`, `StoryScene`, `SceneConfig` | See below. |
| Audio | `audioManager`, `AudioTrack`, `EffectChain`, `crossfadeMix`, `RoundRobin`, `preferredAudioFormat` | Resumes on the first gesture, ducks on blur, equal-power `blend`. |
| Text | `configureFonts`, `loadFont`, `layoutText`, `karaokeBuffer` | MSDF (msdf-bmfont JSON) layout into quad buffers. |
| DOM tweens | `dom(el).set(...)`, `dom(el).tween(...)` | x / y (px, %, vw, vh), scale, scaleX, opacity. |

## Shader library

A bundle is a single text file of `{@}<file name>{@}<source>` entries.

- A plain entry is a chunk that other sources pull in with `#require(<name>)`.
- An entry with `#!ATTRIBUTES`, `#!UNIFORMS`, `#!VARYINGS` sections and `#!SHADER: Name.vs` / `#!SHADER: Name.fs` blocks
  becomes `Name.vs` and `Name.fs`, with the shared declarations prepended.
- `#test <condition>` ... `#endtest` keeps or drops a block. Conditions are plain strings that your evaluators resolve:

```ts
addShaderTests((condition, { isMobile }) => (condition === 'quality.high' ? !isMobile : undefined));
```

An unknown condition, a missing `#require` or a missing shader throws. `createShaderMaterial(name, uniforms, options)`
builds a GLSL ES 3.00 `RawShaderMaterial`: GLSL 1 sources are converted, duplicate declarations are dropped, every
`sampler2D` defaults to `null`, and `time`, `timeScale`, `resolution`, `cameraQuaternion` and `normalMatrixWorld` are
provided. Transparent materials with normal blending use straight alpha (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`); opaque
ones disable blending.

## Story

`ScrollStory` stacks `StoryScene`s top to bottom. Each scene's height is given in viewport heights (`height`, or
`'auto'` to measure its DOM section), interpolated toward `mobileHeight` as the viewport narrows from 1600 px to 393 px.

Per frame the story eases the camera toward the virtual scroll, updates each scene's `visible` and `scrollProgress`
(0 when its slot starts entering the screen, 1 when it has left through the top), translates the DOM sections and
publishes:

| State | Value |
| --- | --- |
| `Story/scrollY` | Eased scroll in world units (negative going down) |
| `Story/scrollDirection` | -1, 0 or 1 |
| `Story/visibleScenes` | Ids of visible scenes (`StoryScene.id`) |
| `Story/screenHeightWorld`, `Story/screenWidthWorld` | Viewport size at the camera's focal plane |
| `Story/scroll` | The `VirtualScroll` |

Events: `Global/scenesReady`, `Story/update` (every frame, with the camera), `Global/wheel`. Emit
`Global/loaderFinished` when the intro is over.

Subclass `ScrollStory` to add site behaviour through `onStart`, `onLoaderFinished`, `onScrollY`, `updateScene`,
`afterScenes` and `afterUpdate`. Subclass `StoryScene` and override `load` (to fetch assets before calling
`super.load`), `create`, `setupUI`, `uiOptions`, `init`, `handleResize`, `animateIn`, `animateOut` and
`onVisibilityChange`.

## GPU warm-up

`pipeline.warmUp(camera)` compiles every program (in parallel where `KHR_parallel_shader_compile` exists) and draws
every object of the scene and overlays once into a 1×1 target, hidden scenes included, so textures and buffers are on
the GPU before the first scroll. Full-screen passes that live outside the scenes must call
`registerOffscreenPass(mesh)` to be included.

## Development

```sh
npm test -w @tunn/engine        # vitest (happy-dom)
npm run typecheck -w @tunn/engine
npm run build -w @tunn/engine
```
