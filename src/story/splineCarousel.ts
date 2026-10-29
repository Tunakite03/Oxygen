import * as THREE from 'three';
import { Spring } from '../physics/spring';
import { clamp } from '../core/math';

export interface SplineCarouselItem<T = unknown> {
  id: string;
  object: THREE.Object3D;
  data: T;
  originalScale?: THREE.Vector3;
}

export interface SplineCarouselOptions {
  curve?: THREE.Curve<THREE.Vector3>;
  itemSpacing?: number;
  visibleRange?: number;
  orientation?: 'tangent' | 'lookAtCamera' | 'faceForward';
  springFrequency?: number;
  springDamping?: number;
}

/**
 * SplineCarousel3D arranges interactive 3D cards/meshes along a 3D curve (spine). A spring eases the
 * carousel between items, and items shrink with distance from the focal centre.
 */
export class SplineCarousel3D<T = unknown> {
  readonly curve: THREE.Curve<THREE.Vector3>;
  readonly items: SplineCarouselItem<T>[] = [];
  readonly container: THREE.Group;

  readonly scrollSpring: Spring;
  targetProgress = 0;
  progress = 0;

  itemSpacing: number;
  visibleRange: number;
  orientation: 'tangent' | 'lookAtCamera' | 'faceForward';

  activeIndex = 0;
  hoveredIndex: number | null = null;

  private readonly raycaster = new THREE.Raycaster();

  constructor(options: SplineCarouselOptions = {}) {
    this.container = new THREE.Group();
    this.container.name = 'SplineCarousel3D';

    // Default spine: a gentle S-curve through the origin
    this.curve = options.curve ?? new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -6, 4),
      new THREE.Vector3(0, -2, 1),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 2, -1),
      new THREE.Vector3(0, 6, -4),
    ]);

    this.itemSpacing = options.itemSpacing ?? 0.22;
    this.visibleRange = options.visibleRange ?? 1.2;
    this.orientation = options.orientation ?? 'tangent';

    this.scrollSpring = new Spring(0, {
      frequency: options.springFrequency ?? 2.5,
      damping: options.springDamping ?? 1,
    });
  }

  addItem(id: string, object: THREE.Object3D, data: T): void {
    const item: SplineCarouselItem<T> = {
      id,
      object,
      data,
      originalScale: object.scale.clone(),
    };
    this.items.push(item);
    this.container.add(object);
    this.updateItemTransform(this.items.length - 1);
  }

  scrollBy(delta: number): void {
    const maxProgress = Math.max(0, (this.items.length - 1) * this.itemSpacing);
    this.targetProgress = clamp(this.targetProgress + delta, 0, maxProgress);
  }

  scrollToIndex(index: number): void {
    const clamped = clamp(index, 0, Math.max(0, this.items.length - 1));
    this.targetProgress = clamped * this.itemSpacing;
    this.activeIndex = clamped;
  }

  update(dt = 16.67, camera?: THREE.Camera): void {
    // Spring toward targetProgress
    this.scrollSpring.target = this.targetProgress;
    this.progress = this.scrollSpring.update(dt);

    // Update closest active item index
    const approxIndex = Math.round(this.progress / this.itemSpacing);
    this.activeIndex = clamp(approxIndex, 0, Math.max(0, this.items.length - 1));

    for (let i = 0; i < this.items.length; i++) {
      this.updateItemTransform(i, camera);
    }
  }

  private updateItemTransform(index: number, camera?: THREE.Camera): void {
    const item = this.items[index];
    if (!item) return;

    // Relative distance along curve from centre (0.5 is the focal centre)
    const itemOffset = index * this.itemSpacing - this.progress;
    const u = 0.5 + itemOffset;

    // Visibility clipping
    if (u < -0.3 || u > 1.3) {
      item.object.visible = false;
      return;
    }
    item.object.visible = true;

    const clampedU = clamp(u, 0.001, 0.999);
    const point = this.curve.getPointAt(clampedU);
    const tangent = this.curve.getTangentAt(clampedU).normalize();

    item.object.position.copy(point);

    if (this.orientation === 'lookAtCamera' && camera) {
      item.object.lookAt(camera.position);
    } else if (this.orientation === 'tangent') {
      const up = new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
      const binormal = new THREE.Vector3().crossVectors(normal, tangent).normalize();
      const rotMatrix = new THREE.Matrix4().makeBasis(normal, binormal, tangent);
      item.object.quaternion.setFromRotationMatrix(rotMatrix);
    }

    // Distance attenuation: center item is full scale and bright, further items shrink
    const distFromCenter = Math.abs(itemOffset);
    const scaleFactor = clamp(1.0 - distFromCenter * 0.45, 0.35, 1.0);
    const isHovered = this.hoveredIndex === index;
    const hoverScale = isHovered ? 1.06 : 1.0;

    const baseScale = item.originalScale ?? new THREE.Vector3(1, 1, 1);
    item.object.scale.set(
      baseScale.x * scaleFactor * hoverScale,
      baseScale.y * scaleFactor * hoverScale,
      baseScale.z * scaleFactor * hoverScale,
    );
  }

  /** Index of the visible item under a normalized device coordinate, nearest first, or null when the ray misses. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera): number | null {
    this.raycaster.setFromCamera(ndc, camera);
    for (const hit of this.raycaster.intersectObjects(this.container.children, true)) {
      const index = this.indexOfItem(hit.object);
      if (index !== null && this.items[index]!.object.visible) return index;
    }
    return null;
  }

  /** Maps a mesh nested anywhere under an item back to that item's index. */
  private indexOfItem(object: THREE.Object3D): number | null {
    let root: THREE.Object3D | null = object;
    while (root && root.parent !== this.container) root = root.parent;
    if (!root) return null;
    const index = this.items.findIndex((item) => item.object === root);
    return index === -1 ? null : index;
  }

  dispose(): void {
    for (const item of this.items) {
      this.container.remove(item.object);
    }
    this.items.length = 0;
  }
}
