# Adaptive quality

Pick a starting quality from the GPU, then let real frame times move it.

```ts
import { QualityManager, detectGPU } from '@tunn/oxygen';

const levels = [
  { name: 'low', dpr: 1, particles: 32_768, bloom: false },
  { name: 'medium', dpr: 1.5, particles: 131_072, bloom: true },
  { name: 'high', dpr: 2, particles: 262_144, bloom: true },
] as const;

const gpu = detectGPU(pipeline.renderer.getContext());
const quality = new QualityManager({ levels, initial: { tier: gpu.tier } });
quality.bindPipeline(pipeline);                    // canvas pixel ratio = min(devicePixelRatio, level.dpr)
quality.onChange((level) => (bloom.enabled = level.bloom));
quality.start();                                   // samples every frame from the engine loop
```

## GPU tiers

`detectGPU()` reads the unmasked WebGL renderer string (`WEBGL_debug_renderer_info`) and returns
`{ renderer, vendor, tier, reason, mobile, webgl2 }`. `classifyGPU(renderer, hints)` is the pure rule set.

| Tier | Examples |
| --- | --- |
| 0 | SwiftShader, llvmpipe, Microsoft Basic Render, no WebGL |
| 1 | Intel HD / UHD, older Adreno and Mali, WebGL 1 only |
| 2 | Iris Xe, Radeon integrated, GeForce MX / GTX, current phones (Apple GPU, Adreno 730+, Mali-G710+) |
| 3 | RTX, Radeon RX 5000+, Apple M-series, GTX 1060+ and 16-series |

Devices reporting 2 GB of memory or fewer, or 2 cores or fewer, drop one tier. Unknown desktop GPUs get 2, unknown
mobile GPUs 1. Levels are spread over the tiers with `levelForTier`.

## Adaptive switching

`AdaptiveQuality` measures fps in windows (1 s by default):

- After `warmupMs` (2 s, while shaders compile) it starts sampling.
- Two consecutive windows below `targetFps × downgradeRatio` (60 × 0.85) step down one level.
- Eight consecutive windows at or above `targetFps × upgradeRatio` (60 × 0.97) step up one level.
- Frames of 250 ms or more (`gapMs`: tab switches, GC pauses) are skipped.
- The display refresh rate caps the target, so a 30 Hz display is not treated as slow.
- After `maxFlips` direction changes (3) it locks on the lower level to stop oscillating.

`quality.set(index)` forces a level and locks adaptation. `adaptive: false` keeps the initial level. State
`Quality/level` and `Quality/index` are published for other modules.

`prefersReducedMotion()` reports the OS setting; use it to shorten transitions and disable camera wobble.
