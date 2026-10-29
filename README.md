# Oxygen

`@tunn/oxygen` is a WebGL engine for creative, award-style sites on three.js. It started as the scroll-story engine of
a site rebuild and grew into a toolkit: a frame loop with ordered phases, tweens, asset loading with GPU warm-up, a
named GLSL library, a render pipeline, scroll stories, a post-processing stack, GPU particles, physics, a router with
page transitions, adaptive quality, pointer input, Web Audio and a debug panel.

It is a clean-room implementation. It contains no code, shaders or assets from any third-party framework or site;
projects supply their own content on top of it.

## Integration status

Version 0.3.0-beta.1 is a beta release. Oxygen is available under the [MIT License](LICENSE). See the [integration and migration guide](docs/guide.md) for ownership, SSR imports, accessibility, GLB/glTF, CI and release requirements. Generate the API with `npm run build:docs`; the embedded-scene demo covers mount/unmount and fallback behavior.

Rigid-body physics is now imported from `@tunn/oxygen/physics`; other utilities remain in the root entry.

## Install

After the package is published to npm, install it and its required peers with:

```sh
npm install @tunn/oxygen three zod
npm install @dimforge/rapier3d-compat   # only for PhysicsWorld (rigid bodies)
```

The release workflow publishes the beta to npm's `latest` tag, so an unqualified install selects a prerelease version after publication.

Peer dependencies: `three` (~0.186.1), `zod` (4.x) and, optionally, `@dimforge/rapier3d-compat` (~0.21.0), which is
imported on demand by `PhysicsWorld.create`. three's `basis_transcoder` files are needed for KTX2 and Google's Draco
decoder (`draco_wasm_wrapper.js`, `draco_decoder.wasm`) for `.bin` geometry.

Until the package is published, depend on the repository pinned to a commit. npm clones it, installs its dev
dependencies and runs the `prepare` script, which builds `dist/`:

```json
"dependencies": { "@tunn/oxygen": "git+https://github.com/Tunakite03/Oxygen.git#<commit>" }
```

For engine work against a site, `npm link` a local checkout, or alias `@tunn/oxygen` to `src/index.ts` in your bundler.

## Quick start

A scene with post-processing and adaptive quality:

```ts
import * as THREE from 'three';
import {
  BloomPass, ColorGradePass, PostStack, QualityManager, createPipeline, detectGPU, onFrame, onResize,
  setRenderFunction, stage, startLoop,
} from '@tunn/oxygen';

startLoop();
const pipeline = createPipeline(document.querySelector<HTMLElement>('.stage')!, { hdr: true });
const camera = new THREE.PerspectiveCamera(45, stage.width / stage.height, 0.1, 100);
camera.position.z = 5;
onResize(() => {
  camera.aspect = stage.width / stage.height;
  camera.updateProjectionMatrix();
});

const post = new PostStack(pipeline.renderer);
post.add(new BloomPass({ threshold: 0.9 }));
post.add(new ColorGradePass({ toneMapping: 'aces', outputSRGB: true }));
pipeline.setPost(post);

const quality = new QualityManager({
  levels: [{ name: 'low', dpr: 1 }, { name: 'high', dpr: 2 }],
  initial: { tier: detectGPU(pipeline.renderer.getContext()).tier },
});
quality.bindPipeline(pipeline);
quality.start();

const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 200, 24), new THREE.MeshStandardMaterial({ emissive: 0x3d7bff, emissiveIntensity: 4 }));
pipeline.scene.add(mesh, new THREE.HemisphereLight(0xffffff, 0x222222, 1));
onFrame((_t, delta) => (mesh.rotation.y += delta * 0.0005));
await pipeline.warmUp(camera);
setRenderFunction(() => pipeline.render(camera));
```

A scroll story (stacked scenes driven by a virtual scroll, with DOM sections):

```ts
import * as THREE from 'three';
import {
  ScrollStory, StoryScene, createLoadProgress, createPipeline, createShaderMaterial, emit, initTextures,
  loadShaderLibrary, pendingTextureLoads, setRenderFunction, startLoop,
} from '@tunn/oxygen';

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

## Examples

`npm run dev` serves the website from `website/`. The homepage links to documentation, API reference and the examples gallery. `npm run build:website` builds the standalone site into `website/dist/`; `npm run preview:website` previews it. Live demos include:

| Example | Shows |
| --- | --- |
| `post/` | HDR scene through bloom, ACES grading, lens and FXAA; quality levels; debug panel and frame stats |
| `particles/` | Up to 262k GPU particles in curl noise with a pointer attractor (press to repel) |
| `physics/` | Rapier rigid bodies (tap to throw), a Verlet cloth pushed by the pointer, spring hover |
| `router/` | Hash router with a noise-dissolve page transition, focus management and reduced-motion support |

Press <kbd>`</kbd> in any example to toggle the panel.

## Modules

| Area | Exports | Notes |
| --- | --- | --- |
| Frame loop | `startLoop`, `onFrame(cb, phase)`, `setRenderFunction`, `frame` | Phases run in order: tweens, `loop`, `afterLoops`, `beforeRender`, render, `postRender`. `frame.delta` is capped at 200 ms. |
| Events, state | `emit`, `listen`, `setState`, `getState`, `requireState`, `bindState`, `whenState` | One process-wide bus. `bindState` fires now and on change. |
| Math, random | `clamp`, `range`, `mix`, `lerp`, `lerpVec`, `smoothstep`, `radians`, `createRandom`, `randomRange` | `lerp(target, value, alpha)` is normalised to 60 Hz frames. `createRandom(seed)` is a seeded Mulberry32. |
| Tweens | `tween`, `tweenUniform`, `clearTween`, `addCustomEase`, `getEase`, `delay`, `defer` | Penner eases by name plus named `cubic-bezier(...)` eases. A new tween replaces earlier ones on the same object unless it sets `multiTween`. |
| Components | `Component` | A `THREE.Group` with `startRender` loops that only run while the component and its ancestors are visible. |
| Viewport | `stage`, `pointer`, `device`, `getDPR`, `onResize` | |
| Assets | `getTexture`, `getRepeatTexture`, `getKTX2Texture`, `pendingTextureLoads`, `initTextures` | One cached texture per path and alpha mode. |
| Geometry | `configureGeometry`, `loadGeometry`, `loadSkinAnimation` | `.bin` (JSON header + Draco payload, optional bone metadata) and BufferGeometry `.json`. |
| Scene config | `ConfigStore` | Typed reads of a flat key/value document; wrong types throw `ConfigValueError`. |
| Load progress | `createLoadProgress` | Weighted stages; the value never decreases. |
| Shader library | `loadShaderLibrary`, `registerShaderBundle`, `registerShaderSource`, `addShaderTests`, `createShaderMaterial`, `globalUniforms` | See below. |
| Pipeline | `createPipeline`, `registerOffscreenPass` | MSAA scene buffer (half float with `hdr`), composite material or post stack, pixel-space overlays, `setPixelRatio`, `warmUp`. |
| Post-processing | `PostStack`, `BloomPass`, `ColorGradePass`, `LensPass`, `FXAAPass`, `ShaderPass`, `TransitionPass` | [docs/post.md](docs/post.md) |
| GPU particles | `GPUParticles`, `GPUSimulation`, `NOISE_GLSL` | [docs/particles.md](docs/particles.md) |
| Physics | `Spring`, `VectorSpring`, `VerletWorld`, `createRope`, `createCloth`, `ClothGeometry`, `PhysicsWorld` | [docs/physics.md](docs/physics.md) |
| Router | `Router`, `compilePath`, `matchPath`, `buildPath` | [docs/router.md](docs/router.md) |
| Quality | `detectGPU`, `classifyGPU`, `QualityManager`, `AdaptiveQuality`, `prefersReducedMotion` | [docs/quality.md](docs/quality.md) |
| Skinning | `Skin`, `SkinAnimation` | Bone matrices in a float texture (`boneTexture`, `boneTextureSize`); override `isBoneAnimated` to drive bones in code. |
| Overlay UI | `GLUIElement`, `gluiQuad`, `setQuadSize`, `HitLink`, `bindTap` | Elements in CSS pixels with y down; `HitLink` gives a GL element an accessible link. |
| Camera | `GazeCamera`, `world`, `units`, `getHeightFromCamera` | Pointer-gaze camera with optional wobble. |
| Input | `PointerTracker`, `pointerToPlane`, `Interaction3D`, `interaction3d` | [docs/input.md](docs/input.md) |
| Scroll | `VirtualScroll`, `scrollState`, `SceneUI` | Wheel, touch drag and keyboard with per-platform wheel tuning. Elements with class `prevent_interactionScroll` opt out. |
| Story | `ScrollStory`, `StoryScene`, `SceneConfig` | See below. |
| Audio | `audioManager`, `AudioTrack`, `EffectChain`, `crossfadeMix`, `RoundRobin`, `preferredAudioFormat` | Resumes on the first gesture, ducks on blur, equal-power `blend`. |
| Text | `configureFonts`, `loadFont`, `layoutText`, `karaokeBuffer` | MSDF (msdf-bmfont JSON) layout into quad buffers. |
| DOM tweens | `dom(el).set(...)`, `dom(el).tween(...)` | x / y (px, %, vw, vh), scale, scaleX, opacity. |
| Debug | `DebugGUI`, `PerfMonitor`, `debugEnabled` | [docs/debug.md](docs/debug.md) |

Errors are typed: `AssetLoadError`, `ShaderNotFoundError`, `ConfigValueError`, `GeometryFormatError`,
`UnsupportedFeatureError`, `MissingDependencyError`, `RouteNotFoundError`.

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
npm install
npm test               # vitest (happy-dom); the Rapier tests run the real WASM build
npm run typecheck      # library, tests and examples
npm run build          # dist/index.js + dist/**/*.d.ts
npm run dev            # examples on a Vite dev server
npm run build:examples # static examples in examples-dist/
```
