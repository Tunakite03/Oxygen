import * as THREE from 'three';
import { onFrame } from '../core/loop';

/**
 * Debug panel for tuning: sliders, toggles, selects, colours, buttons, read-only monitors and sparkline graphs in
 * collapsible folders. Controls read and write plain object properties (uniform `.value`s included), refresh while the
 * panel is open so values changed in code show up, and can persist to `localStorage` under `storageKey`. Built on
 * native inputs with labels, so it works with the keyboard and screen readers. Toggle with the backquote key.
 */
export interface NumberOptions {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

export interface Controller<V> {
  readonly element: HTMLElement;
  readonly label: string;
  getValue(): V;
  setValue(value: V): void;
  onChange(listener: (value: V) => void): Controller<V>;
  /** Re-reads the bound property into the input. */
  refresh(): void;
  destroy(): void;
}

export interface DebugGUIOptions {
  title?: string;
  container?: HTMLElement;
  /** Persists changed values under this `localStorage` key and restores them on the next load. */
  storageKey?: string;
  /** Key that shows / hides the panel. Default '`'. */
  hotkey?: string;
  /** Start collapsed. Default false. */
  closed?: boolean;
}

type Primitive = number | boolean | string;
type Persisted = Record<string, Primitive>;
type KeysOfType<T, V> = { [K in keyof T]: T[K] extends V ? K : never }[keyof T] & string;

const STYLE_ID = 'oxygen-debug-gui-style';
const CSS = `
.ox-gui{--ox-bg:#15171b;--ox-row:#1c1f24;--ox-line:#2a2e35;--ox-text:#d5d8dd;--ox-dim:#8b919a;--ox-accent:#5b8def;
position:fixed;top:8px;right:8px;width:268px;max-height:calc(100vh - 16px);overflow:auto;z-index:10000;background:var(--ox-bg);
color:var(--ox-text);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--ox-line);border-radius:4px;
user-select:none;-webkit-user-select:none}
.ox-gui[hidden]{display:none}
.ox-gui *{box-sizing:border-box}
.ox-gui-head{all:unset;box-sizing:border-box;display:flex;width:100%;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;color:var(--ox-text);font-weight:600}
.ox-gui-head:focus-visible{outline:1px solid var(--ox-accent);outline-offset:-1px}
.ox-gui-head::before{content:'';width:0;height:0;border:4px solid transparent;border-left-color:var(--ox-dim);transform:translateX(2px) rotate(90deg);transition:transform .1s}
.ox-gui-head[aria-expanded="false"]::before{transform:translateX(2px)}
.ox-gui-folder{border-top:1px solid var(--ox-line)}
.ox-gui-folder>.ox-gui-head{font-weight:500;color:var(--ox-dim)}
.ox-gui-body{padding:2px 0 4px}
.ox-gui-body[hidden]{display:none}
.ox-gui-body .ox-gui-body{padding-left:8px}
.ox-gui-row{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:6px;padding:2px 8px;min-height:24px}
.ox-gui-row>label,.ox-gui-row>span.ox-gui-label{color:var(--ox-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ox-gui-field{display:flex;gap:4px;align-items:center;min-width:0}
.ox-gui input,.ox-gui select,.ox-gui button{font:inherit;color:var(--ox-text);background:var(--ox-row);border:1px solid var(--ox-line);border-radius:3px;height:20px;min-width:0}
.ox-gui input:focus-visible,.ox-gui select:focus-visible,.ox-gui button:focus-visible{outline:1px solid var(--ox-accent);outline-offset:0}
.ox-gui input[type=range]{flex:1;accent-color:var(--ox-accent);background:none;border:0;padding:0}
.ox-gui input[type=number]{width:64px;padding:0 4px;text-align:right}
.ox-gui input[type=text],.ox-gui select{flex:1;padding:0 4px}
.ox-gui input[type=checkbox]{accent-color:var(--ox-accent);height:14px;width:14px;margin:0}
.ox-gui input[type=color]{width:28px;padding:0 2px}
.ox-gui button{width:100%;cursor:pointer;padding:0 6px}
.ox-gui button:hover{border-color:var(--ox-dim)}
.ox-gui output{font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ox-gui canvas{width:100%;height:28px;display:block;background:var(--ox-row);border-radius:3px}
.ox-gui-wide{grid-template-columns:1fr}
`;

let uid = 0;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function decimals(step: number): number {
  const s = String(step);
  return s.includes('.') ? (s.split('.')[1] ?? '').length : 0;
}

/** True when the page URL has `?debug` (or the given parameter). */
export function debugEnabled(param = 'debug'): boolean {
  return new URLSearchParams(window.location.search).has(param);
}

interface Root {
  persisted: Persisted;
  save(path: string, value: Primitive): void;
  refreshers: Set<() => void>;
}

export class GUIFolder {
  readonly element: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly head: HTMLButtonElement;
  private readonly children: { destroy(): void }[] = [];

  protected constructor(
    readonly title: string,
    protected readonly root: Root,
    protected readonly path: string,
    className: string,
    open: boolean,
  ) {
    this.element = el('div', className);
    const bodyId = `ox-gui-${++uid}`;
    this.head = el('button', 'ox-gui-head', { type: 'button', 'aria-expanded': String(open), 'aria-controls': bodyId });
    this.head.textContent = title;
    this.body = el('div', 'ox-gui-body', { id: bodyId });
    this.body.hidden = !open;
    this.head.addEventListener('click', () => this.setOpen(this.body.hidden));
    this.element.append(this.head, this.body);
  }

  get open(): boolean {
    return !this.body.hidden;
  }

  setOpen(open: boolean): void {
    this.body.hidden = !open;
    this.head.setAttribute('aria-expanded', String(open));
  }

  addFolder(title: string, options: { open?: boolean } = {}): GUIFolder {
    const folder = new GUIFolder(title, this.root, `${this.path}${title}/`, 'ox-gui-folder', options.open ?? true);
    this.body.appendChild(folder.element);
    this.children.push(folder);
    return folder;
  }

  private row(label: string, wide = false): { row: HTMLElement; field: HTMLElement; id: string } {
    const id = `ox-gui-${++uid}`;
    const row = el('div', wide ? 'ox-gui-row ox-gui-wide' : 'ox-gui-row');
    const field = el('div', 'ox-gui-field');
    if (!wide) {
      const l = el('label', undefined, { for: id });
      l.textContent = label;
      l.title = label;
      row.appendChild(l);
    }
    row.appendChild(field);
    this.body.appendChild(row);
    return { row, field, id };
  }

  private controller<V extends Primitive>(
    label: string,
    row: HTMLElement,
    get: () => V,
    set: (v: V) => void,
    display: (v: V) => void,
  ): { controller: Controller<V>; changed: (v: V) => void } {
    const listeners = new Set<(v: V) => void>();
    const key = `${this.path}${label}`;
    const changed = (v: V): void => {
      set(v);
      this.root.save(key, v);
      for (const l of [...listeners]) l(v);
    };
    const refresh = (): void => display(get());
    this.root.refreshers.add(refresh);
    const controller: Controller<V> = {
      element: row,
      label,
      getValue: get,
      setValue: (v) => {
        changed(v);
        display(v);
      },
      onChange(listener) {
        listeners.add(listener);
        return controller;
      },
      refresh,
      destroy: () => {
        this.root.refreshers.delete(refresh);
        row.remove();
      },
    };
    this.children.push(controller);
    const stored = this.root.persisted[key];
    if (stored !== undefined && typeof stored === typeof get()) set(stored as V);
    refresh();
    return { controller, changed };
  }

  /** Number slider (with `min` and `max`) or number box. */
  addNumber<T extends object>(target: T, key: KeysOfType<T, number>, options: NumberOptions = {}): Controller<number> {
    const label = options.label ?? key;
    const obj = target as Record<string, number>;
    const { row, field, id } = this.row(label);
    const step = options.step ?? (options.min !== undefined && options.max !== undefined ? (options.max - options.min) / 100 : 0.01);
    const digits = Math.min(decimals(step), 6);
    const box = el('input', undefined, { type: 'number', step: String(step) });
    let slider: HTMLInputElement | null = null;
    if (options.min !== undefined && options.max !== undefined) {
      slider = el('input', undefined, { type: 'range', id, min: String(options.min), max: String(options.max), step: String(step) });
      box.setAttribute('aria-label', `${label} value`);
      field.appendChild(slider);
    } else box.id = id;
    if (options.min !== undefined) box.min = String(options.min);
    if (options.max !== undefined) box.max = String(options.max);
    field.appendChild(box);
    const clampValue = (v: number): number => Math.min(options.max ?? Infinity, Math.max(options.min ?? -Infinity, v));
    const { controller, changed } = this.controller<number>(
      label,
      row,
      () => obj[key] as number,
      (v) => (obj[key] = v),
      (v) => {
        if (document.activeElement !== box) box.value = v.toFixed(digits);
        if (slider && document.activeElement !== slider) slider.value = String(v);
      },
    );
    slider?.addEventListener('input', () => {
      const v = clampValue(slider.valueAsNumber);
      box.value = v.toFixed(digits);
      changed(v);
    });
    box.addEventListener('change', () => {
      if (Number.isNaN(box.valueAsNumber)) return controller.refresh();
      const v = clampValue(box.valueAsNumber);
      if (slider) slider.value = String(v);
      changed(v);
    });
    return controller;
  }

  addBoolean<T extends object>(target: T, key: KeysOfType<T, boolean>, options: { label?: string } = {}): Controller<boolean> {
    const label = options.label ?? key;
    const obj = target as Record<string, boolean>;
    const { row, field, id } = this.row(label);
    const input = el('input', undefined, { type: 'checkbox', id });
    field.appendChild(input);
    const { controller, changed } = this.controller<boolean>(label, row, () => obj[key] as boolean, (v) => (obj[key] = v), (v) => (input.checked = v));
    input.addEventListener('change', () => changed(input.checked));
    return controller;
  }

  addSelect<T extends object>(target: T, key: KeysOfType<T, string>, choices: readonly string[], options: { label?: string } = {}): Controller<string> {
    const label = options.label ?? key;
    const obj = target as Record<string, string>;
    const { row, field, id } = this.row(label);
    const select = el('select', undefined, { id });
    for (const c of choices) {
      const option = el('option');
      option.value = option.textContent = c;
      select.appendChild(option);
    }
    field.appendChild(select);
    const { controller, changed } = this.controller<string>(label, row, () => obj[key] as string, (v) => (obj[key] = v), (v) => (select.value = v));
    select.addEventListener('change', () => changed(select.value));
    return controller;
  }

  addText<T extends object>(target: T, key: KeysOfType<T, string>, options: { label?: string } = {}): Controller<string> {
    const label = options.label ?? key;
    const obj = target as Record<string, string>;
    const { row, field, id } = this.row(label);
    const input = el('input', undefined, { type: 'text', id });
    field.appendChild(input);
    const { controller, changed } = this.controller<string>(label, row, () => obj[key] as string, (v) => (obj[key] = v), (v) => {
      if (document.activeElement !== input) input.value = v;
    });
    input.addEventListener('change', () => changed(input.value));
    return controller;
  }

  /** Colour picker for a `THREE.Color` (edited in place). */
  addColor(color: THREE.Color, label: string): Controller<string> {
    const { row, field, id } = this.row(label);
    const input = el('input', undefined, { type: 'color', id });
    const hex = el('output');
    field.append(input, hex);
    const { controller, changed } = this.controller<string>(
      label,
      row,
      () => `#${color.getHexString()}`,
      (v) => color.set(v),
      (v) => {
        input.value = v;
        hex.textContent = v;
      },
    );
    input.addEventListener('input', () => {
      hex.textContent = input.value;
      changed(input.value);
    });
    return controller;
  }

  /** Slider bound to a float uniform's `.value`. */
  addUniform(uniforms: Record<string, THREE.IUniform>, name: string, options: NumberOptions = {}): Controller<number> {
    const u = uniforms[name];
    if (!u || typeof u.value !== 'number') throw new Error(`Uniform "${name}" is missing or not a float`);
    return this.addNumber(u as { value: number }, 'value', { label: name, ...options });
  }

  addButton(label: string, action: () => void): HTMLButtonElement {
    const { row, field } = this.row(label, true);
    const button = el('button', undefined, { type: 'button' });
    button.textContent = label;
    button.addEventListener('click', action);
    field.appendChild(button);
    this.children.push({ destroy: () => row.remove() });
    return button;
  }

  /** Read-only value, refreshed while the panel is open. */
  addMonitor(label: string, read: () => number | string, options: { digits?: number } = {}): HTMLOutputElement {
    const { row, field } = this.row(label);
    const out = el('output', undefined, { 'aria-live': 'off' });
    field.appendChild(out);
    const refresh = (): void => {
      const v = read();
      out.textContent = typeof v === 'number' ? v.toFixed(options.digits ?? 2) : v;
    };
    this.root.refreshers.add(refresh);
    this.children.push({ destroy: () => (this.root.refreshers.delete(refresh), row.remove()) });
    refresh();
    return out;
  }

  /** Sparkline of the last `samples` values with the latest value as text. */
  addGraph(label: string, read: () => number, options: { min?: number; max?: number; samples?: number; digits?: number } = {}): HTMLCanvasElement {
    const { row, field } = this.row(label);
    const wrap = el('div');
    wrap.style.flex = '1';
    const canvas = el('canvas', undefined, { role: 'img', 'aria-label': `${label} history` });
    const out = el('output');
    out.style.minWidth = '40px';
    out.style.textAlign = 'right';
    wrap.appendChild(canvas);
    field.append(wrap, out);
    const values: number[] = [];
    const size = options.samples ?? 90;
    const refresh = (): void => {
      const v = read();
      values.push(v);
      if (values.length > size) values.shift();
      out.textContent = v.toFixed(options.digits ?? 0);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = (canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1) || 160);
      const h = (canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1) || 28);
      const lo = options.min ?? Math.min(...values);
      const hi = options.max ?? Math.max(...values, lo + 1e-6);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = getComputedStyle(this.element).getPropertyValue('--ox-accent') || '#5b8def';
      ctx.lineWidth = Math.max(1, w / 160);
      ctx.beginPath();
      values.forEach((value, i) => {
        const x = (i / (size - 1)) * w;
        const y = h - ((Math.min(Math.max(value, lo), hi) - lo) / (hi - lo || 1)) * (h - 2) - 1;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    this.root.refreshers.add(refresh);
    this.children.push({ destroy: () => (this.root.refreshers.delete(refresh), row.remove()) });
    return canvas;
  }

  destroy(): void {
    for (const c of this.children) c.destroy();
    this.children.length = 0;
    this.element.remove();
  }
}

function readStorage(key: string | undefined): Persisted {
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Persisted = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    return out;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the panel works without persistence.
    return {};
  }
}

export class DebugGUI extends GUIFolder {
  private readonly stopFrame: () => void;
  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly storageKey: string | undefined;

  constructor(options: DebugGUIOptions = {}) {
    injectStyles();
    const persisted = readStorage(options.storageKey);
    const root: Root = {
      persisted,
      refreshers: new Set(),
      save: (path, value) => {
        if (!options.storageKey) return;
        persisted[path] = value;
        try {
          window.localStorage.setItem(options.storageKey, JSON.stringify(persisted));
        } catch {
          // See readStorage.
        }
      },
    };
    super(options.title ?? 'Oxygen', root, '', 'ox-gui', !(options.closed ?? false));
    this.storageKey = options.storageKey;
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', `${this.title} debug panel`);
    (options.container ?? document.body).appendChild(this.element);
    const hotkey = options.hotkey ?? '`';
    this.onKey = (e) => {
      if (e.key !== hotkey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.element.hidden = !this.element.hidden;
    };
    window.addEventListener('keydown', this.onKey);
    // Refresh at ~10 Hz while visible: enough to follow values without costing a frame.
    let last = 0;
    this.stopFrame = onFrame((time) => {
      if (this.element.hidden || !this.open || time - last < 100) return;
      last = time;
      this.refreshAll();
    }, 'postRender');
  }

  /** Re-reads every control and monitor now. */
  refreshAll(): void {
    for (const r of [...this.root.refreshers]) r();
  }

  /** Forgets persisted values. */
  clearStorage(): void {
    for (const k of Object.keys(this.root.persisted)) delete this.root.persisted[k];
    if (!this.storageKey) return;
    try {
      window.localStorage.removeItem(this.storageKey);
    } catch {
      // See readStorage.
    }
  }

  override destroy(): void {
    this.stopFrame();
    window.removeEventListener('keydown', this.onKey);
    super.destroy();
  }
}
