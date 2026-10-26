import { clearTween, tween } from '../core/tween';

/**
 * Transform / opacity tweens for DOM elements: x/y translation (px, %, vw, vh),
 * scale / scaleX and opacity, tweened with the shared eases. `clear` removes the inline transform once the tween ends.
 */
export interface DomProps {
  x?: number | string;
  y?: number | string;
  scale?: number;
  scaleX?: number;
  opacity?: number;
}

interface DomState {
  x: number;
  y: number;
  scale: number;
  scaleX: number;
  opacity: number;
}

function movesWith(props: DomProps): boolean {
  return props.x !== undefined || props.y !== undefined || props.scale !== undefined || props.scaleX !== undefined;
}

const UNIT_RE = /^(-?[\d.]+)(px|%|vw|vh)?$/;

function parseLength(value: number | string): { n: number; unit: string } {
  if (typeof value === 'number') return { n: value, unit: 'px' };
  const m = UNIT_RE.exec(value.trim());
  if (!m) throw new Error(`domTween: unsupported length "${value}"`);
  return { n: Number(m[1]), unit: m[2] ?? 'px' };
}

class DomTransform {
  private readonly state: DomState = { x: 0, y: 0, scale: 1, scaleX: 1, opacity: 1 };
  private unitX = 'px';
  private unitY = 'px';

  constructor(private readonly el: HTMLElement | SVGElement) {
    const opacity = el.style.opacity;
    if (opacity !== '') this.state.opacity = Number(opacity);
  }

  set(props: DomProps): this {
    clearTween(this.state);
    if (props.x !== undefined) ({ n: this.state.x, unit: this.unitX } = parseLength(props.x));
    if (props.y !== undefined) ({ n: this.state.y, unit: this.unitY } = parseLength(props.y));
    if (props.scale !== undefined) this.state.scale = props.scale;
    if (props.scaleX !== undefined) this.state.scaleX = props.scaleX;
    if (props.opacity !== undefined) this.state.opacity = props.opacity;
    this.apply(props.opacity !== undefined, movesWith(props));
    return this;
  }

  tween(props: DomProps & { clear?: boolean }, time: number, ease: string, delay = 0): Promise<void> {
    const end: Partial<DomState> = {};
    const moves = movesWith(props);
    if (props.x !== undefined) {
      const { n, unit } = parseLength(props.x);
      if (this.state.x === 0) this.unitX = unit;
      end.x = n;
    }
    if (props.y !== undefined) {
      const { n, unit } = parseLength(props.y);
      if (this.state.y === 0) this.unitY = unit;
      end.y = n;
    }
    if (props.scale !== undefined) end.scale = props.scale;
    if (props.scaleX !== undefined) end.scaleX = props.scaleX;
    if (props.opacity !== undefined) end.opacity = props.opacity;
    const fades = props.opacity !== undefined;
    return tween(this.state, end as Record<string, number>, time, ease, delay)
      .onUpdate(() => this.apply(fades, moves))
      .onComplete(() => {
        if (props.clear) this.el.style.transform = '';
      })
      .promise();
  }

  private apply(opacity: boolean, transform: boolean): void {
    if (opacity) this.el.style.opacity = String(this.state.opacity);
    if (!transform) return;
    const { x, y, scale, scaleX } = this.state;
    this.el.style.transform = `translate3d(${x}${this.unitX}, ${y}${this.unitY}, 0px)${scale !== 1 ? ` scale(${scale})` : ''}${scaleX !== 1 ? ` scaleX(${scaleX})` : ''}`;
  }
}

const transforms = new WeakMap<HTMLElement | SVGElement, DomTransform>();

export function dom(el: HTMLElement | SVGElement): DomTransform {
  let t = transforms.get(el);
  if (!t) {
    t = new DomTransform(el);
    transforms.set(el, t);
  }
  return t;
}
