import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { DebugGUI } from '../src/debug/gui';
import { PerfMonitor } from '../src/debug/perfMonitor';

afterEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function input(gui: DebugGUI, label: string): HTMLInputElement | HTMLSelectElement {
  const labelEl = [...gui.element.querySelectorAll('label')].find((l) => l.textContent === label);
  const id = labelEl?.getAttribute('for');
  const el = id ? gui.element.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`) : null;
  if (!el) throw new Error(`No control labelled ${label}`);
  return el;
}

describe('DebugGUI', () => {
  it('binds sliders, toggles, selects and colours to object properties', () => {
    const params = { speed: 1, enabled: false, mode: 'fade' };
    const color = new THREE.Color('#ff0000');
    const gui = new DebugGUI({ title: 'Test' });
    const changes: number[] = [];
    gui.addNumber(params, 'speed', { min: 0, max: 10, step: 0.5 }).onChange((v) => changes.push(v));
    gui.addBoolean(params, 'enabled');
    gui.addSelect(params, 'mode', ['fade', 'wipe']);
    gui.addColor(color, 'tint');

    const slider = input(gui, 'speed') as HTMLInputElement;
    expect(slider.type).toBe('range');
    slider.value = '4.5';
    slider.dispatchEvent(new Event('input'));
    expect(params.speed).toBe(4.5);
    expect(changes).toEqual([4.5]);

    const box = input(gui, 'enabled') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(params.enabled).toBe(true);

    const select = input(gui, 'mode') as HTMLSelectElement;
    select.value = 'wipe';
    select.dispatchEvent(new Event('change'));
    expect(params.mode).toBe('wipe');

    const picker = input(gui, 'tint') as HTMLInputElement;
    picker.value = '#00ff00';
    picker.dispatchEvent(new Event('input'));
    expect(color.getHexString()).toBe('00ff00');

    params.speed = 7;
    gui.refreshAll();
    expect(slider.value).toBe('7');
    gui.destroy();
    expect(document.querySelector('.ox-gui')).toBeNull();
  });

  it('collapses folders accessibly', () => {
    const gui = new DebugGUI();
    const folder = gui.addFolder('Bloom', { open: false });
    const head = folder.element.querySelector('button.ox-gui-head') as HTMLButtonElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    expect(folder.open).toBe(true);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    gui.destroy();
  });

  it('persists changed values and restores them on the next panel', () => {
    const first = { exposure: 0 };
    const gui = new DebugGUI({ storageKey: 'ox-test' });
    const slider = gui.addFolder('Grade').addNumber(first, 'exposure', { min: -2, max: 2 });
    slider.setValue(1.25);
    gui.destroy();
    const second = { exposure: 0 };
    const again = new DebugGUI({ storageKey: 'ox-test' });
    again.addFolder('Grade').addNumber(second, 'exposure', { min: -2, max: 2 });
    expect(second.exposure).toBe(1.25);
    again.clearStorage();
    expect(window.localStorage.getItem('ox-test')).toBeNull();
    again.destroy();
  });

  it('binds float uniforms and shows monitors', () => {
    const uniforms = { uAmount: { value: 0.5 } };
    const gui = new DebugGUI();
    gui.addUniform(uniforms, 'uAmount', { min: 0, max: 1 });
    expect(() => gui.addUniform(uniforms, 'missing')).toThrow(/missing or not a float/);
    let n = 1;
    const out = gui.addMonitor('count', () => n, { digits: 0 });
    n = 42;
    gui.refreshAll();
    expect(out.textContent).toBe('42');
    gui.destroy();
  });
});

describe('PerfMonitor', () => {
  it('averages frame rate and reports and resets per-frame render counts', () => {
    const info = { autoReset: true, render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 }, memory: { geometries: 3, textures: 2 }, programs: [], reset() {
      this.render.calls = 0;
      this.render.triangles = 0;
    } };
    const monitor = new PerfMonitor({ info } as unknown as Pick<THREE.WebGLRenderer, 'info'>);
    expect(info.autoReset).toBe(false);
    for (let i = 0; i < 30; i++) {
      info.render.calls = 12;
      info.render.triangles = 900;
      monitor.sample(1000 / 60);
    }
    expect(monitor.stats.fps).toBeCloseTo(60, 0);
    expect(monitor.stats.drawCalls).toBe(12);
    expect(monitor.stats.geometries).toBe(3);
    expect(info.render.calls).toBe(0);
    monitor.destroy();
    expect(info.autoReset).toBe(true);
  });
});
