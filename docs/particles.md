# GPU particles

`GPUParticles` simulates particles in float textures on the GPU and draws them as soft points. Positions and
velocities are two RGBA textures advanced by `GPUSimulation`, so hundreds of thousands of particles cost two
full-screen passes and one draw per frame.

```ts
import { GPUParticles, onFrame } from '@tunn/oxygen';

const particles = new GPUParticles(pipeline.renderer, {
  count: 131_072,
  emitter: { type: 'sphere', center: [0, 0, 0], radius: 1.5 },
  lifetime: [3, 7],          // seconds, picked per particle
  speed: 0.1,                // birth speed in a random direction
  gravity: [0, -0.2, 0],
  drag: 0.9,                 // velocity loss per second
  curl: { strength: 1.4, scale: 0.55, speed: 0.12 },
  size: 0.018,               // world units
  colorStart: 0xffc27a,      // at birth
  colorEnd: 0x3a5cff,        // at death
  blending: 'additive',
});
pipeline.scene.add(particles.object);
onFrame((_t, delta) => particles.update(delta));
```

## Behaviour

- **Lifetime.** Position `w` holds the remaining life and velocity `w` the full lifetime. A particle whose life runs
  out respawns inside the emitter on the GPU, so changing `particles.emitter` (or moving it every frame) affects only
  particles born afterwards. The first generation's lives are spread over the lifetime so they do not die together.
- **Forces.** Gravity, exponential drag, curl noise and one spherical attractor. The curl of a vector noise field is
  divergence-free, so particles swirl without bunching up. `curl.scale` is the spatial frequency (1 / feature size).
- **Attractor.** `particles.attractor.position`, `strength` (negative repels) and `radius` (no effect beyond it). Point it
  at the pointer with `pointerToPlane` (see [input](input.md)).
- **Time.** `update(deltaMs)` clamps the step to 1/30 s so a background tab does not explode the simulation.
  `timeScale` scales or freezes it.
- **Rendering.** Points fade in over the first 10 % of their life and out over the last 20 %. Their size is in world
  units and scales with distance and the render target height.

Live tuning: `particles.material.uniforms` has `size`, `opacity`, `colorStart`, `colorEnd`;
`particles.simulation.uniforms('velocity')` has `gravity`, `drag`, `curl` (x strength, y scale, z speed).

## Requirements

WebGL 2 with renderable float (`EXT_color_buffer_float`) or half-float targets. Without either the constructor throws
`UnsupportedFeatureError`; choose a smaller `count` or skip the effect on quality tier 0.

## Custom simulations

`GPUSimulation` is the generic part: variables are RGBA textures computed by fragment shaders, every `step` computes
all variables from the previous step's textures and then swaps.

```ts
import { GPUSimulation, onFrame } from '@tunn/oxygen';

const sim = new GPUSimulation(renderer, 256, 256);
sim.addVariable({
  name: 'height',
  dependencies: ['height'],
  initial: new Float32Array(256 * 256 * 4),
  uniforms: { damping: { value: 0.98 } },
  fragmentShader: `
uniform float damping;
void main() {
  vec2 t = 1.0 / simResolution;
  vec4 c = texture(tHeight, vUv);
  float sum = texture(tHeight, vUv + vec2(t.x, 0.0)).r + texture(tHeight, vUv - vec2(t.x, 0.0)).r
            + texture(tHeight, vUv + vec2(0.0, t.y)).r + texture(tHeight, vUv - vec2(0.0, t.y)).r;
  float next = (sum * 0.5 - c.g) * damping;
  FragColor = vec4(next, c.r, 0.0, 1.0);
}`,
});
sim.init();
onFrame(() => {
  sim.step();
  material.uniforms.tHeight.value = sim.texture('height'); // the current texture alternates every step
});
```

Each shader gets `in vec2 vUv`, `out vec4 FragColor`, `uniform vec2 simResolution` and a `uniform sampler2D t<Name>`
per dependency (`height` → `tHeight`). `NOISE_GLSL` provides `oxHash12`, `oxHash33`, `oxGradientNoise`, `oxNoise3` and
`oxCurlNoise` for your own shaders.
