import { prefersReducedMotion } from '../accessibility/motion';
import { GazeCamera } from '../camera/gazeCamera';
import { Component } from '../core/component';
import { emit, getState, listen, setState } from '../core/events';
import { frame, onFrame } from '../core/loop';
import { clamp, lerp, range } from '../core/math';
import { device, onResize, stage } from '../core/stage';
import { clearWorld, getHeightFromCamera, getWidthFromCamera, setWorld, units } from '../core/world';
import type { Pipeline } from '../gl/pipeline';
import { Interaction3D, setMainInteraction } from '../input/interaction3d';
import { scrollState } from '../scroll/scrollState';
import { VirtualScroll } from '../scroll/virtualScroll';
import type { ScrollOptions } from '../scroll/virtualScroll';
import type { StoryScene } from './storyScene';

/**
 * Scroll-driven story: stacks scenes vertically in world space and in the DOM, feeds the virtual scroll into the
 * camera (eased), toggles scene visibility, translates the DOM sections and publishes the scroll state.
 *
 * Published state: `Story/scroll`, `Story/scrollY` (world units, negative going down), `Story/scrollDirection`,
 * `Story/screenHeightWorld`, `Story/screenWidthWorld`, `Story/visibleScenes` (scene ids).
 * Events: `Global/scenesReady` after `start` lays out the scenes, `Story/update` (camera) every frame,
 * `Global/wheel` on wheel input. Emit `Global/loaderFinished` to hand control to the user: scrolling is enabled
 * 1.5 s later.
 *
 * Subclasses hook in with `onStart`, `onLoaderFinished`, `onScrollY`, `updateScene`, `afterScenes` and `afterUpdate`.
 */
export interface SceneConfig<S extends StoryScene = StoryScene> {
  scene: S;
  /** Height in viewport heights, or `auto` to use the DOM section's own height. */
  height: number | 'auto';
  /** Height at the narrowest layout; interpolated with `height` across `heightBreakpoints`. */
  mobileHeight?: number;
  marginTop?: number;
  marginBottom?: number;
}

export interface ScrollStoryOptions {
  fov?: number;
  cameraZ?: number;
  /** Pointer gaze strength of the story camera by layout. */
  gaze?: { desktop: number; mobile: number };
  /** Viewport width below which the mobile layout applies (touch devices always use it). */
  mobileBreakpoint?: number;
  /** Viewport widths (px) at which `height` and `mobileHeight` apply. */
  heightBreakpoints?: { desktop: number; mobile: number };
  /** Per-frame lerp of the camera toward the scroll position. */
  scrollLerp?: { desktop: number; mobile: number };
  scroll?: Partial<ScrollOptions>;
}

export class ScrollStory<S extends StoryScene = StoryScene> extends Component {
  readonly camera: GazeCamera;
  /** Twin of `camera` without pointer gaze, for screen-locked layers. */
  readonly fixedCamera: GazeCamera;
  readonly scroll: VirtualScroll;
  readonly root: HTMLDivElement;
  protected configs: SceneConfig<S>[] = [];
  private screenHeightWorld = 1;
  private screenWidthWorld = 1;
  private totalHeight = 0;
  private lerpedScrollY = -1e-4;
  private lerpedScrollDeltaY = 0;
  private readonly lerpDelta: number;
  private visibleScenes: string[] = [];
  private readonly options: Required<Omit<ScrollStoryOptions, 'scroll'>>;
  private readonly interaction: Interaction3D;
  private readonly events = new AbortController();
  private observer: ResizeObserver | null = null;
  private offLoader: (() => void) | null = null;
  private offResize: (() => void) | null = null;
  private offFrame: (() => void) | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    protected readonly pipeline: Pipeline,
    root: HTMLDivElement,
    options: ScrollStoryOptions = {},
  ) {
    super();
    this.options = {
      fov: options.fov ?? 35,
      cameraZ: options.cameraZ ?? 5,
      gaze: options.gaze ?? { desktop: 0.5, mobile: 0 },
      mobileBreakpoint: options.mobileBreakpoint ?? 768,
      heightBreakpoints: options.heightBreakpoints ?? { desktop: 1600, mobile: 393 },
      scrollLerp: options.scrollLerp ?? { desktop: 0.08, mobile: 0.9 },
    };
    const { fov, cameraZ, gaze } = this.options;
    this.root = root;
    this.lerpDelta = device.mobile ? this.options.scrollLerp.mobile : this.options.scrollLerp.desktop;
    this.camera = new GazeCamera(fov);
    this.camera.setPosition(0, 0, cameraZ);
    this.camera.moveXY.set(gaze.desktop, gaze.desktop);
    this.fixedCamera = new GazeCamera(fov);
    this.fixedCamera.setPosition(0, 0, cameraZ);
    this.fixedCamera.moveXY.set(0, 0);
    this.camera.resize(stage.width / stage.height);
    this.fixedCamera.resize(stage.width / stage.height);
    pipeline.scene.add(this.camera.group, this.fixedCamera.group);
    setWorld({ renderer: pipeline.renderer, scene: pipeline.scene, camera: this.camera, fixedCamera: this.fixedCamera, uiScene: pipeline.uiScene, beforePassesScene: pipeline.beforePassesScene, sceneTexture: pipeline.sceneRT.texture, dpr: pipeline.dpr });
    this.interaction = new Interaction3D(() => this.camera.camera);
    setMainInteraction(this.interaction);
    this.scroll = new VirtualScroll({ drag: device.mobile, mouseWheel: true, limit: true, keyboard: true, scale: 1, touchScale: 1, ...options.scroll });
    setState('Story/scroll', this.scroll);
    this.updateScreenWorld();
    setState('Story/scrollY', 0);
    pipeline.scene.add(this.group);
  }

  get scenes(): readonly S[] {
    return this.configs.map(({ scene }) => scene);
  }

  private updateScreenWorld(): void {
    const dist = this.camera.position.z;
    this.screenHeightWorld = getHeightFromCamera(this.camera.camera, dist);
    this.screenWidthWorld = getWidthFromCamera(this.camera.camera, dist);
    setState('Story/screenHeightWorld', this.screenHeightWorld);
    setState('Story/screenWidthWorld', this.screenWidthWorld);
    const fov = (this.camera.camera.fov * Math.PI) / 180;
    units.perPixelY = (Math.tan(fov / 2) * Math.abs(this.camera.position.z) * 2) / stage.height;
  }

  /** Loads every scene (assets, child components, DOM sections); progress reports scenes as they finish. */
  async load(configs: SceneConfig<S>[], onProgress: (loaded: number, total: number) => void): Promise<void> {
    if (this.destroyed) return;
    this.configs = configs;
    let loaded = 0;
    await Promise.all(
      configs.map(async ({ scene }) => {
        this.addChild(scene);
        await scene.load(this.root);
        if (this.destroyed) return;
        onProgress(++loaded, configs.length);
      }),
    );
  }

  private sceneHeight(initial: number | 'auto', mobile: number | undefined): number | 'auto' {
    const { desktop, mobile: narrow } = this.options.heightBreakpoints;
    return mobile !== undefined && initial !== 'auto' ? range(stage.width, desktop, narrow, initial, mobile, true) : initial;
  }

  /** Lays out and initialises the scenes, then runs the frame loop once the loader finishes. Call after `load`. */
  async start(): Promise<void> {
    if (this.destroyed) return;
    this.onStart();
    if (this.destroyed) return;
    const scroll = this.scroll;
    this.totalHeight = 0;
    const inits: Promise<void>[] = [];
    this.configs.forEach(({ scene, height, mobileHeight, marginTop = 0, marginBottom = 0 }, index) => {
      this.totalHeight += marginTop * this.screenHeightWorld;
      scene.initialHeight = height;
      scene.initialMobileHeight = mobileHeight;
      scene.setLayout({ screenHeightWorld: this.screenHeightWorld, height: this.sceneHeight(height, mobileHeight), totalHeight: this.totalHeight, marginTop, marginBottom });
      scene.visible = index === 0;
      this.totalHeight += scene.heightWorld + marginBottom * this.screenHeightWorld;
      inits.push(scene.init());
    });
    await Promise.all(inits);
    if (this.destroyed) return;
    scrollState.ready = true;
    for (const { scene } of this.configs) scene.ui?.computeScrollBounds();
    emit('Global/scenesReady');
    if (this.destroyed) return;

    this.observer = new ResizeObserver(() => {
      if (this.destroyed) return;
      scroll.max.y = this.root.clientHeight - stage.height;
      scrollState.max = scroll.max.y;
    });
    this.observer.observe(this.root);
    window.addEventListener('wheel', () => emit('Global/wheel'), { passive: true, signal: this.events.signal });
    scroll.max.y = this.root.clientHeight - stage.height;
    scroll.enabled = false;
    this.loop();
    await new Promise((r) => requestAnimationFrame(r));
    if (this.destroyed) return;
    this.loop();
    if (this.destroyed) return;
    this.offLoader = listen('Global/loaderFinished', () => {
      this.offLoader?.();
      this.offLoader = null;
      if (this.destroyed) return;
      this.onLoaderFinished();
      if (this.destroyed) return;
      this.delayedCall(() => (scroll.enabled = true), 1500);
      this.offFrame = onFrame(() => this.loop(), 'afterLoops');
    });
    this.offResize = onResize(() => {
      if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => void this.handleResize(), 200);
    });
    await this.handleResize();
  }

  /** Eases back to the top; the duration grows with the distance (0.8 s for one screen, 3 s from ten or more). */
  scrollToTop(): number {
    const scroll = this.scroll;
    const time = range(Math.abs(scroll.y), stage.height, 10 * stage.height, 800, 3000, true);
    scroll.enabled = false;
    scroll.scrollTo(0, time, 'easeOutCubic');
    this.delayedCall(() => (scroll.enabled = true), 200);
    return time;
  }

  /** Scene by id (`StoryScene.id`). */
  protected findScene(id: string): S | undefined {
    return this.configs.find(({ scene }) => scene.id === id)?.scene;
  }

  /** Runs first in `start`, before the scenes are laid out. */
  protected onStart(): void {}

  /** Runs when `Global/loaderFinished` fires, before scrolling is scheduled to unlock. */
  protected onLoaderFinished(): void {}

  /** Each frame after `Story/scrollY` is published, with the eased scroll in world units. */
  protected onScrollY(_scrollY: number): void {}

  /** Each frame per scene, between its visibility update and its DOM translation. */
  protected updateScene(_scene: S): void {}

  /** Each frame after visibility, with the visible scene ids of this frame and the previous one. */
  protected afterScenes(_visible: readonly string[], _previous: readonly string[]): void {}

  /** Each frame after `Story/visibleScenes` is published, before `Story/update`. */
  protected afterUpdate(): void {}

  private loop(): void {
    if (this.destroyed) return;
    const scroll = this.scroll;
    this.lerpedScrollY = prefersReducedMotion() ? -scroll.y : lerp(-scroll.y, this.lerpedScrollY, this.lerpDelta);
    const finalScrollY = this.lerpedScrollY * units.perPixelY;
    const prev = getState<number>('Story/scrollY') ?? 0;
    setState('Story/scrollDirection', Math.sign(finalScrollY - prev));
    scrollState.y = scroll.y;
    scrollState.delta = scroll.delta.y;
    setState('Story/scrollY', finalScrollY);
    this.onScrollY(finalScrollY);
    this.camera.group.position.y = finalScrollY;
    this.fixedCamera.group.position.y = finalScrollY;
    this.fixedCamera.update(frame.time);
    this.lerpedScrollDeltaY = lerp(scroll.delta.y || 0, this.lerpedScrollDeltaY, this.lerpDelta);
    this.camera.group.rotation.x = prefersReducedMotion() ? 0 : clamp(lerp(0.002 * this.lerpedScrollDeltaY, this.camera.group.rotation.x, 0.05), -0.2, 0.2);
    this.camera.update(frame.time);
    for (const { scene } of this.configs) {
      // Top/bottom custom paddings are crossed here; scenes are tuned against this mapping, so keep it.
      scene.toggleVisibility({
        lerpedScrollY: finalScrollY,
        screenHeightWorld: this.screenHeightWorld,
        visibilityPaddingTop: scene.customVisibilityPaddingBottom ?? 0.1,
        visibilityPaddingBottom: scene.customVisibilityPaddingTop ?? 0.1,
      });
      this.updateScene(scene);
      scene.scrollUI(this.lerpedScrollY);
    }
    const visible = this.configs.filter(({ scene }) => scene.visible).map(({ scene }) => scene.id);
    this.afterScenes(visible, this.visibleScenes);
    this.visibleScenes = visible;
    setState('Story/visibleScenes', visible);
    this.afterUpdate();
    emit('Story/update', this.camera.camera);
  }

  private async handleResize(): Promise<void> {
    if (this.destroyed) return;
    const isMobile = device.mobile || stage.width < this.options.mobileBreakpoint;
    const gaze = isMobile ? this.options.gaze.mobile : this.options.gaze.desktop;
    this.camera.moveXY.set(gaze, gaze);
    this.camera.resize(stage.width / stage.height);
    this.fixedCamera.resize(stage.width / stage.height);
    this.updateScreenWorld();
    this.totalHeight = 0;
    for (const { scene, marginTop = 0, marginBottom = 0 } of this.configs) {
      scene.isResizing = true;
      this.totalHeight += marginTop * this.screenHeightWorld;
      scene.setLayout({ screenHeightWorld: this.screenHeightWorld, height: this.sceneHeight(scene.initialHeight, scene.initialMobileHeight), totalHeight: this.totalHeight, marginTop, marginBottom });
      this.totalHeight += scene.heightWorld + marginBottom * this.screenHeightWorld;
      await scene.handleViewResize();
      if (this.destroyed) return;
    }
    this.scroll.max.y = this.root.clientHeight - stage.height;
    scrollState.max = this.scroll.max.y;
  }

  override destroy(): void {
    if (this.destroyed) return;
    super.destroy();
    this.events.abort();
    this.observer?.disconnect();
    this.observer = null;
    this.offLoader?.();
    this.offResize?.();
    this.offFrame?.();
    this.offLoader = this.offResize = this.offFrame = null;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.scroll.destroy();
    this.interaction.destroy();
    this.camera.group.removeFromParent();
    this.fixedCamera.group.removeFromParent();
    this.configs = [];
    clearWorld(this.camera);
    if (getState<VirtualScroll>('Story/scroll') === this.scroll) {
      scrollState.ready = false;
      setState('Story/scroll', undefined);
      setState('Story/visibleScenes', []);
    }
  }
}
