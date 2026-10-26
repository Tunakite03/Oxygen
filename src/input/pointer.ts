import * as THREE from 'three';

/**
 * Pointer state for interactive scenes: position in CSS pixels, NDC and UV relative to an element, smoothed velocity
 * in px/s, an eased follower, and tap / drag gestures. Mouse, pen and touch go through the same Pointer Events path;
 * only the primary pointer is tracked. `feed` is the single entry point, so input can be replayed in tests.
 */
export interface PointerTrackerOptions {
  /** Time constant (s) of the velocity smoothing. Default 0.05. */
  velocitySmoothing?: number;
  /** Per-60 Hz-frame lerp of `smoothed` toward `position` in `update`. Default 0.15. */
  follow?: number;
  /** Movement (px) after which a press becomes a drag. Default 6. */
  dragThreshold?: number;
  /** A press released within this time (ms) without dragging is a tap. Default 300. */
  tapMaxMs?: number;
}

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel' | 'leave';

export interface DragState {
  active: boolean;
  start: THREE.Vector2;
  /** Offset from `start` in px. */
  delta: THREE.Vector2;
}

export interface PointerEvents {
  tap: (position: THREE.Vector2) => void;
  dragStart: (drag: DragState) => void;
  drag: (drag: DragState) => void;
  dragEnd: (drag: DragState) => void;
}

type Listeners = { [K in keyof PointerEvents]: Set<PointerEvents[K]> };

export class PointerTracker {
  /** CSS px relative to the element's top-left. */
  readonly position = new THREE.Vector2();
  /** -1..1, y up. */
  readonly ndc = new THREE.Vector2();
  /** 0..1, y up. */
  readonly uv = new THREE.Vector2(0.5, 0.5);
  /** Smoothed px/s. */
  readonly velocity = new THREE.Vector2();
  /** Eased follower of `position`, advanced by `update`. */
  readonly smoothed = new THREE.Vector2();
  readonly drag: DragState = { active: false, start: new THREE.Vector2(), delta: new THREE.Vector2() };
  down = false;
  /** False until the first event and after the pointer leaves the element. */
  inside = false;
  private readonly options: Required<PointerTrackerOptions>;
  private readonly listeners: Listeners = { tap: new Set(), dragStart: new Set(), drag: new Set(), dragEnd: new Set() };
  private readonly cleanup: (() => void)[] = [];
  private lastTime = -1;
  private downTime = 0;
  private width = 1;
  private height = 1;
  private initialised = false;

  constructor(
    private readonly element: HTMLElement | Window = window,
    options: PointerTrackerOptions = {},
  ) {
    this.options = { velocitySmoothing: 0.05, follow: 0.15, dragThreshold: 6, tapMaxMs: 300, ...options };
    const handler = (phase: PointerPhase) => (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const rect = this.rect();
      this.feed(phase, e.clientX - rect.left, e.clientY - rect.top, e.timeStamp, rect.width, rect.height);
    };
    const bind = (type: string, phase: PointerPhase, target: HTMLElement | Window = element): void => {
      const fn = handler(phase) as EventListener;
      target.addEventListener(type, fn, { passive: true });
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    bind('pointerdown', 'down');
    bind('pointermove', 'move');
    // Releases are tracked on the window so a drag that ends outside the element still ends.
    bind('pointerup', 'up', window);
    bind('pointercancel', 'cancel', window);
    if (element !== window) bind('pointerleave', 'leave');
  }

  private rect(): { left: number; top: number; width: number; height: number } {
    if (this.element instanceof Window) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return this.element.getBoundingClientRect();
  }

  on<K extends keyof PointerEvents>(event: K, listener: PointerEvents[K]): () => void {
    const set = this.listeners[event] as Set<PointerEvents[K]>;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Applies one pointer sample: local position (px), timestamp (ms) and the element size. */
  feed(phase: PointerPhase, x: number, y: number, time: number, width = this.width, height = this.height): void {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    if (phase === 'leave') {
      this.inside = false;
      return;
    }
    const dt = this.lastTime < 0 ? 0 : (time - this.lastTime) / 1000;
    if (dt > 0 && phase === 'move') {
      const vx = (x - this.position.x) / dt;
      const vy = (y - this.position.y) / dt;
      const a = 1 - Math.exp(-dt / this.options.velocitySmoothing);
      this.velocity.x += (vx - this.velocity.x) * a;
      this.velocity.y += (vy - this.velocity.y) * a;
    }
    this.lastTime = time;
    this.position.set(x, y);
    this.ndc.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.uv.set(x / this.width, 1 - y / this.height);
    if (!this.initialised) {
      this.smoothed.copy(this.position);
      this.initialised = true;
    }
    this.inside = phase !== 'up' && phase !== 'cancel' ? true : this.inside;

    if (phase === 'down') {
      this.down = true;
      this.downTime = time;
      this.drag.start.set(x, y);
      this.drag.delta.set(0, 0);
    } else if (phase === 'move' && this.down) {
      this.drag.delta.set(x - this.drag.start.x, y - this.drag.start.y);
      if (!this.drag.active && this.drag.delta.length() >= this.options.dragThreshold) {
        this.drag.active = true;
        for (const l of [...this.listeners.dragStart]) l(this.drag);
      }
      if (this.drag.active) for (const l of [...this.listeners.drag]) l(this.drag);
    } else if (phase === 'up' || phase === 'cancel') {
      if (!this.down) return;
      this.down = false;
      if (this.drag.active) {
        this.drag.active = false;
        for (const l of [...this.listeners.dragEnd]) l(this.drag);
      } else if (phase === 'up' && time - this.downTime <= this.options.tapMaxMs) {
        for (const l of [...this.listeners.tap]) l(this.position);
      }
    }
  }

  /** Per frame: eases `smoothed` and decays the velocity once the pointer stops sending moves. */
  update(deltaMs: number): void {
    const dt = Math.max(deltaMs, 0) / 1000;
    const follow = 1 - Math.pow(1 - THREE.MathUtils.clamp(this.options.follow, 0, 1), dt * 60);
    this.smoothed.lerp(this.position, follow);
    this.velocity.multiplyScalar(Math.exp(-dt * 6));
  }

  get speed(): number {
    return this.velocity.length();
  }

  destroy(): void {
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
  }
}

const _raycaster = new THREE.Raycaster();

/** Where the ray through `ndc` meets `plane`, or null when it is parallel or behind the camera. */
export function pointerToPlane(ndc: THREE.Vector2, camera: THREE.Camera, plane: THREE.Plane, out = new THREE.Vector3()): THREE.Vector3 | null {
  _raycaster.setFromCamera(ndc, camera);
  return _raycaster.ray.intersectPlane(plane, out);
}
