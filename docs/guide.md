# Oxygen integration guide

Oxygen 0.3.0-beta.0 is an ESM-only WebGL 2 toolkit for browser applications. Importing the root package in Node/SSR is safe; creating a renderer, starting the frame loop, or constructing browser input/audio adapters requires the browser. Node 24 and 26 are the supported development/CI runtimes. The tested peers are Three 0.186.x and Zod 4.x; rigid bodies additionally use Rapier 0.21.x.

Oxygen is available under the [MIT License](../LICENSE). The manifest intentionally has `private: true`, which blocks public npm publication. Use local tarballs for integration testing within this project.

## Install and verify a local package

```sh
npm ci
npx playwright install chromium
npm run verify
npm run test:browser
npm run test:package
npm run build:docs
npm pack --ignore-scripts
```

Install the generated tarball in a separate application together with `three@~0.186.1` and `zod@^4`. Add `@types/three@~0.186.0` for TypeScript. The automated package test creates such an application outside this repository, checks SSR import and both Bundler/NodeNext declaration resolution with `skipLibCheck: false`, builds it with Vite, and opens its production output in Chromium. It first checks runtime-only installation without Rapier, then removes the older Rapier dependency brought by `@types/three` to check core declaration isolation.

Core imports do not include rigid-body physics:

```ts
import { createAccessiblePipeline, GLTFAssets } from '@tunn/oxygen';
import { PhysicsWorld } from '@tunn/oxygen/physics';
```

Only applications using the second entry need `@dimforge/rapier3d-compat@~0.21.0`. Spring and Verlet utilities remain in the root entry. Oxygen ships ESM JavaScript and declarations; CommonJS `require()` is not a supported contract.

## Mount, render and unmount

`website/embed/main.ts` is the complete lifecycle example. Create a pipeline in a positioned host with explicit dimensions and `sizeMode: 'container'` for embedded content. The default `viewport` mode preserves full-page scroll stories. `pipeline.size` exposes the current logical pixel dimensions; update camera aspect from it. Container mode uses `ResizeObserver` and remains at least 1 × 1 when hidden.

`createAccessiblePipeline(host, fallbackElement, options)` returns a nullable `pipeline` plus a typed `reason` when WebGL 2 cannot initialize. Supply useful semantic HTML yourself: scene meaning, equivalent navigation, and required controls. The adapter shows it when WebGL is unavailable or context is lost, and hides it after restoration. Other initialization errors propagate. The canvas is marked `aria-hidden`; put essential information in accessible HTML outside the canvas. The adapter restores the fallback's original hidden state when disposed.

Ownership is explicit:

| Resource | Owner and cleanup |
| --- | --- |
| Pipeline | `pipeline.dispose()` releases its render target, copy material, quad, renderer, canvas, resize observer and context listeners. Idempotent. Later render/mutation throws `DisposedError`. |
| Scene geometry/materials/textures | Application owns manually supplied resources; dispose them separately. Sharing an asset across scenes does not transfer ownership to a pipeline. |
| Post stack/custom composite | Application owns it; detach with `setPost(null)` before disposing an attached stack. A pipeline never disposes shared caller materials. |
| GLTF scope | `GLTFAssets.dispose()` aborts requests and releases all assets loaded by that scope. Individual asset handles can be disposed early. |
| Frame subscriptions | Keep the cleanup returned by `onFrame` and `setRenderFunction`. The latter only clears the render function it installed. |
| Global loop | `stopLoop()` cancels RAF but retains subscriptions for `startLoop()` to resume. Release subscriptions on final unmount. One application owns this singleton; stopping it affects every mounted scene. |
| Global stage | `disposeStage()` removes viewport/pointer listeners and resize subscriptions. Call only after all stage consumers unmount. Subsequent initialization is supported. |
| Audio | `AudioManager.dispose()` owns and disposes registered tracks/effect chains, removes gesture/focus listeners, rejects pending resume waits, and closes its context. Await it. The singleton accessor can then create a fresh manager. |
| Story/input/quality/router | Call each adapter's `destroy()` or `stop()` as exposed by its API. Scene application assets remain caller-owned. |

Cancelled tween promises now resolve without invoking `onComplete`; code waiting on a fade or transition can finish teardown. A pending audio decode cannot resurrect a disposed track. Duplicate audio and effect-chain IDs are rejected so replacement cannot leak the previous graph.

`warmUp()` restores visibility, camera layers and the previous render target even when rendering fails. On context restoration Three recreates its GPU objects; application simulations containing transient GPU-only state may need reseeding. Listen with `pipeline.onContextChange()` to handle that application-specific state.

## Reduced motion

The global policy defaults to the live OS media query. `setMotionPreference('reduce' | 'full' | 'system')` implements an explicit user control; `onMotionChange()` returns an unsubscribe function and calls its listener immediately. Release subscriptions on unmount.

Decorative tweens finish on the next engine update, including any visual delay. Gaze camera pointer/wobble motion and scroll tilt are disabled; story scroll positions snap; GPU particle simulation pauses. Transition progress uses the same tween policy. Audio envelopes use the `essential` tween purpose and preserve their duration. Application-authored animation callbacks and shaders must consult `prefersReducedMotion()` themselves, as the embedded demo does. Reduced motion does not disable keyboard navigation or replace semantic HTML.

## GLB/glTF and compressed assets

```ts
const assets = new GLTFAssets({
  renderer: pipeline.renderer,
  dracoDecoderPath: '/decoders/draco/',
  ktx2TranscoderPath: '/decoders/basis/',
});
const controller = new AbortController();
const asset = await assets.load('/models/scene.glb', {
  signal: controller.signal,
  timeoutMs: 30000,
});
pipeline.scene.add(asset.gltf.scene);
// On unmount: assets.dispose();
```

The standard Three GLTFLoader handles GLB, JSON glTF, external buffers/textures, animations and skins. Draco and KTX2 are opt-in; KTX2 needs the renderer for format detection. Decoder paths must be nonempty directories ending in `/`. Host the matching files from the installed Three package:

- Draco glTF: `three/examples/jsm/libs/draco/gltf/` (`draco_wasm_wrapper.js`, `draco_decoder.wasm`, and `draco_decoder.js` for JS fallback).
- KTX2: `three/examples/jsm/libs/basis/` (`basis_transcoder.js`, `basis_transcoder.wasm`).

Use same-origin URLs or configure CORS on asset hosts. Content Security Policy must allow the worker/blob and WebAssembly behavior required by Three's decoders. Missing decoders or unsupported formats fail with the model URL in `AssetLoadError`. The root request retries transient network/5xx failures up to three attempts; 4xx and cancellation do not retry. The overall timeout covers fetch and parsing. External glTF subresources use Three's loader behavior and do not gain Oxygen retry handling. Cancellation aborts supported Three loaders; image decoding or worker computation already in progress may finish internally, but late successful scenes are released and never returned to the caller.

An asset handle owns every scene in its glTF. Do not dispose a handle while another scene still borrows its geometry/materials. Clone shared resources before transferring ownership. Meshopt and third-party GLTFLoader plugins are outside this initial API. The owned triangle fixtures validate real GLB and external-buffer glTF in Chromium; Draco/KTX2 decoder paths are integrated but codec fixtures are not yet part of the browser suite. Compression tooling and MSDF font generation remain separate future authoring work; the current font loader consumes BMFont-style MSDF metadata, not raw msdf-atlas-gen JSON.

## API reference, demo and release

`npm run build:docs` generates the API reference in `docs-dist/api`. `npm run build:examples` generates the demo in `examples-dist`. Serve each output over HTTP; opening HTML via `file:` does not support module/asset requests. The documentation preview workflow uploads both outputs as an artifact, without changing any deployed site. Host `examples-dist` at `/demo/` alongside `/api/` to match the API navigation link. `npm run dev` opens the website from `website/`, including the homepage, guides, API reference and live examples. `npm run build:website` emits the standalone site to `website/dist/`; `npm run preview:website` serves that build.

CI checks Node 24 and 26: typecheck, unit/regression tests, engine/demo builds, generated API, isolated package consumption and real Chromium integration. Local verification is evidence only for the runtime/browser actually run; remote matrix jobs must pass after pushing.

The manual npm workflow is intentionally blocked by `npm run release:check` while `private: true`. After approval to distribute publicly, remove `private: true` and configure npm trusted publishing for repository `Tunakite03/Oxygen`, workflow `release.yml`, and GitHub environment `npm`. The workflow uses GitHub OIDC and provenance, not a stored npm token. It publishes to the `next` tag because this version is beta. The initial package creation/trusted-publisher setup, npm namespace ownership, GitHub environment protection, and public hosting configuration are account-owner prerequisites. No workflow has been dispatched and no package or demo has been published by this change.

## Migration from 0.2

1. Import `PhysicsWorld` and other rigid-body types from `@tunn/oxygen/physics`; install its optional peer when using that entry.
2. Use the tested Three/Rapier minor versions listed above instead of assuming unrestricted future versions are compatible.
3. Start stage/loop explicitly in the browser. Root import no longer installs pointer/resize listeners.
4. Retain cleanup functions and dispose owned resources on unmount. Do not render a disposed pipeline.
5. Cancelled tweens resolve their promises, and decorative motion follows OS preference by default. Use the `essential` purpose only when motion is necessary to the task.
6. Supply fallback HTML and define the size of embedded pipeline hosts.
