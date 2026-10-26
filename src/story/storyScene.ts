import * as THREE from 'three';
import { Component } from '../core/component';
import { requireState } from '../core/events';
import { range } from '../core/math';
import { stage } from '../core/stage';
import { getHeightFromCamera, units } from '../core/world';
import { SceneUI } from '../scroll/sceneUI';
import type { SceneUIOptions } from '../scroll/sceneUI';

/**
 * One scene (chapter) of a `ScrollStory`. It owns a DOM section (`SceneUI`) whose height decides how long the scene
 * stays on screen, a vertical slot in the shared world (`worldBottom`..`worldTop`, world units measured down from the
 * story top), scroll-driven visibility and `scrollProgress`.
 *
 * Lifecycle: `load` (assets, `create`, DOM section, `setupUI`) → `setLayout` → `init` → per frame
 * `toggleVisibility` + `scrollUI` → `handleViewResize` on resize. In/out-view triggers call `animateIn` / `animateOut`.
 */
export interface LayoutArgs {
  screenHeightWorld: number;
  height: number | 'auto';
  totalHeight: number;
  marginTop: number;
  marginBottom: number;
}

export interface VisibilityArgs {
  lerpedScrollY: number;
  screenHeightWorld: number;
  visibilityPaddingTop: number;
  visibilityPaddingBottom: number;
}

export abstract class StoryScene extends Component {
  readonly name: string;
  /** CSS `order` of the DOM section inside the story root. */
  readonly order: number;
  ui: SceneUI | null = null;
  heightWorld = 0;
  /** Height in viewport heights, after `auto` sections are measured. */
  baseHeight = 1;
  worldTop = 0;
  worldBottom = 0;
  worldMiddle = 0;
  marginTop = 0;
  marginBottom = 0;
  marginTopWorld = 0;
  marginBottomWorld = 0;
  /** 0 when the slot starts entering the viewport, 1 when it has fully left through the top. */
  scrollProgress = 0;
  customVisibilityPaddingTop: number | undefined;
  customVisibilityPaddingBottom: number | undefined;
  isResizing = false;
  /** Heights from the story config, kept for re-layout on resize. */
  initialHeight: number | 'auto' = 1;
  initialMobileHeight: number | undefined;

  protected constructor(name: string, order: number) {
    super();
    this.name = name;
    this.order = order;
    this.group.name = name;
  }

  /** Stable id used in `Story/visibleScenes`: the name with a lower-case first letter. */
  get id(): string {
    return this.name.charAt(0).toLowerCase() + this.name.slice(1);
  }

  /** DOM section options; scenes with DOM content override. */
  protected uiOptions(): Omit<SceneUIOptions, 'className'> {
    return { useScrollTrigger: true, scrollTriggerOffsetIn: 0.25, scrollTriggerOffsetOut: 0.25 };
  }

  /** Creates child components (`create`), then the DOM section in `storyRoot`. Subclasses load assets first. */
  async load(storyRoot: HTMLElement): Promise<void> {
    await this.create();
    this.ui = new SceneUI(storyRoot, { className: this.name.replace('Scene', 'UI'), ...this.uiOptions() });
    this.ui.onInView = () => this.onInView();
    this.ui.onOutView = () => this.onOutView();
    this.setupUI(this.ui);
  }

  /** Child components created before the DOM section. */
  protected async create(): Promise<void> {}

  /** DOM wiring for sections with content. */
  protected setupUI(_ui: SceneUI): void {}

  /** Scene setup that needs the final layout. */
  async init(): Promise<void> {}

  handleResize(): void | Promise<void> {}

  animateIn(): void {}

  animateOut(): void {}

  protected onInView(): void {
    this.animateIn();
  }

  protected onOutView(): void {
    this.animateOut();
  }

  onVisibilityChange(_visible: boolean): void {}

  get screenHeightWorld(): number {
    return requireState<number>('Story/screenHeightWorld');
  }

  get screenWidthWorld(): number {
    return requireState<number>('Story/screenWidthWorld');
  }

  /** Slot edges in viewport heights relative to the current scroll, for clipping layers to the slot in shaders. */
  discardValues(scrollY: number): { top: number; bottom: number } {
    const shw = this.screenHeightWorld;
    return { top: (this.worldTop + scrollY) / shw, bottom: (this.worldBottom + scrollY) / shw };
  }

  toggleVisibility({ lerpedScrollY, screenHeightWorld, visibilityPaddingTop, visibilityPaddingBottom }: VisibilityArgs): void {
    const visible = -lerpedScrollY + screenHeightWorld + visibilityPaddingBottom > this.worldBottom && -lerpedScrollY - visibilityPaddingTop < this.worldTop;
    this.scrollProgress = range(-lerpedScrollY, this.worldBottom - screenHeightWorld - visibilityPaddingBottom + this.marginTopWorld, this.worldTop + visibilityPaddingTop, 0, 1);
    this.visible = visible;
    this.onVisibilityChange(visible);
  }

  scrollUI(scrollY: number): void {
    this.ui?.setScroll(scrollY);
  }

  setLayout({ screenHeightWorld, height, totalHeight, marginTop, marginBottom }: LayoutArgs): void {
    this.marginTop = marginTop || 0;
    this.marginBottom = marginBottom || 0;
    this.marginTopWorld = this.marginTop * screenHeightWorld;
    this.marginBottomWorld = this.marginBottom * screenHeightWorld;
    const ui = this.ui;
    if (!ui) throw new Error(`${this.name}: setLayout before UI creation`);
    ui.element.style.order = String(this.order);
    if (height === 'auto') ui.element.style.setProperty('height', 'auto', 'important');
    else {
      ui.element.style.setProperty('--height', `${stage.height * height}px`);
      ui.element.style.setProperty('--margin-top', `${stage.height * marginTop}px`);
      ui.element.style.setProperty('--margin-bottom', `${stage.height * marginBottom}px`);
    }
    const h = height === 'auto' ? ui.element.clientHeight / stage.height : height;
    this.baseHeight = h;
    this.heightWorld = h * screenHeightWorld;
    this.group.position.y = 0.5 * screenHeightWorld - totalHeight - 0.5 * this.heightWorld;
    this.worldBottom = totalHeight;
    this.worldMiddle = totalHeight + 0.5 * this.heightWorld;
    this.worldTop = totalHeight + this.heightWorld;
  }

  get worldTopPx(): number {
    return this.worldTop / units.perPixelY;
  }

  get worldBottomPx(): number {
    return this.worldBottom / units.perPixelY;
  }

  /**
   * An element's screen rect mapped to the plane `dist` in front of the camera (position of its centre and its size).
   * `offsetY` (px) is subtracted from the rect top.
   */
  domToWebGL(element: HTMLElement, camera: THREE.PerspectiveCamera, dist: number, offsetY: number): { position: THREE.Vector2; scale: THREE.Vector3 } {
    const b = element.getBoundingClientRect();
    const vh = getHeightFromCamera(camera, dist);
    const vw = vh * camera.aspect;
    const x = b.left + b.width / 2;
    const y = b.top - offsetY + b.height / 2;
    return {
      position: new THREE.Vector2((x / stage.width - 0.5) * vw, (1 - y / stage.height - 0.5) * vh),
      scale: new THREE.Vector3((b.width / stage.width) * vw, (b.height / stage.height) * vh, (b.height / stage.height) * vh),
    };
  }

  /** The section's current top (its DOM follows the lerped scroll) minus the centring pad of a shorter-than-viewport section. */
  sectionOffsetY(): number {
    if (!this.ui) throw new Error(`${this.name}: sectionOffsetY before UI creation`);
    return this.ui.element.getBoundingClientRect().top - ((1 - this.baseHeight) / 2) * stage.height;
  }

  async handleViewResize(): Promise<void> {
    this.ui?.handleUIResize();
    await this.handleResize();
    this.isResizing = false;
  }
}
