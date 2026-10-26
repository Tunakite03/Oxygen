# Post-processing

`PostStack` runs an ordered list of full-screen passes after the scene. Each enabled pass reads the previous result
and writes the next; two ping-pong targets carry intermediate frames and the last enabled pass draws straight to the
canvas, so N passes cost N draws. With every pass disabled the scene buffer is copied.

```ts
import { BloomPass, ColorGradePass, FXAAPass, LensPass, PostStack, createPipeline } from '@tunn/oxygen';

const pipeline = createPipeline(container, { hdr: true }); // half-float scene buffer keeps values above 1.0
const post = new PostStack(pipeline.renderer);
post.add(new BloomPass({ threshold: 0.9, intensity: 0.8 }));
post.add(new ColorGradePass({ toneMapping: 'aces', outputSRGB: true }));
post.add(new LensPass({ vignette: 0.3, grain: 0.03 }));
post.add(new FXAAPass());
pipeline.setPost(post); // replaces the composite draw; resized with the pipeline
```

Order matters: bloom works on HDR values, so it runs before tone mapping; FXAA works on display values, so it runs
last. `pipeline.warmUp(camera)` also runs the stack once so its programs compile during the loader.

With a stack attached the pipeline's composite material is not drawn. Keep it by adding it as a pass:
`post.add(new ShaderPass('composite', myFragmentShader, uniforms), 0)`.

## Passes

| Pass | Options | Notes |
| --- | --- | --- |
| `BloomPass` | `threshold` 0.8, `knee` 0.3, `intensity` 1, `radius` 0.75, `levels` 6 | Soft-knee threshold, then a dual-filter mip chain: each level is half the previous, the way back up adds a tent-filtered coarser level scaled by `radius`. Normalised so `radius` changes the spread more than the brightness. Fireflies are suppressed by luma-weighting the first downsample. |
| `ColorGradePass` | `exposure` (stops) 0, `contrast` 1, `saturation` 1, `tint`, `toneMapping` `'none' \| 'reinhard' \| 'aces'`, `outputSRGB` false | Changing `toneMapping` or `outputSRGB` recompiles the shader; the rest are uniforms. Set `outputSRGB` when the scene renders linear colour (three's built-in materials). |
| `LensPass` | `chromaticAberration` 0.002, `vignette` 0.25, `vignetteOffset` 0.4, `grain` 0.04 | One pass for all three effects. Grain is re-seeded each frame from `time`. |
| `FXAAPass` | | Luma-edge anti-aliasing. Useful when MSAA is off or for alpha-tested edges. |
| `TransitionPass` | `effect` `'fade' \| 'wipe' \| 'noise'`, `softness` 0.1, `edgeColor`, `edgeIntensity` 1, `direction`, `noiseScale` 4 | See below. |
| `ShaderPass` | `(name, fragmentShader, uniforms)` | Your own effect. |

Every built-in pass exposes its parameters as properties (`bloom.intensity = 2`, `grade.exposure = -0.5`), which the
debug GUI can bind directly.

## Custom passes

A `ShaderPass` fragment shader is GLSL ES 3.00. It declares `uniform sampler2D tDiffuse` (the previous result),
`in vec2 vUv` and `out vec4 FragColor`. `resolution` (vec2, pixels) and `time` (seconds) are set every frame.

```ts
const invert = new ShaderPass('invert', `
uniform sampler2D tDiffuse;
uniform float amount;
in vec2 vUv;
out vec4 FragColor;
void main() {
  vec4 c = texture(tDiffuse, vUv);
  FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
}`, { amount: { value: 1 } });
post.add(invert);
invert.uniform<number>('amount').value = 0.5;
```

For multi-draw effects implement `PostPass` directly: `setSize(width, height)` receives the drawing-buffer size and
`render(context, input, output)` must draw into `output` (null is the canvas) without writing to `input`. Use
`context.quad.render(context.renderer, material, target)` for full-screen draws.

## Screen transitions

`TransitionPass` blends from a snapshot of an earlier frame to the live image. It is disabled until `capture()`, so it
costs nothing between transitions.

```ts
const transition = post.add(new TransitionPass({ effect: 'noise', edgeColor: 0xffa152, edgeIntensity: 3 }), 0);

await transition.capture(); // resolves after the next frame is snapshotted; the screen holds that frame
swapSceneContent();
await transition.play(900, 'easeInOutCubic'); // reveals the new content, then disables itself
```

Put it first in the stack to transition HDR colour, so an `edgeIntensity` above 1 blooms. `play` and `capture` cancel
an earlier `play`. The router example wires this into `RouteView.leave` / `enter`.
