import * as THREE from 'three';
import { onFrame } from './loop';
import type { Phase } from './loop';

/**
 * Scene-graph component: a `THREE.Group` plus a parent chain. `startRender` callbacks only run while the component and
 * every ancestor are visible, so hidden scenes cost nothing per frame; timers and loops die with the component.
 */
export class Component {
  parent: Component | null = null;
  readonly group = new THREE.Group();
  private readonly loops = new Map<(time: number, delta: number) => void, () => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private _visible = true;

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this.group.visible = v;
  }

  /** Adds a child component; its group is parented under ours. */
  addChild<T extends Component>(child: T): T {
    child.parent = this;
    this.group.add(child.group);
    return child;
  }

  add(object: THREE.Object3D): void {
    this.group.add(object);
  }

  isEffectivelyVisible(): boolean {
    let p: Component | null = this;
    while (p) {
      if (!p._visible || !p.group.visible) return false;
      p = p.parent;
    }
    return true;
  }

  startRender(callback: (time: number, delta: number) => void, phase: Phase = 'loop'): void {
    if (this.loops.has(callback)) return;
    const off = onFrame((t, d) => {
      if (this.isEffectivelyVisible()) callback(t, d);
    }, phase);
    this.loops.set(callback, off);
  }

  stopRender(callback: (time: number, delta: number) => void): void {
    this.loops.get(callback)?.();
    this.loops.delete(callback);
  }

  clearRenders(): void {
    for (const off of this.loops.values()) off();
    this.loops.clear();
  }

  delayedCall(callback: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.add(id);
  }

  destroy(): void {
    this.clearRenders();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.group.removeFromParent();
  }
}
