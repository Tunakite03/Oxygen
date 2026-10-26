import * as THREE from 'three';
import { frame } from '../core/loop';
import { getDPR, stage } from '../core/stage';
import type { PostStack } from '../post/postStack';
import { globalUniforms } from './shaderLibrary';

/**
 * Frame pipeline: the world scene renders into an MSAA target, an optional pixel-space overlay is drawn into the same
 * buffer, one full-screen composite material draws it to the canvas, then the pixel-space UI overlay (ortho camera,
 * y down, insertion order) draws on top. Sorting: renderOrder, then world z (transparent) or material (opaque), then
 * creation id, which keeps authored layer order stable.
 *
 * With a `PostStack` attached (`setPost`), the stack replaces the composite draw: it reads the scene buffer and its
 * last pass writes the canvas. Add the composite material as a `ShaderPass` to keep it.
 */
export interface PipelineOptions {
  clearColor?: THREE.ColorRepresentation;
  /** MSAA samples of the scene buffer. Default 4. */
  samples?: number;
  /**
   * three.js flips the front face of mirrored (negative-scale) meshes. Set false to keep the authored winding, which
   * content exported for engines without that flip expects. Default true.
   */
  flipMirroredWinding?: boolean;
  /** Half-float scene buffer so lighting above 1.0 survives until tone mapping (bloom, colour grading). Default false. */
  hdr?: boolean;
}

export interface Pipeline {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  uiScene: THREE.Scene;
  uiCamera: THREE.OrthographicCamera;
  /** Pixel-space overlay drawn into the scene buffer before the composite pass. */
  beforePassesScene: THREE.Scene;
  sceneRT: THREE.WebGLRenderTarget;
  /** Full-screen material that draws `tDiffuse` (the scene buffer) to the canvas; a plain copy until one is set. */
  composite: THREE.RawShaderMaterial | null;
  /** Post-processing stack drawn instead of the composite, or null. */
  post: PostStack | null;
  /** Current pixel ratio of the canvas and the scene buffer. */
  readonly dpr: number;
  setComposite(material: THREE.RawShaderMaterial): void;
  setPost(stack: PostStack | null): void;
  /** Changes the canvas, scene buffer and post stack resolution (adaptive quality). */
  setPixelRatio(dpr: number): void;
  render(camera: THREE.Camera): void;
  /** Extra off-screen renders run before the main pass each frame (FX scenes, water sims). */
  addPreRender(fn: () => void): () => void;
  /**
   * Compiles every program and uploads every texture and geometry of the three scenes, hidden chapters included, so
   * the first time a chapter scrolls into view does not stall on lazy GPU work. Run once while the loader is up.
   */
  warmUp(camera: THREE.Camera): Promise<void>;
}

const _m = new THREE.Vector3();

/** Meshes drawn outside the three scenes (full-screen passes) that only run on demand; precompiled by `warmUp`. */
const offscreenPasses = new Set<THREE.Object3D>();

export function registerOffscreenPass(object: THREE.Object3D): void {
  offscreenPasses.add(object);
}

/** Shows every object (and turns off culling) for one warm-up draw; returns the restore function. */
function revealAll(root: THREE.Object3D): () => void {
  const saved: [THREE.Object3D, boolean, boolean][] = [];
  root.traverse((o) => {
    saved.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  return () => {
    for (const [o, visible, culled] of saved) {
      o.visible = visible;
      o.frustumCulled = culled;
    }
  };
}

function createCopyMaterial(): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    name: 'PipelineCopy',
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = vec4(position.xy, 0.0, 1.0);\n}',
    fragmentShader: 'precision highp float;\nuniform sampler2D tDiffuse;\nin vec2 vUv;\nout vec4 FragColor;\nvoid main() {\n  FragColor = texture(tDiffuse, vUv);\n}',
    uniforms: { tDiffuse: { value: null } },
    depthTest: false,
    depthWrite: false,
  });
}

function worldZ(o: THREE.Object3D): number {
  return _m.setFromMatrixPosition(o.matrixWorld).z;
}

export function createPipeline(canvasParent: HTMLElement, options: PipelineOptions = {}): Pipeline {
  let dpr = getDPR();
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(dpr);
  renderer.setSize(stage.width, stage.height);
  renderer.setClearColor(options.clearColor ?? '#000000', 1);
  if (options.flipMirroredWinding === false) {
    const setMaterial = renderer.state.setMaterial.bind(renderer.state);
    renderer.state.setMaterial = (material: THREE.Material, _frontFaceCW: boolean, clippingPlanes: number): void => setMaterial(material, false, clippingPlanes);
  }
  renderer.sortObjects = true;
  renderer.setOpaqueSort((a, b) => a.renderOrder - b.renderOrder || (a.material.id - b.material.id) || a.id - b.id);
  renderer.setTransparentSort((a, b) => a.renderOrder - b.renderOrder || worldZ(a.object) - worldZ(b.object) || a.id - b.id);
  const canvas = renderer.domElement;
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvasParent.appendChild(canvas);

  const scene = new THREE.Scene();
  const uiScene = new THREE.Scene();
  const beforePassesScene = new THREE.Scene();
  const uiCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  uiCamera.position.z = 1;
  const sceneRT = new THREE.WebGLRenderTarget(stage.width * dpr, stage.height * dpr, {
    samples: options.samples ?? 4,
    type: options.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    generateMipmaps: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), createCopyMaterial());
  quad.frustumCulled = false;
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const preRenders = new Set<() => void>();
  const camQuat = new THREE.Quaternion();

  const resize = (): void => {
    renderer.setPixelRatio(dpr);
    renderer.setSize(stage.width, stage.height);
    sceneRT.setSize(stage.width * dpr, stage.height * dpr);
    pipeline.post?.setSize(stage.width * dpr, stage.height * dpr);
    uiCamera.left = -stage.width / 2;
    uiCamera.right = stage.width / 2;
    uiCamera.top = stage.height / 2;
    uiCamera.bottom = -stage.height / 2;
    uiCamera.position.set(stage.width / 2, -stage.height / 2, 1);
    uiCamera.updateProjectionMatrix();
  };
  const pipeline: Pipeline = {
    renderer,
    scene,
    uiScene,
    uiCamera,
    beforePassesScene,
    sceneRT,
    composite: null,
    post: null,
    get dpr() {
      return dpr;
    },
    setComposite(material) {
      material.depthTest = false;
      material.depthWrite = false;
      quad.material = material;
      pipeline.composite = material;
    },
    setPost(stack) {
      pipeline.post = stack;
      stack?.setSize(stage.width * dpr, stage.height * dpr);
    },
    setPixelRatio(value) {
      if (!(value > 0)) throw new RangeError(`Pixel ratio must be positive, got ${value}`);
      if (value === dpr) return;
      dpr = value;
      resize();
    },
    addPreRender(fn) {
      preRenders.add(fn);
      return () => preRenders.delete(fn);
    },
    async warmUp(camera) {
      const passes: [THREE.Scene, THREE.Camera][] = [
        [scene, camera],
        [beforePassesScene, uiCamera],
        [uiScene, uiCamera],
      ];
      // KHR_parallel_shader_compile lets the driver build the programs off the main thread.
      const targets: [THREE.Object3D, THREE.Camera][] = [...passes, ...[...offscreenPasses].map((o): [THREE.Object3D, THREE.Camera] => [o, quadCamera])];
      if (renderer.extensions.has('KHR_parallel_shader_compile')) await Promise.all(targets.map(([o, c]) => renderer.compileAsync(o, c)));
      else for (const [o, c] of targets) renderer.compile(o, c);
      // One draw of everything into a 1x1 target uploads the textures and vertex buffers (and links any program whose
      // key depends on the drawn object). Layers are opened so FX-layer meshes are included.
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, generateMipmaps: false });
      const previous = renderer.getRenderTarget();
      for (const [s, c] of passes) {
        const restore = revealAll(s);
        const mask = c.layers.mask;
        c.layers.enableAll();
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(s, c);
        c.layers.mask = mask;
        restore();
      }
      // One pass of the post stack compiles its programs and allocates its targets.
      pipeline.post?.render(sceneRT.texture, target);
      renderer.setRenderTarget(previous);
      target.dispose();
    },
    render(camera) {
      globalUniforms.time.value += 0.001 * frame.delta;
      for (const fn of preRenders) fn();
      camera.getWorldQuaternion(camQuat);
      globalUniforms.cameraQuaternion.value.set(camQuat.x, camQuat.y, camQuat.z, camQuat.w);
      globalUniforms.resolution.value.set(sceneRT.width, sceneRT.height);
      renderer.setRenderTarget(sceneRT);
      renderer.clear();
      renderer.render(scene, camera);
      if (beforePassesScene.children.length) {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(beforePassesScene, uiCamera);
        renderer.autoClear = autoClear;
      }
      renderer.setRenderTarget(null);
      globalUniforms.resolution.value.set(canvas.width, canvas.height);
      if (pipeline.post) pipeline.post.render(sceneRT.texture, null);
      else drawComposite();
      if (uiScene.children.length) {
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(uiScene, uiCamera);
        renderer.autoClear = autoClear;
      }
    },
  };
  const drawComposite = (): void => {
    const tDiffuse = quad.material.uniforms.tDiffuse;
      if (!tDiffuse) throw new Error(`Composite material "${quad.material.name}" has no tDiffuse uniform`);
    tDiffuse.value = sceneRT.texture;
    renderer.render(quad, quadCamera);
  };
  resize();
  window.addEventListener('resize', resize);
  return pipeline;
}

