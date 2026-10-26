import * as THREE from 'three';
import { initializeStage, pointer, stage } from '../core/stage';

/**
 * Pointer interaction with 3D meshes: raycasts registered meshes from the pointer, firing over/out on hover
 * changes, move while hovering and click when press and release hit the same mesh. DOM elements with the classes
 * `hit` or `prevent_interaction3d` under the pointer block 3D interaction, like the original.
 */
export interface Interaction3DEvent {
  action: 'over' | 'out' | 'click' | 'move' | 'start';
  mesh: THREE.Object3D;
  hit: THREE.Intersection | null;
}

type Callback = (e: Interaction3DEvent) => void;

interface Entry {
  mesh: THREE.Object3D;
  hover?: Callback;
  click?: Callback;
  move?: Callback;
}

const PROHIBITED = ['hit', 'prevent_interaction3d'];

function prohibited(x: number, y: number): boolean {
  let el: Element | null = document.elementFromPoint(Math.min(Math.max(x, 0), stage.width), Math.min(Math.max(y, 0), stage.height));
  while (el) {
    for (const c of PROHIBITED) if (el.classList?.contains(c)) return true;
    el = el.parentElement;
  }
  return false;
}

function effectivelyVisible(o: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = o;
  while (p) {
    if (!p.visible) return false;
    p = p.parent;
  }
  return true;
}

export class Interaction3D {
  private readonly entries: Entry[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hover: Entry | null = null;
  private pressed: Entry | null = null;
  enabled = true;
  intersecting = false;
  private readonly events = new AbortController();

  constructor(private readonly getCamera: () => THREE.Camera) {
    initializeStage();
    const { signal } = this.events;
    window.addEventListener('pointermove', (e) => this.move(e.clientX, e.clientY), { passive: true, signal });
    window.addEventListener('pointerdown', (e) => this.start(e.clientX, e.clientY), { signal });
    window.addEventListener('pointerup', (e) => this.click(e.clientX, e.clientY, e.button), { signal });
  }

  destroy(): void {
    this.events.abort();
    this.enabled = false;
    this.intersecting = false;
    this.entries.length = 0;
    this.hover = null;
    this.pressed = null;
    if (main === this) {
      main = null;
      document.body.style.cursor = '';
    }
  }

  add(mesh: THREE.Object3D, hover?: Callback, click?: Callback, move?: Callback): void {
    const meshes: THREE.Object3D[] = [];
    mesh.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o);
    });
    for (const m of meshes) this.entries.push({ mesh: m, hover, click, move });
  }

  remove(mesh: THREE.Object3D): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i] as Entry;
      let p: THREE.Object3D | null = e.mesh;
      let match = false;
      while (p) {
        if (p === mesh) match = true;
        p = p.parent;
      }
      if (match) this.entries.splice(i, 1);
    }
  }

  private hitTest(x: number, y: number): { entry: Entry; hit: THREE.Intersection } | null {
    this.ndc.set((x / stage.width) * 2 - 1, -(y / stage.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.getCamera());
    let best: { entry: Entry; hit: THREE.Intersection } | null = null;
    for (const entry of this.entries) {
      if (!effectivelyVisible(entry.mesh)) continue;
      const hits = this.raycaster.intersectObject(entry.mesh, false);
      const hit = hits[0];
      if (hit && (!best || hit.distance < best.hit.distance)) best = { entry, hit };
    }
    return best;
  }

  /** Nearest hit among `objects` under the current pointer (Interaction3D.checkObjectHit). */
  checkObjectHit(objects: readonly THREE.Object3D[]): THREE.Intersection | null {
    this.ndc.set((pointer.x / stage.width) * 2 - 1, -(pointer.y / stage.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.getCamera());
    return this.raycaster.intersectObjects(objects.filter(effectivelyVisible), false)[0] ?? null;
  }

  private move(x: number, y: number): void {
    if (prohibited(x, y)) return;
    if (!this.enabled) return;
    const res = this.hitTest(x, y);
    if (res) {
      this.intersecting = true;
      if (this.hover !== res.entry) {
        if (this.hover) this.hover.hover?.({ action: 'out', mesh: this.hover.mesh, hit: res.hit });
        this.hover = res.entry;
        res.entry.hover?.({ action: 'over', mesh: res.entry.mesh, hit: res.hit });
        document.body.style.cursor = res.entry.click ? 'pointer' : '';
      } else res.entry.move?.({ action: 'move', mesh: res.entry.mesh, hit: res.hit });
      return;
    }
    this.intersecting = false;
    if (this.hover) {
      this.hover.hover?.({ action: 'out', mesh: this.hover.mesh, hit: null });
      this.hover = null;
      document.body.style.cursor = '';
    }
  }

  private start(x: number, y: number): void {
    if (prohibited(x, y) || !this.enabled) return;
    const res = this.hitTest(x, y);
    this.pressed = res?.entry ?? null;
  }

  private click(x: number, y: number, button: number): void {
    if (!this.enabled || !this.pressed) return;
    if (prohibited(x, y)) return;
    const res = this.hitTest(x, y);
    if (res && res.entry === this.pressed && button >= 0 && button < 3) res.entry.click?.({ action: 'click', mesh: res.entry.mesh, hit: res.hit });
    this.pressed = null;
  }
}

let main: Interaction3D | null = null;

export function setMainInteraction(i: Interaction3D): void {
  main = i;
}

export function interaction3d(): Interaction3D {
  if (!main) throw new Error('Interaction3D used before the story camera exists');
  return main;
}
