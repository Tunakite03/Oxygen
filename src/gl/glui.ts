import * as THREE from 'three';
import { device } from '../core/stage';
import { world } from '../core/world';

/**
 * Element of the pixel-space overlay scene (`Pipeline.uiScene`): `x`/`y` are CSS pixels with y down, `scale` is
 * uniform around the element origin, quads are unit planes scaled to their pixel size (shaders see a centred plane).
 */
export class GLUIElement {
  readonly group = new THREE.Group();

  get x(): number {
    return this.group.position.x;
  }

  set x(v: number) {
    this.group.position.x = v;
  }

  get y(): number {
    return -this.group.position.y;
  }

  set y(v: number) {
    this.group.position.y = -v;
  }

  get scale(): number {
    return this.group.scale.x;
  }

  set scale(v: number) {
    this.group.scale.set(v, v, 1);
  }

  show(): void {
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  addToStage(): void {
    world().uiScene.add(this.group);
  }
}

const unitPlane = new THREE.PlaneGeometry(1, 1);

/** A w×h pixel quad whose top-left corner sits at the parent origin. */
export function gluiQuad(width: number, height: number, material: THREE.RawShaderMaterial): THREE.Mesh<THREE.PlaneGeometry, THREE.RawShaderMaterial> {
  const mesh = new THREE.Mesh(unitPlane, material);
  mesh.scale.set(width, height, 1);
  mesh.position.set(width / 2, -height / 2, 0);
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Tap handler: the virtual scroll cancels touchstart (so no click is synthesised on phones), hence taps
 * are taken from touchend on mobile and from click elsewhere.
 */
export function bindTap(el: HTMLElement, onTap: () => void): void {
  el.addEventListener(device.mobile ? 'touchend' : 'click', (e) => {
    e.preventDefault();
    onTap();
  });
}

/** Resizes a `gluiQuad` in place, keeping its top-left corner on the parent origin. */
export function setQuadSize(mesh: THREE.Mesh, width: number, height: number): void {
  mesh.scale.set(width, height, 1);
  mesh.position.set(width / 2, -height / 2, mesh.position.z);
}

/**
 * Accessible hit area: a transparent fixed-position link over a GL element, giving it pointer hover / click,
 * the pointer cursor and an accessible name. `place` follows the element's pixel rect.
 */
export class HitLink {
  readonly el = document.createElement('a');

  constructor(label: string, onClick: () => void, onHover: ((over: boolean) => void) | null = null, zIndex = 95) {
    const el = this.el;
    el.className = 'hit gl-hit';
    el.href = '#';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    el.textContent = label;
    Object.assign(el.style, { position: 'fixed', zIndex: String(zIndex), fontSize: '0', cursor: 'pointer', display: 'block' });
    bindTap(el, onClick);
    if (onHover) {
      el.addEventListener('mouseenter', () => onHover(true));
      el.addEventListener('mouseleave', () => onHover(false));
    }
    document.body.appendChild(el);
  }

  place(x: number, y: number, width: number, height: number): void {
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  }

  setVisible(visible: boolean): void {
    this.el.style.display = visible ? 'block' : 'none';
  }
}
